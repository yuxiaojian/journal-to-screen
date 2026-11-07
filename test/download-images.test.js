import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeEnv, seedFamily, agent, jpeg, key, PW } from './helpers.js';
import { downloadImages, validateBaseUrl } from '../scripts/download-images.js';

const real = !!process.env.TEST_DATABASE_URL;
const S = real ? 'PG' : 'pglite';

async function setup(t) {
  const env = await makeEnv({ real });
  const fam = await seedFamily(env.db, 'a');
  const other = await seedFamily(env.db, 'b');
  const up = agent(env.app);
  await up.login(fam.name('uploader'));
  const server = env.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-images-'));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(outDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { ...env, fam, other, up, outDir, baseUrl };
}
const upload = async (a) => (await a.post('/api/uploads').field('key', key()).attach('photo', await jpeg(), 'p.jpg')).body.id;

test(`[${S}] image download: saves new photos privately, skips existing ones, signs out`, async (t) => {
  const e = await setup(t);
  const id = await upload(e.up);
  const opts = { baseUrl: e.baseUrl, username: e.fam.name('parent1'), password: PW, outDir: e.outDir };

  const first = await downloadImages(opts);
  assert.equal(first.saved.length, 1);
  assert.equal(first.skipped, 0);
  assert.ok(first.saved[0].includes(id));
  const file = path.join(e.outDir, first.saved[0]);
  const stored = (await e.db.query('SELECT image FROM uploads WHERE id = $1', [id])).rows[0].image;
  assert.deepEqual(await fs.readFile(file), Buffer.from(stored));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const id2 = await upload(e.up);
  const second = await downloadImages(opts);
  assert.equal(second.saved.length, 1);
  assert.ok(second.saved[0].includes(id2));
  assert.equal(second.skipped, 1);

  const parentSessions = await e.db.query(
    "SELECT count(*)::int n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.role = 'parent1'",
  );
  assert.equal(parentSessions.rows[0].n, 0); // every run signed out
});

test(`[${S}] image download: reads past the first page of the list`, async (t) => {
  const e = await setup(t);
  const id = await upload(e.up);
  for (let i = 1; i < 55; i++) {
    await e.db.query(
      `INSERT INTO uploads (id, family_id, uploader_id, idempotency_key, image, content_type, byte_size, created_at, expires_at)
       SELECT $1, family_id, uploader_id, $2, image, content_type, byte_size, created_at - ($3::int * interval '1 minute'), expires_at FROM uploads WHERE id = $4`,
      [crypto.randomUUID(), key(), i, id],
    );
  }
  const r = await downloadImages({ baseUrl: e.baseUrl, username: e.fam.name('parent1'), password: PW, outDir: e.outDir });
  assert.equal(r.saved.length, 55);
});

test(`[${S}] image download: only a parent of that family gets photos`, async (t) => {
  const e = await setup(t);
  await upload(e.up);
  const base = { baseUrl: e.baseUrl, outDir: e.outDir };
  await assert.rejects(downloadImages({ ...base, username: e.fam.name('uploader'), password: PW }), /parent login/);
  await assert.rejects(downloadImages({ ...base, username: e.fam.name('parent1'), password: 'wrong' }), /login failed \(401\)/);
  const other = await downloadImages({ ...base, username: e.other.name('parent1'), password: PW });
  assert.equal(other.saved.length, 0);
  assert.deepEqual(await fs.readdir(e.outDir), []);
});

test('image download: a password is never sent over plain http to another host', () => {
  assert.equal(validateBaseUrl('https://example.com/inbox'), 'https://example.com');
  assert.equal(validateBaseUrl('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.throws(() => validateBaseUrl('http://example.com'), /https/);
});
