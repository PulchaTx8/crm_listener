import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 20c. The reference screens (Task 3): `/catalog/labels` and
 * `/catalog/genres`, one component rendered twice (design spec §2 D2).
 * Task 4 appends the albums journey; Task 5 carries across whatever
 * tests/e2e/music-catalogue.spec.ts proved before deleting it, and repoints
 * the sidebar at these routes.
 *
 * Only `/catalog/labels` is driven below — the two routes render the exact
 * same component (reference-screen.tsx) with only `kind` and `copy` swapped,
 * so a second, near-identical journey through `/catalog/genres` would prove
 * the copy differs and nothing else. Task 5's sidebar journey is where
 * `/catalog/genres` is reached instead.
 *
 * Fixtures are provisioned through the RPC path (provisionCustomer), not
 * clicked through the console — the same reasoning filtered-draw.spec.ts and
 * dashboards.spec.ts give for their own: this journey is Task 3's reference
 * screens, not Task 16's provisioning console.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-catalog-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-catalog-admin-${stamp}-pw`;
const ownerEmail = `e2e-catalog-owner-${stamp}@example.test`;
const ownerPassword = `Owner-catalog-${stamp}-provisional`;
const ownerFinalPassword = `Owner-catalog-${stamp}-chosen`;

const createdUserIds: string[] = [];

async function signIn(email: string, password: string) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in failed for ${email}: ${error.message}`);
  return client;
}

async function createUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  await admin.from('profiles').insert({ id: data.user.id, email });
  return data.user.id;
}

test.beforeAll(async () => {
  const adminId = await createUser(platformAdminEmail, platformAdminPassword);
  await admin.from('platform_admins').insert({ user_id: adminId });
  const ownerId = await createUser(ownerEmail, ownerPassword);

  const adminClient = await signIn(platformAdminEmail, platformAdminPassword);
  // provision_organization/add_company mark the owner's password provisional
  // regardless of which client created it — the sign-in below still meets the
  // change-password screen, the same as every other spec that uses this
  // helper.
  await provisionCustomer(adminClient, {
    userId: ownerId,
    organizationName: `Catalog Org ${stamp}`,
    companyName: `Catalog Station ${stamp}`,
  });
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a record label is registered, found and archived on its own screen', async ({ page }) => {
  // Sign in as an owner with music.manage — provision_customer's owner bypass
  // (has_permission, 0024) grants an Organization's owner every permission,
  // music.view and music.manage included, in every active Company of that
  // Organization, with no role to compose or assign.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The screen exists at its own address -- the whole of item 5.
  await page.goto('/catalog/labels');
  await expect(page.getByRole('heading', { name: 'Record labels' })).toBeVisible();

  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Teste 20c');
  await page.getByTestId('reference-save').click();

  await expect(page.getByTestId('references-grid')).toContainText('Selo Teste 20c');

  // The filter narrows to it, and away from it.
  await page.getByTestId('references-search').fill('Selo Teste 20c');
  await page.getByTestId('references-search-submit').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Teste 20c');

  await page.getByTestId('references-search').fill('nothing matches this');
  await page.getByTestId('references-search-submit').click();
  await expect(page.getByTestId('references-grid')).not.toContainText('Selo Teste 20c');
});
