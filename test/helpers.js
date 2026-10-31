import crypto from 'node:crypto';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { createPgliteDb, createPgDb, migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/security.js';

export const PW = 'test-password-123';
export const GOOD_ENDPOINT = 'https://web.push.apple.com/abc123';

export async function makeEnv({ pushSender, real = false } = {}) {
  const config = loadConfig({ INSECURE_COOKIES: '1' });
  config.vapid = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:t@example.com' };
  const db = real ? await createPgDb({ databaseUrl: process.env.TEST_DATABASE_URL, dbSsl: false }) : await createPgliteDb();
  if (real) await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  const calls = [];
  const sender = pushSender || (async (sub, payload) => { calls.push({ sub, payload }); return { statusCode: 201 }; });
  const app = createApp({ db, config, pushSender: async (...a) => { const r = await sender(...a); if (pushSender) calls.push({ sub: a[0], payload: a[1] }); return r; } });
  return { db, config, app, calls };
}

export async function seedFamily(db, tag = 'a') {
  const fid = crypto.randomUUID();
  await db.query('INSERT INTO families (id,name) VALUES ($1,$2)', [fid, tag]);
  const ph = await hashPassword(PW);
  const ids = {};
  for (const role of ['uploader', 'parent1', 'parent2']) {
    ids[role] = crypto.randomUUID();
    await db.query('INSERT INTO users (id,family_id,username,role,password_hash) VALUES ($1,$2,$3,$4,$5)', [ids[role], fid, `${tag}-${role}`, role, ph]);
  }
  return { fid, ids, name: (r) => `${tag}-${r}` };
}

// Minimal cookie-aware agent over supertest.
import request from 'supertest';
export function agent(app) {
  let cookie = '';
  const base = { Origin: 'http://127.0.0.1', Host: '127.0.0.1', 'X-STM-Request': '1' };
  const wrap = (m) => (url) => {
    const r = request(app)[m](url).set('Host', '127.0.0.1');
    if (cookie) r.set('Cookie', cookie);
    if (m !== 'get') r.set('Origin', base.Origin).set('X-STM-Request', '1');
    return r;
  };
  return {
    get: wrap('get'), post: wrap('post'), delete: wrap('delete'),
    raw: (m, url) => wrap(m)(url),
    async login(username, password = PW) {
      const r = await wrap('post')('/api/login').send({ username, password });
      const sc = r.headers['set-cookie']?.[0];
      if (sc) cookie = sc.split(';')[0];
      return r;
    },
    clear() { cookie = ''; },
    get cookie() { return cookie; },
  };
}

export const jpeg = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } }).jpeg().toBuffer();
export const jpegWithGps = async () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#336699' } })
  .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 47/1 0/1' } }).jpeg().toBuffer();
export const key = () => crypto.randomBytes(12).toString('hex');
export const sub = (endpoint = GOOD_ENDPOINT) => ({ endpoint, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } });
