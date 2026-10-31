import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { makeEnv, seedFamily, agent, jpeg, jpegWithGps, key, sub, GOOD_ENDPOINT, PW } from './helpers.js';
import { validateEndpoint } from '../src/push.js';

const real = !!process.env.TEST_DATABASE_URL;
const suite = real ? 'PG' : 'pglite';

async function setup(opts) {
  const env = await makeEnv({ ...opts, real });
  const fam = await seedFamily(env.db, 'a');
  const other = await seedFamily(env.db, 'b');
  const up = agent(env.app), p1 = agent(env.app), p2 = agent(env.app);
  await up.login(fam.name('uploader'));
  await p1.login(fam.name('parent1'));
  await p2.login(fam.name('parent2'));
  return { ...env, fam, other, up, p1, p2 };
}
const upload = (a, buf, k = key()) => a.post('/api/uploads').field('key', k).attach('photo', buf, 'p.jpg');

test(`[${suite}] auth: login, bad password generic, throttle, no signup`, async () => {
  const t = await setup();
  const a = agent(t.app);
  assert.equal((await a.login(t.fam.name('parent1'), 'wrong')).status, 401);
  assert.equal((await a.login('nobody', 'x')).status, 401);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await a.post('/api/signup').send({})).status, 404);
  const th = agent(t.app);
  let last;
  for (let i = 0; i < 7; i++) last = await th.login(t.fam.name('uploader'), 'bad');
  assert.equal(last.status, 429);
  assert.equal((await th.login(t.fam.name('uploader'))).status, 429); // locked even for the right password
  const me = await t.p1.get('/api/me');
  assert.equal(me.body.role, 'parent1');
});

test(`[${suite}] session: token stored hashed, logout kills it`, async () => {
  const t = await setup();
  const tok = t.p1.cookie.split('=')[1];
  const rows = (await t.db.query('SELECT token_hash FROM sessions')).rows;
  assert.ok(rows.length >= 3 && rows.every((r) => r.token_hash !== tok && r.token_hash.length === 64));
  assert.equal((await t.p1.post('/api/logout')).status, 200);
  assert.equal((await t.p1.get('/api/me')).status, 401);
});

test(`[${suite}] CSRF: mutation without header/origin rejected`, async () => {
  const t = await setup();
  const { default: request } = await import('supertest');
  const r = await request(t.app).post('/api/logout').set('Host', '127.0.0.1').set('Cookie', t.p1.cookie);
  assert.equal(r.status, 403);
  const r2 = await request(t.app).post('/api/logout').set('Host', '127.0.0.1').set('Cookie', t.p1.cookie).set('X-STM-Request', '1').set('Origin', 'https://evil.example');
  assert.equal(r2.status, 403);
  assert.equal((await t.p1.get('/api/me')).status, 200);
});

test('endpoint validation negatives', () => {
  const hosts = ['web.push.apple.com', 'fcm.googleapis.com'];
  const bad = [
    'http://web.push.apple.com/x', 'https://evil.com/x', 'https://web.push.apple.com.evil.com/x',
    'https://evilweb.push.apple.com/x', 'https://sub.web.push.apple.com/x', 'https://user:pw@web.push.apple.com/x',
    'https://web.push.apple.com:8443/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/x',
    'https://web.push.apple.com@evil.com/x', 'https://WEB.push.apple.com/x', '//web.push.apple.com/x', 'not a url', '', null, 123,
  ];
  for (const b of bad) assert.equal(validateEndpoint(b, hosts), false, String(b));
  assert.equal(validateEndpoint('https://web.push.apple.com/abc', hosts), true);
  assert.equal(validateEndpoint('https://fcm.googleapis.com/fcm/send/abc', hosts), true);
  assert.equal(validateEndpoint('https://web.push.apple.com:443/abc', hosts), false); // non-canonical form rejected
});

