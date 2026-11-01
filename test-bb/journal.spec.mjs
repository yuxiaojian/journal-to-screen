import { test, expect, waitFor } from './harness/fixtures.mjs';

// Hand-written word lists. Expected counts and minutes are stated literally here, never computed by app code.
const W = (n) => Array.from({ length: n }, (_, i) => ['apple', 'river', 'stone', 'cloud', 'maple'][i % 5]).join(' ');

test.describe('AI on: journal reading', () => {
  test('upload returns before analysis; one generic push only after the result exists', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    expect(s.aiState()).toBe('on');
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const sub = await bb.subscribe(p1);
    bb.fakes.scriptAi({ hold: true, then: { transcript: `Today I went to the park. ${W(60)}` } });

    const up = await bb.upload(child);
    await test.step('Then the upload is accepted as processing, with no push yet', async () => {
      expect(up.status).toBe(201);
      expect(up.body.state).toBe('processing');
      await waitFor(async () => bb.fakes.aiCalls.length === 1, { what: 'AI call' });
      const d = await bb.journal(p1, up.body.id);
      expect(d.journal.status).toBe('processing');
      expect(sub.received()).toHaveLength(0);
    });
    await test.step('When the AI answers, the parent gets exactly one generic push', async () => {
      bb.fakes.releaseHolds();
      const d = await bb.waitTerminal(p1, up.body.id);
      expect(d.journal.status).toBe('ready');
      await waitFor(async () => sub.received().length === 1, { what: 'terminal push' });
      expect(sub.decrypt(sub.received()[0])).toEqual({ v: 1, title: 'New upload ready', id: up.body.id });
      await new Promise((r) => setTimeout(r, 1000));
      expect(sub.received()).toHaveLength(1);
    });
    await test.step('And the parent sees the literal transcript, count and suggestion; the child sees status only', async () => {
      const d = await bb.journal(p1, up.body.id);
      expect(d.journal.original.transcript).toBe(`Today I went to the park. ${W(60)}`);
      expect(d.journal.original.wordCount).toBe(66);
      expect(d.journal.original.suggestedMinutes).toBe(45);
      const c = await bb.journal(child, up.body.id);
      expect(c.journal).toEqual({ state: 'sent' });
      expect(JSON.stringify(c)).not.toContain('park');
    });
    await test.step('And the AI request carried only the page image and fixed instructions', async () => {
      const req = bb.fakes.aiCalls[0].body;
      expect(req.model).toBe('claude-haiku-5-5');
      expect(req.tool_choice).toEqual({ type: 'tool', name: 'record_transcript' });
      const content = req.messages[0].content;
      expect(content[0].type).toBe('image');
      expect(content[0].source.media_type).toBe('image/jpeg');
      expect(JSON.stringify(req)).not.toContain(u.uploader);
      expect(JSON.stringify(req)).not.toContain('family-a');
    });
  });

  // Each row: transcript, expected count, expected minutes, expected status. Written out by hand.
  const TIERS = [
    ['', 0, 0, 'needs_review'],
    [W(30), 30, 0, 'ready'],
    [W(49), 49, 0, 'needs_review'],
    [W(50), 50, 45, 'needs_review'],
    [W(70), 70, 45, 'ready'],
    [W(99), 99, 45, 'needs_review'],
    [W(100), 100, 60, 'needs_review'],
    [W(125), 125, 60, 'ready'],
    [W(149), 149, 60, 'needs_review'],
    [W(150), 150, 75, 'needs_review'],
    [W(200), 200, 75, 'ready'],
    ["don't stop after-school 12 3.5 — fun! ok", 5, 0, 'ready'],
  ];

  test('suggestion tiers, boundaries and review flags', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    // 12 rows exceed one family's daily cap of 10, so the rows are split over two families.
    const fams = [await bb.seedFamily('a'), await bb.seedFamily('b')];
    const sessions = [];
    for (const f of fams) sessions.push({ child: await bb.login(s, f.uploader), p1: await bb.login(s, f.parent1) });
    for (const [i, [transcript, count, minutes, status]] of TIERS.entries()) {
      const { child, p1 } = sessions[i % 2];
      await test.step(`${count} words -> ${minutes} min (${status})`, async () => {
        bb.fakes.scriptAi({ transcript });
        const up = await bb.upload(child, { seed: count + 1000 });
        expect(up.status).toBe(201);
        const d = await bb.waitTerminal(p1, up.body.id);
        expect(d.journal.original.wordCount).toBe(count);
        expect(d.journal.original.suggestedMinutes).toBe(minutes);
        expect(d.journal.status).toBe(status);
        expect(d.journal.provisional).toBe(status === 'needs_review');
      });
    }
  });

  test('unreadable words and page problems force review; a blank page is never a confident zero', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    bb.fakes.scriptAi(
      { transcript: `${W(70)} [?] [?]`, illegible_count: 2 },
      { transcript: W(70), page_issues: ['blurry'] },
      { transcript: '', page_issues: ['blank'] },
    );
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      const up = await bb.upload(child, { seed: 50 + i });
      results.push(await bb.waitTerminal(p1, up.body.id));
    }
    expect(results[0].journal.status).toBe('needs_review');
    expect(results[0].journal.original.wordCount).toBe(70);
    expect(results[0].journal.original.flags).toContain('illegible_marker');
    expect(results[1].journal.status).toBe('needs_review');
    expect(results[1].journal.original.pageIssues).toEqual(['blurry']);
    expect(results[2].journal.status).toBe('needs_review');
    expect(results[2].journal.original.wordCount).toBe(0);
    expect(results[2].journal.original.flags).toContain('empty_transcript');
  });

  test('transcript is shown literally: misspellings kept, markup inert', async ({ bb }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const p1 = await bb.login(s, u.parent1);
    const literal = `I goed to scool <b>today</b> & ate "pizza". ${W(60)}`;
    bb.fakes.scriptAi({ transcript: literal });
    const up = await bb.upload(child);
    const d = await bb.waitTerminal(p1, up.body.id);
    expect(d.journal.original.transcript).toBe(literal);
  });
});
