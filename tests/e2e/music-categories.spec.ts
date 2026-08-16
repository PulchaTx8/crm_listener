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
 * Block 27, items 1 and 5, as one journey: an operator reaches Categories from
 * the sidebar, registers one, finds it in the Song data form on the next screen,
 * saves a song with it, reads it back in the list's own column, filters the list
 * down to it — and then tries to archive it and is refused because that song
 * still wears it.
 *
 * THE TWO SCREENS ARE ONE TEST ON PURPOSE, the same reasoning
 * prize-categories.spec.ts gives for its own pair. Everything worth proving here
 * happens BETWEEN them: a category registered on one screen has to reach a
 * <select> and a filter on the other, and a song saved on the second has to
 * reach the archive refusal on the first. Split in two, each half would
 * provision its own customer and neither would prove the join.
 *
 * Fixtures are provisioned through the RPC path rather than clicked through the
 * console — the same reasoning catalog-screens.spec.ts gives for its own: this
 * journey is the category, not Block 16's provisioning console. The ARTIST is
 * seeded the same way, for the same reason: a song needs one, and registering it
 * by hand would be a second screen's journey inside this one.
 *
 * The owner drives, which this suite normally avoids. Here it is right: the
 * permission boundary is not what this journey is about, and
 * tests/isolation/music-categories.test.ts drives every one of those cases as a
 * non-owner delegate through a real JWT.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-mcat-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-mcat-admin-${stamp}-pw`;
const ownerEmail = `e2e-mcat-owner-${stamp}@example.test`;
const ownerPassword = `Owner-mcat-${stamp}-provisional`;
const ownerFinalPassword = `Owner-mcat-${stamp}-chosen`;

const artistName = `Elis ${stamp}`;
const categoryName = `Trilha sonora ${stamp}`;
const otherCategoryName = `Vinheta ${stamp}`;
const songTitle = `Aguas de marco ${stamp}`;
const otherSongTitle = `Chamada da tarde ${stamp}`;

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
  const { company_id: companyId } = await provisionCustomer(adminClient, {
    userId: ownerId,
    organizationName: `Music Category Org ${stamp}`,
    companyName: `Music Category Station ${stamp}`,
  });

  // The owner's bypass (has_permission, 0024) grants every permission in every
  // active Company of the Organization, so no role has to be composed. Signing
  // in with the provisional password is enough to call the door; the screen
  // journey below still walks through /change-password.
  const ownerClient = await signIn(ownerEmail, ownerPassword);
  const artist = await ownerClient.rpc('create_music_reference', {
    p_company_id: companyId,
    p_kind: 'ARTIST',
    p_name: artistName,
  });
  if (artist.error) throw new Error(`could not seed the artist: ${artist.error.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a category is registered, chosen on a song, shown in the list, filtered by — and then refuses to be archived', async ({
  page,
}) => {
  // Past the 30s default and sized to the work: this journey signs in, changes a
  // password, visits two routes for the first time (each compiled on demand by
  // `next dev`) and performs five writes.
  test.setTimeout(180_000);

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // --- Categories, reached from the sidebar under Catalog -------------------
  // Clicked rather than navigated to, because "a submenu of CATALOG" is half of
  // the owner's item 1 and a page.goto would prove the route and not the menu.
  await openNavSection(page, 'Catalog');
  await page.getByRole('link', { name: 'Categories' }).click();
  // A generous timeout on the FIRST navigation to this route and nowhere else:
  // the suite runs against `next dev`, so the first request for a route the
  // server has never served compiles it, and a client-side navigation sits on
  // the old URL until that RSC payload lands.
  await expect(page).toHaveURL(/\/catalog\/categories/, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible();

  // --- Register two ---------------------------------------------------------
  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill(categoryName);
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText(categoryName, {
    timeout: 30_000,
  });

  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill(otherCategoryName);
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText(otherCategoryName, {
    timeout: 30_000,
  });

  // --- Songs: the category is on the form ------------------------------------
  await page.getByRole('link', { name: 'Songs', exact: true }).click();
  await expect(page).toHaveURL(/\/music\/songs/, { timeout: 60_000 });

  await page.getByTestId('song-create').click();
  const createForm = page.locator('[data-testid="song-create-form"]');
  await createForm.getByLabel('Title').fill(songTitle);
  await createForm.getByLabel('Artist').selectOption({ label: artistName });
  // By NAME rather than by label: `getByLabel` matches on a substring, and this
  // screen carries both "Category" and (after Block 27's rename) nothing else
  // close — but the filter bar above the dialog has a "Category" label too, and
  // scoping to the form is what keeps the two apart whichever way the matcher
  // is tightened later.
  await createForm.locator('select[name="categoryId"]').selectOption({ label: categoryName });
  await createForm.getByRole('button', { name: 'Register song' }).click();
  await expect(createForm.getByText('Song registered.')).toBeVisible({ timeout: 30_000 });
  // "View song", not "Close", and this is the product's behaviour rather than a
  // convenience: songs-grid.tsx patches rows into its own state instead of
  // re-fetching the list, and the patch comes from the record dialog's own
  // `onLoaded` — one read for both. Closing the create dialog outright leaves
  // the new song saved and off the page until the next navigation.
  // music-requests.spec.ts walks the same two clicks for the same reason.
  await createForm.getByRole('button', { name: 'View song' }).click();
  await expect(page.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // --- The column reads it back ----------------------------------------------
  const songRow = page.getByTestId('song-row').filter({ hasText: songTitle });
  await expect(songRow).toHaveCount(1, { timeout: 30_000 });
  await expect(songRow).toContainText(categoryName);

  // A second song with the OTHER category, so the filter below has something to
  // exclude. Without it, filtering would narrow a list of one to a list of one
  // and prove nothing.
  await page.getByTestId('song-create').click();
  const secondForm = page.locator('[data-testid="song-create-form"]');
  await secondForm.getByLabel('Title').fill(otherSongTitle);
  await secondForm.getByLabel('Artist').selectOption({ label: artistName });
  await secondForm.locator('select[name="categoryId"]').selectOption({ label: otherCategoryName });
  await secondForm.getByRole('button', { name: 'Register song' }).click();
  await expect(secondForm.getByText('Song registered.')).toBeVisible({ timeout: 30_000 });
  await secondForm.getByRole('button', { name: 'View song' }).click();
  await expect(page.getByRole('heading', { name: otherSongTitle, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('song-row')).toHaveCount(2, { timeout: 30_000 });

  // --- The filter narrows to it ----------------------------------------------
  await page.getByTestId('song-category-filter').selectOption({ label: categoryName });
  await expect(page.getByTestId('song-row')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('song-row').first()).toContainText(songTitle);
  await page.getByTestId('song-clear-filters').click();
  await expect(page.getByTestId('song-row')).toHaveCount(2, { timeout: 30_000 });

  // --- And the archive is refused, because a live song still wears it ---------
  // The whole reason archive_music_reference (0205) counts songs.category_id
  // rather than detaching the way archive_prize_category does: a song left
  // pointing at an archived category would render a label RLS has made
  // unreadable.
  await page.getByRole('link', { name: 'Categories' }).click();
  await expect(page).toHaveURL(/\/catalog\/categories/, { timeout: 60_000 });

  const categoryRow = page.getByTestId('reference-row').filter({ hasText: categoryName });
  await expect(categoryRow).toHaveCount(1, { timeout: 30_000 });
  // `exact: true` — the row's pencil and its menu both carry the record's name
  // as a substring of their own aria-label, the trap catalog-screens.spec.ts
  // records for the same two controls.
  await categoryRow
    .getByRole('button', { name: `Actions for ${categoryName}`, exact: true })
    .click();
  // A `menuitem`, not a button, and the ellipsis is part of the name: the label
  // opens a confirmation rather than acting, which is why its two siblings spell
  // it the same way.
  await page.getByRole('menuitem', { name: 'Archive category…' }).click();
  await page.getByTestId('reference-archive-confirm').click();

  // STILL THERE. The counterpart assertion in catalog-screens.spec.ts is
  // `not.toContainText` — a label with no song archives and leaves the list.
  // This one wears a song, so 0205's CATEGORY branch answers 23503 and the row
  // stays, which is the whole of what that branch exists to do.
  await expect(page.getByTestId('references-grid')).toContainText(categoryName, {
    timeout: 30_000,
  });
  // And the operator is told why, rather than watching a click do nothing. The
  // wording is the one describeMusicWriteError (music/errors.ts) substitutes for
  // the RPC's own "still used by N live row(s)" — that sentence cannot name the
  // kind, because archive_music_reference serves all five and does not know
  // which screen called it, so the screen supplies the verb.
  await expect(page.getByText(/You cannot archive this category yet/i)).toBeVisible({
    timeout: 30_000,
  });
});