test(`[${suite}] subscriptions: parents only, forged endpoint rejected, unique, logout detaches`, async () => {
  const t = await setup();
  assert.equal((await t.up.post('/api/subscriptions').send(sub())).status, 403);
  assert.equal((await t.p1.post('/api/subscriptions').send(sub('https://127.0.0.1/x'))).status, 400);
  assert.equal((await t.p1.post('/api/subscriptions').send(sub())).status, 201);
  assert.equal((await t.p1.post('/api/subscriptions').send(sub())).status, 201); // repeat: no duplicate
  assert.equal((await t.db.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n, 1);
  // account switch on the same browser endpoint moves ownership
  assert.equal((await t.p2.post('/api/subscriptions').send(sub())).status, 201);
  const r = (await t.db.query('SELECT user_id FROM subscriptions')).rows;
  assert.equal(r.length, 1);
  assert.equal(r[0].user_id, t.fam.ids.parent2);
  await t.p2.post('/api/logout');
  assert.equal((await t.db.query('SELECT count(*)::int n FROM subscriptions')).rows[0].n, 0);
});

test(`[${suite}] upload happy path: durable record, generic payload, statuses not 'delivered', metadata stripped`, async () => {
  const t = await setup();
  await t.p1.post('/api/subscriptions').send(sub('https://web.push.apple.com/p1'));
  await t.p2.post('/api/subscriptions').send(sub('https://fcm.googleapis.com/fcm/send/p2'));
  const r = await upload(t.up, await jpegWithGps());
  assert.equal(r.status, 201);
  assert.equal(r.body.sends.length, 2);
  assert.ok(r.body.sends.every((s) => s.status === 'accepted_by_push_service'));
  assert.equal(t.calls.length, 2);
  const payload = JSON.parse(t.calls[0].payload);
  assert.deepEqual(Object.keys(payload).sort(), ['id', 'title', 'v']);
  assert.equal(payload.title, 'New upload ready');
  assert.equal(payload.id, r.body.id);
  const stored = (await t.db.query('SELECT image, content_type FROM uploads WHERE id=$1', [r.body.id])).rows[0];
  const m = await sharp(Buffer.from(stored.image)).metadata();
  assert.equal(m.format, 'jpeg');
  assert.equal(m.exif, undefined);
  assert.ok(!JSON.stringify(r.body).includes('delivered'));
});

test(`[${suite}] idempotent upload: same key -> one record, no extra sends`, async () => {
  const t = await setup();
  await t.p1.post('/api/subscriptions').send(sub());
  const k = key();
  const buf = await jpeg();
  const a = await upload(t.up, buf, k);
  const b = await upload(t.up, buf, k);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.duplicate, true);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 1);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM sends')).rows[0].n, 1);
  assert.equal(t.calls.length, 1);
  // concurrent same key
  const k2 = key();
  const [x, y] = await Promise.all([upload(t.up, buf, k2), upload(t.up, buf, k2)]);
  assert.equal(new Set([x.body.id, y.body.id]).size, 1);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 2);
});

test(`[${suite}] upload validation: rejects leave no upload or send rows`, async () => {
  const t = await setup();
  await t.p1.post('/api/subscriptions').send(sub());
  const count = async () => (await t.db.query('SELECT (SELECT count(*)::int FROM uploads) u, (SELECT count(*)::int FROM sends) s')).rows[0];
  // not an image
  assert.equal((await upload(t.up, Buffer.from('hello world'))).status, 400);
  // malformed jpeg
  assert.equal((await upload(t.up, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50, 1)]))).status, 400);
  // unsupported format (gif)
  const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).gif().toBuffer();
  assert.equal((await upload(t.up, gif)).status, 415);
  // excessive dimensions (decoded pixels over cap) from a tiny file
  const big = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
  assert.ok(big.length < 2 * 1024 * 1024);
  assert.equal((await upload(t.up, big)).status, 400);
  // oversized body
  assert.equal((await upload(t.up, Buffer.alloc(11 * 1024 * 1024, 0))).status, 413);
  // missing/invalid key, missing file
  assert.equal((await t.up.post('/api/uploads').field('key', 'x').attach('photo', await jpeg(), 'p.jpg')).status, 400);
  assert.equal((await t.up.post('/api/uploads').field('key', key())).status, 400);
  assert.deepEqual(await count(), { u: 0, s: 0 });
  assert.equal(t.calls.length, 0);
});

