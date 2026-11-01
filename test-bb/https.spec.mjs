import { test, expect } from './harness/fixtures.mjs';
import { startExpectingExit } from './harness/server.mjs';
import { makeVapidKeys } from './harness/webpush-decrypt.mjs';

const ORIGIN = 'https://bb-app.example.test';

test.describe('production mode and startup config', () => {
  test('plain http is redirected or refused; forwarded https is served with HSTS', async ({ bb }) => {
    const s = await bb.start({ https: { appOrigin: ORIGIN } });
    const c = await bb.client(s, { csrfHeaders: false });
    const get = await c.get('/login?x=1');
    expect(get.status()).toBe(308);
    expect(get.headers().location).toBe(`${ORIGIN}/login?x=1`);
    const evilHost = await c.get('/inbox', { headers: { Host: 'evil.example' } });
    expect(evilHost.headers().location).toBe(`${ORIGIN}/inbox`);
    expect((await c.post('/api/login', { data: { username: 'x', password: 'y' } })).status()).toBe(426);
    for (const xfp of ['http', 'https, http', 'http, https', 'garbage', '']) {
      const r = await c.get('/healthz', { headers: { 'X-Forwarded-Proto': xfp } });
      expect(r.status(), `X-Forwarded-Proto=${JSON.stringify(xfp)}`).toBe(308);
    }
    const ok = await c.get('/healthz', { headers: { 'X-Forwarded-Proto': 'https' } });
    expect(ok.status()).toBe(200);
    expect(ok.headers()['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(ok.headers()['content-security-policy']).toContain("default-src 'self'");
  });

  test('startup fails closed on unsafe config; AI stays off without a key', async ({ bb }) => {
    const vapid = makeVapidKeys();
    const base = {
      DATABASE_URL: bb.dbUrl, PGSSL: '0', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:bb@example.invalid',
    };
    for (const appOrigin of [undefined, 'http://bb-app.example.test', 'https://bb-app.example.test:8443', 'https://bb-app.example.test/path']) {
      const env = { ...base, ...(appOrigin ? { APP_ORIGIN: appOrigin } : {}) };
      const r = await startExpectingExit({ fakeUrl: bb.fakes.url, env });
      expect(r.code, `APP_ORIGIN=${appOrigin}`).toBe(1);
      expect(r.logs).toContain('APP_ORIGIN');
    }
    const noKey = await startExpectingExit({ fakeUrl: bb.fakes.url, env: { ...base, INSECURE_COOKIES: '1', VAPID_SUBJECT: 'nope' } });
    expect(noKey.code).toBe(1);
    const s = await bb.start({ ai: false, extraEnv: { AI_ENABLED: '1' } }); // enabled, but no key
    expect(s.aiState()).toBe('off');
    expect(s.logs.join('\n')).toContain('AI stays off');
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    expect((await bb.upload(child)).body.state).toBeUndefined(); // legacy relay path, no analysis
    expect(bb.fakes.aiCalls).toHaveLength(0);
  });
});
