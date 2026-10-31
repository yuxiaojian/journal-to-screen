import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider, ProviderError, TOOL_NAME, SYSTEM_PROMPT, TOOL, IMAGE_LONG_EDGE } from '../src/ai.js';
import { loadConfig } from '../src/config.js';

const KEY = 'sk-test-not-a-real-key';
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new Error('bad json'); return body; } });
const mk = (fetchImpl) => createAnthropicProvider({ apiKey: KEY, model: 'claude-haiku-5-5', maxOutputTokens: 4096, timeoutMs: 40, fetchImpl });
const tool = (input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: TOOL_NAME, input }] });
const img = { imageBase64: 'AAAA', mediaType: 'image/jpeg' };

test('request shape: forced single tool, inline base64 image, no thinking/tools/history/server features, key only in header', async () => {
  let seen;
  const p = mk(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return resp(200, tool({ transcript: 'hi', illegible_count: 0, page_issues: [] })); });
  const out = await p.analyze(img);
  assert.deepEqual(out, { transcript: 'hi', illegible_count: 0, page_issues: [] });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['x-api-key'], KEY);
  assert.equal(seen.init.headers['anthropic-version'], '2023-06-01');
  const b = seen.body;
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.equal(b.max_tokens, 4096);
  assert.deepEqual(b.tool_choice, { type: 'tool', name: TOOL_NAME });
  assert.deepEqual(b.tools, [TOOL]);
  assert.equal(b.system, SYSTEM_PROMPT);
  assert.equal(b.messages.length, 1); // no history
  assert.deepEqual(b.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  for (const k of ['thinking', 'stream', 'metadata', 'container', 'mcp_servers']) assert.equal(k in b, false, k);
  assert.ok(!JSON.stringify(b).includes(KEY)); // the key is never in the body
  assert.ok(!JSON.stringify(b).includes('http')); // image sent inline, no public URL / Files API reference
});

test('failure mapping: transient statuses are retryable+unknown, 4xx is final, truncation/refusal/no-tool/multi-tool are final failures', async () => {
  const cases = [
    [resp(429), 'http_429', true], [resp(500), 'http_500', true], [resp(529), 'http_529', true], [resp(503), 'http_503', true],
    [resp(400), 'http_400', false], [resp(401), 'http_401', false], [resp(413), 'http_413', false],
    [resp(200, { stop_reason: 'max_tokens', content: [] }), 'truncated', false],
    [resp(200, { stop_reason: 'refusal', content: [] }), 'refused', false],
    [resp(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'free text' }] }), 'no_tool_call', false],
    [resp(200, { content: [{ type: 'tool_use', name: 'other_tool', input: {} }] }), 'no_tool_call', false],
    [resp(200, { content: [{ type: 'tool_use', name: TOOL_NAME, input: {} }, { type: 'tool_use', name: TOOL_NAME, input: {} }] }), 'no_tool_call', false],
    [resp(200, undefined), 'bad_response', false],
    [resp(200, null), 'no_tool_call', false],
  ];
  for (const [r, code, retryable] of cases) {
    await assert.rejects(mk(async () => r).analyze(img), (e) => e instanceof ProviderError && e.code === code && e.retryable === retryable, code);
  }
  // 4xx never reached processing: outcome is known
  await assert.rejects(mk(async () => resp(400)).analyze(img), (e) => e.unknownOutcome === false);
  // timeouts and network errors are retryable and the outcome is unknown
  const slow = mk((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))));
  await assert.rejects(slow.analyze(img), (e) => e.code === 'timeout' && e.retryable && e.unknownOutcome);
  await assert.rejects(mk(async () => { throw new TypeError('fetch failed'); }).analyze(img), (e) => e.code === 'network' && e.retryable && e.unknownOutcome);
});

test('errors never carry the key, the request or the response body', async () => {
  const leaky = mk(async () => resp(500, { error: { message: `secret ${KEY} transcript text` } }));
  try { await leaky.analyze(img); assert.fail('should throw'); } catch (e) {
    assert.ok(e instanceof ProviderError);
    assert.ok(!String(e.message + e.stack).includes(KEY));
    assert.ok(!String(e.message).includes('transcript'));
  }
});