test(`[${suite}] roles: only uploader uploads; uploader cannot read others / images`, async () => {
  const t = await setup();
  assert.equal((await upload(t.p1, await jpeg())).status, 403);
  assert.equal((await upload(agent(t.app), await jpeg())).status, 401);
  const r = await upload(t.up, await jpeg());
  assert.equal((await t.up.get(`/api/uploads/${r.body.id}/image`)).status, 403);
  assert.equal((await t.up.get('/api/uploads')).status, 403);
  assert.equal((await t.up.get(`/api/uploads/${r.body.id}`)).status, 200);
});

test(`[${suite}] isolation: other family cannot see list, result, image, resend; direct URLs`, async () => {
  const t = await setup();
  const r = await upload(t.up, await jpeg());
  const id = r.body.id;
  const ob = agent(t.app), ou = agent(t.app);
  await ob.login(t.other.name('parent1'));
  await ou.login(t.other.name('uploader'));
  assert.equal((await ob.get(`/api/uploads/${id}`)).status, 404);
  assert.equal((await ob.get(`/api/uploads/${id}/image`)).status, 404);
  assert.equal((await ob.post(`/api/uploads/${id}/resend`).send({})).status, 404);
  assert.equal((await ou.get(`/api/uploads/${id}`)).status, 404);
  assert.deepEqual((await ob.get('/api/uploads')).body.uploads, []);
  assert.equal((await ob.get('/api/uploads/not-a-uuid/image')).status, 404);
  const own = await t.p1.get(`/api/uploads/${id}/image`);
  assert.equal(own.status, 200);
  assert.equal(own.headers['content-type'], 'image/jpeg');
  assert.match(own.headers['cache-control'], /no-store/);
  assert.equal((await agent(t.app).get(`/api/uploads/${id}/image`)).status, 401);
  // list never includes image bytes
  assert.ok(!JSON.stringify((await t.p1.get('/api/uploads')).body).includes('image'));
});

test(`[${suite}] dispatch boundary: failure keeps upload; 410 disables; timeout -> unknown; manual resend with duplicate warning`, async () => {
  let mode = 'ok';
  const sender = async (s) => {
    if (mode === 'gone') throw Object.assign(new Error('x'), { statusCode: 410 });
    if (mode === 'fail') throw Object.assign(new Error('x'), { statusCode: 500 });
    if (mode === 'timeout') throw Object.assign(new Error('x'), { timedOut: true });
    return { statusCode: 201 };
  };
  const t = await setup({ pushSender: sender });
  await t.p1.post('/api/subscriptions').send(sub('https://web.push.apple.com/p1'));
  await t.p2.post('/api/subscriptions').send(sub('https://web.push.apple.com/p2'));
  mode = 'fail';
  let r = await upload(t.up, await jpeg());
  assert.equal(r.status, 201);
  assert.ok(r.body.sends.every((s) => s.status === 'failed'));
  assert.equal((await t.p1.get(`/api/uploads/${r.body.id}/image`)).status, 200); // upload durable
  mode = 'ok';
  const rs = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.ok(rs.body.sends.every((s) => s.status === 'accepted_by_push_service'));
  // timeout -> unknown, retry requires confirmation
  mode = 'timeout';
  r = await upload(t.up, await jpeg());
  assert.ok(r.body.sends.every((s) => s.status === 'unknown'));
  mode = 'ok';
  const warn = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.equal(warn.status, 409);
  assert.equal(warn.body.error, 'possible_duplicate');
  const conf = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({ confirmDuplicate: true });
  assert.ok(conf.body.sends.every((s) => s.status === 'accepted_by_push_service'));
  // 410 disables the endpoint; later uploads skip it
  mode = 'gone';
  r = await upload(t.up, await jpeg());
  assert.ok(r.body.sends.every((s) => s.status === 'disabled_endpoint'));
  assert.equal((await t.db.query('SELECT count(*)::int n FROM subscriptions WHERE disabled_at IS NULL')).rows[0].n, 0);
  mode = 'ok';
  r = await upload(t.up, await jpeg());
  assert.equal(r.body.sends.length, 0);
});

