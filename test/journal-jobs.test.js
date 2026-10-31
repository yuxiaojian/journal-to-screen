import test from 'node:test';
import assert from 'node:assert/strict';
import { makeJournalEnv, mockProvider, okOut, upload, rowOf, budget, words, ProviderError } from './journal-helpers.js';
import { monthKey } from '../src/jobs.js';

const real = !!process.env.TEST_DATABASE_URL;
const S = real ? 'PG' : 'pglite';
const sendsFor = async (db, uploadId) => (await db.query('SELECT status, round FROM sends WHERE upload_id = $1 ORDER BY round, created_at', [uploadId])).rows;

test(`[${S}] AI disabled by default: no analysis row, POC behavior (immediate push) unchanged, provider never called`, async () => {
  const t = await makeJournalEnv({ real, aiEnabled: false });
  assert.equal(t.jobs.active, false);
  const r = await upload(t.up);
  assert.equal(r.status, 201);
  assert.equal(r.body.sends.length, 2); // POC behavior
  assert.equal((await t.db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 0);
  assert.equal(await t.jobs.runOnce(), false);
  assert.equal(t.provider.calls.length, 0);
  assert.equal((await t.p1.post(`/api/uploads/${r.body.id}/retry`).send({})).status, 409);
});

test(`[${S}] missing key or unpriced model keeps the runner inert even when enabled`, async () => {
  const bad = await makeJournalEnv({ real, mutate: (c) => { c.ai.model = 'claude-unpriced-9'; } });
  assert.equal(bad.jobs.active, false);
  const r = await upload(bad.up);
  assert.equal(r.status, 201);
  assert.equal(await bad.jobs.runOnce(), false);
  assert.equal(bad.provider.calls.length, 0);
  assert.equal((await budget(bad.db)).length, 0);
});

test(`[${S}] happy path: atomic upload+queued, 201 returns at once with no push, one terminal push, parent sees data, child sees status only`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(75)]) });
  const r = await upload(t.up);
  assert.equal(r.status, 201);
  assert.equal(r.body.state, 'processing');
  assert.deepEqual(r.body.sends, []);
  assert.equal((await rowOf(t.db, r.body.id)).status, 'queued');
  assert.equal(t.pushes.length, 0); // no push at upload time
  await t.jobs.drain();
  const a = await rowOf(t.db, r.body.id);
  assert.equal(a.status, 'ready');
  assert.deepEqual([a.word_count, a.suggested_minutes, a.attempts, a.count_version, a.prompt_version, a.model_id], [75, 45, 1, 'count_v1', 'prompt_v1', 'claude-haiku-5-5']);
  assert.equal(t.pushes.length, 2); // one generic notice per parent subscription
  for (const p of t.pushes) assert.deepEqual(Object.keys(p.payload).sort(), ['id', 'title', 'v']);
  const view = await t.p1.get(`/api/uploads/${r.body.id}`);
  assert.equal(view.body.journal.original.suggestedMinutes, 45);
  assert.equal(view.body.journal.original.wordCount, 75);
  assert.equal(view.body.journal.provisional, false);
  const child = await t.up.get(`/api/uploads/${r.body.id}`);
  assert.deepEqual(child.body.journal, { state: 'sent' });
  assert.ok(!JSON.stringify(child.body).includes('word'));
  assert.equal((await t.up.get(`/api/uploads/${r.body.id}/image`)).status, 403);
});

test(`[${S}] needs_review shows a provisional suggestion; push body never carries text or minutes`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([{ transcript: words(60) + ' [?]', illegible_count: 1, page_issues: [] }]) });
  const r = await upload(t.up);
  await t.jobs.drain();
  assert.equal((await rowOf(t.db, r.body.id)).status, 'needs_review');
  const v = (await t.p1.get(`/api/uploads/${r.body.id}`)).body.journal;
  assert.equal(v.provisional, true);
  assert.equal(v.original.suggestedMinutes, 45);
  assert.ok(v.original.flags.includes('illegible_marker'));
  // Check fields, not substrings: the opaque id is a random UUID that can contain digits like "45" by chance.
  for (const p of t.pushes) {
    assert.deepEqual(Object.keys(p.payload).sort(), ['id', 'title', 'v']);
    assert.equal(p.payload.title, 'New upload ready');
    assert.match(p.payload.id, /^[0-9a-f-]{36}$/);
  }
});

