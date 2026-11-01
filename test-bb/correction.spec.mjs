import { test, expect } from './harness/fixtures.mjs';

const W = (n) => Array.from({ length: n }, (_, i) => ['sun', 'tree', 'bird', 'lake', 'hill'][i % 5]).join(' ');

test.describe('parent correction', () => {
  test('correction recomputes count and suggestion and keeps the original', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.scriptAi({ transcript: W(70) });
    const up = await bb.upload(child);
    const before = await bb.waitTerminal(p1, up.body.id);
    const expiresBefore = before.upload.expires_at;

    const r = await p1.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(120), version: before.journal.version } });
    expect(r.status()).toBe(200);
    const after = (await bb.journal(p1, up.body.id));
    expect(after.journal.corrected.wordCount).toBe(120);
    expect(after.journal.corrected.suggestedMinutes).toBe(60);
    expect(after.journal.original.wordCount).toBe(70);
    expect(after.journal.original.transcript).toBe(W(70));
    expect(after.journal.original.suggestedMinutes).toBe(45);
    expect(after.upload.expires_at).toBe(expiresBefore);
    // the second parent sees the same corrected state
    const p2 = await bb.login(s, u.parent2);
    expect((await bb.journal(p2, up.body.id)).journal.corrected.wordCount).toBe(120);
  });

  test('concurrent corrections: the stale one gets 409 and changes nothing', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const p2 = await bb.login(s, u.parent2);
    bb.fakes.scriptAi({ transcript: W(70) });
    const up = await bb.upload(child);
    const d = await bb.waitTerminal(p1, up.body.id);
    const v = d.journal.version;
    const [a, b] = await Promise.all([
      p1.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(110), version: v } }),
      p2.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(160), version: v } }),
    ]);
    const statuses = [a.status(), b.status()].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status() === 409 ? a : b;
    expect((await loser.json()).error).toBe('version_conflict');
    const winnerCount = a.status() === 200 ? 110 : 160;
    expect((await bb.journal(p1, up.body.id)).journal.corrected.wordCount).toBe(winnerCount);
  });

  test('expired uploads are not viewable or correctable', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.scriptAi({ transcript: W(70) });
    const up = await bb.upload(child);
    const d = await bb.waitTerminal(p1, up.body.id);
    // fixture precondition: move this upload past its 7-day expiry
    await bb.sql("UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = $1", [up.body.id]);
    expect((await p1.get(`/api/uploads/${up.body.id}`)).status()).toBe(404);
    expect((await p1.get(`/api/uploads/${up.body.id}/image`)).status()).toBe(404);
    expect((await p1.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(90), version: d.journal.version } })).status()).toBe(404);
    expect((await (await p1.get('/api/uploads')).json()).uploads).toEqual([]);
  });

  test('correction is refused while the page is still being read', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.scriptAi({ hold: true, then: { transcript: W(70) } });
    const up = await bb.upload(child);
    const d = await bb.journal(p1, up.body.id);
    const r = await p1.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(90), version: d.journal.version } });
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toBe('not_correctable');
    bb.fakes.releaseHolds();
    await bb.waitTerminal(p1, up.body.id);
  });
});
