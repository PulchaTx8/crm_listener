import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 12b. The gear beside the member's name, driven the way a person drives
 * it: click it, pick a language, read the screen.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE is the round trip. The unit tests assert
 * resolveLocale on its own and the catalogues on disk; neither can show that a
 * click reaches the Server Action, that the action writes both the cookie and
 * the profile, that revalidation repaints the shell, or that the choice is
 * still there in a browser that has never seen this person before — which is
 * the whole difference between a cookie and a preference.
 *
 * The suite pins `locale: 'en-US'` in playwright.config.ts, so every other
 * journey renders in English regardless of the machine. This one overrides it
 * where it needs to and relies on it everywhere else.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const email = `e2e-lang-${stamp}@example.test`;
const password = `E2e-lang-${stamp}-pw`;
// Typed by a person, in their own alphabet, and never a translatable string.
const fullName = 'Ana Gonçalves Ştefan';
let userId = '';

// The one word in the shell that differs in all three languages and is on
// screen for anybody signed in, with or without an Organization.
const SIGN_OUT = { en: 'Sign out', pt: 'Sair', es: 'Cerrar sesión' };

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create user: ${error?.message}`);
  userId = data.user.id;
  const profile = await admin.from('profiles').insert({ id: userId, email, full_name: fullName });
  if (profile.error) throw new Error(`could not create profile: ${profile.error.message}`);
});

test.afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('the gear switches the interface, keeps the name, and remembers the person', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: SIGN_OUT.en })).toBeVisible();

  // --- English to Portuguese ------------------------------------------------
  await page.getByTestId('locale-gear').click();
  await expect(page.getByTestId('locale-option-pt')).toBeVisible();
  await page.getByTestId('locale-option-pt').click();

  await expect(page.getByRole('button', { name: SIGN_OUT.pt })).toBeVisible();
  await expect(page.getByRole('button', { name: SIGN_OUT.en })).toHaveCount(0);

  // D1, and the reason this block touched one column and no others: what a
  // person typed is theirs, in whatever alphabet they typed it.
  await expect(page.getByText(fullName)).toBeVisible();

  // --- it is a preference, not a repaint -----------------------------------
  await page.reload();
  await expect(page.getByRole('button', { name: SIGN_OUT.pt })).toBeVisible();

  const { data: afterPt } = await admin
    .from('profiles')
    .select('locale, full_name')
    .eq('id', userId)
    .single();
  expect(afterPt?.locale, 'the choice did not reach the profile').toBe('pt');
  expect(afterPt?.full_name, 'switching language rewrote a stored value').toBe(fullName);

  // --- Portuguese to Spanish ------------------------------------------------
  await page.getByTestId('locale-gear').click();
  await page.getByTestId('locale-option-es').click();
  await expect(page.getByRole('button', { name: SIGN_OUT.es })).toBeVisible();

  const { data: afterEs } = await admin
    .from('profiles')
    .select('locale')
    .eq('id', userId)
    .single();
  expect(afterEs?.locale).toBe('es');
});

test('the choice follows the person into a browser that has never seen them', async ({
  browser,
}) => {
  // The point of storing it on the profile rather than only in a cookie. This
  // context has no cookie at all, and asks for English in its Accept-Language
  // header -- so if the profile did not win, the shell would come back English.
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();

  await admin.from('profiles').update({ locale: 'pt' }).eq('id', userId);
  await signIn(page);

  await expect(page.getByRole('button', { name: SIGN_OUT.pt })).toBeVisible();
  await context.close();
});

test('a browser asking for Portuguese is answered in Portuguese before anybody signs in', async ({
  browser,
}) => {
  // The last step of the resolution order, on the one screen that has no
  // profile and no cookie to read. Before Block 12b this had to answer English,
  // because messages/pt.json did not exist.
  const context = await browser.newContext({ locale: 'pt-BR' });
  const page = await context.newPage();

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();

  await context.close();
});
