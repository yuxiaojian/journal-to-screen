import crypto from 'node:crypto';
import { test, expect, guardedBrowserContext, PASSWORD } from './harness/fixtures.mjs';

test.describe('inbox paging', () => {
  test('Show older reaches every page and goes away at the end; a failed load can be retried', async ({ bb, browser }) => {
    const s = await bb.start({ ai: false });
    const u = await bb.seedFamily('a');
    const child = await bb.login(s, u.uploader);
    const up = await bb.upload(child);
    for (let i = 1; i < 55; i++) {
      await bb.sql(
        `INSERT INTO uploads (id, family_id, uploader_id, idempotency_key, image, content_type, byte_size, created_at, expires_at)
         SELECT $1, family_id, uploader_id, $2, image, content_type, byte_size, created_at - ($3::int * interval '1 minute'), expires_at FROM uploads WHERE id = $4`,
        [crypto.randomUUID(), crypto.randomBytes(12).toString('hex'), i, up.body.id],
      );
    }
    const g = await guardedBrowserContext(browser, { viewport: { width: 390, height: 844 } });
    const page = await g.context.newPage();
    await page.goto(`${s.base}/login`);
    await page.getByLabel('Username').fill(u.parent1);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    const items = page.locator('.list li');
    await expect(items).toHaveCount(50);
    const older = page.getByRole('button', { name: 'Show older' });

    await page.route('**/api/uploads?before=*', (route) => route.abort());
    await older.click();
    await expect(page.getByText("Couldn't load older pages.")).toBeVisible();
    await expect(items).toHaveCount(50);
    await page.unroute('**/api/uploads?before=*');

    await older.click();
    await expect(items).toHaveCount(55);
    await expect(older).toBeHidden();
    await expect(page.getByText("Couldn't load older pages.")).toBeHidden();

    await items.last().getByRole('link').click(); // rows added later navigate like the first page's
    await expect(page.getByRole('heading', { name: 'Journal page' })).toBeVisible();
    expect(g.blocked).toEqual([]);
    await g.context.close();
  });
});