test(`[${suite}] forged DB endpoint is never contacted (re-validated before send)`, async () => {
  const t = await setup();
  await t.p1.post('/api/subscriptions').send(sub());
  await t.db.query("UPDATE subscriptions SET endpoint='https://169.254.169.254/latest'");
  const r = await upload(t.up, await jpeg());
  assert.equal(t.calls.length, 0);
  assert.equal(r.body.sends[0].status, 'failed');
});

test(`[${suite}] pending intents survive crash: persisted before send, resend recovers`, async () => {
  let blow = true;
  const sender = async () => { if (blow) { blow = false; throw Object.assign(new Error('x'), { statusCode: 500 }); } return { statusCode: 201 }; };
  const t = await setup({ pushSender: sender });
  await t.p1.post('/api/subscriptions').send(sub());
  // simulate dyno death after commit: insert upload+pending directly
  const r = await upload(t.up, await jpeg());
  await t.db.query("UPDATE sends SET status='pending'");
  const list = await t.p1.get('/api/uploads');
  assert.equal(list.body.uploads[0].needs_attention, 1);
  const rs = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.equal(rs.body.sends[0].status, 'accepted_by_push_service');
});

test(`[${suite}] retention: expired uploads removed with sends (cascade)`, async () => {
  const t = await setup();
  t.config.cleanupIntervalMs = 0;
  await t.p1.post('/api/subscriptions').send(sub());
  const r = await upload(t.up, await jpeg());
  await t.db.query("UPDATE uploads SET expires_at = now() - interval '1 minute'");
  assert.equal((await t.p1.get(`/api/uploads/${r.body.id}`)).status, 404);
  await t.p1.get('/api/uploads'); // triggers request-time cleanup
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 0);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM sends')).rows[0].n, 0);
});

test(`[${suite}] headers and errors`, async () => {
  const t = await setup();
  const r = await agent(t.app).get('/healthz');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /default-src 'self'/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-powered-by'], undefined);
  const e = await agent(t.app).get('/api/nope');
  assert.deepEqual(e.body, { error: 'not_found' });
});

test(`[${suite}] rebind: endpoint moved to another family retires old sends; no cross-family leak or send`, async () => {
  const t = await setup();
  const bUp = agent(t.app), bP = agent(t.app);
  await bUp.login(t.other.name('uploader'));
  await bP.login(t.other.name('parent1'));
  // A registers; upload send fails (kept as failed intent)
  await t.p1.post('/api/subscriptions').send(sub('https://web.push.apple.com/shared'));
  const r = await upload(t.up, await jpeg());
  await t.db.query("UPDATE sends SET status='failed'");
  assert.equal(t.calls.length, 1);
  // B (other family) registers the same endpoint
  assert.equal((await bP.post('/api/subscriptions').send(sub('https://web.push.apple.com/shared'))).status, 201);
  const view = await t.p1.get(`/api/uploads/${r.body.id}`);
  assert.deepEqual(view.body.sends, []); // old-family history retired, B's name not exposed
  assert.ok(!JSON.stringify(view.body).includes(t.other.name('parent1')));
  const before = t.calls.length;
  const rs = await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.equal(t.calls.length, before); // A's upload never notifies B's endpoint
  assert.deepEqual(rs.body.sends, []);
  // new identity for B, and B's own uploads still notify it
  const rows = (await t.db.query('SELECT user_id FROM subscriptions')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, t.other.ids.parent1);
  const rb = await upload(bUp, await jpeg());
  assert.equal(rb.body.sends.length, 1);
  assert.equal(t.calls.length, before + 1);
});

