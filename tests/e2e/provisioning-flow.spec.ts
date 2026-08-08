import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * The whole customer journey through the real UI: an owner is provisioned by a
 * platform admin, signs in with the password that was shown once, is forced to
 * change it, and lands in the app. Then the subscription is suspended and the
 * customer sees why.
 *
 * This replaces the plan's manual walkthrough. Clicking through it once proves
 * it worked once; this proves it on every run.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-admin-${stamp}-pw`;
const ownerEmail = `e2e-owner-${stamp}@example.test`;
const companyName = `E2E Station ${stamp}`;
const createdUserIds: string[] = [];

test.beforeAll(async () => {
  // There is no UI for seeding the first platform admin, by design.
  const { data, error } = await admin.auth.admin.createUser({
    email: platformAdminEmail,
    password: platformAdminPassword,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create admin: ${error?.message}`);
  createdUserIds.push(data.user.id);

  await admin.from('profiles').insert({ id: data.user.id, email: platformAdminEmail });
  await admin.from('platform_admins').insert({ user_id: data.user.id });
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('provision a customer, sign in, change the password, then suspend', async ({ page }) => {
  // --- the admin signs in and reaches the console -------------------------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The admin's own gate is clear, so the change screen bounces them onward.
  await expect(page).toHaveURL(/\/app$/);
  // The platform links live in the sidebar, which only renders for a platform
  // admin — so reaching the console this way also asserts the nav is scoped.
  await page.getByRole('link', { name: 'Customers' }).click();
  await expect(page).toHaveURL(/\/admin\/customers$/);

  // --- provisioning reveals the password exactly once ---------------------
  // The form lives in a dialog over the console since Block 3c; the dialog is
  // deliberately not closed on success, because the password below is shown
  // once and stored nowhere.
  await page.getByTestId('customer-create').click();
  await page.getByPlaceholder('Organization name').fill(`E2E Org ${stamp}`);
  await page.getByPlaceholder('Company (Station) name').fill(companyName);
  await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
  await page.getByRole('button', { name: 'Provision', exact: true }).click();

  const revealed = page.locator('code').first();
  await expect(revealed).toBeVisible({ timeout: 15_000 });
  const provisionalPassword = (await revealed.innerText()).trim();
  expect(provisionalPassword.length).toBeGreaterThanOrEqual(16);

  // It must never have travelled in the URL (spec §6).
  expect(page.url()).not.toContain(provisionalPassword);
  expect(page.url()).not.toContain('password=');

  // Hard failure, not a soft guard: this row drives the password restore below
  // and the afterAll cleanup. Letting it be null would turn a missing profile
  // into a TypeError halfway down the test, and leak the user besides.
  const { data: owner, error: ownerLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  expect(ownerLookupError).toBeNull();
  if (!owner) throw new Error(`provisioning left no profile row for ${ownerEmail}`);
  createdUserIds.push(owner.id);

  // --- the console resolves each Company's owner --------------------------
  // A regression guard: this row is built from two queries joined in JS
  // because the obvious PostgREST embed has no foreign key to travel along
  // and silently returns nothing. Asserting the email here is what catches
  // that, since the failure mode is an empty row rather than an error.
  await page.reload();
  const provisionedRow = page.locator('[data-testid="company-row"]', { hasText: companyName });
  await expect(provisionedRow.getByText(`Owner: ${ownerEmail}`)).toBeVisible();

  // --- and can reissue a provisional password -----------------------------
  // Reissuing lives on the record's Owner tab now, so the record is opened by
  // name and the tab chosen. Same operation, same RPC, one screen further in.
  // exact: the row also carries "Open <name>" and "Actions for <name>" buttons,
  // and a substring match would resolve to all three.
  await provisionedRow.getByRole('button', { name: companyName, exact: true }).click();
  await page.getByRole('tab', { name: 'Owner' }).click();
  await page.getByRole('button', { name: 'New password' }).click();
  const reissued = page.locator('code').first();
  await expect(reissued).toBeVisible({ timeout: 15_000 });
  const reissuedPassword = (await reissued.innerText()).trim();
  expect(reissuedPassword.length).toBeGreaterThanOrEqual(16);
  expect(reissuedPassword).not.toBe(provisionalPassword);
  expect(page.url()).not.toContain(reissuedPassword);

  // The customer signs in below with the ORIGINAL password, which the reissue
  // has just invalidated — so put the account back the way the test needs it.
  const { error: restoreError } = await admin.auth.admin.updateUserById(owner.id, {
    password: provisionalPassword,
  });
  expect(restoreError).toBeNull();

  // --- the customer signs in and is forced through the gate ---------------
  const customer = await page.context().browser()!.newContext();
  const customerPage = await customer.newPage();

  await customerPage.goto('/login');
  await customerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await customerPage.getByLabel('Password', { exact: true }).fill(provisionalPassword);
  await customerPage.getByRole('button', { name: 'Sign in' }).click();

  await expect(customerPage).toHaveURL(/\/change-password$/);

  // The gate has no holes: any other route bounces straight back.
  await customerPage.goto('/app');
  await expect(customerPage).toHaveURL(/\/change-password$/);

  const chosenPassword = `Chosen-${stamp}-pw`;
  await customerPage.getByPlaceholder('New password').fill(chosenPassword);
  await customerPage.getByPlaceholder('Repeat the password').fill(chosenPassword);
  await customerPage.getByRole('button', { name: 'Save' }).click();

  await expect(customerPage).toHaveURL(/\/app$/);
  const customerRow = customerPage.locator('[data-testid="station-card"]', { hasText: companyName });
  await expect(customerRow).toBeVisible();
  await expect(customerRow.getByText('active', { exact: true })).toBeVisible();

  // --- suspension reaches the open session, without a forced sign-out -----
  // ESC first: the record dialog is modal, so the row menu behind it is inert
  // until it closes — and closing it must leave the list exactly as it was.
  await page.keyboard.press('Escape');
  const adminRow = page.locator('[data-testid="company-row"]', { hasText: companyName });
  await adminRow.getByRole('button', { name: `Actions for ${companyName}` }).click();
  await page.getByRole('menuitem', { name: 'Suspend…' }).click();
  await page.getByPlaceholder('Reason').fill('non-payment');
  await page.getByTestId('customer-status-confirm').click();

  // Wait for the console to reflect it before asking the customer's session,
  // otherwise the reload races the server action. The row is patched in place
  // rather than re-read (Block 3c), so this is the grid showing what the write
  // returned, not a fresh query.
  await expect(adminRow.getByText(/suspended/)).toBeVisible({ timeout: 15_000 });

  // The open customer session loses access on its next request — no forced
  // sign-out — because the RLS helpers query the tables on every check.
  await customerPage.reload();
  await expect(customerRow.getByText('suspended', { exact: true })).toBeVisible();
  // Task 11 (7af640b) reworded this from "Your subscription is suspended" to
  // the Station-card sentence below; this assertion had drifted from it.
  await expect(
    customerPage.getByText(/no data is available while the subscription is inactive/i),
  ).toBeVisible();

  await customer.close();
});
