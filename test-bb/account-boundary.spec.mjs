// Review round 1 regressions: a photo chosen by one account can never be uploaded by another account that signs in
// on the same page, whatever state the upload was in; and a correction that fails on the network is recoverable.
import { test, expect, waitFor, guardedBrowserContext, pngPage, PASSWORD } from './harness/fixtures.mjs';

const isUpload = (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/uploads';
const photo = async (seed) => ({ name: `p${seed}.png`, mimeType: 'image/png', buffer: await pngPage(seed) });
async function signIn(page, username) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Upload' })).toBeVisible();
}
async function pick(page, name, files) {
  const [c] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name }).click()]);
  await c.setFiles(files);
}
async function uploadsOf(bb, s, parent) {
  const p = await bb.login(s, parent);
  return (await (await p.get('/api/uploads')).json()).uploads;
}

async function setup(bb, browser) {
  const s = await bb.start({ ai: false });
  const a = await bb.seedFamily('a');
  const b = await bb.seedFamily('b');
  const g = await guardedBrowserContext(browser);
  const page = await g.context.newPage();
  const posts = [];
  page.on('request', (r) => { if (isUpload(r)) posts.push(r); });
  await page.goto(`${s.base}/login`);
  await signIn(page, a.uploader);
  return { s, a, b, page, posts, g };
}
async function switchAccount(page, to) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signIn(page, to);
}

test.describe('account boundary', () => {
  test('a selected library photo is gone after another account signs in on the same page', async ({ bb, browser }) => {
    const { s, a, b, page, posts } = await setup(bb, browser);
    await pick(page, 'Choose from library', await photo(1));
    await expect(page.getByRole('button', { name: 'Upload photo' })).toBeVisible();
    await switchAccount(page, b.uploader);
    await expect(page.getByRole('button', { name: 'Upload photo' })).toBeHidden();
    await expect(page.getByText('Photo selected.')).toBeHidden();
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    expect(await uploadsOf(bb, s, b.parent1)).toHaveLength(0);
    expect(await uploadsOf(bb, s, a.parent1)).toHaveLength(0);
  });

  test('a failed photo cannot be retried by the next account', async ({ bb, browser }) => {
    const { s, a, b, page, posts } = await setup(bb, browser);
    await page.route('**/api/uploads', (r) => r.abort('failed'));
    await pick(page, 'Take photo & upload', await photo(2));
    await expect(page.getByRole('status')).toContainText('Not sent');
    await page.unroute('**/api/uploads');
    await switchAccount(page, b.uploader);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeHidden();
    await expect(page.getByRole('status')).toBeEmpty();
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1); // only the original failed attempt, made by A
    expect(await uploadsOf(bb, s, b.parent1)).toHaveLength(0);
    expect(await uploadsOf(bb, s, a.parent1)).toHaveLength(0);
  });

  test('a photo still being prepared when the account changes is never sent (no tap needed to trigger the leak before)', async ({ bb, browser }) => {
    const { s, a, b, page, posts } = await setup(bb, browser);
    // hold the resize step, exactly as the reviewer's reproduction did
    await page.evaluate(() => {
      const real = window.createImageBitmap;
      window.__releasePrepare = null;
      window.createImageBitmap = (...args) => new Promise((resolve) => { window.__releasePrepare = () => resolve(real(...args)); });
    });
    await pick(page, 'Take photo & upload', await photo(3));
    await expect(page.getByRole('status')).toContainText('Preparing');
    await waitFor(() => page.evaluate(() => typeof window.__releasePrepare === 'function'), { what: 'held resize' });
    await switchAccount(page, b.uploader);
    await page.evaluate(() => window.__releasePrepare());
    await page.waitForTimeout(1500);
    expect(posts).toHaveLength(0);
    await expect(page.getByRole('status')).not.toContainText('Sent');
    expect(await uploadsOf(bb, s, b.parent1)).toHaveLength(0);
    expect(await uploadsOf(bb, s, a.parent1)).toHaveLength(0);
  });

  test('an upload already sent by A may finish for A, but nothing is sent for B and B sees none of it', async ({ bb, browser }) => {
    const { s, a, b, page, posts } = await setup(bb, browser);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/api/uploads', async (route) => { await held; await route.continue().catch(() => {}); });
    await pick(page, 'Take photo & upload', await photo(4));
    await expect(page.getByRole('status')).toContainText('Uploading');
    await switchAccount(page, b.uploader);
    release();
    await page.waitForTimeout(1500);
    await expect(page.getByRole('status')).not.toContainText('Sent');
    expect(posts).toHaveLength(1); // the one request A started; no fresh request after B signed in
    expect(await uploadsOf(bb, s, b.parent1)).toHaveLength(0); // never under B
    // The aborted request may or may not have reached the server under A's old session. Either way it is A's.
    expect((await uploadsOf(bb, s, a.parent1)).length).toBeLessThanOrEqual(1);
  });

  test('after switching, B can upload their own photo normally, under B only', async ({ bb, browser }) => {
    const { s, a, b, page, posts } = await setup(bb, browser);
    await pick(page, 'Choose from library', await photo(5));
    await switchAccount(page, b.uploader);
    await pick(page, 'Take photo & upload', await photo(6));
    await expect(page.getByRole('status')).toContainText('Sent');
    expect(posts).toHaveLength(1);
    expect(await uploadsOf(bb, s, b.parent1)).toHaveLength(1);
    expect(await uploadsOf(bb, s, a.parent1)).toHaveLength(0);
  });
});

test.describe('correction network failure', () => {
  test('a correction lost on the network keeps the edit, re-enables Save and explains; a later save works', async ({ bb, browser }) => {
    const s = await bb.start({ ai: true });
    const u = await bb.seedFamily('a');
    bb.fakes.scriptAi({ transcript: 'apple river stone cloud maple '.repeat(14) });
    const child = await bb.login(s, u.uploader);
    const up = await bb.upload(child);
    const p = await bb.login(s, u.parent1);
    await bb.waitTerminal(p, up.body.id);
    const g = await guardedBrowserContext(browser);
    const page = await g.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${s.base}/login`);
    await page.getByLabel('Username').fill(u.parent1);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    await page.goto(`${s.base}/uploads/${up.body.id}`);
    const tx = page.getByLabel('Text (edit to correct)');
    await tx.fill('my careful correction text here');
    await page.route('**/correction', (r) => r.abort('failed'));
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText("Couldn't save. Check the connection, then try again.", { exact: false })).toBeVisible();
    await expect(tx).toHaveValue('my careful correction text here');
    await expect(page.getByRole('button', { name: 'Save correction' })).toBeEnabled();
    expect(errors).toEqual([]);
    await page.unroute('**/correction');
    await page.getByRole('button', { name: 'Save correction' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await expect(page.getByText('5 words')).toBeVisible();
    expect((await bb.journal(p, up.body.id)).journal.corrected.transcript).toBe('my careful correction text here');
  });
});
