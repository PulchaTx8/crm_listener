import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The whole prize-and-stock journey through the real UI (Block 2, Task 10).
 *
 * An owner composes a "Stock Keeper" role from the permission catalogue —
 * inventory.view, inventory.catalogue, inventory.entry and inventory.reserve,
 * deliberately withholding inventory.adjust — and assigns it to a delegate in
 * one Station. The owner appears only for those two steps. From there the
 * delegate drives every remaining step themselves: registers a prize, adds 50
 * units, reserves 10 with a note, opens the prize and reads the movement
 * history that explains the balance, and finds no way to adjust stock, because
 * they were never given that permission.
 *
 * The role-editor assertion below is as much the point as the journey itself:
 * the six inventory.* permissions were inserted into `permissions` by
 * migration 0025 (Block 2, Task 1) and nothing in role-form.tsx or roles/
 * page.tsx (both Block 1c) was touched to display them. If that catalogue had
 * not been built to be extended, one of the six labels asserted below would
 * simply not appear.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-inventory-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-inventory-admin-${stamp}-pw`;
const ownerEmail = `e2e-inventory-owner-${stamp}@example.test`;
const delegateEmail = `e2e-inventory-delegate-${stamp}@example.test`;
const delegatePassword = `Delegate-${stamp}-pw`;
const orgName = `Inventory Org ${stamp}`;
const stationName = `Inventory Station ${stamp}`;
const roleName = 'Stock Keeper';
const prizeName = `Festival Hoodie ${stamp}`;
const reserveNote = `Held back for the ${stamp} community draw`;
const createdUserIds: string[] = [];

test.beforeAll(async () => {
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

test('a delegate holding a scoped Stock Keeper role runs the whole prize and stock journey', async ({
  page,
  browser,
}) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Identity #1 of 3: the platform admin. The "Platform admin" role label and
  // the Customers console link only render for this identity (lib/auth/
  // shell.ts) — asserting both here is what stops this test from passing
  // merely because /admin/customers happened to be reachable.
  await expect(page.getByText(platformAdminEmail)).toBeVisible();
  await expect(page.getByText('Platform admin')).toBeVisible();

  await page.getByRole('link', { name: 'Customers' }).click();
  await page.getByTestId('customer-create').click();
  await page.getByPlaceholder('Organization name').fill(orgName);
  await page.getByPlaceholder('Company (Station) name').fill(stationName);
  await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
  await page.getByRole('button', { name: 'Provision', exact: true }).click();

  const revealed = page.locator('code').first();
  await expect(revealed).toBeVisible({ timeout: 15_000 });
  const ownerPassword = (await revealed.innerText()).trim();

  const { data: ownerProfile, error: ownerLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  expect(ownerLookupError).toBeNull();
  if (!ownerProfile) throw new Error(`no profile row for ${ownerEmail}`);
  createdUserIds.push(ownerProfile.id);

  // --- the owner signs in and clears the provisional-password gate ---------
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();

  await ownerPage.goto('/login');
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // Identity #2 of 3: the owner, in a separate browser context from the
  // admin above. Checking their own e-mail is visible, and that the
  // platform-only Customers link is absent, is what proves this context
  // actually switched identity rather than reusing the admin's session.
  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: 'Customers' })).toHaveCount(0);

  // --- the owner composes "Stock Keeper" from the permission catalogue -----
  await ownerPage.getByRole('link', { name: 'Roles' }).click();
  await expect(ownerPage).toHaveURL(/\/roles$/);

  // This is the test of whether Block 1c's permission catalogue was built to
  // be extended: migration 0025 (Task 1 of this block) inserted these six
  // rows into `permissions`, and the role editor was never touched to know
  // about "inventory" as a module — not when it was role-form.tsx, and not
  // when Block 3c moved it into role-record-dialog.tsx. Each label below is
  // read straight out of that migration's `label` column, not paraphrased — a
  // rename there would turn this into a real (not flaky) failure.
  await ownerPage.getByTestId('role-create').click();
  await ownerPage.getByRole('tab', { name: 'Powers' }).click();
  const catalogueLabels = [
    'See prizes and stock', // inventory.view
    'Register, edit and archive prizes and categories', // inventory.catalogue
    'Add stock', // inventory.entry
    'Record a manual exit', // inventory.exit
    'Adjust stock to match a count', // inventory.adjust
    'Reserve stock and release a reservation', // inventory.reserve
  ];
  for (const label of catalogueLabels) {
    await expect(ownerPage.getByLabel(label)).toBeVisible();
  }

  await ownerPage.getByLabel('See prizes and stock').check();
  await ownerPage.getByLabel('Register, edit and archive prizes and categories').check();
  await ownerPage.getByLabel('Add stock').check();
  await ownerPage.getByLabel('Reserve stock and release a reservation').check();
  // Deliberately left unchecked: "Record a manual exit" (inventory.exit) and
  // "Adjust stock to match a count" (inventory.adjust). The whole point of
  // this role, and of the absence assertion at the end of this test, is that
  // its holder cannot adjust.
  await ownerPage.getByRole('tab', { name: 'Role data' }).click();
  await ownerPage.getByLabel('Name').fill(roleName);
  await ownerPage.getByTestId('role-save').click();

  const roleRow = ownerPage.locator('[data-testid="role-row"]', { hasText: roleName });
  await expect(roleRow).toBeVisible();
  await expect(roleRow.getByText('held by 0 user(s)')).toBeVisible();

  // --- the owner assigns it to the delegate, in the one Station ------------
  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/team$/);

  await ownerPage.getByTestId('team-invite').click();
  const inviteForm = ownerPage.locator('form', {
    has: ownerPage.getByPlaceholder("Colleague's e-mail"),
  });
  await inviteForm.getByPlaceholder("Colleague's e-mail").fill(delegateEmail);
  await inviteForm.getByRole('combobox').selectOption({ label: roleName });
  await inviteForm.getByLabel(stationName).check();
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

  const linkBox = ownerPage.locator('code').first();
  await expect(linkBox).toBeVisible({ timeout: 15_000 });
  const acceptUrl = (await linkBox.innerText()).trim();
  expect(acceptUrl).toContain('/invite/');

  // --- from here on, the delegate drives every remaining step --------------
  const delegateContext = await browser.newContext();
  const delegatePage = await delegateContext.newPage();

  await delegatePage.goto(acceptUrl);
  await expect(delegatePage.getByRole('heading', { name: `Join ${orgName}` })).toBeVisible();

  await delegatePage.getByPlaceholder('Choose a password').fill(delegatePassword);
  await delegatePage.getByPlaceholder('Repeat the password').fill(delegatePassword);
  await delegatePage.getByRole('button', { name: 'Create my account' }).click();
  await expect(delegatePage).toHaveURL(/\/login/);

  const { data: delegateProfile, error: delegateLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', delegateEmail)
    .single();
  expect(delegateLookupError).toBeNull();
  if (!delegateProfile) throw new Error(`no profile row for ${delegateEmail}`);
  createdUserIds.push(delegateProfile.id);

  await delegatePage.getByLabel('E-mail', { exact: true }).fill(delegateEmail);
  await delegatePage.getByLabel('Password', { exact: true }).fill(delegatePassword);
  await delegatePage.getByRole('button', { name: 'Sign in' }).click();
  await expect(delegatePage).toHaveURL(/\/app$/);

  // Identity #3 of 3: the delegate, in yet another browser context. Asserting
  // their own e-mail is visible AND that the owner's e-mail is nowhere on the
  // page is what rules out a leaked/reused session — a test that "passed"
  // while quietly still being logged in as the owner would prove nothing
  // about the Stock Keeper role at all.
  await expect(delegatePage.getByText(delegateEmail)).toBeVisible();
  await expect(delegatePage.getByText(ownerEmail)).toHaveCount(0);
  await expect(
    delegatePage.locator('[data-testid="station-card"]', { hasText: stationName }),
  ).toBeVisible();

  // --- the delegate registers a prize ---------------------------------------
  // 'Stock', not 'Inventory': Block 6d, Task 10 renamed this nav item (the
  // href is unchanged, still /inventory) when a second item, Movements,
  // joined it under a section now itself labelled 'Inventory' — this
  // assertion is about reaching the stock screen, not about the section
  // heading above it (which renders as a plain <p> in sidebar-nav.tsx and was
  // never a link this could have selected anyway).
  await delegatePage.getByRole('link', { name: 'Stock' }).click();
  await expect(delegatePage).toHaveURL(/\/inventory$/);

  // The button is rendered only because the delegate holds inventory.catalogue
  // — a courtesy gate, not the boundary (station-access.ts's own comment), but
  // its presence here is what lets the rest of this step use the real form
  // rather than asserting against a screen that doesn't exist for them.
  await delegatePage.getByTestId('prize-create').click();
  const prizeForm = delegatePage.locator('[data-testid="prize-form"]');
  await expect(prizeForm).toBeVisible();
  await prizeForm.getByLabel('Name').fill(prizeName);
  await prizeForm.getByRole('button', { name: 'Register prize' }).click();
  await expect(prizeForm.getByText('Prize registered.')).toBeVisible();

  // "View prize" closes the registration dialog and opens the new prize's
  // record over the list, which is also what puts its row on that list — the
  // record's own read is where the row comes from, so there is no second
  // query and no re-render of the screen behind it.
  await prizeForm.getByRole('button', { name: 'View prize' }).click();
  await expect(delegatePage).toHaveURL(/\/inventory\?.*record=[0-9a-f-]+/);
  await expect(delegatePage.getByRole('heading', { name: prizeName, level: 2 })).toBeVisible();

  const prizeRow = delegatePage.locator('[data-testid="prize-row"]', { hasText: prizeName });
  await expect(prizeRow).toBeVisible();

  // --- adds 50 units -----------------------------------------------------
  await delegatePage.getByRole('tab', { name: 'Stock movements' }).click();
  const entryForm = delegatePage.locator('[data-testid="stock-entry-form"]');
  await expect(entryForm).toBeVisible();
  await entryForm.getByLabel('Quantity').fill('50');
  await entryForm.getByRole('button', { name: 'Add stock' }).click();
  await expect(entryForm.getByText('Stock added.')).toBeVisible();

  // Newest-first: at this point the entry is the only movement, so this
  // locator must resolve to exactly one row (Playwright's expect(locator)
  // throws a strict-mode violation if it matched more than one) — proof this
  // exact figure and bucket transition are on the ledger, not just that a
  // "success" toast appeared.
  //
  // The ledger reaches this state without a page render: the record re-reads
  // itself after a movement written inside it, where the retired detail page
  // used revalidatePath. Everything the count in record-dialog.spec.ts
  // forbids is therefore also being exercised here.
  const entryMovement = delegatePage.locator('[data-testid="movement-row"]', {
    hasText: '50 unit(s), outside the Station → Available',
  });
  await expect(entryMovement).toBeVisible();

  // --- reserves 10 with a note ---------------------------------------------
  const reserveForm = delegatePage.locator('[data-testid="reserve-form"]');
  await expect(reserveForm).toBeVisible();
  await reserveForm.getByLabel('Quantity').fill('10');
  await reserveForm.getByLabel('Note').fill(reserveNote);
  await reserveForm.getByRole('button', { name: 'Reserve stock' }).click();
  await expect(reserveForm.getByText('Reserved.')).toBeVisible();

  // --- the movement history explains the numbers ----------------------------
  // Exactly two movements exist: the entry and the reservation above. Newest
  // first (getPrizeMovements' own order), each row names its quantity, the
  // bucket transition and the note — this is "why does the balance say what
  // it says", the feature this card exists to answer, not a debug view.
  await expect(delegatePage.locator('[data-testid="movement-row"]')).toHaveCount(2);
  await expect(entryMovement).toBeVisible();

  const reserveMovement = delegatePage.locator('[data-testid="movement-row"]', {
    hasText: '10 unit(s), Available → Reserved',
  });
  await expect(reserveMovement).toBeVisible();
  await expect(reserveMovement.getByText(reserveNote)).toBeVisible();

  // --- finds no way to adjust ------------------------------------------------
  // The Stock Keeper role never held inventory.adjust. The adjustment form
  // lives behind `powers.adjust` on the record's Stock movements tab, which
  // page.tsx resolves through station-access.ts's getInventoryPermissions —
  // the same permission, the same resolver, one screen further in. This
  // assertion fails the instant that form renders for this delegate, which is
  // exactly the regression it exists to catch: a courtesy gate that quietly
  // stopped gating.
  await expect(delegatePage.locator('[data-testid="adjustment-form"]')).toHaveCount(0);

  // Same reasoning, same mechanism, for inventory.exit — also never granted.
  await expect(delegatePage.locator('[data-testid="stock-exit-form"]')).toHaveCount(0);

  await delegateContext.close();
  await ownerContext.close();
});
