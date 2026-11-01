// Playwright fixtures for the black-box suite. Each test gets its own fresh database, its own fake AI/push services and
// its own server process(es). Setup may use SQL (seeding users, preconditioning time/budget state); assertions use
// only HTTP responses, the browser, and what the fake services received.
import crypto from 'node:crypto';
import { test as base, expect } from '@playwright/test';
import sharp from 'sharp';
import { createDb, dropDb, withDb } from './pg.mjs';
import { startFakes } from './fakes.mjs';
import { startServer } from './server.mjs';
import { makeSubscriptionKeys, makeVapidKeys, decryptAes128gcm } from './webpush-decrypt.mjs';

export { expect };
export const PASSWORD = 'bb-synthetic-password-1';

// The documented stored-hash format: scrypt$<16-byte salt, base64>$<64-byte key, base64> (Node scrypt defaults).
function scryptHash(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function pngPage(seed = 1) {
  const w = 600; const h = 800;
  const raw = Buffer.alloc(w * h * 3, 255);
  for (let i = 0; i < 4000; i += 1) raw[((seed * 7919 + i * 104729) % (w * h)) * 3] = 0;
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

export async function waitFor(fn, { timeout = 30_000, interval = 250, what = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const test = base.extend({
  bb: async ({ playwright }, use) => {
    const adminUrl = process.env.BB_PG_URL;
    if (!adminUrl) throw new Error('BB_PG_URL is not set: run the suite with `npm run test:bb` or `npm run test:all`');
    const db = await createDb(adminUrl);
    const fakes = await startFakes();
    const vapid = makeVapidKeys();
    const servers = [];
    const contexts = [];

    const bb = {
      fakes,
      dbUrl: db.url,
      sql: (q, params) => withDb(db.url, (c) => c.query(q, params)),

      async start({ ai = false, https, extraEnv } = {}) {
        const s = await startServer({ dbUrl: db.url, fakeUrl: fakes.url, vapid, ai, https, extraEnv });
        servers.push(s);
        return s;
      },

      async restart(server, opts) {
        await server.kill('SIGKILL');
        return bb.start(opts);
      },

      // Fixture-only: users are created directly, as the owner's private seeding script would.
      async seedFamily(tag) {
        const fid = crypto.randomUUID();
        await bb.sql('INSERT INTO families (id, name) VALUES ($1, $2)', [fid, `family-${tag}`]);
        const users = {};
        for (const role of ['uploader', 'parent1', 'parent2']) {
          const username = `${tag}-${role}`;
          await bb.sql('INSERT INTO users (id, family_id, username, role, password_hash) VALUES ($1,$2,$3,$4,$5)',
            [crypto.randomUUID(), fid, username, role, scryptHash(PASSWORD)]);
          users[role] = username;
        }
        return users;
      },

      // A same-origin client like the app's own front end (custom header + Origin), with its own cookie jar.
      async client(server, { csrfHeaders = true } = {}) {
        const ctx = await playwright.request.newContext({
          baseURL: server.base,
          extraHTTPHeaders: csrfHeaders ? { Origin: server.base, 'X-STM-Request': '1' } : {},
          maxRedirects: 0,
        });
        contexts.push(ctx);
        return ctx;
      },

      async login(server, username) {
        const c = await bb.client(server);
        const r = await c.post('/api/login', { data: { username, password: PASSWORD } });
        expect(r.status(), `login ${username}`).toBe(200);
        return c;
      },

      // Registers a Web Push subscription through the public API, with real keys so payloads can be decrypted.
      async subscribe(client) {
        const keys = makeSubscriptionKeys();
        const path = `/bb/${crypto.randomBytes(8).toString('hex')}`;
        const endpoint = `https://web.push.apple.com${path}`;
        const r = await client.post('/api/subscriptions', { data: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.authB64 } } });
        expect(r.status(), 'subscribe').toBe(201);
        return {
          path,
          endpoint,
          received: () => fakes.pushesTo(path),
          decrypt: (push) => JSON.parse(decryptAes128gcm(push.body, keys)),
        };
      },

      async upload(client, { key = crypto.randomBytes(12).toString('hex'), seed = 1 } = {}) {
        const buffer = await pngPage(seed);
        const r = await client.post('/api/uploads', { multipart: { key, photo: { name: 'page.png', mimeType: 'image/png', buffer } } });
        return { status: r.status(), body: await r.json().catch(() => ({})), key };
      },

      async journal(client, id) {
        const r = await client.get(`/api/uploads/${id}`);
        return r.ok() ? (await r.json()) : { status: r.status() };
      },

      async waitTerminal(client, id, { timeout = 30_000 } = {}) {
        return waitFor(async () => {
          const d = await bb.journal(client, id);
          const st = d?.journal?.status;
          return st && ['ready', 'needs_review', 'failed'].includes(st) ? d : null;
        }, { timeout, what: `terminal analysis for ${id}` });
      },
    };

    await use(bb);

    for (const c of contexts) await c.dispose().catch(() => {});
    const blocked = servers.flatMap((s) => s.egressBlocked());
    for (const s of servers) await s.kill('SIGKILL').catch(() => {});
    await fakes.close().catch(() => {});
    await dropDb(adminUrl, db.name).catch(() => {});
    expect(blocked, 'server attempted non-loopback egress').toEqual([]);
  },
});

// Browser contexts may only talk to loopback; anything else is aborted and fails the test.
export async function guardedBrowserContext(browser, extra = {}) {
  const context = await browser.newContext(extra);
  const blocked = [];
  await context.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  return { context, blocked };
}
