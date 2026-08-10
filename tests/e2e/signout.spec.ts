import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The sign-out button, driven the way a person drives it.
 *
 * IT HAD NO COVERAGE AT ALL until 2026-08-10, which is how it reached the owner
 * broken. One spec knew the control existed -- language.spec.ts asserts the word
 * "Sign out" is on screen in three languages -- and nothing had ever clicked it.
 *
 * WHAT ONLY A BROWSER CAN PROVE HERE is that the two halves of the response
 * arrive together. The route clears the session through the next/headers cookie
 * store and sets its own Location header on a plain NextResponse; the unit test
 * beside it (tests/unit/security/auth-redirect-origin.test.ts) mocks the
 * Supabase client away, so it can pin the redirect and says nothing whatever
 * about the cookies. A redirect that worked while the session quietly survived
 * would be a worse defect than the one that prompted this file, and it would
 * look identical from the outside: the screen goes to /login either way.
 *
 * So the last two assertions matter more than the obvious one -- they ask
 * whether the door actually locked behind us.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const email = `e2e-signout-${stamp}@example.test`;
const password = `E2e-signout-${stamp}-pw`;
let userId = '';

test.beforeAll(async () => {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create user: ${error?.message}`);
  userId = data.user.id;
  const profile = await admin
    .from('profiles')
    .insert({ id: userId, email, full_name: 'Signout Probe' });
  if (profile.error) throw new Error(`could not create profile: ${profile.error.message}`);
});

test.afterAll(async () => {
  if (userId) await admin.auth.admin.deleteUser(userId);
});

test('signing out lands on the login screen and the session is genuinely gone', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The Location the route sends back, captured before the browser acts on it.
  // Asserted RELATIVE: an absolute one is what broke the deployment, where the
  // proxy's internal Host made it `https://0.0.0.0:3000/login` and the browser
  // had nowhere to go. Nothing about localhost would have shown that, so this
  // reads the header rather than trusting the address bar.
  const [response] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/auth/signout'),
    page.getByRole('button', { name: 'Sign out' }).click(),
  ]);

  expect(response.status()).toBe(303);
  expect(await response.headerValue('location')).toBe('/login');

  await expect(page).toHaveURL(/\/login$/);

  // The half a passing redirect cannot vouch for. Asking for a protected screen
  // has to come back to /login, and it is the middleware -- not this page --
  // that decides, so a surviving cookie would show up right here.
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login$/);

  // And nothing signed is left in the jar to be replayed.
  const cookies = await page.context().cookies();
  expect(cookies.filter((c) => c.name.includes('auth-token') && c.value !== '')).toHaveLength(0);
});
