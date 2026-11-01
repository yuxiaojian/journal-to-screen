// Phase 2: camera-first upload, library upload, retries and layout, driven through the real front end in Chromium.
// The native OS camera cannot be exercised headless: these tests prove the page's side of the contract (input
// attributes, what each selection does, and exactly which requests reach the server). Real-phone checks stay manual.
import { test, expect, waitFor, guardedBrowserContext, pngPage, PASSWORD } from './harness/fixtures.mjs';

const UPLOAD = '**/api/uploads';
const isUpload = (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/uploads';

async function childPage(bb, browser, s, u, ctxOptions = {}) {
  const g = await guardedBrowserContext(browser, ctxOptions);
  const page = await g.context.newPage();
  const posts = [];
  page.on('request', (r) => { if (isUpload(r)) posts.push(r); });
  await page.goto(`${s.base}/login`);
  await page.getByLabel('Username').fill(u.uploader);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Upload' })).toBeVisible();
  return { page, posts, g };
}

const keyOf = (req) => {
  const body = req.postDataBuffer().toString('latin1');
  const m = body.match(/name="key"\r\n\r\n([^\r]+)/);
  return m && m[1];
};
async function pick(page, buttonName, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonName }).click()]);
  await chooser.setFiles(files);
}
const photo = async (seed) => ({ name: `page-${seed}.png`, mimeType: 'image/png', buffer: await pngPage(seed) });