test(`[${suite}] same-family account switch also retires old history; dispatch re-checks family`, async () => {
  const t = await setup();
  await t.p1.post('/api/subscriptions').send(sub('https://web.push.apple.com/s'));
  const r = await upload(t.up, await jpeg());
  await t.p2.post('/api/subscriptions').send(sub('https://web.push.apple.com/s'));
  assert.deepEqual((await t.p1.get(`/api/uploads/${r.body.id}`)).body.sends, []);
  // defense in depth: a forced cross-family send row is never dispatched
  const bP = agent(t.app);
  await bP.login(t.other.name('parent1'));
  await bP.post('/api/subscriptions').send(sub('https://web.push.apple.com/b'));
  const subB = (await t.db.query("SELECT id FROM subscriptions WHERE endpoint='https://web.push.apple.com/b'")).rows[0].id;
  const sid = crypto.randomUUID();
  await t.db.query("INSERT INTO sends (id, upload_id, subscription_id, status) VALUES ($1,$2,$3,'pending')", [sid, r.body.id, subB]);
  const n = t.calls.length;
  await t.p1.post(`/api/uploads/${r.body.id}/resend`).send({});
  assert.equal(t.calls.length, n);
  assert.equal((await t.db.query('SELECT status FROM sends WHERE id=$1', [sid])).rows[0].status, 'disabled_endpoint');
});

test(`[${suite}] HTTPS enforcement: http redirected to canonical origin / rejected before effects; https passes; local http unaffected`, async () => {
  const t = await setup();
  t.config.requireHttps = true;
  t.config.appOrigin = 'https://stm-relay.example.com';
  const { default: request } = await import('supertest');
  const before = (await t.db.query('SELECT count(*)::int n FROM sessions')).rows[0].n;
  // GET/HEAD over http -> 308 to the configured origin, whatever Host the client sent
  for (const path of ['/', '/login', '/api/me', '/healthz', '/uploads/abc?x=1']) {
    for (const host of ['stm-relay.example.com', 'evil.com', 'evil.com/x']) {
      const r = await request(t.app).get(path).set('Host', host);
      assert.equal(r.status, 308, path);
      assert.equal(r.headers.location, `https://stm-relay.example.com${path}`);
    }
  }
  assert.equal((await request(t.app).head('/login').set('Host', 'evil.com')).headers.location, 'https://stm-relay.example.com/login');
  // protocol-relative style path cannot change the destination origin
  const pr = await request(t.app).get('//evil.com/x').set('Host', 'stm-relay.example.com');
  assert.equal(pr.status, 426); // protocol-relative path is never turned into a redirect
  assert.equal(pr.headers.location, undefined);
  // credential / mutation over http: rejected unread, not redirected, no cookie, no effects
  for (const m of ['post', 'delete']) {
    const r = await request(t.app)[m]('/api/login').set('Host', 'stm-relay.example.com').set('Origin', 'http://stm-relay.example.com').set('X-STM-Request', '1').send({ username: t.fam.name('parent1'), password: PW });
    assert.equal(r.status, 426);
    assert.equal(r.headers.location, undefined);
    assert.equal(r.headers['set-cookie'], undefined);
  }
  const up = await request(t.app).post('/api/uploads').set('Host', 'stm-relay.example.com').set('Cookie', t.up.cookie).set('X-STM-Request', '1').set('Origin', 'http://stm-relay.example.com').field('key', key()).attach('photo', await jpeg(), 'p.jpg');
  assert.equal(up.status, 426);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM sessions')).rows[0].n, before);
  assert.equal((await t.db.query('SELECT count(*)::int n FROM uploads')).rows[0].n, 0);
  // behind Heroku's router: forwarded https passes, with HSTS
  const ok = await request(t.app).get('/healthz').set('Host', 'stm-relay.example.com').set('X-Forwarded-Proto', 'https');
  assert.equal(ok.status, 200);
  assert.match(ok.headers['strict-transport-security'], /max-age=\d+/);
  // ambiguous / mixed / duplicate forwarded-proto chains are treated as insecure (every value must be exactly https)
  for (const xfp of ['https, http', 'http, https', 'https,http', 'http', 'HTTP', 'ws', 'https;proto=http', ' ', 'httpss', 'https, https, http', 'garbage, https', 'https, garbage', '']) {
    const g = await request(t.app).get('/login').set('Host', 'stm-relay.example.com').set('X-Forwarded-Proto', xfp);
    assert.ok([308, 426].includes(g.status), `GET xfp=${JSON.stringify(xfp)} got ${g.status}`);
    assert.notEqual(g.status, 200, xfp);
    const p = await request(t.app).post('/api/login').set('Host', 'stm-relay.example.com').set('X-Forwarded-Proto', xfp).send({});
    assert.equal(p.status, 426, `POST xfp=${JSON.stringify(xfp)}`);
  }
  // consistent duplicates of https pass
  const dup = await request(t.app).get('/healthz').set('Host', 'stm-relay.example.com').set('X-Forwarded-Proto', 'https, https');
  assert.equal(dup.status, 200);
  // invalid configured origins fail closed (GET rejected, never redirected anywhere)
  for (const bad of ['http://stm-relay.example.com', 'https://stm-relay.example.com/path', 'https://user@stm-relay.example.com', 'https://stm-relay.example.com?x=1', 'https://stm-relay.example.com#f', 'https://stm-relay.example.com:443', 'https://stm-relay.example.com:8443', 'https://stm-relay.example.com:0', 'https://stm-relay.example.com:99999', 'https://stm-relay.example.com:999999', 'https://user:pw@stm-relay.example.com', '//stm-relay.example.com', 'stm-relay.example.com', '', 'https://stm-relay.example.com ']) {
    t.config.appOrigin = bad;
    const g = await request(t.app).get('/login').set('Host', 'stm-relay.example.com');
    assert.equal(g.status, 426, `origin ${JSON.stringify(bad)}`);
    assert.equal(g.headers.location, undefined);
  }
  t.config.appOrigin = 'https://stm-relay.example.com';
  // missing APP_ORIGIN: GET is rejected, never redirected to a guessed host
  t.config.appOrigin = null;
  assert.equal((await request(t.app).get('/login').set('Host', 'stm-relay.example.com')).status, 426);
  // local dev mode keeps plain http working
  t.config.requireHttps = false;
  assert.equal((await request(t.app).get('/healthz')).status, 200);
  assert.equal((await t.up.get('/api/me')).status, 200);
});

