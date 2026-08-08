import { test, expect } from '@playwright/test';

/**
 * The front door. Was `home.spec.ts` until the landing page was deleted and
 * what it said moved into the panel beside the sign-in form.
 *
 * The locale is pinned to en-US by playwright.config.ts, so every string
 * asserted here is the English catalogue.
 */

test('the bare domain sends a visitor to the sign-in screen', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
});

test('the sign-in screen carries what the landing page used to say', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'PulchatX' })).toBeVisible();
  await expect(page.getByText(/CRM for entertainment companies/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /Get in touch/i })).toBeVisible();
});

test('the sign-in screen offers labelled credentials and a reset', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Access your account/i })).toBeVisible();
  // BY LABEL, not by placeholder. The fields carry no placeholder at all now,
  // and this is the assertion that would fail if one came back instead of a
  // visible label — which is the whole difference this screen introduced.
  //
  // `exact: true` EVERYWHERE THESE TWO ARE USED, in all 24 spec files, and it
  // is not decoration. getByLabel matches as a case-insensitive SUBSTRING by
  // default, so a bare getByLabel('Password') also matches the reveal button,
  // whose accessible name is "Show the password" — a strict-mode violation that
  // failed every one of the migrated call sites at once. It is also what keeps
  // this working if /change-password ever gains labels of its own: "New
  // password" and "Repeat the password" would both match too.
  await expect(page.getByLabel('E-mail', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /Forgot your password/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('the panel shows the picture from the branding bucket, actually loaded', async ({ page }) => {
  await page.goto('/login');

  // `alt=""` makes this presentational, so it has no img ROLE to be found by.
  // Located by its address instead, which also asserts the address's shape.
  const hero = page.locator('img[src*="/storage/v1/object/public/branding/login-hero.png"]');
  await expect(hero).toBeVisible();

  // THE VERSION STAMP, without which an operator who replaces this picture goes
  // on seeing the old one for the hour Storage caches it.
  await expect(hero).toHaveAttribute('src', /\?v=\d+$/);

  // naturalWidth, not merely "the element is on the page". An <img> whose
  // source 404s is still visible and still has the right src — it is a broken
  // icon — and this is the difference between the tag being right and the
  // picture having arrived. It is also what fails if seed:branding did not run.
  await expect
    .poll(async () => hero.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
});

test('the password can be revealed and hidden again', async ({ page }) => {
  await page.goto('/login');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('something-secret');

  await expect(password).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Show the password' }).click();
  await expect(password).toHaveAttribute('type', 'text');

  // Back again, and the value survives the round trip — a toggle that cleared
  // the field would be worse than none.
  await page.getByRole('button', { name: 'Hide the password' }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveValue('something-secret');
});

test('the contact page still renders its form', async ({ page }) => {
  // Reached from the panel's button, and the one public page the landing
  // deletion left standing.
  await page.goto('/contato');
  await expect(page.getByRole('heading', { name: /Get in touch/i })).toBeVisible();
  await expect(page.getByPlaceholder('Your name')).toBeVisible();
});

test('an anonymous visitor is redirected away from the app', async ({ page }) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);
});
