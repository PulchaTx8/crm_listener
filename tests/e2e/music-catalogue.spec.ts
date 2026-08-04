import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 7a's whole journey (Task 11): an operator reaches the music
 * catalogue for the first time through the sidebar — the Music section this
 * task wires into src/lib/auth/shell.ts, pointing at the three screens Tasks
 * 8-10 already built — and leaves with a song in it.
 *
 * The order is the point, not an artifact of how the screens happen to be
 * laid out: a song cannot be registered before its artist exists, because the
 * Artist <select> on the create-song form (song-fields.tsx) is built from
 * whatever listMusicReferences already returned when Songs loaded, and stays
 * empty until an artist exists to populate it — same story for the Genre and
 * Label <select>s and the Catalog rows created below. A spec that seeded rows
 * directly through the service-role client and only checked the grids would
 * pass over exactly the ordering an operator meets on their first day. Every
 * row below is created through the real UI, in the sequence an operator would
 * meet it: a genre and a label on Catalog, an artist on its own screen, the
 * song that needs both, the artist's record showing the song, and the artist
 * refusing to be archived while the song still names it.
 *
 * Sign-in and Station-selection preamble copied from inventory-flow.spec.ts,
 * simplified to one identity: provision_customer's owner bypass
 * (has_permission, 0024) grants an Organization's owner every permission —
 * music.view and music.manage included — in every active Company of that
 * Organization, with no role to compose or assign. inventory-flow.spec.ts
 * builds a scoped "Stock Keeper" role for a delegate because proving a
 * SCOPED role works is that spec's own point; nothing about this journey
 * needs one, so the owner drives every step directly.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-music-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-music-admin-${stamp}-pw`;
const ownerEmail = `e2e-music-owner-${stamp}@example.test`;
const orgName = `Music Org ${stamp}`;
const stationName = `Music Station ${stamp}`;
const genreName = 'MPB';
const labelName = 'Philips';
const artistName = 'Elis Regina';
const songTitle = 'Águas de Março';
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

test('an operator builds a Station catalogue from nothing, reached from the sidebar', async ({
  page,
  browser,
}) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(platformAdminEmail);
  await page.getByPlaceholder('Password').fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
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
  await ownerPage.getByPlaceholder('E-mail').fill(ownerEmail);
  await ownerPage.getByPlaceholder('Password').fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // A separate browser context from the admin above, proven by identity:
  // the owner's own e-mail is visible, and the platform-only Customers link
  // is absent.
  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: 'Customers' })).toHaveCount(0);

  // The owner reaches exactly one Station, provisioned above — every music
  // screen resolves it as `first` (listCompanyAccess) with nothing to pick,
  // which is this test's whole Station-selection story.
  await expect(
    ownerPage.locator('[data-testid="station-card"]', { hasText: stationName }),
  ).toBeVisible();

  // ===========================================================================
  // 1. A genre and a label, on the Catalog screen — reached through the new
  //    Music section this task adds to the sidebar.
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'Catalog' }).click();
  // ReferenceTabs (reference-tabs.tsx) rewrites the address to a canonical
  // `?tab=` on mount via history.replaceState — labels is CATALOG_TABS' own
  // default — so the URL is never bare `/music/catalog` once this screen has
  // rendered.
  await expect(ownerPage).toHaveURL(/\/music\/catalog\?tab=labels$/);

  await ownerPage.getByRole('tab', { name: 'Genres' }).click();
  const genreForm = ownerPage.locator('[data-testid="genre-create-form"]');
  await genreForm.getByLabel('Name').fill(genreName);
  await genreForm.getByRole('button', { name: 'Add genre' }).click();
  // Once saved, the row is an EditableRow (reference-panel.tsx): the name is
  // an uncontrolled <input>'s value, aria-labelled "genre name" — not text
  // content, so this checks the value rather than getByText.
  await expect(ownerPage.getByLabel('genre name')).toHaveValue(genreName);

  await ownerPage.getByRole('tab', { name: 'Labels' }).click();
  const labelForm = ownerPage.locator('[data-testid="label-create-form"]');
  await labelForm.getByLabel('Name').fill(labelName);
  await labelForm.getByRole('button', { name: 'Add label' }).click();
  await expect(ownerPage.getByLabel('label name')).toHaveValue(labelName);

  // ===========================================================================
  // 2. An artist, on its own screen.
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'Artists' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/artists$/);

  await ownerPage.getByTestId('artist-create').click();
  const artistCreateForm = ownerPage.locator('[data-testid="artist-create-form"]');
  await artistCreateForm.getByLabel('Name').fill(artistName);
  await artistCreateForm.getByRole('button', { name: 'Register artist' }).click();
  await expect(artistCreateForm.getByText('Artist registered.')).toBeVisible();

  // "View artist" closes the registration dialog and opens the new artist's
  // record over the list, which is also what puts its row on that list — the
  // record's own read (onLoaded, artists-grid.tsx) is where the row comes
  // from, so there is no second query and no re-render of the screen behind
  // it.
  await artistCreateForm.getByRole('button', { name: 'View artist' }).click();
  await expect(ownerPage.getByRole('heading', { name: artistName, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // exact: true — the Actions cell's own accessible name ("Edit Elis Regina
  // Actions for…") also contains the artist's name as a substring.
  await expect(ownerPage.getByRole('cell', { name: artistName, exact: true })).toBeVisible();

  // ===========================================================================
  // 3. The song, which needs both the artist just registered and the genre
  //    and label registered on Catalog a moment ago — the Artist <select>
  //    would be empty, and the Genre/Label <select>s one option short, had any
  //    of the three steps above been skipped.
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'Songs' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/songs$/);

  await ownerPage.getByTestId('song-create').click();
  const songCreateForm = ownerPage.locator('[data-testid="song-create-form"]');
  await songCreateForm.getByLabel('Title').fill(songTitle);
  await songCreateForm.getByLabel('Artist').selectOption({ label: artistName });
  await songCreateForm.getByLabel('Label').selectOption({ label: labelName });
  await songCreateForm.getByLabel('Genre').selectOption({ label: genreName });
  await songCreateForm.getByLabel('Duration (seconds)').fill('213');
  await songCreateForm.getByRole('button', { name: 'Register song' }).click();
  await expect(songCreateForm.getByText('Song registered.')).toBeVisible();

  await songCreateForm.getByRole('button', { name: 'View song' }).click();
  await expect(ownerPage.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // exact: true — same reason as the artist cell above.
  await expect(ownerPage.getByRole('cell', { name: songTitle, exact: true })).toBeVisible();
  // 213 seconds through formatDuration's m:ss (music/format.ts): 3 minutes,
  // 33 seconds.
  await expect(ownerPage.getByRole('cell', { name: '3:33', exact: true })).toBeVisible();

  // ===========================================================================
  // 4. The artist's record now knows about the song — one read, two tabs
  //    (getArtistRecordAction reads getArtistById and getArtistSongs
  //    together; switching tabs never calls the server again).
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'Artists' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/artists$/);

  // exact: true — "Edit Elis Regina" and "Actions for Elis Regina" are two
  // other buttons on this row whose accessible names contain the artist's
  // name as a substring.
  await ownerPage.getByRole('button', { name: artistName, exact: true }).click();
  await ownerPage.getByRole('tab', { name: 'Songs' }).click();
  await expect(ownerPage.getByRole('link', { name: songTitle })).toBeVisible();

  // ===========================================================================
  // 5. And the artist cannot be archived out from under it. The record dialog
  //    above is a native <dialog> opened with showModal() (dialog.tsx's own
  //    header): the rest of the page, including the grid row's own "Actions"
  //    menu, is inert while it is open, so archiving has to happen from the
  //    grid, after this record is closed — not from a button inside it.
  // ===========================================================================
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  await ownerPage.getByRole('button', { name: `Actions for ${artistName}` }).click();
  await ownerPage.getByRole('menuitem', { name: 'Archive artist…' }).click();

  // Archiving goes through a styled Dialog with its own data-testid
  // (ArchiveArtistDialog, artists-grid.tsx) — not window.confirm, which
  // Playwright cannot drive the way the rest of this suite is written.
  await ownerPage.getByTestId('artist-archive-confirm').click();

  // describeMusicWriteError's BusinessRuleError branch (music/errors.ts) is
  // shared by all four reference kinds, and archive_music_reference's 23503
  // carries no entity kind — so the sentence rendered here is generic, and
  // does NOT name "songs" or Águas de Março specifically. Asserted verbatim
  // against that branch, with the `action` phrase archiveArtistAction
  // (artists/actions.ts) passes it: "archive this artist".
  await expect(
    ownerPage.getByText(
      'You cannot archive this artist yet — it still has other records registered against it. Move or archive them first.',
    ),
  ).toBeVisible();

  await ownerContext.close();
});
