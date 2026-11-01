import { test, expect } from './harness/fixtures.mjs';

test.describe('auth and access', () => {
  test('login sets a hardened session cookie; logout ends the session', async ({ bb }) => {
    const s = await bb.start();
    const u = await bb.seedFamily('a');
    const c = await bb.client(s);
    await test.step('Given no session, private endpoints refuse', async () => {
      expect((await c.get('/api/me')).status()).toBe(401);
      expect((await c.get('/api/uploads')).status()).toBe(401);
    });
    await test.step('When a parent logs in with a wrong password, it fails', async () => {
      expect((await c.post('/api/login', { data: { username: u.parent1, password: 'wrong-password-x' } })).status()).toBe(401);
    });
    await test.step('When the parent logs in correctly, the cookie is HttpOnly and SameSite=Lax', async () => {
      const r = await c.post('/api/login', { data: { username: u.parent1, password: 'bb-synthetic-password-1' } });
      expect(r.status()).toBe(200);
      const cookie = r.headers()['set-cookie'];
      expect(cookie).toMatch(/stm_session=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(await (await c.get('/api/me')).json()).toEqual({ username: u.parent1, role: 'parent1' });
    });
    await test.step('Then logout invalidates the session', async () => {
      expect((await c.post('/api/logout')).status()).toBe(200);
      expect((await c.get('/api/me')).status()).toBe(401);
    });
  });

  test('roles: uploader cannot use parent endpoints and parents cannot upload', async ({ bb }) => {
    const s = await bb.start();
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const parent = await bb.login(s, u.parent1);
    expect((await child.get('/api/uploads')).status()).toBe(403);
    expect((await child.post('/api/subscriptions', { data: {} })).status()).toBe(403);
    expect((await bb.upload(parent)).status).toBe(403);
    const up = await bb.upload(child);
    expect(up.status).toBe(201);
    expect((await child.get(`/api/uploads/${up.body.id}/image`)).status()).toBe(403);
    expect((await child.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: 'x', version: 1 } })).status()).toBe(403);
  });

  test('family isolation: another family sees nothing', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    bb.fakes.setDefaultAi({ transcript: 'one two three' });
    const a = await bb.seedFamily('a');
    const b = await bb.seedFamily('b');
    const childA = await bb.login(s, a.uploader);
    const parentB = await bb.login(s, b.parent1);
    const up = await bb.upload(childA);
    expect(up.status).toBe(201);
    const parentA = await bb.login(s, a.parent1);
    await bb.waitTerminal(parentA, up.body.id);
    const id = up.body.id;
    expect((await (await parentB.get('/api/uploads')).json()).uploads).toEqual([]);
    expect((await parentB.get(`/api/uploads/${id}`)).status()).toBe(404);
    expect((await parentB.get(`/api/uploads/${id}/image`)).status()).toBe(404);
    expect((await parentB.post(`/api/uploads/${id}/correction`, { data: { transcript: 'hacked text here', version: 2 } })).status()).toBe(404);
    // and the owning family's data is unchanged by the attempt
    const d = await bb.journal(parentA, id);
    expect(d.journal.corrected).toBeNull();
  });

  test('CSRF: mutations need the app header and a same-origin Origin', async ({ bb }) => {
    const s = await bb.start();
    const u = await bb.seedFamily('a');
    const bare = await bb.client(s, { csrfHeaders: false });
    expect((await bare.post('/api/login', { data: { username: u.parent1, password: 'bb-synthetic-password-1' } })).status()).toBe(403);
    expect((await bare.post('/api/login', {
      headers: { 'X-STM-Request': '1', Origin: 'https://evil.example' },
      data: { username: u.parent1, password: 'bb-synthetic-password-1' },
    })).status()).toBe(403);
    expect((await bare.post('/api/login', {
      headers: { Origin: s.base },
      data: { username: u.parent1, password: 'bb-synthetic-password-1' },
    })).status()).toBe(403);
  });
});
