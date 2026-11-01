import { test, expect, waitFor } from './harness/fixtures.mjs';

test.describe('AI off (legacy relay)', () => {
  test('upload pushes immediately with a generic payload and creates no journal result', async ({ bb }) => {
    const s = await bb.start({ ai: false });
    expect(s.aiState()).toBe('off');
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const p2 = await bb.login(s, u.parent2);
    const sub1 = await bb.subscribe(p1);
    const sub2 = await bb.subscribe(p2);

    const up = await bb.upload(child);
    await test.step('Then the upload response already reports the sends', async () => {
      expect(up.status).toBe(201);
      expect(up.body.state).toBeUndefined();
      expect(up.body.sends.map((x) => x.status).sort()).toEqual(['accepted_by_push_service', 'accepted_by_push_service']);
    });
    await test.step('And each parent got exactly one generic push naming only the upload id', async () => {
      for (const sub of [sub1, sub2]) {
        const got = sub.received();
        expect(got).toHaveLength(1);
        expect(sub.decrypt(got[0])).toEqual({ v: 1, title: 'New upload ready', id: up.body.id });
      }
    });
    await test.step('And no AI call and no journal panel', async () => {
      expect(bb.fakes.aiCalls).toHaveLength(0);
      const d = await bb.journal(p1, up.body.id);
      expect(d.journal).toBeNull();
      const list = (await (await p1.get('/api/uploads')).json()).uploads;
      expect(list[0].analysis_status).toBeNull();
      expect(list[0].paused).toBe(false);
    });
  });

  test('a push service 410 disables that device; later uploads skip it', async ({ bb }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const p2 = await bb.login(s, u.parent2);
    const gone = await bb.subscribe(p1);
    const live = await bb.subscribe(p2);
    bb.fakes.setPushStatus(gone.path, 410);

    const first = await bb.upload(child, { seed: 1 });
    expect(first.status).toBe(201);
    const byParent = Object.fromEntries(first.body.sends.map((x) => [x.parent, x.status]));
    expect(byParent[u.parent1]).toBe('disabled_endpoint');
    expect(byParent[u.parent2]).toBe('accepted_by_push_service');

    const second = await bb.upload(child, { seed: 2 });
    expect(second.body.sends.map((x) => x.parent)).toEqual([u.parent2]);
    expect(gone.received()).toHaveLength(1);
    expect(live.received()).toHaveLength(2);
  });

  test('a failed push leaves the upload available in the inbox', async ({ bb }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    bb.fakes.setPushStatus(sub.path, 500);
    const up = await bb.upload(child);
    expect(up.status).toBe(201);
    expect(up.body.sends[0].status).toBe('failed');
    const list = (await (await p1.get('/api/uploads')).json()).uploads;
    expect(list.map((x) => x.id)).toEqual([up.body.id]);
    expect(list[0].needs_attention).toBe(1);
    expect((await p1.get(`/api/uploads/${up.body.id}/image`)).status()).toBe(200);
    await waitFor(async () => sub.received().length === 1, { what: 'one push attempt' });
  });
});
