import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGuardedFetch, createSession, realOutside, resultsPathOutside, assertPrivateDir, MAX_CALLS, ENDPOINT, REPO_ROOT } from '../scripts/validation/guard.js';
import { settings, bounds, newSession, fakeNet, good, toolInput } from './validation-helpers.js';
import { liveCall } from '../scripts/validation/runner.js';

const img = { imageBase64: 'AAAA', mediaType: 'image/jpeg' };
const call = (net, session, opts = {}) => liveCall({ apiKey: 'k'.repeat(30), settings, session, realFetch: net, image: img, ...opts });

test('constants: eight calls, one consented session, fixed endpoint', () => {
  assert.equal(MAX_CALLS, 8);
  assert.equal(ENDPOINT, 'https://api.anthropic.com/v1/messages');
});

test('no consent => no network use at all', async () => {
  const net = fakeNet([good()]);
  const session = createSession({ bounds }); // consent NOT granted
  const r = await call(net, session);
  assert.equal(r.ok, false);
  assert.equal(net.calls.length, 0);
  assert.equal(session.used, 0);
});

test('endpoint, method, model and max_tokens are enforced before any dispatch', async () => {
  const mk = (session) => createGuardedFetch({ session, realFetch: fakeNet([good()]), expectedModel: bounds.model, maxOutputTokens: bounds.maxOutputTokens });
  const body = (o = {}) => JSON.stringify({ model: bounds.model, max_tokens: bounds.maxOutputTokens, messages: [{}], ...o });
  const cases = [
    [ENDPOINT + '/x', { method: 'POST', body: body() }, 'endpoint_not_allowed'],
    ['https://evil.example/v1/messages', { method: 'POST', body: body() }, 'endpoint_not_allowed'],
    ['http://api.anthropic.com/v1/messages', { method: 'POST', body: body() }, 'endpoint_not_allowed'],
    [ENDPOINT, { method: 'GET', body: body() }, 'method_not_allowed'],
    [ENDPOINT, { method: 'POST', body: 'not json' }, 'body_not_json'],
    [ENDPOINT, { method: 'POST', body: body({ model: 'claude-sonnet-5-5' }) }, 'model_mismatch'],
    [ENDPOINT, { method: 'POST', body: body({ max_tokens: 99999 }) }, 'max_tokens_mismatch'],
    [ENDPOINT, { method: 'POST', body: body({ stream: true }) }, 'unexpected_field'],
    [ENDPOINT, { method: 'POST', body: body({ thinking: { type: 'enabled' } }) }, 'unexpected_field'],
    [ENDPOINT, { method: 'POST', body: body({ messages: [{}, {}] }) }, 'unexpected_history'],
  ];
  for (const [url, init, why] of cases) {
    const session = newSession();
    await assert.rejects(mk(session)(url, init), new RegExp(why), why);
    assert.equal(session.used, 0, `${why}: a refused request must not consume a slot`);
  }
});

test('redirects are forbidden: the real fetch is always called with redirect:"error", and a 3xx is refused', async () => {
  const net = fakeNet([good()]);
  const session = newSession();
  await call(net, session);
  assert.equal(net.calls[0].init.redirect, 'error');
  const net3 = fakeNet([{ status: 302, ok: false, json: async () => ({}) }]);
  const s3 = newSession();
  const r = await call(net3, s3);
  assert.equal(r.ok, false);
  assert.equal(s3.used, 1); // a redirect after dispatch keeps its slot
});

test('the eight-call ceiling: the ninth call is refused before any network use, per consented session', async () => {
  const net = fakeNet(Array.from({ length: 12 }, () => good()));
  const session = newSession();
  for (let i = 0; i < 8; i += 1) assert.equal((await call(net, session)).ok, true, `call ${i + 1}`);
  assert.equal(net.calls.length, 8);
  const ninth = await call(net, session);
  assert.equal(ninth.ok, false);
  assert.equal(net.calls.length, 8); // nothing sent
  assert.equal(session.used, 8);
  // a restart is a NEW session and needs fresh consent: without it nothing is sent
  const fresh = createSession({ bounds });
  assert.equal((await call(net, fresh)).ok, false);
  assert.equal(net.calls.length, 8);
});

test('reserve BEFORE dispatch: the slot is consumed even if the network call never completes (timeout / cancel / unknown)', async () => {
  for (const failure of [Object.assign(new Error('x'), { name: 'AbortError' }), new TypeError('fetch failed'), new Error('socket hang up')]) {
    const net = fakeNet([failure]);
    const session = newSession();
    const r = await call(net, session);
    assert.equal(r.ok, false);
    assert.equal(r.ambiguous, true);
    assert.equal(session.used, 1, 'an ambiguous outcome keeps its slot');
    assert.equal(session.dispatched, 1);
  }
  // reserve happens first: when the fake network observes the call, the slot is already counted
  let usedAtDispatch = -1;
  const session = newSession();
  await call((u, i) => { usedAtDispatch = session.used; return good(); }, session);
  assert.equal(usedAtDispatch, 1);
});

test('no automatic retry: a failing call is attempted exactly once', async () => {
  const net = fakeNet([{ status: 503, ok: false, json: async () => ({}) }, good()]);
  const session = newSession();
  const r = await call(net, session);
  assert.equal(r.ok, false);
  assert.equal(net.calls.length, 1);
  assert.equal(session.stopped, 'non_200');
});