test('production config defaults and canonical origin validation', async () => {
  const { loadConfig, validateAppOrigin } = await import('../src/config.js');
  assert.equal(loadConfig({}).requireHttps, true);
  assert.equal(loadConfig({ INSECURE_COOKIES: '1' }).requireHttps, false);
  assert.equal(loadConfig({}).secureCookies, true);
  assert.equal(loadConfig({}).appOrigin, null);
  assert.equal(loadConfig({ APP_ORIGIN: 'https://x.example.com' }).appOrigin, 'https://x.example.com');
  assert.equal(validateAppOrigin('https://a.example.com'), 'https://a.example.com');
  for (const bad of ['https://a.example.com:8443', 'https://a.example.com:999999', 'https://a.example.com:80', 'https://a.example.com:', 'https://[::1]', 'https://127.0.0.1:3000', 'https://a.example.com/', 'https://a.example.com:443', 'http://a.example.com', 'https://a.example.com/p', 'https://u:p@a.example.com', 'https://a.example.com?q', 'https://a.example.com#h', 'https://-a.example.com', 'https://a.example.com:70000', ' https://a.example.com', null, undefined, 5]) {
    assert.equal(validateAppOrigin(bad), null, String(bad));
  }
});

test(`[${suite}] seed from hashes: format validated, login works, refuses second seed, no plaintext path`, async () => {
  const { seedFromHashes, validateHashes } = await import('../src/seed.js');
  const { hashPassword } = await import('../src/security.js');
  const env = await makeEnv({ real });
  const h = { uploader: await hashPassword('uploader-pass-111'), parent1: await hashPassword('parent1-pass-2222'), parent2: await hashPassword('parent2-pass-3333') };
  assert.throws(() => validateHashes({ ...h, parent1: 'plaintext-password' }), /invalid hash format for parent1/);
  assert.throws(() => validateHashes({ ...h, parent2: h.parent1 }), /differ/);
  assert.throws(() => validateHashes({ uploader: h.uploader }), /invalid hash/);
  await seedFromHashes(env.db, h);
  const a = agent(env.app);
  assert.equal((await a.login('parent1', 'parent1-pass-2222')).status, 200);
  assert.equal((await agent(env.app).login('parent1', 'uploader-pass-111')).status, 401);
  assert.equal((await agent(env.app).login('uploader', 'uploader-pass-111')).status, 200);
  await assert.rejects(seedFromHashes(env.db, h), /already seeded/);
  assert.equal((await env.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 3);
  const src = (await import('node:fs')).readFileSync(new URL('../scripts/seed-local.js', import.meta.url), 'utf8');
  assert.ok(!/['"]--?[a-z-]*pass/i.test(src.replace(/'Password for/g, '')), 'no password in argv');
  assert.match(src, /child\.stdin\.end\(JSON\.stringify\(hashes\)\)/);
  assert.ok(!/env\s*:/.test(src), 'child env not used to carry secrets');
});

