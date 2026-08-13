import { expect, test } from '@playwright/test';

/**
 * NO SIGN-IN ANYWHERE IN THIS FILE, and that is the point.
 *
 * PUBLIC_PATHS in src/middleware.ts is an explicit list, and a path missing
 * from it sends a signed-out visitor to /login. Asserting these pages while
 * signed in would pass with the middleware misconfigured and tell us nothing
 * about the listener who will actually open them -- from a link inside
 * WhatsApp, with no account.
 */
for (const { path, heading } of [
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Service' },
  { path: '/delete-data', heading: 'Data Deletion Request' },
]) {
  test(`${path} is readable with no session at all`, async ({ page }) => {
    await page.goto(path);

    // Not redirected to the sign-in screen.
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

    // Semantic structure a legal document needs, asserted rather than assumed.
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('article')).toBeVisible();
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(3);

    // The header links the three documents to each other and nothing else.
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
  });
}

test('a legal page offers no way into the signed-in product', async ({ page }) => {
  await page.goto('/privacy');
  // The listener reading this has no account. A link into the app would be a
  // dead end that looks like a door.
  await expect(page.getByRole('link', { name: 'My stations' })).toHaveCount(0);
});