test.describe('camera-first upload', () => {
  test('camera and library inputs: rear camera hint on one, none on the other; both open from a tap', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts, g } = await childPage(bb, browser, s, u);
    const cam = page.locator('#cam');
    const lib = page.locator('#lib');
    await expect(cam).toHaveAttribute('type', 'file');
    await expect(cam).toHaveAttribute('accept', 'image/*');
    await expect(cam).toHaveAttribute('capture', 'environment');
    await expect(lib).toHaveAttribute('accept', 'image/*');
    expect(await lib.getAttribute('capture')).toBeNull();
    for (const name of ['Take photo & upload', 'Choose from library']) {
      const chooser = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name }).click()]).then((x) => x[0]);
      expect(chooser.isMultiple()).toBe(false);
      await chooser.setFiles([]); // cancel
    }
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    await expect(page.getByRole('status')).toBeEmpty();
    expect(g.blocked).toEqual([]);
  });

  test('accepting a camera photo sends exactly one upload; cancelling sends none', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    await pick(page, 'Take photo & upload', []);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    await pick(page, 'Take photo & upload', await photo(1));
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(posts).toHaveLength(1);
    const p1 = await bb.login(s, u.parent1);
    expect((await (await p1.get('/api/uploads')).json()).uploads).toHaveLength(1);
  });

  test('library selection never sends on its own; the Upload button sends exactly once', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    await pick(page, 'Choose from library', await photo(2));
    await expect(page.getByText('Photo selected.')).toBeVisible();
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(0);
    await page.getByRole('button', { name: 'Upload photo' }).click();
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(posts).toHaveLength(1);
  });

  test('while an upload is held, repeated taps and new selections start no second request', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(UPLOAD, async (route) => { await held; await route.continue(); });
    await pick(page, 'Take photo & upload', await photo(3));
    await expect(page.getByRole('status')).toContainText('Uploading');
    await expect(page.getByRole('button', { name: 'Take photo & upload' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Choose from library' })).toBeDisabled();
    // try anyway: forced clicks and a direct change event on both inputs
    await page.getByRole('button', { name: 'Take photo & upload' }).click({ force: true });
    await page.locator('#cam').setInputFiles(await photo(4));
    await page.locator('#lib').setInputFiles(await photo(5));
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);
    release();
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(posts).toHaveLength(1);
    const p1 = await bb.login(s, u.parent1);
    expect((await (await p1.get('/api/uploads')).json()).uploads).toHaveLength(1);
  });

  test('a failed request keeps the photo: Try again resends it with the same key, without reopening the camera', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    let failNext = true;
    await page.route(UPLOAD, async (route) => { if (failNext) { failNext = false; await route.abort('failed'); } else await route.continue(); });
    await pick(page, 'Take photo & upload', await photo(6));
    await expect(page.getByRole('status')).toContainText('Not sent');
    await expect(page.getByRole('status')).toContainText("The photo didn't send.");
    await expect(page.getByRole('status')).not.toContainText('network');
    let opened = false;
    page.on('filechooser', () => { opened = true; });
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(opened).toBe(false);
    expect(posts).toHaveLength(2);
    expect(keyOf(posts[1])).toBe(keyOf(posts[0]));
    const p1 = await bb.login(s, u.parent1);
    expect((await (await p1.get('/api/uploads')).json()).uploads).toHaveLength(1);
  });

  test('a lost response: the server saved the upload, the retry gets the same upload back, no duplicate', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    let first = true;
    let firstId = null;
    await page.route(UPLOAD, async (route) => {
      if (!first) return route.continue();
      first = false;
      const resp = await route.fetch(); // the real server commits the upload
      firstId = (await resp.json()).id;
      await route.abort('connectionreset'); // ... but the response never reaches the page
    });
    await pick(page, 'Take photo & upload', await photo(7));
    await expect(page.getByRole('status')).toContainText('Not sent');
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    const retry = page.waitForResponse((r) => isUpload(r.request()));
    await page.getByRole('button', { name: 'Try again' }).click();
    const resp = await retry;
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.duplicate).toBe(true);
    expect(body.id).toBe(firstId);
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(keyOf(posts[1])).toBe(keyOf(posts[0]));
    const p1 = await bb.login(s, u.parent1);
    expect((await (await p1.get('/api/uploads')).json()).uploads.map((x) => x.id)).toEqual([firstId]);
  });

  test('replacing a failed photo uses a new key; a cancelled replacement keeps the failed photo retryable', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    let failing = 1;
    await page.route(UPLOAD, async (route) => { if (failing > 0) { failing -= 1; await route.abort('failed'); } else await route.continue(); });
    await pick(page, 'Take photo & upload', await photo(8));
    await expect(page.getByRole('status')).toContainText('Not sent');
    await test.step('cancelling "Choose a different photo" keeps the failed one', async () => {
      await pick(page, 'Choose a different photo', []);
      await page.waitForTimeout(300);
      expect(posts).toHaveLength(1);
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    });
    await test.step('choosing a different photo replaces it with a new key', async () => {
      await pick(page, 'Choose a different photo', await photo(9));
      await page.getByRole('button', { name: 'Upload photo' }).click();
      await expect(page.getByRole('status')).toContainText('Sent');
      expect(posts).toHaveLength(2);
      expect(keyOf(posts[1])).not.toBe(keyOf(posts[0]));
    });
  });

  test('after a success the same photo can be chosen again, and it is a new upload', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page, posts } = await childPage(bb, browser, s, u);
    const same = await photo(10);
    await pick(page, 'Take photo & upload', same);
    await expect(page.getByRole('status')).toContainText('Sent');
    await pick(page, 'Take photo & upload', same);
    await waitFor(async () => posts.length === 2, { what: 'second upload' });
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(keyOf(posts[1])).not.toBe(keyOf(posts[0]));
    const p1 = await bb.login(s, u.parent1);
    expect((await (await p1.get('/api/uploads')).json()).uploads).toHaveLength(2);
  });

  test('server refusals are shown in plain language without codes; permanent ones offer no retry', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const { page } = await childPage(bb, browser, s, u);
    // A GIF passes the browser's image/* filter but is not an accepted format on the server.
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await page.route(UPLOAD, (route) => route.continue()); // real server response
    await page.evaluate(() => { window.createImageBitmap = () => Promise.reject(new Error('skip resize')); }); // send as-is
    await pick(page, 'Take photo & upload', { name: 'x.gif', mimeType: 'image/gif', buffer: gif });
    await expect(page.getByRole('status')).toContainText("That photo type isn't supported.");
    await expect(page.getByRole('status')).not.toContainText('unsupported_format');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Choose a different photo' })).toBeVisible();
  });
});

