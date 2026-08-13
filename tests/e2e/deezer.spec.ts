import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 13a's journey: an operator registers a song from Deezer without typing
 * an artist, a label, a genre or an album — and then links a song they typed
 * by hand to the same catalogue.
 *
 * THE POINT OF THE FIRST HALF is that the Station starts EMPTY. A song
 * registered through the ordinary form cannot be saved before its artist
 * exists, because the Artist `<select>` is built from what this Station
 * already holds (music-catalogue.spec.ts walks exactly that ordering). The
 * Deezer path is the one that does not need it: create_song_from_deezer (0139)
 * resolves or creates all four references inside the same transaction as the
 * song. A spec that seeded an artist first would pass over the whole reason
 * the door exists.
 *
 * THE POINT OF THE SECOND HALF is design D10: linking is the only way the
 * catalogue built before this block — and everything Block 9's import will
 * bring — ever gets a cover.
 *
 * The Deezer transport is the FIXTURE one, selected by DEEZER_FAKE=1 in
 * playwright.config.ts. Reaching api.deezer.com from here would spend the
 * platform's shared per-IP rate limit on every run, need a third party to be
 * up to go green, and assert against a catalogue that can change underneath —
 * three ways to fail while the code is correct.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-deezer-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-deezer-admin-${stamp}-pw`;
const ownerEmail = `e2e-deezer-owner-${stamp}@example.test`;
const orgName = `Deezer Org ${stamp}`;
const stationName = `Deezer Station ${stamp}`;
const createdUserIds: string[] = [];

// What the fixture transport answers (src/lib/integrations/deezer/index.ts).
const FIXTURE_TITLE = 'Sozinho (Ao Vivo)';
const FIXTURE_SECOND_TITLE = 'Prenda Minha (Ao Vivo)';
const FIXTURE_ARTIST = 'Caetano Veloso';
const FIXTURE_ALBUM = 'Prenda Minha';
const FIXTURE_LABEL = 'Universal Music';
const FIXTURE_GENRE = 'Pop';
const FIXTURE_ISRC = 'BRPGD9800678';

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

test('an operator registers a song from Deezer into an empty Station, then links one typed by hand', async ({
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
    organizationName: orgName,
    companyName: stationName,
    ownerEmail: ownerEmail,
  });

  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
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

  // =========================================================================
  // 1. The Songs screen, empty. No artist, no label, no genre, no album.
  // =========================================================================
  await openNavSection(ownerPage, 'Catalog');
  await ownerPage.getByRole('link', { name: 'Songs' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/songs/);
  await expect(ownerPage.getByTestId('song-row')).toHaveCount(0);

  // =========================================================================
  // 2. Register from Deezer. Nothing is typed but a filter.
  // =========================================================================
  await ownerPage.getByTestId('song-create').click();
  await ownerPage.getByTestId('create-tab-deezer').click();

  // At least one filter, or the tab refuses to search — the same rule the
  // client enforces so an empty query never reaches Deezer at all.
  await ownerPage.getByTestId('deezer-search').click();
  await expect(ownerPage.getByText('Fill in at least one field to search.')).toBeVisible();

  await ownerPage.getByTestId('deezer-filter-track').fill('Sozinho');
  await ownerPage.getByTestId('deezer-search').click();

  await expect(ownerPage.getByTestId('deezer-row')).toHaveCount(2);
  const firstRow = ownerPage.getByTestId('deezer-row').filter({ hasText: FIXTURE_TITLE });
  // The cover comes off the CDN host the CSP admits; what matters here is that
  // a row HAS one rather than the fallback icon.
  await expect(firstRow.getByTestId('song-thumb')).toBeVisible();

  await firstRow.getByTestId('deezer-register').click();

  // =========================================================================
  // 3. The form comes back filled, on the record tab, with nothing saved yet.
  // =========================================================================
  await expect(ownerPage.getByText('Filled in from Deezer.', { exact: false })).toBeVisible();
  await expect(ownerPage.getByRole('textbox', { name: 'Title' })).toHaveValue(FIXTURE_TITLE);
  await expect(ownerPage.getByRole('textbox', { name: 'Artist' })).toHaveValue(FIXTURE_ARTIST);
  // The album lookup happened on the Register click, which is why the label
  // and the genre are visible here rather than appearing out of the write.
  await expect(ownerPage.getByRole('textbox', { name: 'Label' })).toHaveValue(FIXTURE_LABEL);
  await expect(ownerPage.getByRole('textbox', { name: 'Genre' })).toHaveValue(FIXTURE_GENRE);
  await expect(ownerPage.getByRole('textbox', { name: 'Album' })).toHaveValue(FIXTURE_ALBUM);
  await expect(ownerPage.getByRole('textbox', { name: 'ISRC' })).toHaveValue(FIXTURE_ISRC);

  // The Station holds none of the four yet, and the form says so before saving
  // rather than creating them silently.
  await expect(ownerPage.getByText(`The artist “${FIXTURE_ARTIST}”`, { exact: false })).toBeVisible();

  // Still nothing written: the flow the owner described fills the form on the
  // Register click and stores on submit.
  //
  // Scoped to THIS RUN'S STATION, and both halves of that are load-bearing.
  // Counting the songs table read 49 — other specs fill it. Counting by
  // deezer_track_id alone read 1 — an earlier run of THIS spec had already
  // registered the same fixture recording, in its own Station. Only the pair
  // is a statement about this journey.
  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  if (!station) throw new Error(`no Station row for ${stationName}`);

  const { count: beforeSubmit } = await admin
    .from('songs')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', station.id)
    .eq('deezer_track_id', 921568);
  expect(beforeSubmit ?? 0).toBe(0);

  await ownerPage
    .getByTestId('song-create-form')
    .getByRole('button', { name: 'Register song' })
    .click();
  await expect(ownerPage.getByText('Song registered.')).toBeVisible();

  // =========================================================================
  // 4. One call created the song AND its four references.
  // =========================================================================
  await ownerPage.getByRole('button', { name: 'Close' }).click();
  await ownerPage.reload();

  const row = ownerPage.getByTestId('song-row').filter({ hasText: FIXTURE_TITLE });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('song-thumb')).toBeVisible();
  await expect(row).toContainText(FIXTURE_ARTIST);
  await expect(row).toContainText(FIXTURE_LABEL);
  await expect(row).toContainText(FIXTURE_GENRE);

  // =========================================================================
  // 5. The same recording is now marked, not offered again (design D9).
  // =========================================================================
  await ownerPage.getByTestId('song-create').click();
  await ownerPage.getByTestId('create-tab-deezer').click();
  await ownerPage.getByTestId('deezer-filter-track').fill('Sozinho');
  await ownerPage.getByTestId('deezer-search').click();

  const registered = ownerPage.getByTestId('deezer-row').filter({ hasText: FIXTURE_TITLE });
  await expect(registered.getByTestId('deezer-already-registered')).toBeVisible();
  await expect(registered.getByTestId('deezer-register')).toHaveCount(0);

  // The other track off the same album is still offered.
  const second = ownerPage.getByTestId('deezer-row').filter({ hasText: FIXTURE_SECOND_TITLE });
  await expect(second.getByTestId('deezer-register')).toBeVisible();

  await ownerPage.getByRole('button', { name: 'Close' }).click();

  // =========================================================================
  // 6. Design D10: a song typed by hand, linked afterwards.
  //
  //    It can be typed now only because step 4 created the artist — which is
  //    the ordering music-catalogue.spec.ts walks in full, and the ordering
  //    the Deezer path exists to skip.
  // =========================================================================
  const typedTitle = `Typed By Hand ${stamp}`;
  await ownerPage.getByTestId('song-create').click();
  // Scoped to the form: the Songs screen's own artist filter carries the
  // same label, and the dialog does not remove it from the accessibility
  // tree (<Dialog> renders `open`, not showModal).
  const createForm = ownerPage.getByTestId('song-create-form');
  await createForm.getByRole('textbox', { name: 'Title' }).fill(typedTitle);
  await createForm.getByLabel('Artist').selectOption({ label: FIXTURE_ARTIST });
  await ownerPage
    .getByTestId('song-create-form')
    .getByRole('button', { name: 'Register song' })
    .click();
  await expect(ownerPage.getByText('Song registered.')).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close' }).click();
  await ownerPage.reload();

  const typedRow = ownerPage.getByTestId('song-row').filter({ hasText: typedTitle });
  // No album, so no cover — the honest gap, not a broken image.
  await expect(typedRow.getByTestId('song-thumb-empty')).toBeVisible();

  await typedRow.getByRole('button', { name: /Edit/ }).click();
  await ownerPage.getByRole('tab', { name: 'Deezer' }).click();
  await ownerPage.getByTestId('deezer-filter-track').fill('Prenda Minha');
  await ownerPage.getByTestId('deezer-search').click();

  await ownerPage
    .getByTestId('deezer-row')
    .filter({ hasText: FIXTURE_SECOND_TITLE })
    .getByTestId('deezer-link')
    .click();

  // Back on the record: the code is there, read-only, and the title the
  // operator typed is untouched — linking attaches a recording, it does not
  // correct a curated record.
  await expect(ownerPage.getByTestId('song-deezer-id')).toHaveValue('921569');
  await expect(ownerPage.getByRole('textbox', { name: 'Title' })).toHaveValue(typedTitle);
  await expect(ownerPage.getByTestId('song-deezer-id')).toBeDisabled();
});
