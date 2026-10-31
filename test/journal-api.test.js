import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournalEnv, mockProvider, okOut, upload, rowOf, words } from './journal-helpers.js';
import { agent } from './helpers.js';

const real = !!process.env.TEST_DATABASE_URL;
const S = real ? 'PG' : 'pglite';
const done = async (opts = {}) => {
  const t = await makeJournalEnv({ real, provider: mockProvider([opts.out || okOut(70)]) });
  const r = await upload(t.up);
  await t.jobs.drain();
  return { t, id: r.body.id };
};
const fix = (t, id, a, text, version) => a.post(`/api/uploads/${id}/correction`).send({ transcript: text, version });

test(`[${S}] correction: original preserved, count and tier recomputed server-side, expiry not extended`, async () => {
  const { t, id } = await done({ out: okOut(70) });
  const before = await rowOf(t.db, id);
  const exp1 = (await t.db.query('SELECT expires_at FROM uploads WHERE id = $1', [id])).rows[0].expires_at;
  const r = await fix(t, id, t.p1, words(120), before.version);
  assert.equal(r.status, 200);
  const j = r.body.journal;
  assert.deepEqual([j.original.wordCount, j.original.suggestedMinutes], [70, 45]); // original untouched
  assert.deepEqual([j.corrected.wordCount, j.corrected.suggestedMinutes], [120, 60]);
  assert.equal(j.version, before.version + 1);
  const a = await rowOf(t.db, id);
  assert.equal(a.transcript, before.transcript);
  assert.equal(a.corrected_by, t.fam.ids.parent1);
  assert.ok(a.corrected_at);
  const exp2 = (await t.db.query('SELECT expires_at FROM uploads WHERE id = $1', [id])).rows[0].expires_at;
  assert.equal(new Date(exp2).getTime(), new Date(exp1).getTime()); // correction never renews the 7 days
  assert.equal(t.pushes.length, 2); // correction does not send another push
  // a later correction replaces the corrected columns only
  const r2 = await fix(t, id, t.p2, words(45), j.version);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.journal.corrected.wordCount, 45);
  assert.equal(r2.body.journal.original.wordCount, 70);
});

