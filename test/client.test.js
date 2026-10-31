import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createKeyHolder, fileIdOf } from '../public/upload-key.js';

test('idempotency key is kept across failed retries, reset on success or new file', () => {
  let n = 0;
  const h = createKeyHolder(() => `key${++n}`.padEnd(8, 'x'));
  const f1 = fileIdOf({ name: 'a.jpg', size: 10, lastModified: 1 });
  const f2 = fileIdOf({ name: 'b.jpg', size: 10, lastModified: 2 });
  const k = h.forFile(f1);
  assert.equal(h.forFile(f1), k); // failed attempt / lost response -> same key
  assert.equal(h.forFile(f1), k);
  assert.notEqual(h.forFile(f2), k); // different file -> new key
  const k2 = h.forFile(f2);
  h.succeeded();
  assert.notEqual(h.forFile(f2), k2); // after success -> new key
});

test('upload view wires the key holder (no per-render key)', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /keys\.forFile\(/);
  assert.match(src, /keys\.succeeded\(\)/);
  assert.ok(!/crypto\.randomUUID\(\)\.replace/.test(src), 'key must not be generated inside the view');
});

function loadSw(clients) {
  const listeners = {};
  const opened = [];
  const ctx = {
    URL,
    self: {
      location: { origin: 'https://app.example' },
      addEventListener: (n, f) => (listeners[n] = f),
      skipWaiting() {},
      clients: { claim() {}, matchAll: async () => clients, openWindow: async (u) => opened.push(u) },
      registration: { showNotification: async () => {} },
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), ctx);
  return { listeners, opened };
}
const click = async (listeners, id) => {
  const w = [];
  listeners.notificationclick({ notification: { close() {}, data: { id } }, waitUntil: (p) => w.push(p) });
  await Promise.all(w);
};
const ID = '123e4567-e89b-12d3-a456-426614174000';

test('tap with app already open navigates that window', async () => {
  const nav = [];
  const client = { url: 'https://app.example/inbox', focus: async () => {}, navigate: async (u) => nav.push(u) };
  const { listeners, opened } = loadSw([client]);
  await click(listeners, ID);
  assert.deepEqual(nav, [`https://app.example/uploads/${ID}`]);
  assert.equal(opened.length, 0);
});

test('navigate() rejection (uncontrolled client) falls back to openWindow', async () => {
  const client = { url: 'https://app.example/inbox', focus: async () => {}, navigate: async () => { throw new TypeError('uncontrolled'); } };
  const { listeners, opened } = loadSw([client]);
  await click(listeners, ID);
  assert.deepEqual(opened, [`https://app.example/uploads/${ID}`]);
});

test('focus() rejection also falls back; off-origin client ignored', async () => {
  const bad = { url: 'https://app.example/inbox', focus: async () => { throw new Error('x'); }, navigate: async () => {} };
  const foreign = { url: 'https://evil.example/', focus: async () => { throw new Error('must not touch'); } };
  const { listeners, opened } = loadSw([foreign, bad]);
  await click(listeners, ID);
  assert.deepEqual(opened, [`https://app.example/uploads/${ID}`]);
});

test('no clients -> openWindow', async () => {
  const { listeners, opened } = loadSw([]);
  await click(listeners, ID);
  assert.deepEqual(opened, [`https://app.example/uploads/${ID}`]);
});

import { enablePush } from '../public/push-enable.js';

test('permission prompt is requested first, before any slow SW setup await', async () => {
  const order = [];
  let releaseSw;
  const swGate = new Promise((r) => (releaseSw = r));
  const p = enablePush({
    hasPush: true,
    notification: { requestPermission: async () => { order.push('permission'); return 'granted'; } },
    registerSw: async () => { order.push('sw-start'); await swGate; order.push('sw-ready'); return {}; },
    getSubscription: async () => null,
    vapidKey: async () => new Uint8Array(1),
    subscribe: async () => ({ toJSON: () => ({}) }),
    postSubscription: async () => true,
  });
  await new Promise((r) => setImmediate(r)); // SW still pending (slow first install)
  assert.deepEqual(order, ['permission', 'sw-start']);
  releaseSw();
  const r = await p;
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['permission', 'sw-start', 'sw-ready']);
});

test('denied permission skips SW registration and subscription', async () => {
  let touched = false;
  const r = await enablePush({
    hasPush: true,
    notification: { requestPermission: async () => 'denied' },
    registerSw: async () => { touched = true; }, getSubscription: async () => { touched = true; },
    vapidKey: async () => { touched = true; }, subscribe: async () => { touched = true; }, postSubscription: async () => { touched = true; },
  });
  assert.equal(r.ok, false);
  assert.equal(touched, false);
  assert.match(r.msg, /still use this inbox/);
});

test('no push support is reported without prompting', async () => {
  let asked = false;
  const r = await enablePush({ hasPush: false, notification: { requestPermission: async () => { asked = true; } } });
  assert.equal(r.ok, false);
  assert.equal(asked, false);
});

test('app wires enablePush flow module (no permission call after setup awaits)', () => {
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /enablePushFlow\(/);
  assert.ok(!/requestPermission/.test(src), 'permission must only be requested in push-enable.js');
});
