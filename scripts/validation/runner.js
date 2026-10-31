// The validation runner. It uses the REAL production request path: createAnthropicProvider -> analyze(),
// processImage() (resize to 1568, metadata stripped), validateModelOutput(), evaluate() and countWordsV1().
// No database, no server, no job loop. Evidence is numbers and booleans only; model text is shown on screen, never saved.
import { createAnthropicProvider, validateAiConfig, ProviderError } from '../../src/ai.js';
import { processImage } from '../../src/images.js';
import { validateModelOutput, evaluate, countWordsV1, suggestedMinutes } from '../../src/journal.js';
import { loadConfig } from '../../src/config.js';
import { createGuardedFetch, MAX_CALLS, SESSION_SCOPE } from './guard.js';

export function productionSettings(env = {}) {
  const cfg = loadConfig(env);
  const check = validateAiConfig(cfg.ai);
  if (!check.ok) throw new Error(`ai_config_invalid:${check.reason}`);
  return { cfg, check, ai: cfg.ai, limits: cfg.limits };
}

// Percent error with an exact-match rule for a zero reference (never divides by zero).
export function percentError(reference, model) {
  if (!Number.isInteger(reference) || !Number.isInteger(model) || reference < 0 || model < 0) throw new Error('bad_counts');
  if (reference === 0) return model === 0 ? 0 : Infinity;
  return (Math.abs(model - reference) / reference) * 100;
}

export function pageVerdict({ referenceCount, modelCount, tolerancePct = 5 }) {
  const err = percentError(referenceCount, modelCount);
  const refTier = suggestedMinutes(referenceCount);
  const modelTier = suggestedMinutes(modelCount);
  return {
    percentError: Number.isFinite(err) ? Math.round(err * 100) / 100 : null,
    withinTolerance: err <= tolerancePct, // zero reference requires an exact match
    tierMatch: refTier === modelTier,
    referenceTier: refTier,
    modelTier,
  };
}

// The gate: >= 4 of 5 pages within tolerance, no invented passages on accepted pages, and tier agreement on every clear page.
export function gateResult(pages) {
  const n = pages.length;
  const within = pages.filter((p) => p.withinTolerance).length;
  const accepted = pages.filter((p) => p.withinTolerance);
  const inventedOnAccepted = accepted.filter((p) => p.invented === true).length;
  const clear = pages.filter((p) => p.clear === true);
  const clearTierMismatch = clear.filter((p) => !p.tierMatch).length;
  return {
    pages: n,
    withinTolerance: within,
    inventedOnAccepted,
    clearPages: clear.length,
    clearTierMismatch,
    passed: n === 5 && within >= 4 && inventedOnAccepted === 0 && clearTierMismatch === 0,
  };
}

// Builds the exact production request body for an image, using the SAME provider code path, with a recording fetch.
export async function captureProductionRequest({ ai, imageBase64, mediaType }) {
  let captured = null;
  const provider = createAnthropicProvider({
    apiKey: 'dryrun-not-a-key', model: ai.model, maxOutputTokens: ai.maxOutputTokens, timeoutMs: ai.timeoutMs,
    fetchImpl: async (url, init) => { captured = { url, init, raw: init.body, body: JSON.parse(init.body) }; throw new Error('dryrun_no_network'); },
  });
  try { await provider.analyze({ imageBase64, mediaType }); } catch (e) { if (e instanceof ProviderError && e.code === 'network') { /* expected: the capture fetch refused */ } else throw e; }
  if (!captured) throw new Error('no_request_captured');
  return captured;
}

export async function prepareImage(buf, limits) {
  const img = await processImage(buf, limits);
  return { imageBase64: Buffer.from(img.data).toString('base64'), mediaType: img.contentType, bytes: img.data.length };
}

// One consented live call through the guarded fetch. Returns numbers/booleans plus the transient model text (screen only).
export async function liveCall({ apiKey, settings, session, realFetch, image, onRequestBody }) {
  const { ai, check } = settings;
  const guarded = createGuardedFetch({ session, realFetch, expectedModel: ai.model, maxOutputTokens: ai.maxOutputTokens, onRequestBody });
  const provider = createAnthropicProvider({
    apiKey, model: ai.model, maxOutputTokens: ai.maxOutputTokens, timeoutMs: ai.timeoutMs, fetchImpl: guarded,
  });
  const slot = session.used + 1;
  let raw;
  try {
    raw = await provider.analyze(image);
  } catch (e) {
    const code = e instanceof ProviderError ? e.code : String(e?.message || 'error').slice(0, 40).replace(/[^a-z0-9_:\-]/gi, '_');
    // no automatic retry, ever. An ambiguous outcome (timeout/network/5xx) keeps its slot and is reported as such.
    return { ok: false, slot, errorCode: code, ambiguous: e instanceof ProviderError ? e.unknownOutcome === true : true, transient: null };
  }
  let v;
  try { v = validateModelOutput(raw); } catch { return { ok: false, slot, errorCode: 'schema_invalid', ambiguous: false, transient: null }; }
  const ev = evaluate({ transcript: v.transcript, illegibleCount: v.illegible_count, pageIssues: v.page_issues });
  return {
    ok: true, slot,
    modelCount: ev.wordCount, minutes: ev.minutes, status: ev.status, flags: ev.flags,
    illegibleCount: v.illegible_count, pageIssues: v.page_issues,
    transient: { transcript: v.transcript }, // screen only; never written to disk
    reservePerCallMicro: check.reserveMicro,
  };
}

export { MAX_CALLS, SESSION_SCOPE };
