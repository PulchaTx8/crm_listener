import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 24, items 7 and 8, as one journey: an operator reaches Vendors from the
 * sidebar, registers a supplier, edits it, filters for it, and then names it on
 * a stock entry and reads it back on the ledger.
 *
 * THE TWO HALVES ARE ONE TEST ON PURPOSE. The supplier record and the picker on
 * the entry form are two screens with one thing between them, and the thing
 * worth proving is that what a Station registers here is what an entry over
 * there can choose. Split across two specs, each would provision its own
 * customer and neither would prove the join.
 *
 * Sign-in preamble copied from shows.spec.ts, and simplified the same way:
 * provision_customer's owner bypass (has_permission, 0024) grants an
 * Organization's owner every permission in every active Company of that
 * Organization, inventory.catalogue and inventory.entry included, with no role
 * to compose.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-vendors-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-vendors-admin-${stamp}-pw`;
const ownerEmail = `e2e-vendors-owner-${stamp}@example.test`;
const orgName = `Vendors Org ${stamp}`;
const stationName = `Vendors Station ${stamp}`;
const vendorName = `Camisetas do Sul ${stamp}`;
const otherVendorName = `Brindes Norte ${stamp}`;
const prizeName = `Camiseta ${stamp}`;
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

test('an operator registers a vendor and names it on a stock entry', async ({ page, browser }) => {
  // Past the 30s default, and sized to the work rather than rounded up: this
  // journey provisions a customer, changes a password, registers two suppliers
  // and a prize, and records a stock entry — six full page compilations in a dev
  // server, plus every write.
  test.setTimeout(180_000);

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail,
  });

  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  if (!ownerProfile) throw new Error(`no profile row for ${ownerEmail}`);
  createdUserIds.push(ownerProfile.id);

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

  // --- Vendors, reached from the sidebar under Inventory -------------------
  await openNavSection(ownerPage, 'Inventory');
  await ownerPage.getByRole('link', { name: 'Vendors' }).click();
  // A generous timeout on the FIRST navigation to this route and nowhere else:
  // the suite runs against `next dev`, so the first request for a route the
  // server has never served compiles it, and a client-side navigation sits on
  // the old URL until that RSC payload lands. Measured at over five seconds
  // with the other workers competing — a red that is the dev server's compile
  // and not the product's.
  await expect(ownerPage).toHaveURL(/\/inventory\/vendors/, { timeout: 60_000 });
  await expect(ownerPage.getByTestId('vendors-empty')).toBeVisible();

  // --- Register, with every group of the form filled in --------------------
  await ownerPage.getByTestId('vendor-add').click();
  await ownerPage.getByTestId('vendor-name').fill(vendorName);
  await ownerPage.getByTestId('vendor-legal-name').fill('Camisetas do Sul LTDA');
  await ownerPage.getByTestId('vendor-document').fill('12.345.678/0001-90');
  await ownerPage.getByTestId('vendor-contact').fill('Marina');
  await ownerPage.getByTestId('vendor-phone').fill('+55 51 90000-0000');
  await ownerPage.getByTestId('vendor-city').fill('Porto Alegre');
  await ownerPage.getByTestId('vendor-save').click();
  await expect(ownerPage.getByTestId('vendor-row')).toHaveCount(1, { timeout: 30_000 });
  // The register dialog closes itself once the row it produced is on the list.
  await expect(ownerPage.getByTestId('vendor-dialog')).toBeHidden();

  // --- Read it back through the record, not through the grid ---------------
  // The grid shows five of thirteen columns, so a round trip that only checked
  // the row would prove nothing about the eight it does not show.
  await ownerPage.getByTestId('vendor-edit').click();
  await expect(ownerPage.getByTestId('vendor-document')).toHaveValue('12.345.678/0001-90');
  await expect(ownerPage.getByTestId('vendor-legal-name')).toHaveValue('Camisetas do Sul LTDA');
  await expect(ownerPage.getByTestId('vendor-contact')).toHaveValue('Marina');

  // --- Edit: the wholesale replace is the point --------------------------
  // save_vendor writes every column it takes on every call, so a box the
  // operator cleared is cleared. Proved here rather than only in pgTAP, because
  // this is the form that has to post the whole record for that to be safe.
  await ownerPage.getByTestId('vendor-contact').fill('Rafael');
  await ownerPage.getByTestId('vendor-phone').fill('');
  await ownerPage.getByTestId('vendor-save').click();
  await expect(ownerPage.getByTestId('vendor-row').first()).toContainText('Rafael');
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // --- A second supplier, and the filter that narrows to one ---------------
  await ownerPage.getByTestId('vendor-add').click();
  await ownerPage.getByTestId('vendor-name').fill(otherVendorName);
  await ownerPage.getByTestId('vendor-city').fill('Manaus');
  await ownerPage.getByTestId('vendor-save').click();
  await expect(ownerPage.getByTestId('vendor-row')).toHaveCount(2, { timeout: 30_000 });

  await ownerPage.getByTestId('vendors-search').fill('Brindes Norte');
  await expect(ownerPage.getByTestId('vendor-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(ownerPage.getByTestId('vendor-row').first()).toContainText(otherVendorName);
  await ownerPage.getByTestId('vendors-clear-filters').click();
  await expect(ownerPage.getByTestId('vendor-row')).toHaveCount(2, { timeout: 30_000 });

  // --- A prize to buy, and the entry that names who sold it ----------------
  await ownerPage.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(ownerPage).toHaveURL(/\/inventory$/);

  await ownerPage.getByTestId('prize-create').click();
  const prizeForm = ownerPage.locator('[data-testid="prize-form"]');
  await expect(prizeForm).toBeVisible();
  await prizeForm.getByLabel('Name').fill(prizeName);
  await prizeForm.getByRole('button', { name: 'Register prize' }).click();
  await expect(prizeForm.getByText('Prize registered.')).toBeVisible();
  await prizeForm.getByRole('button', { name: 'View prize' }).click();
  await expect(ownerPage).toHaveURL(/\/inventory\?.*record=[0-9a-f-]+/);

  await ownerPage.getByRole('tab', { name: 'Entries' }).click();
  const entryForm = ownerPage.locator('[data-testid="stock-entry-form"]');
  await expect(entryForm).toBeVisible();

  // THE PICKER FILTERS IN THE BROWSER over the list that arrived with the
  // record — no round trip, which is also what makes this assertion meaningful
  // rather than a race: typing narrows the options synchronously.
  await entryForm.getByTestId('stock-entry-vendor-filter').fill('Camisetas');
  await expect(entryForm.getByTestId('stock-entry-vendor').locator('option')).toHaveCount(2);
  await entryForm.getByTestId('stock-entry-vendor').selectOption({ label: vendorName });
  await entryForm.getByLabel('Quantity').fill('10');
  await entryForm.getByLabel('Invoice').fill('NF-2024');
  await entryForm.getByRole('button', { name: 'Add stock' }).click();
  await expect(entryForm.getByText('Stock added.')).toBeVisible();

  // --- The ledger names the supplier --------------------------------------
  await expect(ownerPage.getByTestId('movement-vendor').first()).toHaveText(vendorName, {
    timeout: 30_000,
  });
  await expect(ownerPage.getByTestId('movement-invoice').first()).toHaveText('NF-2024');

  // And the database agrees, which is what rules out a screen echoing back what
  // it was handed.
  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  const { data: movements } = await admin
    .from('inventory_movements')
    .select('quantity, invoice_number, vendors(name)')
    .eq('company_id', station?.id ?? '');

  expect(movements).toHaveLength(1);
  expect(movements?.[0]?.quantity).toBe(10);
  expect(movements?.[0]?.invoice_number).toBe('NF-2024');
  // The embed's generated type is an array here, because PostgREST cannot know
  // from the schema alone that vendor_id is a to-one reference. It resolves to
  // one row, which is what the composite foreign key guarantees.
  const embedded = movements?.[0]?.vendors as unknown as
    | { name: string }
    | { name: string }[]
    | null;
  const suppliedBy = Array.isArray(embedded) ? embedded[0]?.name : embedded?.name;
  expect(suppliedBy).toBe(vendorName);
});
