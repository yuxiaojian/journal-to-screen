import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashToken, newId, newToken, verifyPassword, ID_RE } from './security.js';
import { processImage, ImageError } from './images.js';
import { validateEndpoint } from './push.js';
import { dispatchSends } from './dispatch.js';
import { evaluateCorrection, normalizeText, validText } from './journal.js';
import { validateAppOrigin } from './config.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const COOKIE = 'stm_session';

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// In-memory login backoff (single dyno POC). Keys: "u:<name>" and "ip:<addr>".
function createThrottle() {
  const m = new Map();
  const free = 5;
  return {
    check(keys) {
      const now = Date.now();
      return keys.some((k) => (m.get(k)?.until || 0) > now);
    },
    fail(keys) {
      const now = Date.now();
      if (m.size > 5000) {
        for (const [k, e] of m) if (e.until < now) m.delete(k); // drop expired/stale entries
        while (m.size > 5000) m.delete(m.keys().next().value); // evict oldest only; active lockouts mostly survive
      }
      for (const k of keys) {
        const e = m.get(k) || { n: 0, until: 0 };
        e.n += 1;
        if (e.n >= free) e.until = now + Math.min(2 ** (e.n - free) * 1000, 15 * 60 * 1000);
        m.set(k, e);
      }
    },
    ok(keys) {
      keys.forEach((k) => m.delete(k));
    },
  };
}

