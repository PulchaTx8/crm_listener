import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

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

// --- the second journey: one prize through its own five-tab record ---------
const journeyOwnerEmail = `e2e-inventory-journey-owner-${stamp}@example.test`;
const journeyOrgName = `Inventory Journey Org ${stamp}`;
const journeyStationName = `Inventory Journey Station ${stamp}`;
const journeyPrizeName = `Journey Turntable ${stamp}`;
const journeyShowName = `Journey Programme ${stamp}`;
// Set directly on the profile (below) rather than typed anywhere in the UI —
// provisioning never asks the owner for a display name, and profiles.full_name
// is nullable (0003), so without this describeActor (movement-history.tsx)
// would fall back to "Unnamed operator" and step 3 of the journey would have
// nothing but that fallback to assert on.
const journeyOwnerFullName = `Journey Owner ${stamp}`;
const journeyInvoiceNumber = `INV-${stamp}`;
const journeyArchiveReason = `Typed the wrong quantity — undoing this purchase (${stamp}).`;
const journeyReserveNote = `Held for ${journeyShowName}`;

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
  // merely because /admin/organizations happened to be reachable.
  await expect(page.getByText(platformAdminEmail)).toBeVisible();
  await expect(page.getByText('Platform admin')).toBeVisible();

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail: ownerEmail,
  });

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
  await expect(ownerPage.getByRole('link', { name: 'Organizations' })).toHaveCount(0);

  // --- the owner composes "Stock Keeper" from the permission catalogue -----
  await openNavSection(ownerPage, 'Organization');
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
  await openNavSection(ownerPage, 'Organization');
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
  // heading above it. The heading is now a <button> (Block 20b's disclosure),
  // and the selector below is still on the LINK, so it is unambiguous either
  // way.
  await openNavSection(delegatePage, 'Inventory');
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

  // --- adds 50 units, on Entradas --------------------------------------
  // Block 23 split the record's one old "Stock movements" tab into five —
  // an entry now lives on its own tab (Entradas) rather than beside the
  // reservation form below.
  await delegatePage.getByRole('tab', { name: 'Entries' }).click();
  const entryForm = delegatePage.locator('[data-testid="stock-entry-form"]');
  await expect(entryForm).toBeVisible();
  await entryForm.getByLabel('Quantity').fill('50');
  await entryForm.getByRole('button', { name: 'Add stock' }).click();
  await expect(entryForm.getByText('Stock added.')).toBeVisible();

  // Newest-first: at this point the entry is the only movement on Entradas,
  // so this locator must resolve to exactly one row (Playwright's expect(locator)
  // throws a strict-mode violation if it matched more than one) — proof this
  // exact figure landed on the ledger, not just that a "success" toast
  // appeared.
  //
  // The ledger reaches this state without a page render: the record re-reads
  // itself after a movement written inside it, where the retired detail page
  // used revalidatePath. Everything the count in record-dialog.spec.ts
  // forbids is therefore also being exercised here.
  await expect(delegatePage.locator('[data-testid="movement-row"]')).toHaveCount(1);

  // --- reserves 10 with a note, on Reservas ---------------------------------
  await delegatePage.getByRole('tab', { name: 'Reservations' }).click();
  const reserveForm = delegatePage.locator('[data-testid="reserve-form"]');
  await expect(reserveForm).toBeVisible();
  await reserveForm.getByLabel('Quantity').fill('10');
  await reserveForm.getByLabel('Note').fill(reserveNote);
  await reserveForm.getByRole('button', { name: 'Reserve stock' }).click();
  await expect(reserveForm.getByText('Reserved.')).toBeVisible();
  await expect(delegatePage.locator('[data-testid="movement-row"]')).toHaveCount(1);

  // --- Movimentação explains the numbers, both movements together -----------
  // Movimentação keeps the old tab's own catalogue key ('stockMovements')
  // because it is still what stayed the one unified, unfiltered history —
  // the entry and the reservation above both land on it, newest first
  // (getPrizeMovements' own order), which is "why does the balance say what
  // it says", the feature this card exists to answer, not a debug view.
  await delegatePage.getByRole('tab', { name: 'Stock movements' }).click();
  const allMovements = delegatePage.locator('[data-testid="movement-row"]');
  await expect(allMovements).toHaveCount(2);

  // The reservation is the only one of the two carrying a remaining
  // quantity — a field list_movements computes for RESERVATION rows alone
  // (services/inventory.ts) — which is what tells the two rows apart without
  // matching either one's translated sentence.
  const reserveMovement = allMovements.filter({ has: delegatePage.getByTestId('movement-remaining') });
  await expect(reserveMovement).toHaveCount(1);
  await expect(reserveMovement.getByText(reserveNote)).toBeVisible();

  const entryMovement = allMovements.filter({ hasNot: delegatePage.getByTestId('movement-remaining') });
  await expect(entryMovement).toHaveCount(1);

  // --- finds no way to adjust, on Saídas ------------------------------------
  // The Stock Keeper role never held inventory.adjust, and it never held
  // inventory.exit either. Saídas is the tab that would fall back to
  // AdjustmentForm for a caller holding inventory.adjust without
  // inventory.exit (entries-tab.tsx/exits-tab.tsx's own comment on that
  // fallback) — station-access.ts's getInventoryPermissions resolves both
  // codes the same way it always has, one screen further in. This assertion
  // fails the instant either form renders for this delegate, which is
  // exactly the regression it exists to catch: a courtesy gate that quietly
  // stopped gating.
  await delegatePage.getByRole('tab', { name: 'Exits' }).click();
  await expect(delegatePage.locator('[data-testid="adjustment-form"]')).toHaveCount(0);
  await expect(delegatePage.locator('[data-testid="stock-exit-form"]')).toHaveCount(0);

  await delegateContext.close();
  await ownerContext.close();
});

