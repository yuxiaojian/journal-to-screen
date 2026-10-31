// The interactive flows, with every external effect injected (terminal, network, filesystem roots) so they can be tested
// without a real terminal, key or network. The CLI (scripts/validate.js) wires in the real ones and offers NO way to
// substitute the network from the command line or environment.
import fs from 'node:fs';
import path from 'node:path';
import { askHidden, confirm } from './prompt.js';
import { createSession, resultsPathOutside, realOutside, assertPrivateDir, MAX_CALLS, SESSION_SCOPE } from './guard.js';
import { prepareImage, captureProductionRequest, liveCall, pageVerdict, gateResult } from './runner.js';
import { smokeImage, blankImage, injectionImage, SMOKE_TEXT, EXPECTATIONS } from './fixtures.js';
import { countWordsV1 } from '../../src/journal.js';

export function makeContext({ settings, io, realFetch, out = (s) => console.log(s) }) {
  const { ai, check } = settings;
  const bounds = { model: ai.model, inputTokenBound: check.inputTokenBound, maxOutputTokens: ai.maxOutputTokens };
  return { settings, ai, check, bounds, io, realFetch, out };
}

export function banner(c) {
  c.out(`model=${c.ai.model} max_output_tokens=${c.ai.maxOutputTokens} input_token_bound=${c.check.inputTokenBound}`);
  c.out(`planning reservation per call = ${c.check.reserveMicro} micro-USD (a bounded planning estimate, NOT a provider-enforced cap or an invoice guarantee)`);
  c.out(`call ceiling = ${MAX_CALLS} in ${SESSION_SCOPE}`);
}

export async function dryRun(c) {
  banner(c);
  c.out('DRY RUN: offline. No key requested, no network used, no paid call made.');
  for (const [name, mk] of [['smoke', smokeImage], ['blank', blankImage], ['injection', injectionImage]]) {
    const img = await prepareImage(await mk(), c.settings.limits);
    const cap = await captureProductionRequest({ ai: c.ai, imageBase64: img.imageBase64, mediaType: img.mediaType });
    c.out(`${name}: image ${img.bytes} bytes, request ${cap.raw.length} chars, model=${cap.body.model}, tool_choice=${cap.body.tool_choice.type}, endpoint ok=${cap.url === 'https://api.anthropic.com/v1/messages'}`);
  }
  c.out(`smoke fixture expected count_v1 = ${countWordsV1(SMOKE_TEXT.lines.join('\n'))}`);
  c.out('To run live: node scripts/validate.js --smoke  (asks for the key and consent on the terminal)');
}

async function requireKeyAndConsent(c, what, calls) {
  if (!c.io.input.isTTY) throw new Error('tty_required');
  c.out(`\nAbout to send ${what} to api.anthropic.com. Up to ${calls} paid call(s) in this session.`);
  const key = await askHidden('Paste the Anthropic API key (hidden), or press Ctrl-C to cancel: ', c.io);
  if (!/^\S{20,300}$/.test(key)) throw new Error('key_format');
  return key;
}

export async function smoke(c, { injection = false } = {}) {
  banner(c);
  const key = await requireKeyAndConsent(c, '2 SYNTHETIC test images (no child data)', injection ? 3 : 2);
  const session = createSession({ bounds: c.bounds });
  if (!(await confirm('Type "yes" to consent to this session: ', c.io))) { c.out('No consent. Nothing sent.'); return { session, out: [] }; }
  session.grantConsent();
  const out = [];
  const plan = [['smoke', smokeImage], ['blank', blankImage], ...(injection ? [['injection', injectionImage]] : [])];
  for (const [name, mk] of plan) {
    if (session.stopped) { c.out(`Stopped before ${name}: ${session.stopped}`); break; }
    if (!(await confirm(`Send "${name}" now? [y/N] `, c.io))) { c.out('Stopped by owner.'); break; }
    const img = await prepareImage(await mk(), c.settings.limits);
    const r = await liveCall({ apiKey: key, settings: c.settings, session, realFetch: c.realFetch, image: { imageBase64: img.imageBase64, mediaType: img.mediaType } });
    if (!r.ok) { c.out(`${name}: FAILED code=${r.errorCode} ambiguous=${r.ambiguous}; the slot stays used. Stopping (no automatic retry).`); session.stop(session.stopped ?? 'call_failed'); out.push({ name, ok: false, code: r.errorCode }); break; }
    c.out(`\n${name}: count=${r.modelCount} minutes=${r.minutes} status=${r.status} flags=${r.flags.join(',') || '-'} issues=${r.pageIssues.join(',') || '-'}`);
    c.out(`--- model text (screen only) ---\n${r.transient.transcript}\n--- end ---`);
    const problems = EXPECTATIONS[name]({ transcript: r.transient.transcript, modelCount: r.modelCount, illegibleCount: r.illegibleCount, status: r.status, minutes: r.minutes });
    out.push({ name, ok: true, modelCount: r.modelCount, status: r.status, expectationMet: problems.length === 0, problems });
    if (problems.length) { c.out(`${name}: EXPECTATION NOT MET (${problems.join(', ')}). Stopping before any further call.`); session.stop('expectation_failed'); break; }
    c.out(`${name}: expectation met`);
  }
  c.out(`\nSession log (numbers only): ${JSON.stringify(session.log)}`);
  c.out(`Calls used (reserved): ${session.used}/${MAX_CALLS}; dispatched: ${session.dispatched}; stopped: ${session.stopped ?? 'no'}`);
  const wanted = plan.map(([n]) => n);
  const passed = !session.stopped && wanted.length === out.length && out.every((x) => x.ok && x.expectationMet);
  c.out(`SMOKE RESULT: ${passed ? 'PASS' : 'FAIL'} (${out.filter((x) => x.expectationMet).length}/${wanted.length} expectations met; stopped: ${session.stopped ?? 'no'})`);
  c.out('Next step: STOP and review the response shape and token usage above. The five private pages need a separate, later consent.');
  return { session, out, passed };
}