test(`[${S}] invalid / refused / truncated / partial model output is a failure, never an accepted result`, async () => {
  for (const out of [{ transcript: 'x' }, { ...okOut(60), extra: 1 }, { transcript: 'a [?]', illegible_count: 0, page_issues: [] }, 'garbage', null]) {
    const t = await makeJournalEnv({ real, provider: mockProvider([out, out]) });
    const r = await upload(t.up);
    await t.jobs.drain();
    const a = await rowOf(t.db, r.body.id);
    assert.equal(a.status, 'failed');
    assert.equal(a.transcript, null);
    assert.equal(a.attempts, 2); // schema failures get the one automatic re-attempt, then stop
    assert.equal(t.provider.calls.length, 2);
  }
  const t2 = await makeJournalEnv({ real, provider: mockProvider([new ProviderError('truncated'), new ProviderError('refused')]) });
  const r2 = await upload(t2.up);
  await t2.jobs.drain();
  assert.equal((await rowOf(t2.db, r2.body.id)).status, 'failed');
  assert.equal(t2.provider.calls.length, 1); // non-retryable: no second paid call
});

test(`[${S}] two total attempts: transient failure retries once automatically, then terminal failure with ONE notice`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([new ProviderError('timeout', { retryable: true }), new ProviderError('http_503', { retryable: true })]) });
  const r = await upload(t.up);
  await t.jobs.drain();
  const a = await rowOf(t.db, r.body.id);
  assert.deepEqual([a.status, a.attempts, a.error_code], ['failed', 2, 'http_503']);
  assert.equal(t.provider.calls.length, 2);
  assert.equal(t.pushes.length, 2); // none after the first (temporary) failure; one pair after exhaustion
  assert.equal((await sendsFor(t.db, r.body.id)).length, 2);
  assert.equal((await t.p1.get(`/api/uploads/${r.body.id}`)).body.journal.canRetry, false);
  assert.equal((await t.p1.post(`/api/uploads/${r.body.id}/retry`).send({})).status, 409); // manual retries count toward the same two
  assert.equal(await t.jobs.runOnce(), false);
  assert.equal(t.provider.calls.length, 2);
});

test(`[${S}] manual retry shares the two-attempt cap: one failed attempt + one manual = done; a new round creates a new notice`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([new ProviderError('refused'), okOut(120)]) });
  const r = await upload(t.up);
  await t.jobs.drain();
  assert.equal((await rowOf(t.db, r.body.id)).status, 'failed'); // non-retryable refusal after 1 attempt
  const v1 = (await t.p1.get(`/api/uploads/${r.body.id}`)).body.journal;
  assert.equal(v1.canRetry, true); // attempts(1) < 2
  const pushesBefore = t.pushes.length;
  assert.equal((await t.p1.post(`/api/uploads/${r.body.id}/retry`).send({})).status, 200);
  await t.jobs.drain();
  const a = await rowOf(t.db, r.body.id);
  assert.deepEqual([a.status, a.attempts, a.round, a.suggested_minutes], ['ready', 2, 1, 60]);
  assert.equal(t.pushes.length, pushesBefore + 2); // the recovery produced its own terminal notice (round 1), not lost behind round 0
  assert.deepEqual((await sendsFor(t.db, r.body.id)).map((x) => x.round), [0, 0, 1, 1]);
  assert.equal((await t.p1.post(`/api/uploads/${r.body.id}/retry`).send({})).status, 409);
});

test(`[${S}] reservation is atomic and precedes the call; it is never released, even on failure or timeout`, async () => {
  let seenAtCall;
  const t0 = await makeJournalEnv({ real });
  const provider = mockProvider([async () => { seenAtCall = await budget(t0.db); return okOut(60); }]);
  const t = await makeJournalEnv({ real, provider });
  provider.script.unshift(async () => { seenAtCall = await budget(t.db); return okOut(60); });
  provider.script.splice(1, 1); // keep exactly the one scripted call
  const r = await upload(t.up);
  await t.jobs.drain();
  const reserve = t.jobs.check.reserveMicro;
  assert.equal(seenAtCall[0].reserved_micro, reserve); // reserved BEFORE the provider ran
  assert.equal((await budget(t.db))[0].reserved_micro, reserve); // success does not refund
  const tf = await makeJournalEnv({ real, provider: mockProvider([new ProviderError('timeout', { retryable: true }), new ProviderError('timeout', { retryable: true })]) });
  await upload(tf.up);
  await tf.jobs.drain();
  assert.equal((await budget(tf.db))[0].reserved_micro, 2 * tf.jobs.check.reserveMicro); // ambiguous outcomes stay charged
});

