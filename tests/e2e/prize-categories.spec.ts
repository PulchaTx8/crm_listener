import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 26, as one journey: an operator reaches Categories from the sidebar,
 * registers one, renames it, searches for it, then registers a THIRD category
 * from inside the Register Prize dialog on the next screen and finds it in that
 * screen's own filter without a reload — and finally archives it and watches the
 * prize that wore it become uncategorised.
 *
 * THE TWO SCREENS ARE ONE TEST ON PURPOSE. The whole of the owner's item 4 is a
 * claim about what happens BETWEEN them: a category registered inside a dialog on
 * Stock has to reach the filter beside it, and a category archived on Categories
 * has to reach the prizes on Stock. Split across two specs, each would provision
 * its own customer and neither would prove the join.
 *
 * Sign-in preamble copied from vendors.spec.ts, and simplified the same way:
 * provision_customer's owner bypass (has_permission, 0024) grants an
 * Organization's owner every permission in every active Company of that
 * Organization, inventory.view and inventory.catalogue included, with no role to
 * compose.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-categories-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-categories-admin-${stamp}-pw`;
const ownerEmail = `e2e-categories-owner-${stamp}@example.test`;
const orgName = `Categories Org ${stamp}`;
const stationName = `Categories Station ${stamp}`;
const firstCategory = `Camisetas ${stamp}`;
const renamedCategory = `Camisetas e bonés ${stamp}`;
const secondCategory = `Canecas ${stamp}`;
const inlineCategory = `Chaveiros ${stamp}`;
const prizeName = `Chaveiro de metal ${stamp}`;
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

test('an operator manages categories, and registers one without leaving the prize form', async ({
  page,
  browser,
}) => {
  // Past the 30s default, and sized to the work rather than rounded up: this
  // journey provisions a customer, changes a password, visits two routes for the
  // first time, and performs seven writes.
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

  // --- Categories, reached from the sidebar under Inventory ----------------
  await openNavSection(ownerPage, 'Inventory');
  await ownerPage.getByRole('link', { name: 'Categories' }).click();
  // A generous timeout on the FIRST navigation to this route and nowhere else:
  // the suite runs against `next dev`, so the first request for a route the
  // server has never served compiles it, and a client-side navigation sits on
  // the old URL until that RSC payload lands.
  await expect(ownerPage).toHaveURL(/\/inventory\/categories/, { timeout: 60_000 });
  await expect(ownerPage.getByTestId('categories-empty')).toBeVisible();

  // --- Register ------------------------------------------------------------
  await ownerPage.getByTestId('category-add').click();
  await ownerPage.getByTestId('category-name').fill(firstCategory);
  await ownerPage.getByTestId('category-save').click();
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(1, { timeout: 30_000 });
  // The register dialog closes itself once the row it produced is on the list.
  await expect(ownerPage.getByTestId('category-dialog')).toBeHidden();
  await expect(ownerPage.getByTestId('category-row').first()).toContainText(firstCategory);

  // --- Rename: the row is patched, not re-fetched ---------------------------
  await ownerPage.getByTestId('category-edit').click();
  await expect(ownerPage.getByTestId('category-name')).toHaveValue(firstCategory);
  // The record says what renaming does to the prizes, and there are none yet.
  await expect(ownerPage.getByTestId('category-prize-count')).toContainText('No prize wears');
  await ownerPage.getByTestId('category-name').fill(renamedCategory);
  await ownerPage.getByTestId('category-save').click();
  await expect(ownerPage.getByTestId('category-row').first()).toContainText(renamedCategory);
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // --- A second category, and the search that narrows to one ---------------
  await ownerPage.getByTestId('category-add').click();
  await ownerPage.getByTestId('category-name').fill(secondCategory);
  await ownerPage.getByTestId('category-save').click();
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(2, { timeout: 30_000 });

  await ownerPage.getByTestId('categories-search').fill('Canecas');
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(ownerPage.getByTestId('category-row').first()).toContainText(secondCategory);
  await ownerPage.getByTestId('categories-clear-filters').click();
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(2, { timeout: 30_000 });

  // --- Stock: the button that used to register a category is gone ----------
  await ownerPage.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(ownerPage).toHaveURL(/\/inventory(\?|$)/, { timeout: 60_000 });
  await expect(ownerPage.getByRole('button', { name: 'Register category' })).toHaveCount(0);

  // The filter offers the two that exist, and not the one about to be made.
  const categoryFilter = ownerPage.getByTestId('prize-category-filter');
  await expect(categoryFilter.locator('option', { hasText: renamedCategory })).toHaveCount(1);
  await expect(categoryFilter.locator('option', { hasText: inlineCategory })).toHaveCount(0);

  // --- THE OWNER'S ITEM 4: a category registered inside the prize dialog ----
  await ownerPage.getByTestId('prize-create').click();
  const prizeForm = ownerPage.locator('[data-testid="prize-form"]');
  await expect(prizeForm).toBeVisible();

  await prizeForm.getByTestId('inline-category-open').click();
  await prizeForm.getByTestId('inline-category-name').fill(inlineCategory);
  // ENTER, not the button. An uncaught Enter inside a form submits it, and the
  // form this box sits in registers a prize — so the keystroke is the case worth
  // proving, not the click beside it.
  await prizeForm.getByTestId('inline-category-name').press('Enter');

  // It arrives already chosen, because the operator asked for it while filling
  // in this prize.
  await expect(prizeForm.getByTestId('prize-category')).toHaveValue(/[0-9a-f-]{36}/, { timeout: 30_000 });
  await expect(
    prizeForm.getByTestId('prize-category').locator('option', { hasText: inlineCategory }),
  ).toHaveCount(1);
  // And the prize was NOT registered by that Enter.
  await expect(prizeForm.getByText('Prize registered.')).toHaveCount(0);

  // THE ASSERTION THE WHOLE SCREEN EXISTS FOR. No navigation has happened since
  // the category was written, so the filter behind this dialog can only be
  // offering it because the two share one list in the browser — which is what
  // this screen has instead of a router.refresh() it must never call.
  await expect(categoryFilter.locator('option', { hasText: inlineCategory })).toHaveCount(1);

  // --- Register the prize under it -----------------------------------------
  await prizeForm.getByLabel('Name', { exact: true }).fill(prizeName);
  await prizeForm.getByRole('button', { name: 'Register prize' }).click();
  await expect(prizeForm.getByText('Prize registered.')).toBeVisible({ timeout: 30_000 });
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // The database agrees, which is what rules out a screen echoing back what it
  // was handed.
  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  const { data: stored } = await admin
    .from('prizes')
    .select('name, prize_categories(name)')
    .eq('company_id', station?.id ?? '')
    .eq('name', prizeName)
    .single();
  const embedded = stored?.prize_categories as unknown as
    | { name: string }
    | { name: string }[]
    | null;
  const wornLabel = Array.isArray(embedded) ? embedded[0]?.name : embedded?.name;
  expect(wornLabel).toBe(inlineCategory);

  // --- Back on Categories: the count, and what archiving costs -------------
  await ownerPage.getByRole('link', { name: 'Categories' }).click();
  await expect(ownerPage).toHaveURL(/\/inventory\/categories/, { timeout: 60_000 });
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(3, { timeout: 30_000 });

  const inlineRow = ownerPage
    .getByTestId('category-row')
    .filter({ hasText: inlineCategory });
  await expect(inlineRow.getByTestId('category-prizes-link')).toHaveText('1');

  // --- ARCHIVING IS REFUSED WHILE A PRIZE WEARS IT -------------------------
  // The owner's ruling of 2026-08-16. There is nothing to confirm, so there is
  // no confirm button to render — asserting its ABSENCE is the point, because a
  // disabled one would look like the same screen to anybody skimming.
  await inlineRow.getByRole('button', { name: /Actions for/ }).click();
  await ownerPage.getByTestId('category-archive').click();
  await expect(ownerPage.getByTestId('category-archive-warning')).toContainText(
    'One prize still wears this label',
  );
  await expect(ownerPage.getByTestId('category-archive-confirm')).toHaveCount(0);
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(3);

  // And the database agrees the refusal changed nothing.
  const { count: stillLive } = await admin
    .from('prize_categories')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', station?.id ?? '')
    .is('deleted_at', null);
  expect(stillLive).toBe(3);

  // --- Move the prize off, through the door the maintenance screen will use -
  await ownerPage.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(ownerPage).toHaveURL(/\/inventory(\?|$)/, { timeout: 60_000 });
  const prizeRow = ownerPage.getByTestId('prize-row').filter({ hasText: prizeName });
  await expect(prizeRow).toHaveCount(1, { timeout: 30_000 });
  await expect(prizeRow).toContainText(inlineCategory);

  // The pencil, not the name: an accessible name matches by substring, so the
  // prize's own name also matches "Edit …" and "Actions for …" on the same row.
  // The pencil opens the record on the Data tab explicitly, which is the one
  // this needs.
  await prizeRow.getByRole('button', { name: `Edit ${prizeName}`, exact: true }).click();
  const dataForm = ownerPage.locator('[data-testid="prize-data-form"]');
  await expect(dataForm).toBeVisible({ timeout: 30_000 });
  // By attribute rather than by label: this is a <select> inside its own
  // <label>, so the label's text content is "Category" followed by every option
  // in it — the same reason the register form's own picker carries a testid.
  await dataForm.locator('select[name="categoryId"]').selectOption('');
  await dataForm.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dataForm.getByText('Saved.')).toBeVisible({ timeout: 30_000 });
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(prizeRow).toContainText('Uncategorised');

  // --- Now it archives -----------------------------------------------------
  await ownerPage.getByRole('link', { name: 'Categories' }).click();
  await expect(ownerPage).toHaveURL(/\/inventory\/categories/, { timeout: 60_000 });
  const freedRow = ownerPage.getByTestId('category-row').filter({ hasText: inlineCategory });
  await expect(freedRow.getByTestId('category-prizes-link')).toHaveCount(0);

  await freedRow.getByRole('button', { name: /Actions for/ }).click();
  await ownerPage.getByTestId('category-archive').click();
  await ownerPage.getByTestId('category-archive-confirm').click();
  await expect(ownerPage.getByTestId('category-row')).toHaveCount(2, { timeout: 30_000 });

  // The archived category is no longer offered as a filter on Stock either —
  // 0029's select policy filters `deleted_at`, so no read can reach it.
  await ownerPage.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(ownerPage).toHaveURL(/\/inventory(\?|$)/, { timeout: 60_000 });
  await expect(categoryFilter.locator('option', { hasText: inlineCategory })).toHaveCount(0);
});