test('provider cannot be built without a key, and AI config defaults are off', () => {
  assert.throws(() => createAnthropicProvider({ apiKey: '', model: 'm', maxOutputTokens: 1, timeoutMs: 1 }), /missing/);
  const c = loadConfig({});
  assert.equal(c.ai.enabled, false);
  assert.equal(c.ai.apiKey, null);
  assert.equal(c.ai.model, 'claude-haiku-5-5');
  assert.equal(c.ai.maxAttempts, 2);
  assert.equal(c.ai.monthlyCapMicro, 5_000_000);
  assert.equal(loadConfig({ AI_ENABLED: '1', ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).ai.model, 'claude-sonnet-5-5'); // model is config; pricing gate blocks it
  assert.equal(c.limits.maxEdge, IMAGE_LONG_EDGE);
});

import sharp from 'sharp';
import { processImage } from '../src/images.js';

test('stored/sent image long edge is capped at 1568 for any orientation, so the visual-token bound holds', async () => {
  const cfg = loadConfig({});
  for (const [w, h] of [[4000, 3000], [3000, 4000], [1568, 1568], [2000, 100], [100, 2000], [800, 600]]) {
    const buf = await sharp({ create: { width: w, height: h, channels: 3, background: '#808080' } }).jpeg().toBuffer();
    const out = await processImage(buf, cfg.limits);
    const m = await sharp(out.data).metadata();
    assert.ok(Math.max(m.width, m.height) <= IMAGE_LONG_EDGE, `${w}x${h} -> ${m.width}x${m.height}`);
    assert.ok(Math.ceil(m.width / 28) * Math.ceil(m.height / 28) <= Math.ceil(IMAGE_LONG_EDGE / 28) ** 2);
    assert.equal(m.exif, undefined);
  }
});

test('server startup: AI stays off without a key or with an unusable model; never throws, never dispatches', async () => {
  const { spawnSync } = await import('node:child_process');
  const runMod = (extra) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { loadConfig } = await import('./src/config.js');
    const { validateAiConfig } = await import('./src/ai.js');
    const c = loadConfig(process.env);
    const check = validateAiConfig(c.ai);
    console.log(JSON.stringify({ enabled: c.ai.enabled, hasKey: !!c.ai.apiKey, ok: check.ok, reason: check.reason }));
  `], { env: { PATH: process.env.PATH, ...extra }, cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  const a = JSON.parse(runMod({}).stdout);
  assert.deepEqual([a.enabled, a.hasKey], [false, false]);
  const b = JSON.parse(runMod({ AI_ENABLED: '1' }).stdout);
  assert.deepEqual([b.enabled, b.hasKey, b.ok], [true, false, true]); // enabled but no key: server.js refuses to build a provider
  const c = JSON.parse(runMod({ AI_ENABLED: '1', ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'claude-sonnet-5-5' }).stdout);
  assert.deepEqual([c.ok, c.reason], [false, 'model_not_priced']);
});

test('server.js wiring refuses to build a provider unless enabled AND keyed AND validated', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /if \(config\.ai\.enabled\)/);
  assert.match(src, /!config\.ai\.apiKey \|\| !check\.ok/);
  assert.match(src, /AI stays off/);
  // The key may only be used as a truthiness check in a log line; its value must never be interpolated into output.
  const logged = [...src.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)].map((m) => m[1]);
  for (const l of logged) assert.ok(!/\$\{\s*config\.ai\.apiKey\s*\}/.test(l) && !/\$\{[^}]*process\.env\.ANTHROPIC/.test(l), `log line may expose the key: ${l.slice(0, 60)}`);
  assert.ok(logged.length >= 4);
  const jobs = fs.readFileSync(new URL('../src/jobs.js', import.meta.url), 'utf8');
  assert.match(jobs, /ai\.enabled === true && check\.ok && !!provider/);
});
