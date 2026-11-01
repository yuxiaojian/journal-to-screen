// Failure paths with the production timings (45 s call deadline, 90 s lease, 60 s sweep, 20 s retry delay).
// No timing is shortened: these tests are deliberately slow and run in parallel workers.
import { test, expect, waitFor } from './harness/fixtures.mjs';

const W = (n) => Array.from({ length: n }, (_, i) => ['red', 'blue', 'green', 'gold', 'pink'][i % 5]).join(' ');
const SLOW = 300_000;

test.describe('reliability', () => {
  test('duplicates and the daily cap: same key in parallel is one upload; the 11th new page is refused', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.setDefaultAi({ transcript: W(70) });
    for (let i = 0; i < 9; i += 1) expect((await bb.upload(child, { seed: 200 + i })).status).toBe(201);
    await test.step('When the 10th page is sent twice at once with the same key', async () => {
      const key = 'samekey-parallel-0001';
      const [a, b] = await Promise.all([bb.upload(child, { key, seed: 300 }), bb.upload(child, { key, seed: 300 })]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.id).toBe(b.body.id);
      expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
    });
    await test.step('Then a repeat of that key is still accepted as a duplicate, and a new key is refused', async () => {
      expect((await bb.upload(child, { key: 'samekey-parallel-0001', seed: 300 })).status).toBe(200);
      const over = await bb.upload(child, { seed: 999 });
      expect(over.status).toBe(429);
      expect(over.body.error).toBe('daily_limit');
    });
    await test.step('And exactly 10 pages were read', async () => {
      await waitFor(async () => {
        const list = (await (await p1.get('/api/uploads')).json()).uploads;
        return list.length === 10 && list.every((x) => x.analysis_status === 'ready');
      }, { timeout: 60_000, what: '10 ready results' });
      expect(bb.fakes.aiCalls).toHaveLength(10);
    });
  });

  test('a provider 5xx is retried once and then succeeds', async ({ bb }) => {
    test.setTimeout(SLOW);
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    bb.fakes.scriptAi({ status: 529 }, { transcript: W(120) });
    const up = await bb.upload(child);
    const d = await bb.waitTerminal(p1, up.body.id, { timeout: 240_000 });
    expect(d.journal.status).toBe('ready');
    expect(d.journal.attempts).toBe(2);
    expect(d.journal.original.suggestedMinutes).toBe(60);
    expect(bb.fakes.aiCalls).toHaveLength(2);
    await waitFor(async () => sub.received().length === 1, { what: 'one terminal push' });
  });

  test('two invalid outputs end as failed with one push and no third call', async ({ bb }) => {
    test.setTimeout(SLOW);
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    bb.fakes.scriptAi({ invalid: true }, { invalid: true }, { transcript: W(70) });
    const up = await bb.upload(child);
    const d = await bb.waitTerminal(p1, up.body.id, { timeout: 240_000 });
    expect(d.journal.status).toBe('failed');
    expect(d.journal.error).toBe('invalid_output');
    expect(d.journal.original).toBeNull();
    await waitFor(async () => sub.received().length === 1, { what: 'one terminal push' });
    await new Promise((r) => setTimeout(r, 2000));
    expect(bb.fakes.aiCalls).toHaveLength(2);
  });

  test('a hanging provider is cut off by the deadline; two attempts at most', async ({ bb }) => {
    test.setTimeout(360_000);
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.scriptAi({ hang: true }, { hang: true }, { transcript: W(70) });
    const up = await bb.upload(child);
    await waitFor(async () => bb.fakes.aiCalls.length === 1, { what: 'first call' });
    const t0 = bb.fakes.aiCalls[0].at;
    const d = await bb.waitTerminal(p1, up.body.id, { timeout: 330_000 });
    expect(d.journal.status).toBe('failed');
    expect(d.journal.error).toBe('timeout');
    expect(bb.fakes.aiCalls).toHaveLength(2);
    // the second attempt only starts after the first attempt's 90 s lease (the slot is held after an unclear outcome)
    expect(bb.fakes.aiCalls[1].at - t0).toBeGreaterThanOrEqual(85_000);
  });

  test('the monthly budget ceiling refuses before any AI call', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    // fixture precondition: this UTC month's planning ceiling (USD 5) is already fully reserved
    await bb.sql("INSERT INTO ai_budget_months (month, reserved_micro) VALUES (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 5000000)");
    const up = await bb.upload(child);
    expect(up.status).toBe(201);
    const d = await bb.waitTerminal(p1, up.body.id);
    expect(d.journal.status).toBe('failed');
    expect(d.journal.error).toBe('budget');
    await waitFor(async () => sub.received().length === 1, { what: 'terminal push' });
    expect(bb.fakes.aiCalls).toHaveLength(0);
  });

  test('a restart mid-reading recovers after the lease, with one result and one push', async ({ bb }) => {
    test.setTimeout(SLOW);
    let s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    let p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    bb.fakes.scriptAi({ hold: true, then: { transcript: W(10) } }, { transcript: W(130) });
    const up = await bb.upload(child);
    await waitFor(async () => bb.fakes.aiCalls.length === 1, { what: 'first call' });
    await test.step('When the server dies during the call and comes back', async () => {
      s = await bb.restart(s, { ai: true });
      p1 = await bb.login(s, u.parent1);
      bb.fakes.releaseHolds(); // the old process is gone: this late answer has nobody to receive it
    });
    await test.step('Then the page is read again after the lease and finishes once', async () => {
      const d = await bb.waitTerminal(p1, up.body.id, { timeout: 240_000 });
      expect(d.journal.status).toBe('ready');
      expect(d.journal.original.wordCount).toBe(130);
      expect(d.journal.attempts).toBe(2);
      expect(bb.fakes.aiCalls).toHaveLength(2);
      await waitFor(async () => sub.received().length === 1, { what: 'one terminal push' });
      await new Promise((r) => setTimeout(r, 2000));
      expect(sub.received()).toHaveLength(1);
    });
  });

  test('an upload that expires before it is read is never sent to the AI', async ({ bb }) => {
    test.setTimeout(SLOW);
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    bb.fakes.scriptAi({ hold: true, then: { transcript: W(70) } });
    const first = await bb.upload(child, { seed: 1 }); // occupies the single job slot
    const second = await bb.upload(child, { seed: 2 }); // waits in the queue
    await waitFor(async () => bb.fakes.aiCalls.length === 1, { what: 'first call' });
    await bb.sql("UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = $1", [second.body.id]);
    bb.fakes.releaseHolds();
    const p = await bb.login(s, u.parent1);
    await bb.waitTerminal(p, first.body.id);
    await new Promise((r) => setTimeout(r, 3000));
    expect(bb.fakes.aiCalls).toHaveLength(1);
    expect((await p.get(`/api/uploads/${second.body.id}`)).status()).toBe(404);
  });
});