/**
 * Block 23's own proof: one prize through every one of its record's five
 * tabs, ending on the assertion the whole block exists for — a balance that
 * corrects itself by arithmetic once an entry is archived, with nothing
 * deleted from the ledger (0195's own header, design D1).
 *
 * The owner alone drives this journey — provision_organization's owner
 * bypass (has_permission, 0121/0024) grants an Organization's owner every
 * permission in every active Company of it, no role to compose — the same
 * simplification shows.spec.ts's own header states for its own journey. The
 * delegate/role test above is what proves the PERMISSION boundary; this one
 * is about the RECORD.
 *
 * Assertions below read test ids and numbers, never translated copy: the
 * movement-* testids on movement-history.tsx (movement-actor, -invoice,
 * -programme, -remaining, -reversed, -reversal-badge) and balance-stats.tsx
 * (balance-available) exist because this is the test that needed them —
 * Task 9's own brief names this as deliberate, not an afterthought.
 */
test('a prize is bought, undone by arithmetic, and left partly reserved for a programme', async ({
  page,
  browser,
}) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: journeyOrgName,
    companyName: journeyStationName,
    ownerEmail: journeyOwnerEmail,
  });

  const { data: ownerProfile, error: ownerLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', journeyOwnerEmail)
    .single();
  expect(ownerLookupError).toBeNull();
  if (!ownerProfile) throw new Error(`no profile row for ${journeyOwnerEmail}`);
  createdUserIds.push(ownerProfile.id);

  // The owner's own display name — see this file's own comment on
  // journeyOwnerFullName above for why this is set directly rather than
  // typed anywhere on screen.
  const { error: nameError } = await admin
    .from('profiles')
    .update({ full_name: journeyOwnerFullName })
    .eq('id', ownerProfile.id);
  expect(nameError).toBeNull();

  // --- the owner signs in and clears the provisional-password gate ---------
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();

  await ownerPage.goto('/login');
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(journeyOwnerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Journey-Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // --- a programme to reserve against, registered through its own screen ---
  // "NO RPC SHORTCUT ON ANY STAGE THAT HAS A SCREEN" (acceptance.spec.ts's
  // own header) applies here too: save_show is SECURITY DEFINER and re-checks
  // music.manage against auth.uid(), which a service-role call carries none
  // of, and service_role holds no INSERT grant on shows in the first place
  // (0099's own comment: "service_role never needs a write grant to make one
  // work"). One band is the minimum save_show accepts (D3/D7); its own hours
  // are never exercised by this journey, so a single ordinary weekday
  // suffices.
  await openNavSection(ownerPage, 'Audience');
  await ownerPage.getByRole('link', { name: 'Programmes' }).click();
  await expect(ownerPage).toHaveURL(/\/shows/);

  await ownerPage.getByTestId('show-add').click();
  await ownerPage.getByTestId('show-name').fill(journeyShowName);
  await ownerPage.getByTestId('show-kind').selectOption('MUSICAL');
  await ownerPage.getByTestId('show-age-rating').selectOption('16');
  await ownerPage.getByTestId('show-starts-on').fill('2026-01-01');
  await ownerPage.getByTestId('show-band-add').click();
  await ownerPage.getByTestId('show-band-0-day-1').check();
  await ownerPage.getByTestId('show-band-0-starts').fill('10:00');
  await ownerPage.getByTestId('show-band-0-ends').fill('12:00');
  await ownerPage.getByTestId('show-save').click();
  await expect(ownerPage.getByTestId('show-row')).toBeVisible({ timeout: 30_000 });
  await expect(ownerPage.getByTestId('show-dialog')).toBeHidden();

  // --- registers the prize --------------------------------------------------
  await openNavSection(ownerPage, 'Inventory');
  await ownerPage.getByRole('link', { name: 'Stock' }).click();
  await expect(ownerPage).toHaveURL(/\/inventory$/);

  await ownerPage.getByTestId('prize-create').click();
  const prizeForm = ownerPage.locator('[data-testid="prize-form"]');
  await expect(prizeForm).toBeVisible();
  await prizeForm.getByLabel('Name').fill(journeyPrizeName);
  await prizeForm.getByRole('button', { name: 'Register prize' }).click();
  await expect(prizeForm.getByText('Prize registered.')).toBeVisible();

  // --- 1. the record opens on Dados do prêmio -------------------------------
  await prizeForm.getByRole('button', { name: 'View prize' }).click();
  await expect(ownerPage).toHaveURL(/\/inventory\?.*record=[0-9a-f-]+/);
  await expect(ownerPage.getByTestId('prize-data-form')).toBeVisible();

  // A baseline stock of 5, seeded before the narrative below — a brand-new
  // prize has no inventory_balances row at all and reads every bucket as 0
  // (services/inventory.ts's own comment on ZERO_BALANCE), and step 6 below
  // proves available returns to exactly where it started once the purchase
  // is archived. Without this seed that "start" would itself be 0, and step
  // 7's reservation of 2 would have nothing to reserve FROM — this row is
  // scaffolding the journey stands on, not one of the eight steps it asserts
  // on, so it carries no invoice and is never itself touched again.
  await ownerPage.getByRole('tab', { name: 'Entries' }).click();
  const seedForm = ownerPage.locator('[data-testid="stock-entry-form"]');
  await expect(seedForm).toBeVisible();
  await seedForm.locator('input[name="quantity"]').fill('5');
  await seedForm.locator('button[type="submit"]').click();
  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(1);

  await ownerPage.getByRole('tab', { name: 'Prize data' }).click();
  const startingAvailable = Number(
    (await ownerPage.getByTestId('balance-available').textContent())?.trim(),
  );
  expect(startingAvailable).toBe(5);

  // --- 2. Entradas: a purchase of 10, with an invoice and a unit price -----
  await ownerPage.getByRole('tab', { name: 'Entries' }).click();
  const entryForm = ownerPage.locator('[data-testid="stock-entry-form"]');
  await expect(entryForm).toBeVisible();
  await entryForm.locator('input[name="quantity"]').fill('10');
  await entryForm.locator('input[name="invoiceNumber"]').fill(journeyInvoiceNumber);
  await entryForm.locator('input[name="unitAmount"]').fill('4.00');

  // D9: quantity × unit price fills the total on its own, before the form is
  // even submitted — read off the input's own value, never a rendered label.
  await expect(entryForm.locator('input[name="totalAmount"]')).toHaveValue('40.00');

  await entryForm.locator('button[type="submit"]').click();

  // --- 3. the row names the invoice AND the actor ---------------------------
  // Two rows now on Entradas — the seed above and this purchase — newest
  // first, so `.first()` is this purchase, the one carrying the invoice.
  // The only layer that renders who did this (movement-history.tsx's own
  // header on describeActor) — read off the testid the value is wrapped in,
  // never the translated "By:"/"Invoice:" label beside it.
  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(2);
  const entryRow = ownerPage.locator('[data-testid="movement-row"]').first();
  await expect(entryRow.getByTestId('movement-invoice')).toHaveText(journeyInvoiceNumber);
  await expect(entryRow.getByTestId('movement-actor')).toHaveText(journeyOwnerFullName);

  // --- 4. Dados do prêmio: available went up by 10 --------------------------
  await ownerPage.getByRole('tab', { name: 'Prize data' }).click();
  await expect(ownerPage.getByTestId('balance-available')).toHaveText(String(startingAvailable + 10));

  // --- 5. Entradas: archive that entry, giving a reason ----------------------
  await ownerPage.getByRole('tab', { name: 'Entries' }).click();
  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(2);
  // The only button a movement-row renders is its own reverse/release action
  // (movement-history.tsx) — this is the newest row's, the purchase just
  // made, never the seed's beneath it.
  await ownerPage.locator('[data-testid="movement-row"]').first().locator('button').click();
  // The confirmation requires a reason (reverse_movement refuses a blank
  // p_note with 22023, entries-tab.tsx's own header on ArchiveMovementDialog).
  // Its own testid, not `textarea[name="note"]`: the StockEntryForm still
  // sitting on this same tab has a note field of the same name, and the two
  // coexist in the DOM while this dialog is open.
  await ownerPage.getByTestId('reversal-reason').fill(journeyArchiveReason);
  await ownerPage.getByTestId('movement-archive-confirm').click();

  // Still the same two rows on Entradas — the purchase itself, now reading
  // as reversed, and the seed beneath it, untouched — never a THIRD row: the
  // reversal the archive produced is a MANUAL_EXIT, which belongs to Saídas
  // (format.ts's EXIT_MOVEMENT_TYPES), never to Entradas (Task 9 brief, item
  // 3 — the design is Task 3's, not a bug to route around).
  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(2);
  await expect(entryRow.getByTestId('movement-reversed')).toBeVisible();

  // The reversal itself surfaces on Saídas: exactly one row, carrying the
  // badge that names what it is.
  await ownerPage.getByRole('tab', { name: 'Exits' }).click();
  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(1);
  await expect(ownerPage.getByTestId('movement-reversal-badge')).toBeVisible();

  // --- 6. Dados do prêmio: available is back where it started ---------------
  // THE ASSERTION THE BLOCK EXISTS FOR. If archiving deleted or edited the
  // original entry instead of writing a second, opposite movement (D1), or if
  // apply_inventory_movement's arithmetic on the reversal were wrong, this
  // figure would land anywhere but exactly back at startingAvailable — either
  // still up by 10 (the reversal never applied), or short of it in some other
  // amount (a quantity or a bucket mismatched between the two movements).
  await ownerPage.getByRole('tab', { name: 'Prize data' }).click();
  await expect(ownerPage.getByTestId('balance-available')).toHaveText(String(startingAvailable));

  // --- 7. Reservas: 2 for a programme ---------------------------------------
  await ownerPage.getByRole('tab', { name: 'Reservations' }).click();
  await ownerPage.getByLabel('Type').selectOption('PROGRAMME');
  // Selected by the programme's own name, not a translated word — the show
  // this journey itself registered above, so this is the entity under test,
  // not UI copy.
  await ownerPage.getByTestId('reservation-show-select').selectOption({ label: journeyShowName });
  const reserveForm = ownerPage.locator('[data-testid="reserve-form"]');
  await expect(reserveForm).toBeVisible();
  await reserveForm.locator('input[name="quantity"]').fill('2');
  await reserveForm.locator('textarea[name="note"]').fill(journeyReserveNote);
  await reserveForm.locator('button[type="submit"]').click();

  await expect(ownerPage.locator('[data-testid="movement-row"]')).toHaveCount(1);
  const reservationRow = ownerPage.locator('[data-testid="movement-row"]').first();
  await expect(reservationRow.getByTestId('movement-programme')).toHaveText(journeyShowName);

  // The remaining-quantity note carries two numbers (remaining, total) inside
  // translated words ("{remaining} of {total} still held") — read as digits,
  // never matched as a whole sentence, so a copy change cannot make this
  // assertion pass or fail on its own.
  const remainingText = (await reservationRow.getByTestId('movement-remaining').textContent()) ?? '';
  const remainingNumbers = remainingText.match(/\d+/g) ?? [];
  expect(remainingNumbers, `"${remainingText}" should carry the reserved and the remaining quantity`).toEqual([
    '2',
    '2',
  ]);

  // --- 8. Movimentação: every one of those movements, newest first ---------
  // Four rows in all: the seed, the purchase, its reversal and the
  // reservation — every write this whole journey made, seed included, since
  // Movimentação is the one unfiltered view (D10) and does not pick and
  // choose among them.
  await ownerPage.getByRole('tab', { name: 'Stock movements' }).click();
  const allMovements = ownerPage.locator('[data-testid="movement-row"]');
  await expect(allMovements).toHaveCount(4);

  // Newest first (list_movements' own order): the reservation just made sits
  // above the reversal, which sits above the archived purchase, which sits
  // above the seed — the oldest of the four. Each row is identified by which
  // testid its own content carries, never by matching a translated sentence.
  await expect(allMovements.nth(0).getByTestId('movement-remaining')).toBeVisible();
  await expect(allMovements.nth(1).getByTestId('movement-reversal-badge')).toBeVisible();
  await expect(allMovements.nth(2).getByTestId('movement-invoice')).toHaveText(journeyInvoiceNumber);
  await expect(allMovements.nth(2).getByTestId('movement-reversed')).toBeVisible();
  // The seed: an ordinary, still-standing entry, carrying none of the three
  // testids above (no invoice, never reversed, nothing left to reverse it
  // into) — the oldest row simply because nothing about it changed.
  await expect(allMovements.nth(3).getByTestId('movement-invoice')).toHaveCount(0);
  await expect(allMovements.nth(3).getByTestId('movement-reversed')).toHaveCount(0);

  await ownerContext.close();
});