export async function pages(c, { dir: dirArg, results: resultsArg, repoRoot }) {
  const dir = realOutside(dirArg ?? '', repoRoot);
  assertPrivateDir(dir);
  const resultsFile = resultsPathOutside(resultsArg ?? '', repoRoot);
  banner(c);
  const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (files.length !== 5) throw new Error('need_exactly_five_pages');
  // Reference transcript + count are fixed BEFORE any model output, so the comparison cannot be biased by what the model returns.
  const refs = [];
  for (let i = 0; i < files.length; i += 1) {
    const base = files[i].replace(/\.[^.]+$/, '');
    const refPath = path.join(dir, `${base}.txt`);
    if (!fs.existsSync(refPath)) throw new Error(`missing_reference_${i + 1}`);
    refs.push({ idx: i + 1, file: files[i], referenceCount: countWordsV1(fs.readFileSync(refPath, 'utf8')) });
  }
  c.out(`Reference counts fixed before any model call: ${refs.map((r) => r.referenceCount).join(', ')}`);
  const key = await requireKeyAndConsent(c, 'FIVE PRIVATE journal pages', 5);
  const session = createSession({ bounds: c.bounds });
  if (!(await confirm('These are real pages. Type "yes" to consent to sending them to Anthropic for this session: ', c.io))) { c.out('No consent. Nothing sent.'); return { session, results: [] }; }
  session.grantConsent();
  const results = [];
  for (const r of refs) {
    if (session.stopped) { c.out(`Stopped: ${session.stopped}`); break; }
    if (!(await confirm(`Send page ${r.idx} of 5 now? [y/N] `, c.io))) { c.out('Stopped by owner.'); break; }
    const img = await prepareImage(fs.readFileSync(path.join(dir, r.file)), c.settings.limits);
    const res = await liveCall({ apiKey: key, settings: c.settings, session, realFetch: c.realFetch, image: { imageBase64: img.imageBase64, mediaType: img.mediaType } });
    if (!res.ok) { c.out(`page ${r.idx}: FAILED code=${res.errorCode} ambiguous=${res.ambiguous}. Stopping (no automatic retry).`); session.stop(session.stopped ?? 'call_failed'); break; }
    c.out(`\npage ${r.idx}: reference=${r.referenceCount} model=${res.modelCount} status=${res.status}\n--- model text (screen only) ---\n${res.transient.transcript}\n--- end ---`);
    const clear = await confirm('Was the page clearly legible? [y/N] ', c.io);
    const invented = await confirm('Did the model invent or rewrite any passage? [y/N] ', c.io);
    const v = pageVerdict({ referenceCount: r.referenceCount, modelCount: res.modelCount });
    const log = session.log[session.log.length - 1] || {};
    results.push({ page: r.idx, referenceCount: r.referenceCount, modelCount: res.modelCount, ...v, clear, invented, flagsCount: res.flags.length, inputTokens: log.inputTokens, outputTokens: log.outputTokens });
  }
  const gate = gateResult(results, { stopped: session.stopped });
  const evidence = { schema: 1, model: c.ai.model, sessionScope: SESSION_SCOPE, callsReserved: session.used, callsDispatched: session.dispatched, stopped: session.stopped ?? null, pages: results, gate };
  fs.writeFileSync(resultsFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  c.out(`\nGate: ${JSON.stringify(gate)}`);
  c.out('Numeric evidence saved outside the repository (mode 600). It contains no text, filenames or images.');
  return { session, results, gate, resultsFile };
}
