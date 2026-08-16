import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 27, items 6 and 7, as one journey: an operator opens a song's
 * Integration tab, imports the card from a file their own software exported,
 * reviews it, saves, reopens the record and reads it back — and then hands the
 * same control a file carrying three cards and is refused.
 *
 * THE IMPORT WRITES NOTHING (design D9). The assertion that matters most below
 * is the one after the refusal: the form still holds the values from the good
 * file, because a rejected import must not half-apply.
 *
 * The file is set through `setInputFiles` with an in-memory buffer rather than a
 * fixture on disk: the content is three lines and belongs beside the assertions
 * that read it, and a file under tests/ would be a second place to keep them in
 * step.
 *
 * Fixtures come through the RPC path (catalog-screens.spec.ts's reasoning): this
 * journey is the Integration tab, not the provisioning console. The owner drives
 * because the permission boundary is not what is being tested here —
 * tests/isolation/song-integrations.test.ts drives every refusal as a non-owner
 * delegate through a real JWT.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-integ-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-integ-admin-${stamp}-pw`;
const ownerEmail = `e2e-integ-owner-${stamp}@example.test`;
const ownerPassword = `Owner-integ-${stamp}-provisional`;
const ownerFinalPassword = `Owner-integ-${stamp}-chosen`;

const artistName = `Gonzaga ${stamp}`;
const songTitle = `Asa branca ${stamp}`;
const importedCode = `EXT-${stamp}`;
const importedTitle = `ASA BRANCA (REMASTER) ${stamp}`;
const importedArtist = `LUIZ GONZAGA ${stamp}`;
const importedCategory = `FORRO ${stamp}`;

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
    organizationName: `Integration Org ${stamp}`,
    companyName: `Integration Station ${stamp}`,
  });

  // The song and its artist are seeded through the doors rather than clicked:
  // registering a song is music-categories.spec.ts's journey, not this one.
  const ownerClient = await signIn(ownerEmail, ownerPassword);
  const artist = await ownerClient.rpc('create_music_reference', {
    p_company_id: companyId,
    p_kind: 'ARTIST',
    p_name: artistName,
  });
  if (artist.error) throw new Error(`could not seed the artist: ${artist.error.message}`);

  const song = await ownerClient.rpc('create_song', {
    p_company_id: companyId,
    p_title: songTitle,
    p_artist_id: artist.data as string,
  });
  if (song.error) throw new Error(`could not seed the song: ${song.error.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a JSON file fills the integration card, the save stores it, and a file of three is refused', async ({
  page,
}) => {
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

  await page.goto('/music/songs');
  await expect(page.getByRole('heading', { name: 'Songs' })).toBeVisible({ timeout: 60_000 });

  // --- Open the record, then the tab ----------------------------------------
  await page.getByRole('button', { name: songTitle, exact: true }).click();
  await expect(page.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: 'Integration' }).click();
  await expect(page.getByTestId('integration-form')).toBeVisible();

  // The song was seeded with no code, so there is nothing to describe yet and
  // the "no card" notice stays away — it belongs to a code that HAS no card, not
  // to a song that has no code.
  await expect(page.getByTestId('integration-no-card')).toHaveCount(0);

  // --- Import ---------------------------------------------------------------
  await page.getByTestId('integration-file').setInputFiles({
    name: 'card.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        code: importedCode,
        title: importedTitle,
        artistName: importedArtist,
        categoryName: importedCategory,
        // An export carrying a column we never asked for. It must be dropped
        // rather than refused — and `companyId` above all, since the action
        // reads that from the form and a file choosing a Station would be a
        // hole.
        companyId: '00000000-0000-0000-0000-000000000000',
      }),
      'utf8',
    ),
  });

  await expect(page.getByTestId('integration-import-message')).toContainText(
    'Review it before saving',
  );
  await expect(page.getByTestId('integration-code')).toHaveValue(importedCode);
  await expect(page.getByTestId('integration-title')).toHaveValue(importedTitle);
  await expect(page.getByTestId('integration-artist')).toHaveValue(importedArtist);
  await expect(page.getByTestId('integration-category')).toHaveValue(importedCategory);

  // NOTHING IS SAVED YET. The whole of design D9 in one assertion: the import
  // fills the form and the operator decides.
  await expect(page.getByTestId('integration-form')).not.toContainText('Saved.');

  // --- A file of three is refused, and the form is not disturbed -------------
  // Done BEFORE the save deliberately: a refusal that half-applied would be
  // visible here as the fields changing, and invisible after a save.
  await page.getByTestId('integration-file').setInputFiles({
    name: 'many.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify([{ code: 'A' }, { code: 'B' }, { code: 'C' }]),
      'utf8',
    ),
  });
  await expect(page.getByTestId('integration-import-message')).toContainText('carries 3 cards');
  await expect(page.getByTestId('integration-code')).toHaveValue(importedCode);
  await expect(page.getByTestId('integration-title')).toHaveValue(importedTitle);

  // --- Save, and read it back on a fresh open --------------------------------
  await page.getByTestId('integration-save').click();
  await expect(page.getByTestId('integration-form')).toContainText('Saved.', { timeout: 30_000 });

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: songTitle, exact: true }).click();
  await expect(page.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: 'Integration' }).click();

  // From the database this time, through two doors and a fresh record read.
  await expect(page.getByTestId('integration-code')).toHaveValue(importedCode);
  await expect(page.getByTestId('integration-title')).toHaveValue(importedTitle);
  await expect(page.getByTestId('integration-artist')).toHaveValue(importedArtist);
  await expect(page.getByTestId('integration-category')).toHaveValue(importedCategory);

  // And the code reached the SONG, not only the card — the two writes
  // integration-actions.ts performs, proved by the column on the list behind
  // the dialog.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('song-row').filter({ hasText: songTitle })).toContainText(
    importedCode,
  );
});
