// Safety layer for the validation harness. Pure and offline: no network, no database, no key handling.
// Everything that decides "may this call happen?" lives here so it can be tested exhaustively with mocks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const MAX_CALLS = 8; // ONE consented session: 2 smoke + 1 optional injection + 5 pages
// The eight-call limit is per consented SESSION (one process). It is NOT a persisted lifetime total: a restart is a new
// session and requires fresh explicit consent. This is stated in every report so it is never mistaken for a hard total.
export const SESSION_SCOPE = 'one consented session; a restart requires fresh consent';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

// ---- private paths: realpath must resolve OUTSIDE the worktree (and outside any git work tree) ----
export function realOutside(p, repoRoot = REPO_ROOT) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error('path_invalid');
  let real;
  try { real = fs.realpathSync(p); } catch { throw new Error('path_unreadable'); }
  const root = fs.realpathSync(repoRoot);
  const rel = path.relative(root, real);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('path_inside_repo');
  return real;
}

// A results file is created by us, so its parent directory is what must be outside the repo.
export function resultsPathOutside(p, repoRoot = REPO_ROOT) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error('path_invalid');
  const parent = realOutside(path.dirname(path.resolve(p)), repoRoot);
  const target = path.join(parent, path.basename(p));
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('path_symlink');
  return target;
}

// Directory permissions: private folders must not be group/world accessible.
export function assertPrivateDir(dir) {
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error('not_a_directory');
  if ((st.mode & 0o077) !== 0) throw new Error('dir_not_private');
}

// ---- endpoint guard + request tap, applied around the REAL provider's fetch ----
// The provider is constructed with this as fetchImpl. It refuses anything but the fixed Anthropic URL, forbids redirects,
// reserves a call BEFORE dispatch, and reads usage/model/stop_reason from the raw response without disturbing the provider.
export function createGuardedFetch({ session, realFetch = fetch, expectedModel, maxOutputTokens, onRequestBody }) {
  return async function guardedFetch(url, init = {}) {
    if (url !== ENDPOINT) throw new Error('endpoint_not_allowed');
    if (init.method !== 'POST') throw new Error('method_not_allowed');
    let body;
    try { body = JSON.parse(init.body); } catch { throw new Error('body_not_json'); }
    if (body.model !== expectedModel) throw new Error('model_mismatch');
    if (body.max_tokens !== maxOutputTokens) throw new Error('max_tokens_mismatch');
    for (const k of ['stream', 'thinking', 'metadata', 'container', 'mcp_servers']) if (k in body) throw new Error('unexpected_field');
    if (!Array.isArray(body.messages) || body.messages.length !== 1) throw new Error('unexpected_history');
    onRequestBody?.(body, init.body);
    session.reserve(); // throws before any network use when the ceiling is reached or consent was not given
    let res;
    try {
      res = await realFetch(url, { ...init, redirect: 'error' });
    } catch (e) {
      session.markDispatched();
      throw e;
    }
    session.markDispatched();
    if (res.status >= 300 && res.status < 400) throw new Error('redirect_blocked');
    // Tap the parsed body so usage/model/stop_reason can be checked, then hand the provider an identical result.
    let parsed;
    try { parsed = await res.json(); } catch (e) { session.noteResponse({ status: res.status, parsed: null }); return { status: res.status, ok: res.ok, json: async () => { throw e; } }; }
    session.noteResponse({ status: res.status, parsed });
    return { status: res.status, ok: res.ok, json: async () => parsed };
  };
}

// ---- the session: call ceiling, consent, usage/stop-reason validation before the NEXT call ----
export function createSession({ maxCalls = MAX_CALLS, bounds } = {}) {
  let used = 0; // reserved slots; an ambiguous or cancelled call keeps its slot
  let dispatched = 0;
  let stopped = null;
  let consented = false;
  const log = []; // numeric/boolean facts only
  let current = null;
  return {
    get used() { return used; },
    get dispatched() { return dispatched; },
    get stopped() { return stopped; },
    get log() { return log.map((x) => ({ ...x })); },
    grantConsent() { consented = true; },
    stop(reason) { stopped = reason; },
    reserve() {
      if (!consented) throw new Error('no_consent');
      if (stopped) throw new Error(`session_stopped:${stopped}`);
      if (used >= maxCalls) throw new Error('call_ceiling');
      used += 1; // the slot is consumed at reservation, so cancel/timeout/unknown cannot refund it
      current = { slot: used, dispatched: false, status: null, inputTokens: null, outputTokens: null, stopReason: null, modelOk: null };
      log.push(current);
    },
    markDispatched() { dispatched += 1; if (current) current.dispatched = true; },
    noteResponse({ status, parsed }) {
      if (!current) return;
      current.status = status;
      if (!parsed || typeof parsed !== 'object') { current.malformed = true; stopped = 'malformed_response'; return; }
      const u = parsed.usage || {};
      current.inputTokens = Number.isInteger(u.input_tokens) ? u.input_tokens : null;
      current.outputTokens = Number.isInteger(u.output_tokens) ? u.output_tokens : null;
      current.stopReason = typeof parsed.stop_reason === 'string' ? parsed.stop_reason : null;
      current.modelOk = parsed.model === bounds.model;
      // Validate BEFORE any next call is allowed. Cost for this call is already incurred; the point is to stop the next one.
      if (status !== 200) stopped = 'non_200';
      else if (current.inputTokens === null || current.outputTokens === null) stopped = 'usage_missing';
      else if (current.inputTokens > bounds.inputTokenBound) stopped = 'input_over_bound';
      else if (current.outputTokens >= bounds.maxOutputTokens) stopped = 'output_at_bound';
      else if (current.stopReason !== 'tool_use') stopped = `stop_reason_${current.stopReason ?? 'missing'}`.slice(0, 40);
      else if (!current.modelOk) stopped = 'model_mismatch';
    },
  };
}
