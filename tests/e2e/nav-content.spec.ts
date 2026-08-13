import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 20b, Task 1. The sidebar's CONTENTS and ORDER — not merely that a
 * link to each screen exists somewhere. src/lib/auth/shell.ts builds one tree
 * for both the member area and the platform console (its own header comment
 * says so), so this is the one file where a regression in either would show.
 *
 * A PLATFORM ADMIN, not an owner, and no Organization or Station is
 * provisioned at all. The eleventh section, 'platform', is admin-only
 * (shell.ts's own `if (isAdmin)` push at the bottom) — the reason this spec
 * needs a platform admin rather than an ordinary member. Every OTHER section
 * renders regardless of Organization membership: each one's own comment in
 * shell.ts records the courtesy (a permission gate lives in the database, not
 * in the nav), so a bare platform admin sees all eleven without provision.ts
 * ever being asked to build an owner and a Station nobody here reads from.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-nav-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-nav-admin-${stamp}-pw`;
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

test('the sidebar lists what the product does, in the order somebody chose', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Platform admin')).toBeVisible();

  // Block 20b, D1/D2/D3. The sidebar's CONTENTS and ORDER, asserted by section
  // rather than by counting links: a link exists somewhere is not the claim --
  // the claim is that Requests is filed under Audience and no longer under the
  // catalogue, which is the whole of item 3.
  //
  // English, because playwright.config.ts pins locale: 'en-US' for the suite.
  const audience = page.locator('[data-nav-section="audience"]');
  await expect(audience.getByRole('link', { name: 'Requests' })).toBeVisible();

  const catalogue = page.locator('[data-nav-section="catalog"]');
  await expect(catalogue.getByRole('link', { name: 'Requests' })).toHaveCount(0);
  await expect(catalogue.getByRole('link', { name: 'Record labels' })).toBeVisible();
  await expect(catalogue.getByRole('link', { name: 'Genres' })).toBeVisible();
  await expect(catalogue.getByRole('link', { name: 'Albums' })).toBeVisible();
  // The item this replaces is gone: a section named Catalogue holding an item
  // named Catalogue is the "one link rendered twice" shell.ts warns about in
  // three separate comments.
  await expect(catalogue.getByRole('link', { name: 'Catalogue', exact: true })).toHaveCount(0);

  // D3. The two administrative sections sit AFTER Organization, at the foot of
  // the list -- which is the opposite of what the owner's item 8 literally said
  // and what they actually meant (spec §2 D3).
  const keys = await page.locator('[data-nav-section]').evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('data-nav-section')),
  );
  expect(keys).toEqual([
    'overview', 'dashboards', 'inventory', 'audience', 'promotions',
    'catalog', 'templates', 'organization', 'reports', 'administration',
    'platform',
  ]);
});
