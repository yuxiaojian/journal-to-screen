import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUploadFlow, friendlyError, canRetry, STATUS } from '../public/upload-flow.js';

function harness(results = []) {
  const sends = [];
  const states = [];
  let n = 0;
  let release;
  const gate = { hold: false };
  const flow = createUploadFlow({
    keyGen: () => `key${++n}`.padEnd(10, 'x'),
    prepare: async (f) => `prepared:${f.name}`,
    send: async (body, key) => {
      sends.push({ body, key });
      if (gate.hold) await new Promise((r) => { release = r; });
      const r = results.shift() ?? { ok: true, status: 201, body: { id: 'u1' } };
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (s) => states.push(s.status),
  });
  return { flow, sends, states, gate, release: () => release() };
}
const file = (name) => ({ name, size: 1, lastModified: 1 });

test('camera selection uploads at once; library selection waits for an explicit upload', async () => {
  const h = harness();
  assert.equal(await h.flow.select(file('cam.jpg'), 'camera'), true);
  assert.equal(h.sends.length, 1);
  assert.equal(h.flow.state.status, STATUS.DONE);
  h.flow.select(file('lib.jpg'), 'library');
  assert.equal(h.sends.length, 1);
  assert.equal(h.flow.state.status, STATUS.SELECTED);
  await h.flow.upload();
  assert.equal(h.sends.length, 2);
  assert.notEqual(h.sends[0].key, h.sends[1].key);
});

test('a cancelled picker sends nothing and keeps a retryable failure', async () => {
  const h = harness([{ ok: false, status: 0, body: { error: 'network' } }]);
  await h.flow.select(file('a.jpg'), 'camera');
  assert.equal(h.flow.state.status, STATUS.FAILED);
  const key = h.flow.state.key;
  assert.equal(h.flow.select(null, 'camera'), false);
  assert.equal(h.flow.select(undefined, 'library'), false);
  assert.equal(h.sends.length, 1);
  assert.equal(h.flow.state.status, STATUS.FAILED);
  assert.equal(h.flow.state.key, key);
  await h.flow.retry();
  assert.equal(h.sends.length, 2);
  assert.equal(h.sends[1].key, key);
  assert.equal(h.sends[1].body, 'prepared:a.jpg');
});

test('failure and thrown errors keep the same photo and key for retry; success clears them', async () => {
  const h = harness([new Error('offline'), { ok: false, status: 503, body: {} }]);
  await h.flow.select(file('a.jpg'), 'camera');
  assert.equal(h.flow.state.error, 'network');
  await h.flow.retry();
  assert.equal(h.flow.state.error, 'http_503');
  await h.flow.retry();
  assert.equal(h.flow.state.status, STATUS.DONE);
  assert.deepEqual(h.sends.map((s) => s.key), [h.sends[0].key, h.sends[0].key, h.sends[0].key]);
  assert.equal(h.flow.state.file, null);
  assert.equal(h.flow.state.key, null);
  assert.equal(await h.flow.retry(), false);
});

test('choosing the same photo again after success is a new upload with a new key', async () => {
  const h = harness();
  const f = file('same.jpg');
  await h.flow.select(f, 'camera');
  await h.flow.select(f, 'camera');
  assert.equal(h.sends.length, 2);
  assert.notEqual(h.sends[0].key, h.sends[1].key);
});

test('a replacement after a failure gets a new key', async () => {
  const h = harness([{ ok: false, status: 0, body: { error: 'network' } }]);
  await h.flow.select(file('a.jpg'), 'camera');
  const k1 = h.flow.state.key;
  h.flow.select(file('b.jpg'), 'library');
  assert.notEqual(h.flow.state.key, k1);
  await h.flow.upload();
  assert.equal(h.sends[1].body, 'prepared:b.jpg');
});

test('single flight: while preparing or sending, new selections, uploads and retries are ignored', async () => {
  const h = harness();
  h.gate.hold = true;
  const first = h.flow.select(file('a.jpg'), 'camera');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.flow.state.status, STATUS.UPLOADING);
  assert.equal(h.flow.select(file('b.jpg'), 'camera'), false);
  assert.equal(await h.flow.upload(), false);
  assert.equal(await h.flow.retry(), false);
  assert.equal(h.sends.length, 1);
  h.release();
  await first;
  assert.equal(h.flow.state.status, STATUS.DONE);
  assert.equal(h.sends.length, 1);
});

test('a prepare failure is reported without sending, and the photo stays selected', async () => {
  const sends = [];
  const flow = createUploadFlow({ prepare: async () => { throw new Error('bad image'); }, send: async (...a) => { sends.push(a); return { ok: true }; } });
  await flow.select(file('a.jpg'), 'camera');
  assert.equal(flow.state.status, STATUS.FAILED);
  assert.equal(flow.state.error, 'prepare_failed');
  assert.equal(sends.length, 0);
  assert.ok(flow.state.file);
});

test('error codes map to plain language; codes never leak; permanent errors are not offered as retry', () => {
  for (const code of ['unsupported_format', 'daily_limit', 'request_too_large', 'image_too_large_dimensions', 'network', 'http_500', 'weird_code', undefined]) {
    const m = friendlyError(code);
    assert.ok(m.length > 10);
    if (code) assert.ok(!m.includes(code), `${code} leaked`);
  }
  assert.match(friendlyError('unsupported_format'), /JPEG or PNG/);
  assert.equal(canRetry('network'), true);
  assert.equal(canRetry('http_503'), true);
  assert.equal(canRetry('daily_limit'), false);
  assert.equal(canRetry('unsupported_format'), false);
});

test('nothing about the photo or key is persisted in the browser', () => {
  for (const f of ['upload-flow.js', 'app.js', 'upload-key.js']) {
    const src = fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.ok(!/localStorage|sessionStorage|indexedDB|caches\./.test(src), f);
  }
});

test('no inline styles in the app shell (the CSP would silently drop them)', () => {
  for (const f of ['app.js', 'index.html']) {
    const src = fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.ok(!/style=/.test(src), `${f} contains an inline style attribute`);
    assert.ok(!/<style/.test(src), `${f} contains a style element`);
  }
});