export function createApp({ db, config, pushSender, jobs = null }) {
  const aiOn = jobs?.active === true; // false by default: the POC push-at-upload behavior is unchanged
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Heroku router
  const throttle = createThrottle();
  let lastCleanup = 0;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.rawBytes, files: 1, fields: 4, fieldSize: 256, parts: 6 },
  });

  // HTTPS enforcement. Runs before body parsing and every handler, so credentials are never parsed or processed over http.
  // Scheme: every X-Forwarded-Proto value must be exactly 'https' to count as secure. Any 'http' or unknown value,
  // including mixed chains such as 'https, http' (a client-supplied value ahead of the router's hop), is treated as
  // insecure. This is defense in depth only: Heroku's docs warn forwarded headers are not a security guarantee, so
  // the spoof behavior of the real router is verified live after deploy (see wiki). Redirects go ONLY to the
  // validated canonical origin from config, never to anything derived from the request.
  const schemeOf = (req) => {
    const raw = req.headers['x-forwarded-proto'];
    if (raw === undefined) return req.socket.encrypted === true ? 'https' : 'http';
    const parts = String(raw).split(',').map((v) => v.trim().toLowerCase());
    return parts.length > 0 && parts.every((v) => v === 'https') ? 'https' : 'http';
  };
  app.use((req, res, next) => {
    if (!config.requireHttps) return next();
    if (schemeOf(req) === 'https') {
      res.set('Strict-Transport-Security', 'max-age=15552000');
      return next();
    }
    const canonicalOrigin = validateAppOrigin(config.appOrigin); // fail closed: null -> 426 below
    if (['GET', 'HEAD'].includes(req.method) && canonicalOrigin && /^\/(?!\/)/.test(req.originalUrl)) {
      return res.redirect(308, `${canonicalOrigin}${req.originalUrl}`);
    }
    return res.status(426).json({ error: 'https_required' }); // login/mutations/ambiguous: rejected unread, never replayed
  });

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // Mutation protection: custom header + same-origin Origin (cookie is SameSite=Lax).
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    let ok = req.get('x-stm-request') === '1' && !!origin;
    if (ok) {
      try {
        ok = new URL(origin).host === req.get('host');
      } catch {
        ok = false;
      }
    }
    if (!ok) return res.status(403).json({ error: 'forbidden' });
    next();
  });

  // Corrections carry up to MAX_TRANSCRIPT_CHARS of text; only that route gets the larger body limit.
  app.use('/api/uploads/:id/correction', express.json({ limit: '96kb' }));
  app.use(express.json({ limit: '16kb' }));

  async function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < config.cleanupIntervalMs) return;
    lastCleanup = now;
    await db.query('DELETE FROM uploads WHERE expires_at < now()');
    await db.query('DELETE FROM sessions WHERE expires_at < now()');
  }

  async function auth(req, res, next) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return res.status(401).json({ error: 'unauthenticated' });
    const h = hashToken(tok);
    const r = await db.query(
      `SELECT u.id, u.family_id, u.role, u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [h],
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'unauthenticated' });
    req.user = r.rows[0];
    req.sessionHash = h;
    next();
  }
  const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'forbidden' });
  const parent = requireRole('parent1', 'parent2');

  const setCookie = (res, value, maxAgeSec) =>
    res.append(
      'Set-Cookie',
      `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`,
    );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/api/config', (req, res) => res.json({ vapidPublicKey: config.vapid.publicKey || null }));

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const keys = [`u:${username.toLowerCase()}`, `ip:${req.ip}`];
    if (throttle.check(keys)) return res.status(429).json({ error: 'too_many_attempts' });
    const u = (await db.query('SELECT id, password_hash FROM users WHERE username = $1', [username])).rows[0];
    const ok = await verifyPassword(password, u?.password_hash);
    if (!u || !ok) {
      throttle.fail(keys);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    throttle.ok(keys);
    const token = newToken();
    await db.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3::int * interval \'1 day\'))', [
      hashToken(token),
      u.id,
      config.sessionDays,
    ]);
    setCookie(res, token, config.sessionDays * 86400);
    res.json({ ok: true });
  });

  app.post('/api/logout', auth, async (req, res) => {
    // Detach this browser's push subscription(s) from the identity.
    await db.query('DELETE FROM subscriptions WHERE session_hash = $1', [req.sessionHash]);
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [req.sessionHash]);
    setCookie(res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ username: req.user.username, role: req.user.role }));

  // ---- subscriptions (parents only) ----
  app.post('/api/subscriptions', auth, parent, async (req, res) => {
    const { endpoint, keys } = req.body || {};
    if (!validateEndpoint(endpoint, config.allowedPushHosts) || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }
    // Endpoint is unique. Same user: refresh keys/session in place (idempotent).
    // Different user (account switch / other family): retire the old binding and its send
    // history atomically and create a fresh identity, so old intents never follow the endpoint.
    await db.tx(async (t) => {
      const cur = (await t.query('SELECT id, user_id FROM subscriptions WHERE endpoint=$1', [endpoint])).rows[0];
      if (cur && cur.user_id === req.user.id) {
        await t.query('UPDATE subscriptions SET session_hash=$2, p256dh=$3, auth=$4, disabled_at=NULL WHERE id=$1', [cur.id, req.sessionHash, keys.p256dh, keys.auth]);
        return;
      }
      if (cur) await t.query('DELETE FROM subscriptions WHERE id=$1', [cur.id]); // cascades to its sends
      await t.query(
        'INSERT INTO subscriptions (id, user_id, session_hash, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5,$6)',
        [newId(), req.user.id, req.sessionHash, endpoint, keys.p256dh, keys.auth],
      );
    });
    res.status(201).json({ ok: true });
  });

  app.delete('/api/subscriptions', auth, parent, async (req, res) => {
    const { endpoint } = req.body || {};
    if (typeof endpoint !== 'string') return res.status(400).json({ error: 'bad_request' });
    await db.query('DELETE FROM subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    res.json({ ok: true });
  });

  // ---- uploads ----
  const sendSummary = async (uploadId) =>
    (await db.query(
      `SELECT s.id, s.status, s.updated_at, u.username AS parent FROM sends s
       JOIN subscriptions sub ON sub.id = s.subscription_id JOIN users u ON u.id = sub.user_id
       WHERE s.upload_id = $1 ORDER BY s.created_at`,
      [uploadId],
    )).rows;

  app.post('/api/uploads', auth, requireRole('uploader'), (req, res, next) =>
    upload.single('photo')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'request_too_large'));
      if (err) return next(new HttpError(400, 'bad_upload'));
      next();
    }),
  async (req, res) => {
    await cleanup();
    const key = req.body?.key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) throw new HttpError(400, 'bad_key');
    if (!req.file) throw new HttpError(400, 'no_file');
    const existing = (await db.query('SELECT id FROM uploads WHERE family_id=$1 AND idempotency_key=$2', [req.user.family_id, key])).rows[0];
    if (existing) return res.status(200).json({ id: existing.id, duplicate: true, sends: await sendSummary(existing.id) });

    const img = await processImage(req.file.buffer, config.limits); // throws ImageError before any DB write
    const id = newId();
    const sendIds = [];
    const inserted = await db.tx(async (t) => {
      if (aiOn) {
        // Serialize uploads per family so the daily cap cannot be exceeded by concurrent requests.
        await t.query('SELECT id FROM families WHERE id = $1 FOR UPDATE', [req.user.family_id]);
        const used = (await t.query(
          `SELECT count(*)::int n FROM journal_analyses WHERE family_id = $1
             AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          [req.user.family_id],
        )).rows[0].n;
        if (used >= config.ai.dailyUploadsPerFamily) throw new HttpError(429, 'daily_limit');
      }
      const r = await t.query(
        `INSERT INTO uploads (id, family_id, uploader_id, idempotency_key, image, content_type, byte_size, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8::int * interval '1 day'))
         ON CONFLICT (family_id, idempotency_key) DO NOTHING RETURNING id`,
        [id, req.user.family_id, req.user.id, key, img.data, img.contentType, img.data.length, config.retentionDays],
      );
      if (!r.rows[0]) return false;
      if (aiOn) {
        // Upload + queued analysis are one atomic unit. The single terminal notice is created when analysis finishes.
        await t.query("INSERT INTO journal_analyses (id, upload_id, family_id, status) VALUES ($1,$2,$3,'queued')", [newId(), id, req.user.family_id]);
        return true;
      }
      const subs = await t.query(
        `SELECT sub.id FROM subscriptions sub JOIN users u ON u.id = sub.user_id
         WHERE u.family_id = $1 AND u.role IN ('parent1','parent2') AND sub.disabled_at IS NULL`,
        [req.user.family_id],
      );
      for (const s of subs.rows) {
        const sid = newId();
        await t.query("INSERT INTO sends (id, upload_id, subscription_id, status) VALUES ($1,$2,$3,'pending')", [sid, id, s.id]);
        sendIds.push(sid);
      }
      return true;
    });
    if (!inserted) {
      const e = (await db.query('SELECT id FROM uploads WHERE family_id=$1 AND idempotency_key=$2', [req.user.family_id, key])).rows[0];
      return res.status(200).json({ id: e.id, duplicate: true, sends: await sendSummary(e.id) });
    }
    if (aiOn) {
      jobs.kick();
      return res.status(201).json({ id, duplicate: false, state: 'processing', sends: [] });
    }
    // Intents are committed; push is only a nudge. Failures never undo the upload.
    await dispatchSends({ db, pushSender, config, sendIds }).catch(() => {});
    res.status(201).json({ id, duplicate: false, sends: await sendSummary(id) });
  });

  app.get('/api/uploads', auth, parent, async (req, res) => {
    await cleanup();
    // Deliberately excludes the image column.
    const rows = (await db.query(
      `SELECT up.id, up.created_at, up.byte_size,
         ja.status AS analysis_status,
         COALESCE(ja.corrected_suggested_minutes, ja.suggested_minutes) AS suggested_minutes,
         (SELECT count(*)::int FROM sends s WHERE s.upload_id = up.id AND s.status='accepted_by_push_service') AS accepted,
         (SELECT count(*)::int FROM sends s WHERE s.upload_id = up.id AND s.status IN ('pending','failed','unknown','sending')) AS needs_attention
       FROM uploads up LEFT JOIN journal_analyses ja ON ja.upload_id = up.id
       WHERE up.family_id = $1 AND up.expires_at > now() ORDER BY up.created_at DESC LIMIT 50`,
      [req.user.family_id],
    )).rows;
    res.json({ uploads: rows });
  });

  async function loadOwned(req, res) {
    const id = req.params.id;
    if (!ID_RE.test(id)) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    const q = req.user.role === 'uploader'
      ? 'SELECT id, created_at, byte_size, expires_at FROM uploads WHERE id=$1 AND family_id=$2 AND uploader_id=$3 AND expires_at > now()'
      : 'SELECT id, created_at, byte_size, expires_at FROM uploads WHERE id=$1 AND family_id=$2 AND expires_at > now()';
    const params = req.user.role === 'uploader' ? [id, req.user.family_id, req.user.id] : [id, req.user.family_id];
    const row = (await db.query(q, params)).rows[0];
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return row;
  }

  const CHILD_STATE = { queued: 'processing', processing: 'processing', ready: 'sent', needs_review: 'sent', failed: 'sent' };
  const parseJson = (v) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };

  // Parents see transcript, count and suggestion. The uploader only ever sees a coarse status.
  async function journalView(uploadId, role) {
    const a = (await db.query('SELECT * FROM journal_analyses WHERE upload_id = $1', [uploadId])).rows[0];
    if (!a) return null;
    if (role === 'uploader') return { state: CHILD_STATE[a.status] };
    const corrected = a.corrected_at != null;
    return {
      id: a.id, status: a.status, error: a.status === 'failed' ? a.error_code : null, attempts: a.attempts, version: a.version,
      canRetry: a.status === 'failed' && a.attempts < config.ai.maxAttempts,
      original: a.transcript == null ? null : { transcript: a.transcript, wordCount: a.word_count, suggestedMinutes: a.suggested_minutes,
        flags: parseJson(a.review_flags), pageIssues: parseJson(a.page_issues), illegibleCount: a.illegible_count },
      corrected: corrected ? { transcript: a.corrected_transcript, wordCount: a.corrected_word_count,
        suggestedMinutes: a.corrected_suggested_minutes, flags: parseJson(a.corrected_flags), at: a.corrected_at } : null,
      provisional: a.status === 'needs_review' && !corrected,
      tz: config.familyTz,
    };
  }

  app.get('/api/uploads/:id', auth, async (req, res) => {
    const row = await loadOwned(req, res);
    if (!row) return;
    const journal = await journalView(row.id, req.user.role);
    if (req.user.role === 'uploader') return res.json({ upload: { id: row.id, created_at: row.created_at }, journal });
    res.json({ upload: row, journal, sends: await sendSummary(row.id) });
  });

  // Parent correction: preserves the original, recomputes server-side, optimistic version check, never extends expiry.
  app.post('/api/uploads/:id/correction', auth, parent, async (req, res) => {
    const row = await loadOwned(req, res);
    if (!row) return;
    const { transcript, version } = req.body || {};
    if (!validText(transcript) || !Number.isSafeInteger(version) || version < 1 || version > 2_000_000_000) throw new HttpError(400, 'bad_request');
    const text = normalizeText(transcript);
    const ev = evaluateCorrection(text);
    const r = await db.query(
      `UPDATE journal_analyses a SET corrected_transcript = $3, corrected_word_count = $4, corrected_suggested_minutes = $5,
         corrected_flags = $6, corrected_by = $7, corrected_at = now(), version = a.version + 1
       WHERE a.upload_id = $1 AND a.family_id = $2 AND a.version = $8 AND a.status IN ('ready','needs_review')
         AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = a.upload_id AND u.expires_at > now())
       RETURNING a.version`,
      [row.id, req.user.family_id, text, ev.wordCount, ev.minutes, JSON.stringify(ev.flags), req.user.id, version],
    );
    if (!r.rows[0]) {
      const cur = (await db.query('SELECT status, version FROM journal_analyses WHERE upload_id = $1 AND family_id = $2', [row.id, req.user.family_id])).rows[0];
      if (!cur) throw new HttpError(404, 'not_found');
      if (!['ready', 'needs_review'].includes(cur.status)) throw new HttpError(409, 'not_correctable');
      throw new HttpError(409, 'version_conflict'); // someone else (or a retry) changed it first
    }
    res.json({ journal: await journalView(row.id, req.user.role) });
  });

  // Manual retry of a failed analysis: only while total attempts (including automatic ones) remain.
  app.post('/api/uploads/:id/retry', auth, parent, async (req, res) => {
    const row = await loadOwned(req, res);
    if (!row) return;
    if (!aiOn) throw new HttpError(409, 'ai_disabled');
    const r = await db.query(
      `UPDATE journal_analyses a SET status = 'queued', run_after = now(), error_code = NULL, round = a.round + 1,
         attempt_token = NULL, lease_until = NULL, completed_at = NULL, version = a.version + 1
       WHERE a.upload_id = $1 AND a.family_id = $2 AND a.status = 'failed' AND a.attempts < $3
         AND EXISTS (SELECT 1 FROM uploads u WHERE u.id = a.upload_id AND u.expires_at > now())
       RETURNING a.id`,
      [row.id, req.user.family_id, config.ai.maxAttempts],
    );
    if (!r.rows[0]) throw new HttpError(409, 'not_retryable');
    jobs.kick();
    res.json({ journal: await journalView(row.id, req.user.role) });
  });

  app.get('/api/uploads/:id/image', auth, parent, async (req, res) => {
    const row = await loadOwned(req, res);
    if (!row) return;
    const img = (await db.query('SELECT image, content_type FROM uploads WHERE id=$1 AND family_id=$2', [row.id, req.user.family_id])).rows[0];
    res.set({ 'Content-Type': img.content_type, 'Cache-Control': 'no-store, private' });
    res.send(Buffer.from(img.image));
  });

  app.post('/api/uploads/:id/resend', auth, parent, async (req, res) => {
    const row = await loadOwned(req, res);
    if (!row) return;
    const sends = (await db.query("SELECT id, status FROM sends WHERE upload_id=$1 AND status IN ('pending','failed','unknown','sending')", [row.id])).rows;
    const uncertain = sends.filter((s) => s.status === 'unknown' || s.status === 'sending');
    const confirm = req.body?.confirmDuplicate === true;
    if (uncertain.length && !confirm) {
      return res.status(409).json({ error: 'possible_duplicate', message: 'A previous send may have succeeded. Resending can show the notification twice.' });
    }
    await dispatchSends({ db, pushSender, config, sendIds: sends.map((s) => s.id), allowUncertain: confirm });
    res.json({ sends: await sendSummary(row.id) });
  });

  // ---- static PWA ----
  app.get('/sw.js', (req, res) => res.set('Cache-Control', 'no-cache').type('application/javascript').sendFile(path.join(publicDir, 'sw.js')));
  app.use(express.static(publicDir, { index: false, setHeaders: (r) => r.set('Cache-Control', 'no-cache') }));
  app.get(['/', '/login', '/inbox', '/uploads/:id', '/upload'], (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(publicDir, 'index.html')));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ImageError || err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code });
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'request_too_large' });
    if (err?.type === 'entity.parse.failed' || err?.type === 'encoding.unsupported') return res.status(400).json({ error: 'bad_request' });
    console.error('request_error', { class: err?.name }); // no messages: may contain secrets
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}