test(`[${S}] monthly cap: no dispatch when the worst-case reservation does not fit; terminal failure + notice, attempt not consumed`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  const reserve = t.jobs.check.reserveMicro;
  await t.db.query('INSERT INTO ai_budget_months (month, reserved_micro) VALUES ($1,$2)', [monthKey(new Date()), t.config.ai.monthlyCapMicro - reserve + 1]);
  const r = await upload(t.up);
  await t.jobs.drain();
  const a = await rowOf(t.db, r.body.id);
  assert.deepEqual([a.status, a.error_code, a.attempts], ['failed', 'budget', 0]);
  assert.equal(t.provider.calls.length, 0);
  assert.equal(t.pushes.length, 2);
  // exactly at the cap is allowed
  const t2 = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  await t2.db.query('INSERT INTO ai_budget_months (month, reserved_micro) VALUES ($1,$2)', [monthKey(new Date()), t2.config.ai.monthlyCapMicro - t2.jobs.check.reserveMicro]);
  await upload(t2.up);
  await t2.jobs.drain();
  assert.equal(t2.provider.calls.length, 1);
  assert.equal((await budget(t2.db))[0].reserved_micro, t2.config.ai.monthlyCapMicro);
});

test(`[${S}] month rollover: reservations stay attributed to their original UTC month and never escape accounting`, async () => {
  let now = new Date('2026-10-31T23:59:30Z');
  const t = await makeJournalEnv({ real, clock: () => now, provider: mockProvider([new ProviderError('timeout', { retryable: true }), okOut(60)]) });
  await upload(t.up);
  await t.jobs.runOnce(); // attempt 1 in October, ambiguous (timeout)
  now = new Date('2026-11-01T00:00:30Z');
  await t.jobs.runOnce(); // attempt 2 in November
  const b = await budget(t.db);
  assert.deepEqual(b.map((x) => x.month), ['2026-10', '2026-11']);
  assert.ok(b.every((x) => x.reserved_micro === t.jobs.check.reserveMicro));
  assert.equal(monthKey(new Date('2026-12-31T23:59:59Z')), '2026-12');
  assert.equal(monthKey(new Date('2027-01-01T00:00:00Z')), '2027-01');
});

test(`[${S}] concurrency one: overlapping claimers (startup/sweep/request) cannot start a second attempt while the slot is held`, async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const provider = mockProvider([async () => { await gate; return okOut(60); }]);
  const t = await makeJournalEnv({ real, provider });
  await upload(t.up); await upload(t.up);
  const first = t.jobs.runOnce();
  await new Promise((r) => setTimeout(r, 50));
  const claims = await Promise.all([t.jobs.claimNext(), t.jobs.claimNext(), t.jobs.claimNext()]);
  assert.deepEqual(claims, [null, null, null]);
  assert.equal(provider.calls.length, 1);
  release();
  await first;
  assert.equal((await t.db.query("SELECT count(*)::int n FROM journal_analyses WHERE status = 'processing'")).rows[0].n, 0);
  // reservation for the blocked claimers was not charged
  assert.equal((await budget(t.db))[0].reserved_micro, t.jobs.check.reserveMicro);
});

test(`[${S}] stale completion: attempt 1 finishing after attempt 2 started cannot overwrite it or create a notice`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  const r = await upload(t.up);
  const job1 = await t.jobs.claimNext();
  assert.ok(job1);
  // simulate lease expiry + sweep + a second claim
  await t.db.query("UPDATE journal_analyses SET lease_until = now() - interval '1 second' WHERE id = $1", [job1.id]);
  await t.db.query('UPDATE job_slot SET lease_until = now() - interval \'1 second\'');
  await t.jobs.sweep();
  assert.equal((await rowOf(t.db, r.body.id)).status, 'queued');
  const job2 = await t.jobs.claimNext();
  assert.ok(job2 && job2.token !== job1.token);
  const stale = await t.jobs.finish(job1, { kind: 'success', status: 'ready', transcript: words(200), illegible: 0, pageIssues: [], flags: [], wordCount: 200, minutes: 75 });
  assert.equal(stale.stale, true);
  const a = await rowOf(t.db, r.body.id);
  assert.deepEqual([a.status, a.attempts, a.transcript], ['processing', 2, null]);
  assert.equal((await sendsFor(t.db, r.body.id)).length, 0);
  const good = await t.jobs.finish(job2, { kind: 'success', status: 'ready', transcript: words(60), illegible: 0, pageIssues: [], flags: [], wordCount: 60, minutes: 45 });
  assert.equal(good.stale, false);
  assert.equal((await sendsFor(t.db, r.body.id)).length, 2);
  // a repeated completion of the same attempt is stale, not a second notice
  assert.equal((await t.jobs.finish(job2, { kind: 'success', status: 'ready', transcript: words(60), illegible: 0, pageIssues: [], flags: [], wordCount: 60, minutes: 45 })).stale, true);
  assert.equal((await sendsFor(t.db, r.body.id)).length, 2);
});

