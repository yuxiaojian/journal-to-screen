// All runtime configuration comes from environment variables (Heroku config vars).
export function loadConfig(env = process.env) {
  const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL,
    dbSsl: env.PGSSL ? env.PGSSL === '1' : env.NODE_ENV === 'production',
    baseUrl: env.BASE_URL || null,
    secureCookies: env.INSECURE_COOKIES !== '1',
    requireHttps: env.INSECURE_COOKIES !== '1', // production default; local http dev sets INSECURE_COOKIES=1
    appOrigin: env.APP_ORIGIN ?? null, // canonical https origin for redirects; validate with validateAppOrigin (never the request Host)
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT, // must be mailto: or https:
    },
    // Exact hostnames only (never suffix match). Apple Web Push and Google FCM.
    allowedPushHosts: list(env.ALLOWED_PUSH_HOSTS, 'web.push.apple.com,fcm.googleapis.com'),
    limits: {
      rawBytes: 10 * 1024 * 1024, // incoming multipart file cap
      pixels: 25_000_000, // decoded pixel cap, checked before decode
      storedBytes: 2 * 1024 * 1024, // cap on re-encoded image kept in DB
      maxEdge: 1568, // also the long edge sent to the model (visual-token bound)
    },
    ai: {
      enabled: env.AI_ENABLED === '1', // disabled by default; also needs a key and a priced model
      apiKey: env.ANTHROPIC_API_KEY || null,
      model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
      monthlyCapMicro: 5_000_000, // USD 5 per UTC calendar month, planning ceiling enforced by reservations
      reserveFloorMicro: 0,
      maxOutputTokens: 4096,
      timeoutMs: 45_000,
      leaseSeconds: 90,
      maxAttempts: 2, // total per analysis, including manual retries
      retryDelaySeconds: 20,
      dailyUploadsPerFamily: 10,
      sweepIntervalMs: 60_000,
    },
    familyTz: env.FAMILY_TZ || 'UTC', // display only
    retentionDays: 7,
    cleanupIntervalMs: 60_000,
    sessionDays: 30,
    pushTimeoutMs: 8000,
    pushTtlSeconds: 3600,
    staleSendingSeconds: 60,
  };
}

// Strict canonical origin for this app (443-only policy): https scheme, a plain hostname, NO explicit port at all
// (default 443 only), no userinfo/path/query/fragment. The native URL parser must agree the input is exactly its
// own origin. Returns the normalized origin or null.
export function validateAppOrigin(raw) {
  if (typeof raw !== 'string' || raw.length > 255 || raw !== raw.trim()) return null;
  if (!/^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(raw)) return null; // any ':port' fails here
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  if (u.origin !== raw) return null;
  return u.origin;
}
