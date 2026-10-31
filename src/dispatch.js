import { validateEndpoint } from './push.js';

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timedOut: true })), ms))]);

// Claims eligible send rows (so concurrent resends cannot double-send), sends
// in parallel with a bounded timeout, and records each outcome.
// allowUncertain: also re-claim 'unknown' and stale 'sending' rows (caller must have warned about duplicates).
export async function dispatchSends({ db, pushSender, config, sendIds, allowUncertain = false }) {
  if (!sendIds.length) return [];
  const claimed = (
    await db.query(
      `UPDATE sends SET status='sending', updated_at=now()
       WHERE id = ANY($1::text[]) AND (
         status IN ('pending','failed')
         OR ($2::boolean AND (status='unknown' OR (status='sending' AND updated_at < now() - ($3::int * interval '1 second'))))
       ) RETURNING id, upload_id, subscription_id`,
      [sendIds, allowUncertain, config.staleSendingSeconds],
    )
  ).rows;

  return Promise.all(
    claimed.map(async (s) => {
      let status;
      let httpStatus = null;
      try {
        // Defense in depth: recipient must belong to the same family as the upload.
        const sub = (await db.query(
          `SELECT sub.id, sub.endpoint, sub.p256dh, sub.auth FROM subscriptions sub
           JOIN users u ON u.id = sub.user_id JOIN uploads up ON up.id = $2 AND up.family_id = u.family_id
           WHERE sub.id=$1 AND sub.disabled_at IS NULL`,
          [s.subscription_id, s.upload_id],
        )).rows[0];
        if (!sub) {
          status = 'disabled_endpoint';
        } else if (!validateEndpoint(sub.endpoint, config.allowedPushHosts)) {
          await db.query('UPDATE subscriptions SET disabled_at=now() WHERE id=$1', [sub.id]);
          status = 'failed';
        } else {
          const payload = JSON.stringify({ v: 1, title: 'New upload ready', id: s.upload_id });
          const res = await withTimeout(
            pushSender(sub, payload, { ttl: config.pushTtlSeconds, timeoutMs: config.pushTimeoutMs }),
            config.pushTimeoutMs + 500,
          );
          httpStatus = res?.statusCode ?? null;
          status = 'accepted_by_push_service';
        }
      } catch (e) {
        httpStatus = e?.statusCode ?? null;
        if (httpStatus === 404 || httpStatus === 410) {
          status = 'disabled_endpoint';
          await db.query('UPDATE subscriptions SET disabled_at=now() WHERE id=$1', [s.subscription_id]).catch(() => {});
        } else if (httpStatus) {
          status = 'failed';
        } else {
          status = 'unknown'; // timeout / network error: outcome uncertain
        }
        // Never log endpoint or keys; error class only.
        console.error('push_send_error', { class: e?.name, timedOut: !!e?.timedOut, httpStatus });
      }
      await db.query(
        "UPDATE sends SET status=$2, http_status=$3, updated_at=now() WHERE id=$1 AND status='sending'",
        [s.id, status, httpStatus],
      );
      return { id: s.id, status };
    }),
  );
}