test(`[${S}] simultaneous parent edits: the second with a stale version gets 409 and changes nothing`, async () => {
  const { t, id } = await done();
  const v = (await rowOf(t.db, id)).version;
  const [a, b] = await Promise.all([fix(t, id, t.p1, words(80), v), fix(t, id, t.p2, words(130), v)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.error, 'version_conflict');
  const row = await rowOf(t.db, id);
  assert.ok([80, 130].includes(row.corrected_word_count));
  assert.equal((await fix(t, id, t.p1, words(90), v)).status, 409); // stale again
});

test(`[${S}] correction validation: bad types, control characters, too long, missing version; state must allow correction`, async () => {
  const { t, id } = await done();
  const v = (await rowOf(t.db, id)).version;
  for (const body of [{}, { transcript: 5, version: v }, { transcript: 'a', version: 'x' }, { transcript: 'a', version: 1.5 }, { transcript: 'a\u0001', version: v }, { transcript: 'a'.repeat(20001), version: v }]) {
    assert.equal((await t.p1.post(`/api/uploads/${id}/correction`).send(body)).status, 400, JSON.stringify(body).slice(0, 50));
  }
  // out-of-range or hostile versions are rejected cleanly, never a 500
  for (const version of [0, -1, 99999999999, 2 ** 53, Number.MAX_VALUE]) assert.equal((await t.p1.post(`/api/uploads/${id}/correction`).send({ transcript: 'a', version })).status, 400, String(version));
  // a maximum-length transcript is accepted by the body parser (limit is per-route); above the cap is 400; far above is 413
  const max = await fix(t, id, t.p1, 'a '.repeat(10000).trim(), v);
  assert.equal(max.status, 200);
  assert.equal((await t.p1.post(`/api/uploads/${id}/correction`).send({ transcript: 'a'.repeat(200000), version: v + 1 })).status, 413);
  assert.equal((await t.p1.post(`/api/uploads/${id}/correction`).set('Content-Type', 'application/json').send('{bad json')).status, 400);
  const row0 = await rowOf(t.db, id);
  const e = await fix(t, id, t.p1, '', row0.version); // an empty correction is allowed and is flagged for review, not a silent zero
  assert.equal(e.status, 200);
  assert.deepEqual([e.body.journal.corrected.wordCount, e.body.journal.corrected.suggestedMinutes], [0, 0]);
  assert.ok(e.body.journal.corrected.flags.includes('empty_transcript'));
  // failed / processing analyses cannot be corrected
  const f = await makeJournalEnv({ real, provider: mockProvider([new Error('x')]) });
  const r = await upload(f.up);
  assert.equal((await fix(f, r.body.id, f.p1, 'hello', 1)).status, 409);
});

test(`[${S}] correction is parent-only and family-scoped; uploader and other families are refused`, async () => {
  const { t, id } = await done();
  const v = (await rowOf(t.db, id)).version;
  assert.equal((await fix(t, id, t.up, words(90), v)).status, 403);
  assert.equal((await fix(t, id, agent(t.app), words(90), v)).status, 401);
  const ob = agent(t.app);
  await ob.login(t.other.name('parent1'));
  assert.equal((await fix(t, id, ob, words(90), v)).status, 404);
  assert.equal((await ob.post(`/api/uploads/${id}/retry`).send({})).status, 404);
  assert.equal((await rowOf(t.db, id)).corrected_at, null);
});

test(`[${S}] access: other family sees nothing of an analysis; uploader only sees coarse status; list leaks no text`, async () => {
  const { t, id } = await done({ out: { transcript: 'my secret diary entry ' + words(60), illegible_count: 0, page_issues: [] } });
  const ob = agent(t.app), ou = agent(t.app);
  await ob.login(t.other.name('parent1')); await ou.login(t.other.name('uploader'));
  for (const a of [ob, ou]) assert.equal((await a.get(`/api/uploads/${id}`)).status, 404);
  assert.deepEqual((await ob.get('/api/uploads')).body.uploads, []);
  const child = await t.up.get(`/api/uploads/${id}`);
  assert.deepEqual(child.body.journal, { state: 'sent' });
  assert.ok(!JSON.stringify(child.body).includes('secret'));
  const list = await t.p1.get('/api/uploads');
  assert.ok(!JSON.stringify(list.body).includes('secret'));
  assert.equal(list.body.uploads[0].analysis_status, 'ready');
  assert.equal(list.body.uploads[0].suggested_minutes, 45);
  const parent = await t.p1.get(`/api/uploads/${id}`);
  assert.ok(parent.body.journal.original.transcript.includes('secret'));
  assert.match(parent.headers['cache-control'], /no-store/);
});

test(`[${S}] the uploader sees only a coarse state while processing, and never any analysis fields`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  const r = await upload(t.up);
  const during = await t.up.get(`/api/uploads/${r.body.id}`);
  assert.deepEqual(during.body.journal, { state: 'processing' });
  assert.deepEqual(Object.keys(during.body).sort(), ['journal', 'upload']);
});

test(`[${S}] no private derivative survives expiry: reads 404 after expiry even before cleanup runs`, async () => {
  const { t, id } = await done();
  await t.db.query("UPDATE uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [id]);
  for (const a of [t.p1, t.p2, t.up]) assert.equal((await a.get(`/api/uploads/${id}`)).status, 404);
  assert.equal((await t.p1.get(`/api/uploads/${id}/image`)).status, 404);
  assert.equal((await fix(t, id, t.p1, 'hello there', 2)).status, 404);
  assert.equal((await t.p1.post(`/api/uploads/${id}/retry`).send({})).status, 404);
});

test(`[${S}] POC regressions still hold with AI on: idempotent upload, validation rejects leave no rows, parents-only image`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60), okOut(60)]) });
  const { jpeg } = await import('./helpers.js');
  const buf = await jpeg();
  const k = 'idem-key-12345678';
  const a = await t.up.post('/api/uploads').field('key', k).attach('photo', buf, 'p.jpg');
  const b = await t.up.post('/api/uploads').field('key', k).attach('photo', buf, 'p.jpg');
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 1);
  const bad = await t.up.post('/api/uploads').field('key', 'another-key-123456').attach('photo', Buffer.from('not an image'), 'p.jpg');
  assert.equal(bad.status, 400);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 1);
  assert.equal((await t.up.get(`/api/uploads/${a.body.id}/image`)).status, 403);
  assert.equal((await t.p1.get(`/api/uploads/${a.body.id}/image`)).status, 200);
});

test(`[${S}] only image bytes and the fixed prompt reach the provider: no family id, no usernames`, async () => {
  const provider = mockProvider([okOut(60)]);
  const t = await makeJournalEnv({ real, provider });
  await upload(t.up);
  await t.jobs.drain();
  const sent = provider.calls[0];
  assert.deepEqual(Object.keys(sent).sort(), ['imageBase64', 'mediaType']);
  assert.equal(sent.mediaType, 'image/jpeg');
  assert.ok(!JSON.stringify(sent).includes(t.fam.fid));
});