test(`[${suite}] HTTPS: truly duplicated X-Forwarded-Proto headers (raw) and missing header are insecure unless all values are https`, async () => {
  const t = await setup();
  t.config.requireHttps = true;
  t.config.appOrigin = 'https://stm-relay.example.com';
  const http = await import('node:http');
  const server = http.createServer(t.app).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const raw = (method, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/login', method, headers: { Host: 'stm-relay.example.com', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  // rawHeaders lets us send the same header name twice
  const dup = (method, vals) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/login', method, headers: [['Host', 'stm-relay.example.com'], ...vals.map((v) => ['X-Forwarded-Proto', v])] }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal(await raw('GET', {}), 308); // header missing, plain socket
    assert.equal(await raw('POST', {}), 426);
    assert.equal(await dup('GET', ['https', 'http']), 308);
    assert.equal(await dup('GET', ['http', 'https']), 308);
    assert.equal(await dup('POST', ['https', 'http']), 426);
    assert.equal(await dup('POST', ['http', 'https']), 426);
    assert.equal(await dup('GET', ['garbage', 'https']), 308);
    assert.equal(await dup('GET', ['https', 'https']), 200); // all values https -> served
  } finally {
    server.close();
  }
});

test('server startup refuses to boot in production without a valid APP_ORIGIN (fail closed)', async () => {
  const { spawnSync } = await import('node:child_process');
  const base = { PATH: process.env.PATH, DATABASE_URL: 'postgres://invalid.invalid/none', VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:t@example.com' };
  const cases = [undefined, '', 'http://a.example.com', 'https://a.example.com:999999', 'https://a.example.com:8443', 'https://a.example.com/x', 'https://u@a.example.com', 'a.example.com'];
  for (const origin of cases) {
    const env = { ...base, ...(origin === undefined ? {} : { APP_ORIGIN: origin }) };
    const r = spawnSync(process.execPath, ['src/server.js'], { env, cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 1, `origin ${JSON.stringify(origin)}`);
    assert.match(r.stderr, /APP_ORIGIN must be a canonical https origin/);
    assert.ok(!r.stderr.includes('invalid.invalid'), 'no DB connection attempted');
  }
});

test('password rule is shared: boundaries 11/12/200/201, and a 200-char password can log in', async () => {
  const { passwordProblem, MAX_PASSWORD_LEN, MIN_PASSWORD_LEN, hashPassword, verifyPassword } = await import('../src/security.js');
  assert.equal(MIN_PASSWORD_LEN, 12);
  assert.equal(MAX_PASSWORD_LEN, 200);
  assert.match(passwordProblem('a'.repeat(11)), /short/i);
  assert.equal(passwordProblem('a'.repeat(12)), null);
  assert.equal(passwordProblem('a'.repeat(200)), null);
  assert.match(passwordProblem('a'.repeat(201)), /long/i);
  assert.match(passwordProblem(undefined), /text/i);
  // every accepted password verifies; nothing accepted by the rule is rejected by login
  for (const n of [12, 200]) {
    const pw = 'x'.repeat(n);
    assert.equal(await verifyPassword(pw, await hashPassword(pw)), true, String(n));
  }
  assert.equal(await verifyPassword('x'.repeat(201), await hashPassword('x'.repeat(201))), false); // why the cap must be enforced at seeding
  const fs = await import('node:fs');
  for (const f of ['scripts/seed-local.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(src, /passwordProblem/, f);
    assert.ok(!/\.length\s*<\s*12/.test(src), `${f} must use the shared rule`);
  }
});

test('legacy plaintext seed entrypoint is gone; seed-hashed validates before touching the DB and never echoes input', async () => {
  const fs = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  assert.equal(fs.existsSync(new URL('../scripts/seed.js', import.meta.url)), false);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.seed, undefined);
  for (const f of ['docs/wiki.md', '.env.example', 'README.md']) {
    const txt = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/SEED_(UPLOADER|PARENT1|PARENT2)_PW/.test(txt), `${f} must not reference plaintext seed env vars`);
    assert.ok(!/npm run seed(?!:)/.test(txt), `${f} must not reference the removed npm seed script`);
  }
  const { hashPassword } = await import('../src/security.js');
  const good = { uploader: await hashPassword('uploader-pass-111'), parent1: await hashPassword('parent1-pass-2222'), parent2: await hashPassword('parent2-pass-3333') };
  const SENTINEL = 'SECRET-PLAINTEXT-SENTINEL-9f3a';
  const run = (input) => spawnSync(process.execPath, ['scripts/seed-hashed.js'], { input, env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://invalid.invalid/none' }, cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 15000 });
  const cases = {
    'not json': SENTINEL,
    'plaintext instead of hash': JSON.stringify({ ...good, parent1: SENTINEL }),
    'missing role': JSON.stringify({ uploader: good.uploader, parent1: good.parent1 }),
    'duplicate hashes': JSON.stringify({ ...good, parent2: good.parent1 }),
    'truncated hash': JSON.stringify({ ...good, parent2: good.parent2.slice(0, 40) }),
    'array': JSON.stringify([good.uploader]),
  };
  for (const [name, input] of Object.entries(cases)) {
    const r = run(input);
    assert.equal(r.status, 1, name);
    assert.ok(!(r.stdout + r.stderr).includes(SENTINEL), `${name}: input must never be echoed`);
    assert.ok(!(r.stdout + r.stderr).includes('invalid.invalid'), `${name}: must fail before any DB connection`);
  }
  const src = fs.readFileSync(new URL('../scripts/seed-local.js', import.meta.url), 'utf8');
  assert.match(src, /process\.on\('exit', restoreTty\)/);
  assert.match(src, /'SIGINT'/);
  assert.match(src, /setRawMode\(false\)/);
});

test(`[${suite}] seed is atomic: a failure on the 3rd user insert rolls back the family and earlier users`, async () => {
  const { seedFromHashes } = await import('../src/seed.js');
  const { hashPassword } = await import('../src/security.js');
  const env = await makeEnv({ real });
  const h = { uploader: await hashPassword('uploader-pass-111'), parent1: await hashPassword('parent1-pass-2222'), parent2: await hashPassword('parent2-pass-3333') };
  // Wrap the real db so the 3rd users INSERT inside seedFromHashes' own transaction fails.
  let users = 0;
  const failing = { ...env.db, tx: (fn) => env.db.tx((t) => fn({ query: (q, p) => { if (/INSERT INTO users/.test(q) && ++users === 3) throw new Error('boom'); return t.query(q, p); } })) };
  await assert.rejects(seedFromHashes(failing, h), /boom/);
  assert.equal(users, 3);
  assert.equal((await env.db.query('SELECT count(*)::int n FROM families')).rows[0].n, 0);
  assert.equal((await env.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 0);
  await seedFromHashes(env.db, h); // a clean retry succeeds
  assert.equal((await env.db.query('SELECT count(*)::int n FROM users')).rows[0].n, 3);
  await assert.rejects(seedFromHashes(env.db, h), /already seeded/); // one-time
});
