// Durable, bounded analysis jobs on the existing web process and Postgres. No queue, no worker dyno.
//  - concurrency one across every claimer (startup, sweep, request) via a single-row lease (job_slot)
//  - each attempt = atomic {attempt++, random attempt token, monthly budget reservation} BEFORE any paid call
//  - completion / failure / notice creation are conditional on the current attempt token AND an unexpired upload
//  - reservations are never released (fixed conservative cost per permitted call; ambiguous outcomes stay charged)
import crypto from 'node:crypto';
import { ProviderError, validateAiConfig } from './ai.js';
import { evaluate, validateModelOutput, COUNT_VERSION } from './journal.js';
import { PROMPT_VERSION } from './ai.js';
import { dispatchSends } from './dispatch.js';
import { newId } from './security.js';

export const monthKey = (d) => d.toISOString().slice(0, 7); // UTC calendar month, e.g. 2026-10

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new ProviderError('timeout', { retryable: true })), ms))]);

// Parents of the family with an active subscription get exactly one notice per upload (unique upload+subscription).
export async function createNotice(t, { uploadId, familyId }) {
  const subs = await t.query(
    `SELECT sub.id FROM subscriptions sub JOIN users u ON u.id = sub.user_id
     WHERE u.family_id = $1 AND u.role IN ('parent1','parent2') AND sub.disabled_at IS NULL`,
    [familyId],
  );
  const ids = [];
  for (const s of subs.rows) {
    const r = await t.query(
      "INSERT INTO sends (id, upload_id, subscription_id, status) VALUES ($1,$2,$3,'pending') ON CONFLICT DO NOTHING RETURNING id",
      [newId(), uploadId, s.id],
    );
    if (r.rows[0]) ids.push(r.rows[0].id);
  }
  return ids;
}