test.describe('layout and accessibility', () => {
  const noOverflow = async (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const heightOf = async (loc) => (await loc.boundingBox()).height;

  test('upload, inbox and detail fit a 320px phone and 200% zoom with 44px controls; keyboard reachable', async ({ bb, browser }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    bb.fakes.setDefaultAi({ transcript: 'A long-unbroken-wordwithoutanyspacesatalltotestwrapping and more words '.repeat(8) });
    for (const opts of [{ viewport: { width: 320, height: 640 } }, { viewport: { width: 640, height: 800 }, deviceScaleFactor: 2 }]) {
      const { page } = await childPage(bb, browser, s, u, opts);
      if (opts.deviceScaleFactor) await page.evaluate(() => { document.body.style.zoom = '2'; }); // 200% zoom at 640px ~ 320 CSS px
      expect(await noOverflow(page)).toBe(true);
      for (const name of ['Take photo & upload', 'Choose from library', 'Sign out']) {
        expect(await heightOf(page.getByRole('button', { name }))).toBeGreaterThanOrEqual(44);
      }
      await test.step('keyboard: Tab reaches the primary action, focus is visible, Enter opens the camera', async () => {
        await page.keyboard.press('Tab');
        let guard = 0;
        while (!(await page.evaluate(() => document.activeElement?.id === 'take')) && guard++ < 6) await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement.id)).toBe('take');
        const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
        expect(outline).not.toBe('none');
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
        await chooser.setFiles(await photo(20));
        await expect(page.getByRole('status')).toContainText('Sent');
      });
      await page.context().close();
    }
    const p = await bb.login(s, u.parent1);
    const list = (await (await p.get('/api/uploads')).json()).uploads;
    await bb.waitTerminal(p, list[0].id);
    const g = await guardedBrowserContext(browser, { viewport: { width: 320, height: 640 } });
    const mp = await g.context.newPage();
    await mp.goto(`${s.base}/login`);
    await mp.getByLabel('Username').fill(u.parent1);
    await mp.getByLabel('Password').fill(PASSWORD);
    await mp.getByRole('button', { name: 'Sign in' }).click();
    await expect(mp.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    expect(await noOverflow(mp)).toBe(true);
    expect(await heightOf(mp.locator('.item').first())).toBeGreaterThanOrEqual(44);
    await mp.locator('.item').first().click();
    await expect(mp.getByRole('heading', { name: 'Journal page' })).toBeVisible();
    expect(await noOverflow(mp)).toBe(true);
    expect(await heightOf(mp.getByRole('button', { name: 'Save correction' }))).toBeGreaterThanOrEqual(44);
    await expect(mp.getByLabel('Text (edit to correct)')).toBeVisible();
    expect(g.blocked).toEqual([]);
  });

  test('parent detail: photo beside the text on desktop, stacked on a phone; photo opens full size', async ({ bb, browser }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    bb.fakes.scriptAi({ transcript: 'one two three four five six seven eight nine ten '.repeat(7) });
    const child = await bb.login(s, u.uploader);
    const up = await bb.upload(child);
    const p = await bb.login(s, u.parent1);
    await bb.waitTerminal(p, up.body.id);
    for (const [viewport, sideBySide] of [[{ width: 1280, height: 900 }, true], [{ width: 390, height: 844 }, false]]) {
      const g = await guardedBrowserContext(browser, { viewport });
      const mp = await g.context.newPage();
      await mp.goto(`${s.base}/login`);
      await mp.getByLabel('Username').fill(u.parent1);
      await mp.getByLabel('Password').fill(PASSWORD);
      await mp.getByRole('button', { name: 'Sign in' }).click();
      await expect(mp.getByRole('heading', { name: 'Inbox' })).toBeVisible();
      await mp.goto(`${s.base}/uploads/${up.body.id}`);
      const img = mp.getByRole('img', { name: 'Uploaded photo' });
      const text = mp.getByLabel('Text (edit to correct)');
      await expect(img).toBeVisible();
      await expect(text).toBeVisible();
      const a = await img.boundingBox();
      const b = await text.boundingBox();
      if (sideBySide) {
        expect(b.x).toBeGreaterThan(a.x + a.width - 1); // text column starts to the right of the photo
        expect(Math.abs(a.y - b.y)).toBeLessThan(200); // and at roughly the same height
      } else {
        expect(b.y).toBeGreaterThan(a.y + a.height - 1); // text below the photo
      }
      await expect(mp.getByRole('link', { name: 'Uploaded photo' })).toHaveAttribute('href', `/api/uploads/${up.body.id}/image`);
      expect(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await g.context.close();
    }
  });

  test('login page: labelled fields, inline styles absent, styles come from the stylesheet', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const g = await guardedBrowserContext(browser, { viewport: { width: 320, height: 640 } });
    const page = await g.context.newPage();
    const cspViolations = [];
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
    await page.goto(`${s.base}/login`);
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    expect(await page.evaluate(() => document.querySelectorAll('[style]').length)).toBe(0);
    const bg = await page.getByRole('button', { name: 'Sign in' }).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(30, 58, 95)'); // navy from style.css
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(cspViolations).toEqual([]);
    expect(g.blocked).toEqual([]);
  });
});
