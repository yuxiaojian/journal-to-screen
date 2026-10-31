import webpush from 'web-push';

// Subscription endpoints are untrusted outbound URLs. Exact-host allowlist,
// https only, no userinfo, default port only, and the string must already be
// in canonical URL form so every URL parser agrees on the destination.
export function validateEndpoint(raw, allowedHosts) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.href === raw &&
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    (u.port === '' || u.port === '443') &&
    allowedHosts.includes(u.hostname)
  );
}

export function createPushSender(config) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
  // web-push does not follow redirects; a 3xx surfaces as an error status.
  return (sub, payload, opts) =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payload,
      { TTL: opts.ttl, urgency: 'normal', timeout: opts.timeoutMs },
    );
}