test('usage / model / stop_reason are validated BEFORE the next call is allowed', async () => {
  const scenarios = [
    ['input over bound', good(toolInput(5), { usage: { input_tokens: bounds.inputTokenBound + 1, output_tokens: 50 } }), 'input_over_bound'],
    ['output at the max (possible truncation)', good(toolInput(5), { usage: { input_tokens: 900, output_tokens: bounds.maxOutputTokens } }), 'output_at_bound'],
    ['usage missing', { status: 200, ok: true, json: async () => ({ model: bounds.model, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_transcript', input: toolInput(5) }] }) }, 'usage_missing'],
    ['usage not integers', good(toolInput(5), { usage: { input_tokens: '9', output_tokens: 1.5 } }), 'usage_missing'],
    ['stop reason max_tokens', good(toolInput(5), { stop: 'max_tokens' }), 'stop_reason_max_tokens'],
    ['wrong model echoed', good(toolInput(5), { model: 'claude-other-9' }), 'model_mismatch'],
    ['non-200', { status: 529, ok: false, json: async () => ({ error: 'overloaded' }) }, 'non_200'],
  ];
  for (const [name, response, expected] of scenarios) {
    const net = fakeNet([response, good()]);
    const session = newSession();
    await call(net, session);
    assert.equal(session.stopped, expected, name);
    const second = await call(net, session);
    assert.equal(second.ok, false, `${name}: the next call must be refused`);
    assert.equal(net.calls.length, 1, `${name}: nothing further is sent`);
  }
  // exactly at the input bound is allowed
  const okNet = fakeNet([good(toolInput(5), { usage: { input_tokens: bounds.inputTokenBound, output_tokens: bounds.maxOutputTokens - 1 } }), good()]);
  const s = newSession();
  await call(okNet, s);
  assert.equal(s.stopped, null);
});

test('the session log holds numbers and booleans only (no text, no key, no filenames)', async () => {
  const session = newSession();
  await call(fakeNet([good(toolInput(7))]), session);
  for (const entry of session.log) for (const [k, v] of Object.entries(entry)) {
    assert.ok(['number', 'boolean'].includes(typeof v) || v === null || (k === 'stopReason' && typeof v === 'string'), `${k} is ${typeof v}`);
  }
  assert.ok(!JSON.stringify(session.log).includes('cat'));
  assert.ok(!JSON.stringify(session.log).includes('kkkk'));
});

test('private paths must resolve OUTSIDE the worktree (realpath), including symlinks that point inside', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'val-out-'));
  assert.equal(realOutside(outside), fs.realpathSync(outside));
  assert.throws(() => realOutside(REPO_ROOT), /path_inside_repo/);
  assert.throws(() => realOutside(path.join(REPO_ROOT, 'scripts')), /path_inside_repo/);
  assert.throws(() => realOutside(path.join(REPO_ROOT, 'scripts', '..', 'src')), /path_inside_repo/);
  const link = path.join(outside, 'sneaky');
  fs.symlinkSync(path.join(REPO_ROOT, 'src'), link);
  assert.throws(() => realOutside(link), /path_inside_repo/);
  for (const bad of ['', undefined, null, 5, 'a\0b']) assert.throws(() => realOutside(bad), /path_invalid/);
  assert.throws(() => realOutside(path.join(outside, 'does-not-exist')), /path_unreadable/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('results file: parent directory outside the repo, never a symlink, never overwritten', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'val-res-'));
  const ok = resultsPathOutside(path.join(outside, 'result.json'));
  assert.equal(path.dirname(ok), fs.realpathSync(outside));
  assert.throws(() => resultsPathOutside(path.join(REPO_ROOT, 'result.json')), /path_inside_repo/);
  assert.throws(() => resultsPathOutside(path.join(REPO_ROOT, 'docs', 'x.json')), /path_inside_repo/);
  const link = path.join(outside, 'link.json');
  fs.symlinkSync(path.join(REPO_ROOT, 'package.json'), link);
  assert.throws(() => resultsPathOutside(link), /path_symlink/);
  fs.writeFileSync(path.join(outside, 'exists.json'), '{}');
  fs.writeFileSync(path.join(outside, 'x.json'), '{}', { flag: 'wx' });
  assert.throws(() => fs.writeFileSync(path.join(outside, 'x.json'), '{}', { flag: 'wx' }), /EEXIST/); // 'wx' as used by the CLI
  fs.rmSync(outside, { recursive: true, force: true });
});

test('private page directory must not be group/world accessible', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'val-priv-'));
  fs.chmodSync(d, 0o700);
  assert.doesNotThrow(() => assertPrivateDir(d));
  for (const mode of [0o750, 0o755, 0o707, 0o770]) { fs.chmodSync(d, mode); assert.throws(() => assertPrivateDir(d), /dir_not_private/, mode.toString(8)); }
  const f = path.join(d, 'file'); fs.writeFileSync(f, 'x');
  fs.chmodSync(d, 0o700);
  assert.throws(() => assertPrivateDir(f), /not_a_directory/);
  fs.rmSync(d, { recursive: true, force: true });
});
