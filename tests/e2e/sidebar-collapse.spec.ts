import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';
import { openNavSection } from './nav';

/**
 * Block 27, item 8: the sidebar folds to a rail of icons, remembers, and gives
 * back what it was hiding.
 *
 * Three claims, and each is asserted where a regression would land:
 *
 *   1. FOLDED, EVERY DESTINATION IS STILL REACHABLE BY NAME. The label stops
 *      being visible text and becomes the accessible name, which is the whole of
 *      what an icon rail owes a screen reader — and the difference between a
 *      compact sidebar and a broken one.
 *   2. IT SURVIVES A RELOAD. The preference is a cookie read on the server, and
 *      this is the only assertion that catches somebody moving it into React
 *      state, where it would work perfectly until the next full navigation.
 *   3. UNFOLDING RESTORES THE DISCLOSURE STATE. Folding forces every section
 *      open without writing to the disclosure cookie; if it wrote instead, a
 *      caller would get every section expanded back and lose what they had
 *      chosen.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-rail-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-rail-admin-${stamp}-pw`;
const ownerEmail = `e2e-rail-owner-${stamp}@example.test`;
const ownerPassword = `Owner-rail-${stamp}-provisional`;
const ownerFinalPassword = `Owner-rail-${stamp}-chosen`;

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
  await provisionCustomer(adminClient, {
    userId: ownerId,
    organizationName: `Rail Org ${stamp}`,
    companyName: `Rail Station ${stamp}`,
  });
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('the sidebar folds to icons, remembers across a reload, and gives the labels back', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const aside = page.locator('aside[data-collapsed]');
  const songs = page.getByRole('link', { name: 'Songs', exact: true });

  // --- Expanded: the label is visible text ----------------------------------
  await expect(aside).toHaveAttribute('data-collapsed', 'false');
  // Catalog is not the section holding /app, so it is closed by default. Opening
  // it gives the disclosure state something to preserve across the fold.
  await openNavSection(page, 'Catalog');
  await expect(songs).toBeVisible();
  await expect(songs).toHaveText('Songs');

  // --- Folded ----------------------------------------------------------------
  await page.getByTestId('sidebar-toggle').click();
  await expect(aside).toHaveAttribute('data-collapsed', 'true');

  // The section HEADING is gone — a rail has nothing to disclose.
  await expect(page.getByRole('button', { name: 'Catalog', exact: true })).toHaveCount(0);
  // The destination is not. Still one click away, still findable by the name the
  // rest of this suite knows it by, and showing no text at all.
  await expect(songs).toBeVisible();
  await expect(songs).toHaveText('');

  // --- Reloaded: still folded ------------------------------------------------
  // The assertion that catches a preference kept in React state.
  await page.reload();
  await expect(aside).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByRole('link', { name: 'Songs', exact: true })).toBeVisible();

  // --- Unfolded: the labels come back, and so does the disclosure ------------
  await page.getByTestId('sidebar-toggle').click();
  await expect(aside).toHaveAttribute('data-collapsed', 'false');
  await expect(page.getByRole('link', { name: 'Songs', exact: true })).toHaveText('Songs');
  // Catalog is STILL open. Folding forced every section open without writing to
  // the disclosure cookie; had it written, this heading would come back
  // expanded-by-accident and every other section with it.
  await expect(page.getByRole('button', { name: 'Catalog', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});
