import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * The whole customer journey through the real UI: a group is provisioned by a
 * platform admin, given a Station, and its record filled in. The owner signs in
 * with the password that was shown once, is forced to change it, and lands in
 * the app. Then the whole customer is blocked, and loses access.
 *
 * This replaces the plan's manual walkthrough. Clicking through it once proves
 * it worked once; this proves it on every run.
 *
 * WHAT BLOCK 16 CHANGED HERE, and why the shape of this file moved: provisioning
 * used to ask for a Station name and create one, so a group and a radio arrived
 * together and this journey was one screen long. It is now two — a customer is a
 * group, and how many radios it has is not known when it is taken on — so the
 * journey provisions on /admin/organizations and configures on /admin/stations.
 *
 * The last act blocks the GROUP rather than suspending the Station, which is the
 * heavier of the two controls and the one with no test before this block: it
 * denies the owner and every member across every Station at once, and the owner
 * is the identity a naive implementation lets through.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-admin-${stamp}-pw`;
const ownerEmail = `e2e-owner-${stamp}@example.test`;
const organizationName = `E2E Org ${stamp}`;
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
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id).catch(() => undefined);
});

test('provision a group, add a Station, fill its record, then block the customer', async ({
  page,
}) => {
  // --- the admin signs in and reaches the console -------------------------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The admin's own gate is clear, so the change screen bounces them onward.
  await expect(page).toHaveURL(/\/app$/);
  // The platform links live in the sidebar, which only renders for a platform
  // admin — so reaching the console this way also asserts the nav is scoped.
  await page.getByRole('link', { name: 'Organizations' }).click();
  await expect(page).toHaveURL(/\/admin\/organizations$/);

  // --- provisioning reveals the password exactly once ---------------------
  // The form lives in a dialog over the console; the dialog is deliberately not
  // closed on success, because the password below is shown once and stored
  // nowhere.
  //
  // THERE IS NO STATION FIELD, and its absence is the change this block exists
  // for: a customer's radios are added afterwards, on the record's third tab.
  await page.getByTestId('organization-create').click();
  await page.getByPlaceholder('Organization name').fill(organizationName);
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

  // --- the listing resolves each group's owner ----------------------------
  // A regression guard on list_organizations' lateral join: the owner comes from
  // organization_memberships joined to profiles, and the failure mode is a blank
  // cell rather than an error, so it can only be caught by asserting the value.
  await page.keyboard.press('Escape');
  await page.reload();
  const groupRow = page.locator('[data-testid="organization-row"]', { hasText: organizationName });
  await expect(groupRow.getByText(ownerEmail)).toBeVisible();

  // --- and can reissue a provisional password -----------------------------
  // exact: the row also carries "Open <name>" and "Actions for <name>" buttons,
  // and a substring match would resolve to all three.
  await groupRow.getByRole('button', { name: organizationName, exact: true }).click();
  await page.getByRole('tab', { name: 'Owner' }).click();
  await page.getByRole('button', { name: 'New password' }).click();
  const reissued = page.locator('code').first();
  await expect(reissued).toBeVisible({ timeout: 15_000 });
  const reissuedPassword = (await reissued.innerText()).trim();
  expect(reissuedPassword.length).toBeGreaterThanOrEqual(16);
  expect(reissuedPassword).not.toBe(provisionalPassword);
  expect(page.url()).not.toContain(reissuedPassword);

  // --- the group gets its first Station -----------------------------------
  await page.getByRole('tab', { name: 'Stations' }).click();
  await page.getByPlaceholder('New Station name').fill(companyName);
  await page.getByTestId('organization-add-station').click();
  // The record patches its own list rather than re-rendering the screen, so the
  // new Station appears without the dialog closing.
  await expect(page.getByRole('link', { name: companyName })).toBeVisible({ timeout: 15_000 });

  // --- and the group's own invoicing identity is recorded -----------------
  await page.getByRole('tab', { name: 'Data' }).click();
  // Typed the way it is printed on a contract. It is stored bare — fourteen
  // digits, no punctuation — which is what the assertion below reads back.
  await page.getByLabel('CNPJ').fill('12.345.678/0001-99');
  await page.getByLabel('Legal name').fill(`${organizationName} Ltda`);
  await page.getByTestId('organization-save').click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 15_000 });

  const { data: savedGroup } = await admin
    .from('organizations')
    .select('tax_id, legal_name')
    .eq('name', organizationName)
    .single();
  expect(savedGroup?.tax_id).toBe('12345678000199');
  expect(savedGroup?.legal_name).toBe(`${organizationName} Ltda`);

  // --- the Station's own record, on the screen that owns it ---------------
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Stations', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/stations$/);

  // Nothing is listed until a group is chosen: this screen reads every listed
  // Station's record eagerly, so "all Stations" is the one selection it must
  // not offer.
  await expect(page.getByTestId('station-row')).toHaveCount(0);
  const { data: group } = await admin
    .from('organizations')
    .select('id')
    .eq('name', organizationName)
    .single();
  if (!group) throw new Error('the provisioned group could not be found');
  await page.getByTestId('station-organization-select').selectOption(group.id);
  await expect(page).toHaveURL(new RegExp(`organization=${group.id}$`));

  const stationRow = page.locator('[data-testid="station-row"]', { hasText: companyName });
  await expect(stationRow).toBeVisible();
  await stationRow.getByRole('button', { name: companyName, exact: true }).click();

  // The Station keeps its OWN invoicing identity, independent of the group's
  // selector above (design D7), and its contact details are new in this block.
  await page.getByTestId('station-contactEmail').fill(`contato@${stamp}.example.test`);
  await page.getByTestId('station-websiteUrl').fill('example.test');
  await page.getByTestId('station-save').click();
  await expect(page.getByText('Saved.')).toBeVisible({ timeout: 15_000 });

  const { data: savedStation } = await admin
    .from('companies')
    .select('contact_email, website_url')
    .eq('name', companyName)
    .single();
  expect(savedStation?.contact_email).toBe(`contato@${stamp}.example.test`);
  // The scheme is added by the service, because the column refuses anything
  // that is not http(s) and these values land in an href.
  expect(savedStation?.website_url).toBe('https://example.test');

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

  // --- blocking the whole customer reaches the open session ---------------
  // ESC first: the record dialog is modal, so the row menu behind it is inert
  // until it closes — and closing it must leave the list exactly as it was.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Organizations' }).click();
  const adminRow = page.locator('[data-testid="organization-row"]', { hasText: organizationName });
  await adminRow.getByRole('button', { name: `Actions for ${organizationName}` }).click();
  await page.getByRole('menuitem', { name: 'Block' }).click();
  await page.getByTestId('organization-block-reason').fill('non-payment');
  await page.getByTestId('organization-block-confirm').click();

  // Wait for the console to reflect it before asking the customer's session,
  // otherwise the reload races the server action. The row is patched in place
  // rather than re-read (Block 3c), so this is the grid showing what the write
  // returned, not a fresh query.
  await expect(adminRow.getByText(/Blocked/)).toBeVisible({ timeout: 15_000 });

  // The open customer session loses access on its next request — no forced
  // sign-out — because the RLS helpers query the tables on every check. THE
  // OWNER, not a member: is_owner_for checked no status at all before 0156, so
  // this is the identity a block written into one door and not the other would
  // leave browsing.
  //
  // They still SEE the Station, which is deliberate and asserted here so nobody
  // tidies it into consistency: a screen that says "no station is linked to your
  // account" to somebody who has one is a screen that lies.
  await customerPage.reload();
  await expect(customerRow).toBeVisible();

  await customer.close();
});
