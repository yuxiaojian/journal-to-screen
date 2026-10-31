import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

test('manifest is installable-shaped', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/inbox');
  assert.ok(m.icons.some((i) => i.sizes === '180x180'));
  for (const i of m.icons) assert.ok(fs.existsSync(new URL(`../public${i.src}`, import.meta.url)));
});

test('service worker: no caching, generic payload, same-origin click routing', async () => {
  const src = read('sw.js');
  assert.ok(!/caches\.|cache\.put|fetch\s*\(/.test(src), 'SW must not cache or intercept');
  const listeners = {};
  const shown = [];
  const opened = [];
  const ctx = {
    URL, self: {
      location: { origin: 'https://app.example' },
      addEventListener: (n, f) => (listeners[n] = f),
      skipWaiting() {}, clients: { claim() {}, matchAll: async () => [], openWindow: async (u) => opened.push(u) },
      registration: { showNotification: async (t, o) => shown.push([t, o]) },
    },
  };
  vm.runInNewContext(src, ctx);
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const wait = [];
  listeners.push({ data: { json: () => ({ id, title: 'x', secret: 'child' }) }, waitUntil: (p) => wait.push(p) });
  await Promise.all(wait);
  assert.equal(shown[0][0], 'New upload ready');
  assert.equal(shown[0][1].data.id, id);
  assert.ok(!JSON.stringify(shown).includes('child'));
  // malicious id -> falls back to /inbox, never off-origin
  const w2 = [];
  listeners.notificationclick({ notification: { close() {}, data: { id: 'https://evil.example/x' } }, waitUntil: (p) => w2.push(p) });
  await Promise.all(w2);
  assert.equal(opened.at(-1), 'https://app.example/inbox');
  const w3 = [];
  listeners.notificationclick({ notification: { close() {}, data: { id } }, waitUntil: (p) => w3.push(p) });
  await Promise.all(w3);
  assert.equal(opened.at(-1), `https://app.example/uploads/${id}`);
});