test(`[${S}] expiry in flight: completion cannot recreate expired data or notify; expired uploads are never claimed`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60), okOut(60)]) });
  const r = await upload(t.up);
  const job = await t.jobs.claimNext();
  await t.db.query("UPDATE uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [r.body.id]);
  const res = await t.jobs.finish(job, { kind: 'success', status: 'ready', transcript: words(60), illegible: 0, pageIssues: [], flags: [], wordCount: 60, minutes: 45 });
  assert.equal(res.stale, true);
  assert.equal((await rowOf(t.db, r.body.id)).transcript, null);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM sends')).rows[0].n, 0);
  // an expired upload waiting in the queue is never claimed (no paid call)
  const r2 = await upload(t.up);
  await t.db.query("UPDATE uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [r2.body.id]);
  await t.db.query('UPDATE job_slot SET holder = NULL, lease_until = NULL');
  const before = t.provider.calls.length;
  await t.jobs.drain();
  assert.equal(t.provider.calls.length, before);
  assert.equal((await t.p1.get(`/api/uploads/${r2.body.id}`)).status, 404);
});

test(`[${S}] restart recovery: an expired lease is requeued once, then failed with a notice; deletes cascade analysis`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  const r = await upload(t.up);
  const job1 = await t.jobs.claimNext(); // "dyno dies" here: no finish
  await t.db.query("UPDATE journal_analyses SET lease_until = now() - interval '1 second' WHERE id = $1", [job1.id]);
  await t.db.query("UPDATE job_slot SET lease_until = now() - interval '1 second'");
  await t.jobs.sweep();
  assert.equal((await rowOf(t.db, r.body.id)).status, 'queued');
  assert.equal(t.pushes.length, 0); // temporary: no notice
  const job2 = await t.jobs.claimNext(); // attempt 2 also dies
  await t.db.query("UPDATE journal_analyses SET lease_until = now() - interval '1 second' WHERE id = $1", [job2.id]);
  await t.db.query("UPDATE job_slot SET lease_until = now() - interval '1 second'");
  await t.jobs.sweep();
  const a = await rowOf(t.db, r.body.id);
  assert.deepEqual([a.status, a.error_code, a.attempts], ['failed', 'stalled', 2]);
  assert.equal(t.pushes.length, 2);
  await t.db.query("UPDATE uploads SET expires_at = now() - interval '1 second'");
  t.config.cleanupIntervalMs = 0;
  await t.p1.get('/api/uploads'); // request-time cleanup
  assert.equal((await t.db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 0);
});

test(`[${S}] terminal state and notice intents commit together (a crash after finish loses neither); push failure leaves the result usable`, async () => {
  const t = await makeJournalEnv({ real, provider: mockProvider([okOut(60)]) });
  const r = await upload(t.up);
  const job = await t.jobs.claimNext();
  // finish() commits state + pending intents; dispatch (not called here) models a crash right after commit
  const done = await t.jobs.finish(job, { kind: 'success', status: 'ready', transcript: words(60), illegible: 0, pageIssues: [], flags: [], wordCount: 60, minutes: 45 });
  assert.equal(done.sendIds.length, 2);
  assert.equal((await rowOf(t.db, r.body.id)).status, 'ready');
  assert.deepEqual((await sendsFor(t.db, r.body.id)).map((x) => x.status), ['pending', 'pending']); // recoverable via existing resend
  assert.equal((await t.p1.get(`/api/uploads/${r.body.id}`)).body.journal.status, 'ready'); // result usable without any push
  const rs = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.equal(rs.status, 200);
  assert.ok(rs.body.sends.every((x) => x.status === 'accepted_by_push_service'));
});

test(`[${S}] daily cap: more than the per-family daily uploads are rejected before any row or paid call`, async () => {
  const t = await makeJournalEnv({ real, mutate: (c) => { c.ai.dailyUploadsPerFamily = 2; } });
  assert.equal((await upload(t.up)).status, 201);
  assert.equal((await upload(t.up)).status, 201);
  const third = await upload(t.up);
  assert.equal(third.status, 429);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 2);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM journal_analyses')).rows[0].n, 2);
});

test(`[${S}] the real kick-after-response path runs the job in the background without blocking the 201`, async () => {
  const t = await makeJournalEnv({ real, autoKick: true, provider: mockProvider([okOut(60)]) });
  const r = await upload(t.up);
  assert.equal(r.status, 201);
  assert.equal(r.body.state, 'processing');
  for (let i = 0; i < 100 && (await rowOf(t.db, r.body.id)).status !== 'ready'; i++) await new Promise((x) => setTimeout(x, 20));
  assert.equal((await rowOf(t.db, r.body.id)).status, 'ready');
  assert.equal(t.pushes.length, 2);
});
