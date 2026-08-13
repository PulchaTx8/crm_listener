import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

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
  // on seeing the old one for the hour Storage caches it. It is the object's
  // ETag, so it is an opaque string rather than a number.
  await expect(hero).toHaveAttribute('src', /\?v=.+$/);

  // naturalWidth, not merely "the element is on the page". An <img> whose
  // source 404s is still visible and still has the right src — it is a broken
  // icon — and this is the difference between the tag being right and the
  // picture having arrived. It is also what fails if seed:branding did not run.
  //
  // THIS IS ALSO THE REGRESSION TEST FOR THE HOSTED FAILURE, and it needs no
  // setup to be one. 0147 removed every policy naming this bucket, so the
  // database this runs against has none — and the picture appears anyway. The
  // first version of login-hero.ts read the object's row through RLS and
  // rendered nothing when it could not, which is exactly what a database
  // without those policies produced.
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

test('signing in lands an ordinary member on their audience dashboard', async ({ page }) => {
  // Block 20b, D6. THIS FILE HAD NO TEST THAT ACTUALLY SIGNED SOMEBODY IN --
  // every other test above stays on /login or /contato.
  //
  // An OWNER, not a bare profile: ownership alone satisfies members.view
  // (has_company_access_for's own comment -- "the owner holds no membership
  // row by design" refers to company_memberships, not the
  // organization_memberships row provision_organization writes), so this is
  // the ordinary case MEMBER_HOME's own comment describes -- a member who CAN
  // reach the dashboard, landing there directly rather than being bounced
  // onward. A profile with no Station at all would only prove the OTHER
  // branch (the dashboard's own `redirect('/app')`), which is exercised
  // instead by signout.spec.ts's bare-profile sign-in.
  //
  // provisionCustomer (tests/e2e/provision.ts), not a direct table insert:
  // organizations, companies and organization_memberships all revoke every
  // grant from service_role except SELECT (0006_rls_policies.sql) -- writing
  // a tenant at all has to go through provision_organization/add_company,
  // which are authenticated-only (add_company's own grant list), so this
  // needs a SIGNED-IN platform admin client, the same shape every other
  // fixture in the suite that provisions a Station already uses.
  const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = Date.now();
  const platformAdminEmail = `e2e-login-lands-admin-${stamp}@example.test`;
  const platformAdminPassword = `E2e-login-lands-admin-${stamp}-pw`;
  const ownerEmail = `e2e-login-lands-owner-${stamp}@example.test`;
  const ownerPassword = `E2e-login-lands-owner-${stamp}-pw`;
  const createdUserIds: string[] = [];

  try {
    const { data: adminData, error: adminError } = await admin.auth.admin.createUser({
      email: platformAdminEmail,
      password: platformAdminPassword,
      email_confirm: true,
    });
    if (adminError || !adminData.user) {
      throw new Error(`could not create platform admin: ${adminError?.message}`);
    }
    createdUserIds.push(adminData.user.id);
    const { error: adminProfileError } = await admin
      .from('profiles')
      .insert({ id: adminData.user.id, email: platformAdminEmail });
    if (adminProfileError) {
      throw new Error(`could not create platform admin profile: ${adminProfileError.message}`);
    }
    const { error: adminFlagError } = await admin
      .from('platform_admins')
      .insert({ user_id: adminData.user.id });
    if (adminFlagError) throw new Error(`could not mark the platform admin: ${adminFlagError.message}`);

    const { data: ownerData, error: ownerError } = await admin.auth.admin.createUser({
      email: ownerEmail,
      password: ownerPassword,
      email_confirm: true,
    });
    if (ownerError || !ownerData.user) throw new Error(`could not create owner: ${ownerError?.message}`);
    createdUserIds.push(ownerData.user.id);
    const { error: ownerProfileError } = await admin
      .from('profiles')
      .insert({ id: ownerData.user.id, email: ownerEmail });
    if (ownerProfileError) {
      throw new Error(`could not create owner profile: ${ownerProfileError.message}`);
    }

    const platformAdminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await platformAdminClient.auth.signInWithPassword({
      email: platformAdminEmail,
      password: platformAdminPassword,
    });
    if (signInError) throw new Error(`platform admin sign-in failed: ${signInError.message}`);

    await provisionCustomer(platformAdminClient, {
      userId: ownerData.user.id,
      organizationName: `E2E Login Lands Org ${stamp}`,
      companyName: `E2E Login Lands Station ${stamp}`,
    });

    // provision_organization stamps must_change_password (Block 16, D1) --
    // that gate is roles-flow.spec.ts's story, not this one, so it is cleared
    // directly rather than driven through /change-password here.
    const { error: clearGateError } = await admin
      .from('profiles')
      .update({ must_change_password: false, provisional_expires_at: null })
      .eq('id', ownerData.user.id);
    if (clearGateError) throw new Error(`could not clear the password gate: ${clearGateError.message}`);

    await page.goto('/login');
    await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
    await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Block 20b, D6. Signing in lands on the audience dashboard, not on
    // /app. A member who cannot reach the dashboard is redirected onward to
    // /app by the page itself, so this asserts the ordinary case.
    await expect(page).toHaveURL(/\/dashboards\/audience$/);
  } finally {
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});
