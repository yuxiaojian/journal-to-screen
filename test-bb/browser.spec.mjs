// Real Chromium driving the real front end served by the real server. Replaces the manual app-flow checklist for
// login, upload, inbox, result, correction, paused and legacy views. Real OS push delivery is out of scope.
import { test, expect, waitFor, guardedBrowserContext, pngPage, PASSWORD } from './harness/fixtures.mjs';

const W = (n) => Array.from({ length: n }, (_, i) => ['oak', 'elm', 'fir', 'ash', 'yew'][i % 5]).join(' ');

async function signIn(page, base, username) {
  await page.goto(`${base}/login`);
  await page.getByPlaceholder('Username').fill(username);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: /^(Upload|Inbox)$/ }).waitFor(); // signed in and routed
}

test.describe('browser flows', () => {
  test('child uploads a page; parent reviews, corrects and sees the original', async ({ bb, browser }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    bb.fakes.scriptAi({ transcript: `My day was fun [?] ${W(48)}`, illegible_count: 1 });
    const img = await pngPage(7);

    const kid = await guardedBrowserContext(browser);
    const kp = await kid.context.newPage();
    await test.step('Given the child signs in, they land on the upload page', async () => {
      await signIn(kp, s.base, u.uploader);
      await expect(kp.getByRole('heading', { name: 'Upload' })).toBeVisible();
    });
    await test.step('When the child uploads a photo, they are told it was sent', async () => {
      await kp.locator('input[type=file]').setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer: img });
      await kp.getByRole('button', { name: 'Upload photo' }).click();
      await expect(kp.getByText('Sent. Your parents will look at it soon.')).toBeVisible();
    });

    const mom = await guardedBrowserContext(browser);
    const mp = await mom.context.newPage();
    await test.step('Then the parent inbox lists it as needing review with a suggestion', async () => {
      await signIn(mp, s.base, u.parent1);
      await expect(mp.getByRole('heading', { name: 'Inbox' })).toBeVisible();
      await waitFor(async () => {
        await mp.reload();
        return (await mp.getByText('Needs your review').count()) > 0;
      }, { what: 'inbox shows the result' });
      await expect(mp.getByText('suggested 45 min')).toBeVisible();
    });
    await test.step('And the result page shows the photo, provisional label, count and literal text', async () => {
      await mp.locator('a[data-link]').first().click();
      await expect(mp.getByRole('heading', { name: 'Journal page' })).toBeVisible();
      await expect(mp.getByRole('img', { name: 'Uploaded photo' })).toBeVisible();
      const loaded = await mp.getByRole('img', { name: 'Uploaded photo' }).evaluate((el) => el.complete && el.naturalWidth > 0);
      expect(loaded).toBe(true);
      await expect(mp.getByText('This suggestion is provisional.')).toBeVisible();
      await expect(mp.getByText('52 words')).toBeVisible();
      await expect(mp.getByText('Some words could not be read ([?]).')).toBeVisible();
      await expect(mp.locator('#tx')).toHaveValue(`My day was fun [?] ${W(48)}`);
    });
    await test.step('When the parent corrects the text, the count and suggestion update and the original is kept', async () => {
      await mp.locator('#tx').fill(W(105));
      await mp.getByRole('button', { name: 'Save correction' }).click();
      await expect(mp.getByText('105 words')).toBeVisible();
      await expect(mp.getByText('60 min')).toBeVisible();
      await expect(mp.getByText('(from your corrected text)')).toBeVisible();
      await mp.getByText('Original reading').click();
      await expect(mp.locator('#orig')).toHaveText(`My day was fun [?] ${W(48)}`);
    });
    await test.step('And the child, opening the same page, sees status only', async () => {
      const id = new URL(mp.url()).pathname.split('/').pop();
      await kp.goto(`${s.base}/uploads/${id}`);
      await expect(kp.getByText('Sent to your parents.')).toBeVisible();
      await expect(kp.getByText('words')).toHaveCount(0);
      await expect(kp.getByRole('img')).toHaveCount(0);
    });
    expect([...kid.blocked, ...mom.blocked]).toEqual([]);
  });

  test('a stale correction is rejected and the other parent\'s latest text is shown', async ({ bb, browser }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    bb.fakes.scriptAi({ transcript: W(70) });
    const child = await bb.login(s, u.uploader);
    const up = await bb.upload(child);
    const dad = await bb.login(s, u.parent2);
    await bb.waitTerminal(dad, up.body.id);

    const mom = await guardedBrowserContext(browser);
    const mp = await mom.context.newPage();
    await signIn(mp, s.base, u.parent1);
    await mp.goto(`${s.base}/uploads/${up.body.id}`);
    await expect(mp.getByText('70 words')).toBeVisible();
    // the other parent saves first, through the API
    const v = (await bb.journal(dad, up.body.id)).journal.version;
    expect((await dad.post(`/api/uploads/${up.body.id}/correction`, { data: { transcript: W(130), version: v } })).status()).toBe(200);
    await mp.locator('#tx').fill(W(90));
    await mp.getByRole('button', { name: 'Save correction' }).click();
    // Observable outcome: the stale edit is NOT saved and the latest text replaces it.
    // FINDING (reported, not fixed here): the app sets the conflict message and then immediately re-renders the
    // panel, which clears it, so the parent never sees "Someone else changed this". Tracked as a product follow-up.
    await expect(mp.getByText('130 words')).toBeVisible();
    await expect(mp.locator('#tx')).toHaveValue(W(130));
    expect((await bb.journal(dad, up.body.id)).journal.corrected.wordCount).toBe(130);
    expect(mom.blocked).toEqual([]);
  });

  test('AI off: the parent sees the legacy relay view with no journal panel', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const up = await bb.upload(child);
    expect(up.status).toBe(201);
    const mom = await guardedBrowserContext(browser);
    const mp = await mom.context.newPage();
    await signIn(mp, s.base, u.parent1);
    await expect(mp.getByText('0 accepted by push service')).toBeVisible();
    await mp.locator('a[data-link]').first().click();
    await expect(mp.getByRole('img', { name: 'Uploaded photo' })).toBeVisible();
    await expect(mp.locator('#jv')).toBeEmpty();
    await expect(mp.getByText('Reading')).toHaveCount(0);
    expect(mom.blocked).toEqual([]);
  });

  test('a page queued when AI is turned off shows as paused, then is read once AI is back', async ({ bb, browser }) => {
    let s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    bb.fakes.scriptAi({ hold: true, then: { transcript: W(10) } }, { transcript: W(80) });
    const first = await bb.upload(child, { seed: 1 }); // takes the single job slot
    const second = await bb.upload(child, { seed: 2 }); // stays queued behind it
    await waitFor(async () => bb.fakes.aiCalls.length === 1, { what: 'first call' });
    s = await bb.restart(s, { ai: false });

    const mom = await guardedBrowserContext(browser);
    const mp = await mom.context.newPage();
    await signIn(mp, s.base, u.parent1);
    await expect(mp.getByText('Analysis paused; photo available')).toHaveCount(2);
    await mp.goto(`${s.base}/uploads/${second.body.id}`);
    await expect(mp.getByText('Analysis paused; photo available.')).toBeVisible();
    await expect(mp.getByRole('img', { name: 'Uploaded photo' })).toBeVisible();

    s = await bb.restart(s, { ai: true });
    const p = await bb.login(s, u.parent1);
    const d = await bb.waitTerminal(p, second.body.id, { timeout: 200_000 });
    expect(d.journal.status).toBe('ready');
    await mp.goto(`${s.base}/uploads/${second.body.id}`);
    await expect(mp.getByText('80 words')).toBeVisible();
    void first;
    expect(mom.blocked).toEqual([]);
  });

  test('service worker is served uncached and registers in the page scope', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const c = await bb.client(s);
    const sw = await c.get('/sw.js');
    expect(sw.status()).toBe(200);
    expect(sw.headers()['cache-control']).toBe('no-cache');
    expect(sw.headers()['content-type']).toContain('javascript');
    const manifest = await c.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    const g = await guardedBrowserContext(browser);
    const page = await g.context.newPage();
    await page.goto(`${s.base}/login`);
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.register('/sw.js')).scope);
    expect(scope).toBe(`${s.base}/`);
    expect(g.blocked).toEqual([]);
  });
});