export function createJobRunner({ db, config, provider, pushSender, clock = () => new Date(), log = console }) {
  const ai = config.ai;
  const check = validateAiConfig(ai);
  const active = ai.enabled === true && check.ok && !!provider; // paid dispatch is impossible unless all three hold
  let stopped = false;
  let timer = null;
  let draining = null;

  const dispatch = (sendIds) => (sendIds.length ? dispatchSends({ db, pushSender, config, sendIds }).catch(() => {}) : Promise.resolve());

  async function claimNext() {
    if (!active) return null; // paid dispatch requires enabled + validated config + provider
    const token = crypto.randomUUID();
    return db.tx(async (t) => {
      const cand = (await t.query(
        `SELECT a.id, a.upload_id, a.family_id FROM journal_analyses a JOIN uploads u ON u.id = a.upload_id
         WHERE a.status = 'queued' AND a.run_after <= now() AND a.attempts < $1 AND u.expires_at > now()
         ORDER BY a.run_after, a.created_at LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
        [ai.maxAttempts],
      )).rows[0];
      if (!cand) return null;
      const slot = await t.query(
        `UPDATE job_slot SET holder = $1, lease_until = now() + ($2::int * interval '1 second')
         WHERE id = 1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
        [token, ai.leaseSeconds],
      );
      if (!slot.rows[0]) return null; // another claimer (or a not-yet-expired attempt) holds the slot
      const month = monthKey(clock());
      await t.query('INSERT INTO ai_budget_months (month) VALUES ($1) ON CONFLICT DO NOTHING', [month]);
      const budget = await t.query(
        'UPDATE ai_budget_months SET reserved_micro = reserved_micro + $2 WHERE month = $1 AND reserved_micro + $2 <= $3 RETURNING reserved_micro',
        [month, check.reserveMicro, ai.monthlyCapMicro],
      );
      if (!budget.rows[0]) {
        // Not enough allowance for a safe worst-case reservation: no paid call, terminal failure + notice, attempt not consumed.
        await t.query('UPDATE job_slot SET holder = NULL, lease_until = NULL WHERE holder = $1', [token]);
        await t.query(
          `UPDATE journal_analyses SET status = 'failed', error_code = 'budget', attempt_token = NULL, lease_until = NULL,
             version = version + 1, completed_at = now() WHERE id = $1`,
          [cand.id],
        );
        const sendIds = await createNotice(t, { uploadId: cand.upload_id, familyId: cand.family_id });
        return { refused: true, sendIds };
      }
      await t.query(
        `UPDATE journal_analyses SET status = 'processing', attempts = attempts + 1, attempt_token = $2,
           lease_until = now() + ($3::int * interval '1 second'), error_code = NULL, version = version + 1 WHERE id = $1`,
        [cand.id, token, ai.leaseSeconds],
      );
      return { id: cand.id, uploadId: cand.upload_id, familyId: cand.family_id, token };
    });
  }

  const releaseSlot = (token) => db.query('UPDATE job_slot SET holder = NULL, lease_until = NULL WHERE holder = $1', [token]).catch(() => {});

  // Conditional on the current attempt token and an unexpired upload. Returns { stale } or { status, sendIds }.
  async function finish(job, outcome) {
    const res = await db.tx(async (t) => {
      let row;
      if (outcome.kind === 'success') {
        row = (await t.query(
          `UPDATE journal_analyses a SET status = $3, attempt_token = NULL, lease_until = NULL, error_code = NULL,
             model_id = $4, prompt_version = $5, count_version = $6, transcript = $7, illegible_count = $8, page_issues = $9,
             review_flags = $10, word_count = $11, suggested_minutes = $12, version = version + 1, completed_at = now()
           WHERE a.id = $1 AND a.attempt_token = $2 AND a.status = 'processing'
             AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = a.upload_id AND u.expires_at > now())
           RETURNING a.status, a.upload_id, a.family_id`,
          [job.id, job.token, outcome.status, ai.model, PROMPT_VERSION, COUNT_VERSION, outcome.transcript, outcome.illegible,
            JSON.stringify(outcome.pageIssues), JSON.stringify(outcome.flags), outcome.wordCount, outcome.minutes],
        )).rows[0];
      } else {
        row = (await t.query(
          `UPDATE journal_analyses a SET
             status = CASE WHEN $3::boolean AND a.attempts < $4 THEN 'queued' ELSE 'failed' END,
             run_after = CASE WHEN $3::boolean AND a.attempts < $4 THEN now() + ($5::int * interval '1 second') ELSE a.run_after END,
             error_code = $6, attempt_token = NULL, lease_until = NULL, version = version + 1,
             completed_at = CASE WHEN $3::boolean AND a.attempts < $4 THEN NULL ELSE now() END
           WHERE a.id = $1 AND a.attempt_token = $2 AND a.status = 'processing'
             AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = a.upload_id AND u.expires_at > now())
           RETURNING a.status, a.upload_id, a.family_id`,
          [job.id, job.token, outcome.retryable, ai.maxAttempts, ai.retryDelaySeconds, outcome.code],
        )).rows[0];
      }
      if (!row) return { stale: true, sendIds: [] };
      const terminal = row.status !== 'queued';
      const sendIds = terminal ? await createNotice(t, { uploadId: row.upload_id, familyId: row.family_id }) : [];
      return { stale: false, status: row.status, sendIds };
    });
    // Release the slot only when the provider outcome is KNOWN (success, or a failure that proves it never processed
    // the request). After an ambiguous outcome (timeout, dropped connection, 429/5xx) the provider may still be working
    // on it, so the slot stays held until its 90 s lease expires: no other job can start a second paid call meanwhile.
    if (outcome.kind === 'success' || outcome.known) await releaseSlot(job.token);
    return res;
  }

  async function loadImage(job) {
    const r = (await db.query(
      'SELECT image, content_type FROM uploads WHERE id = $1 AND family_id = $2 AND expires_at > now()',
      [job.uploadId, job.familyId],
    )).rows[0];
    return r ? { imageBase64: Buffer.from(r.image).toString('base64'), mediaType: r.content_type } : null;
  }

  // Runs at most one attempt. Returns false when nothing was claimable.
  async function runOnce() {
    const job = await claimNext();
    if (!job) return false;
    if (job.refused) { await dispatch(job.sendIds); return true; }
    let outcome;
    try {
      const img = await loadImage(job);
      if (!img) {
        outcome = { kind: 'failure', retryable: false, code: 'expired', known: true }; // no call was made
      } else {
        const raw = await withTimeout(provider.analyze(img), ai.timeoutMs + 1000);
        const v = validateModelOutput(raw);
        const ev = evaluate({ transcript: v.transcript, illegibleCount: v.illegible_count, pageIssues: v.page_issues });
        outcome = { kind: 'success', status: ev.status, transcript: v.transcript, illegible: v.illegible_count, pageIssues: v.page_issues,
          flags: ev.flags, wordCount: ev.wordCount, minutes: ev.minutes };
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        outcome = { kind: 'failure', retryable: e.retryable, code: e.code, known: e.unknownOutcome === false };
      } else if (typeof e?.message === 'string' && e.message.startsWith('schema:')) {
        outcome = { kind: 'failure', retryable: true, code: 'invalid_output', known: true }; // a complete response was received
      } else {
        outcome = { kind: 'failure', retryable: false, code: 'internal' };
      }
      log.error?.('analysis_attempt_failed', { code: outcome.code }); // code only; never request/response bodies
    }
    const done = await finish(job, outcome);
    await dispatch(done.sendIds);
    return true;
  }

  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      try {
        // eslint-disable-next-line no-await-in-loop
        while (!stopped && (await runOnce())) { /* keep going until nothing is claimable */ }
      } finally { draining = null; }
    })();
    return draining;
  }

  const kick = () => { if (!stopped && active) setImmediate(() => drain().catch(() => {})); };

  // Expired leases: requeue while attempts remain, otherwise fail terminally (with a notice).
  async function sweep() {
    const sendIds = await db.tx(async (t) => {
      const rows = (await t.query(
        `UPDATE journal_analyses a SET
           status = CASE WHEN a.attempts < $1 THEN 'queued' ELSE 'failed' END,
           run_after = now(), error_code = 'stalled', attempt_token = NULL, lease_until = NULL, version = version + 1,
           completed_at = CASE WHEN a.attempts < $1 THEN NULL ELSE now() END
         WHERE a.status = 'processing' AND a.lease_until < now()
           AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = a.upload_id AND u.expires_at > now())
         RETURNING a.status, a.upload_id, a.family_id`,
        [ai.maxAttempts],
      )).rows;
      const ids = [];
      for (const r of rows) if (r.status === 'failed') ids.push(...(await createNotice(t, { uploadId: r.upload_id, familyId: r.family_id })));
      return ids;
    });
    await dispatch(sendIds);
  }

  function start() {
    if (!active) return;
    sweep().then(() => drain()).catch(() => {});
    timer = setInterval(() => { sweep().then(() => drain()).catch(() => {}); }, ai.sweepIntervalMs);
    timer.unref?.();
  }
  function stop() { stopped = true; if (timer) clearInterval(timer); }

  return { active, runOnce, drain, kick, sweep, start, stop, claimNext, finish, check };
}
