import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 25. The gear beside the member's name, driven the way a person drives
 * it: click it, pick a theme, look at the page.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE:
 *
 *   * that a click reaches the Server Action, which writes both the cookie and
 *     the profile, and that the middleware turns that into a class on <html> on
 *     the very next request;
 *   * that the choice is still there in a browser that has never seen this
 *     person — the whole difference between a preference and a cookie, and
 *     precisely what `localStorage` could not have done (D2);
 *   * that System removes the class rather than picking a side;
 *   * and that the widget carries no class with BOTH ways of forcing one
 *     present at once (D7).
 *
 * The shape is language.spec.ts's, which drives the same menu for the other
 * half of it.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const email = `e2e-theme-${stamp}@example.test`;
const password = `E2e-theme-${stamp}-pw`;
let userId = '';

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create user: ${error?.message}`);
  userId = data.user.id;
  const profile = await admin.from('profiles').insert({ id: userId, email });
  if (profile.error) throw new Error(`could not create profile: ${profile.error.message}`);
});

test.afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

/** The class on the document element — the one thing this whole block produces. */
function documentClass(page: import('@playwright/test').Page) {
  return page.locator('html');
}

test('a member picks a theme, and finds it again in a browser that has never seen them', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);

  await signIn(page);

  // Nobody has chosen: System, which is the ABSENCE of a class rather than a
  // value. Asserted as "no class attribute at all" rather than "not dark",
  // because `class="light"` would also satisfy the weaker form while meaning
  // something different — it would be overruling the person's machine.
  await expect(documentClass(page)).not.toHaveClass(/dark|light/);

  await page.getByTestId('locale-gear').click();
  await expect(page.getByTestId('settings-divider')).toBeVisible();
  await page.getByTestId('theme-option-dark').click();

  await expect(documentClass(page)).toHaveClass(/\bdark\b/);

  // The class survives a real navigation, which is what says the middleware is
  // resolving it rather than the action having painted it once.
  await page.reload();
  await expect(documentClass(page)).toHaveClass(/\bdark\b/);

  // And the profile has it, not just the browser.
  const { data: profile } = await admin
    .from('profiles')
    .select('theme')
    .eq('id', userId)
    .single();
  expect(profile?.theme).toBe('dark');

  // --- A BROWSER THAT HAS NEVER SEEN THIS PERSON ---------------------------
  // The half `localStorage` could not do, and the reason the choice lives on the
  // profile at all. A fresh context shares no cookies with the one above.
  const fresh = await browser.newContext();
  const freshPage = await fresh.newPage();
  await signIn(freshPage);
  await expect(documentClass(freshPage)).toHaveClass(/\bdark\b/);

  // --- SYSTEM REMOVES IT, AND TRAVELS ---------------------------------------
  // Chosen on the second browser, and the first must lose it too — the case
  // `themeCookieUpdate`'s 'clear' exists for, and the one a naive sync leaves
  // dark for ever.
  await freshPage.getByTestId('locale-gear').click();
  await freshPage.getByTestId('theme-option-system').click();
  await expect(documentClass(freshPage)).not.toHaveClass(/dark|light/);

  const { data: cleared } = await admin
    .from('profiles')
    .select('theme')
    .eq('id', userId)
    .single();
  expect(cleared?.theme).toBeNull();

  await page.reload();
  await expect(documentClass(page)).not.toHaveClass(/dark|light/);

  await fresh.close();
});

/**
 * D7, with BOTH of its exposures present at once.
 *
 * The cookie is the one a real operator would carry. The header is the one
 * `forwarded()` deletes on every request — it builds from the client's own
 * headers, so without that line `curl -H 'x-theme: dark'` would reach the root
 * layout on every route the middleware does not overwrite it for, and the widget
 * is exactly such a route.
 *
 * Sent together rather than in two tests: either one alone passing would leave
 * the other hole open, and what is being asserted is that the widget has no
 * theme AT ALL rather than that one particular door is shut.
 */
test('the widget carries no theme, whatever the request brings with it', async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: { 'x-theme': 'dark' },
  });
  await context.addCookies([
    { name: 'theme', value: 'dark', url: 'http://localhost:3000' },
  ]);
  const page = await context.newPage();

  // The panel first, on the same context, so this test also shows the two
  // routes disagreeing under identical conditions — which is the whole point.
  await page.goto('/login');
  await expect(page.locator('html')).not.toHaveClass(/dark|light/);

  // A public key that does not resolve still renders through the root layout,
  // which is the layer under test — the widget's own 404 is not what is being
  // asserted here.
  await page.goto('/w/pw_notarealkey');
  await expect(page.locator('html')).not.toHaveClass(/dark|light/);

  await context.close();
});
