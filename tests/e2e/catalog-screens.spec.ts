import { test, expect, type Page } from '@playwright/test';
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
// Set in beforeAll, read by the cover-key test below -- artworkKey
// (src/lib/storage/artwork-keys.ts) keys an album's cover
// `album-covers/<company_id>/<album_id>`, and that assertion needs the exact
// id this Station provisioned under, not merely the slot name.
let companyId: string;

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
  ({ company_id: companyId } = await provisionCustomer(adminClient, {
    userId: ownerId,
    organizationName: `Catalog Org ${stamp}`,
    companyName: `Catalog Station ${stamp}`,
  }));
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

/**
 * Signs the shared owner in, landing on /app unconditionally.
 *
 * The label journey above walks this SAME owner through /change-password —
 * Playwright runs the tests in one file in declaration order, so by the time
 * either album test below runs as part of the whole file, that has already
 * happened. But run alone (Step 2's own `-g "carries a picture"`, or any
 * other subset that skips the label test), the account is still on
 * provision_customer's provisional password, and the label test's own
 * fill-provisional-then-change-password script would be the wrong one to
 * copy here.
 *
 * Rather than branch on which case this run is, both halves of the gate
 * src/middleware.ts actually reads — the auth password, and profiles.
 * must_change_password, the column that decides the redirect regardless of
 * which password was used to sign in — are forced directly through the admin
 * client first. Idempotent either way, so every test below can assume the
 * account is already past onboarding without caring what ran before it.
 */
async function signInAlbumsOwner(page: Page) {
  const { data: profile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  if (!profile) throw new Error(`no profile row for ${ownerEmail}`);

  await admin.auth.admin.updateUserById(profile.id, { password: ownerFinalPassword });
  await admin
    .from('profiles')
    .update({ must_change_password: false, provisional_expires_at: null })
    .eq('id', profile.id);

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
}

test('a record label is registered and found on its own screen', async ({ page }) => {
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

/**
 * Task 3's review found rename and archive uninstrumented: the whole of
 * reference-record-dialog.tsx and both write actions
 * (updateReferenceAction/archiveReferenceAction) were exercised by no
 * committed test. Two dedicated journeys rather than folding them into the
 * test above: the label test above proves register/find, these prove the two
 * write paths a click on an existing row reaches, and each is independent of
 * the other's fixture data.
 */
test('a record label is renamed through its record dialog', async ({ page }) => {
  await signInAlbumsOwner(page);

  await page.goto('/catalog/labels');
  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Antes Do Rename 20c');
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Antes Do Rename 20c');

  // A click on the row's own name opens ReferenceRecordDialog
  // (reference-record-dialog.tsx) -- the same button references-grid.tsx
  // wires to setEditingId. Its edit form shares the data-testid
  // "reference-name" with the create form above; only one of the two dialogs
  // is ever open at a time, so the selector is unambiguous here. exact: true
  // is required since Task 11: the row's pencil ("Edit Selo Antes Do Rename
  // 20c") and its dropdown ("Actions for Selo Antes Do Rename 20c") both
  // carry this name as a substring of their own aria-label.
  await page.getByRole('button', { name: 'Selo Antes Do Rename 20c', exact: true }).click();
  await page.getByTestId('reference-name').fill('Selo Depois Do Rename 20c');
  await page.getByTestId('reference-save').click();
  // updateReferenceAction landed and revalidatePath refreshed `rows` -- the
  // form's own "Saved." feedback (reference-record-dialog.tsx) is the signal,
  // not a fixed wait.
  await expect(page.getByTestId('reference-data-form')).toContainText('Saved.');
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // The new name appears in the grid, and -- the actual claim of a RENAME
  // rather than a second record -- the old one does not.
  await expect(page.getByTestId('references-grid')).toContainText('Selo Depois Do Rename 20c');
  await expect(page.getByTestId('references-grid')).not.toContainText('Selo Antes Do Rename 20c');
});

test('a record label is archived through its confirmation dialog, and leaves the list', async ({
  page,
}) => {
  await signInAlbumsOwner(page);

  await page.goto('/catalog/labels');
  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Para Arquivar 20c');
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Para Arquivar 20c');

  // exact: true -- the row's pencil and dropdown menu both carry this name
  // as a substring of their own aria-label (Task 11).
  await page.getByRole('button', { name: 'Selo Para Arquivar 20c', exact: true }).click();
  await page.getByTestId('reference-archive').click();

  // ArchiveReferenceDialog (reference-record-dialog.tsx) -- a styled <Dialog>
  // stacked on the browser's own top layer, never window.confirm.
  await page.getByTestId('reference-archive-confirm').click();

  // onArchived (reference-record-dialog.tsx) closes both dialogs itself once
  // archiveReferenceAction reports 'archived', so no explicit Close click is
  // needed here -- and the row is gone from the list revalidatePath refreshed,
  // which is the one claim this test exists to make: archiving is
  // irreversible from this screen, "not by you, not by support" (the dialog's
  // own copy), so there is no undo step left to assert.
  await expect(page.getByTestId('references-grid')).not.toContainText('Selo Para Arquivar 20c');
});

/**
 * Task 11: the row actions references-grid.tsx grew beside the row --
 * neither test above ever presses them, since both reach
 * ReferenceRecordDialog through the row's NAME and archive through the
 * dialog's own footer button. This journey presses the row's pencil and the
 * row's own dropdown menu instead, proving the second door opens the SAME
 * dialog (not a copy of it) and the SAME ArchiveReferenceDialog, exported
 * from reference-record-dialog.tsx for exactly this second caller.
 *
 * Only /catalog/labels is driven here, same as every journey above in this
 * file: /catalog/genres renders the exact same references-grid.tsx with only
 * `kind`/`copy` swapped (design D12), so a second, near-identical journey
 * through /catalog/genres would prove the copy differs and nothing else --
 * not a second line of code this task added.
 */
test("a record label's row actions open the record dialog and archive it", async ({ page }) => {
  await signInAlbumsOwner(page);

  await page.goto('/catalog/labels');
  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Ações Da Linha 20c');
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Ações Da Linha 20c');

  // The pencil, not the name -- both are wired to the same setEditingId
  // (references-grid.tsx), so the same ReferenceRecordDialog opens either way.
  await page.getByRole('button', { name: 'Edit Selo Ações Da Linha 20c', exact: true }).click();
  await expect(page.getByTestId('reference-data-form')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // The row's own dropdown menu, not the record dialog's footer Archive
  // button, reaching the exported ArchiveReferenceDialog directly.
  await page
    .getByRole('button', { name: 'Actions for Selo Ações Da Linha 20c', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Archive label…' }).click();
  await page.getByTestId('reference-archive-confirm').click();

  await expect(page.getByTestId('references-grid')).not.toContainText('Selo Ações Da Linha 20c');
});

/**
 * Fix round 1. tests/e2e/music-catalogue.spec.ts (deleted in Task 5) proved
 * this business rule once, for ARTIST: archiving a record that a live song
 * still names is refused, not silently dropped. The code path is shared --
 * mapMusicError's 23503 branch (services/music.ts) becomes a BusinessRuleError
 * for every one of the four reference kinds alike, and describeMusicWriteError
 * (music/errors.ts) renders the identical sentence, worded per kind only
 * through the `action` phrase (ACTION_KEYS[kind].archive,
 * catalog/references/actions.ts) -- so a LABEL-scoped journey proves the same
 * branch this screen actually owns, without going near the Artists screen
 * this block does not touch.
 */
test('a record label cannot be archived while a live song still names it, and the record survives', async ({
  page,
}) => {
  await signInAlbumsOwner(page);

  // The label under test.
  await page.goto('/catalog/labels');
  await page.getByTestId('reference-create').click();
  await page.getByTestId('reference-name').fill('Selo Vinculado 20c');
  await page.getByTestId('reference-save').click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Vinculado 20c');

  // An artist -- songFormSchema requires one (services/schemas/music.ts),
  // even though the label is the field this test actually cares about.
  await page.goto('/music/artists');
  await page.getByTestId('artist-create').click();
  const artistForm = page.locator('[data-testid="artist-create-form"]');
  await artistForm.getByLabel('Name').fill('Artista Vinculado 20c');
  await artistForm.getByRole('button', { name: 'Register artist' }).click();
  await expect(artistForm.getByText('Artist registered.')).toBeVisible();
  // CreateArtistDialog's own footer Close (artists-grid.tsx) -- always
  // present, unlike the "View artist" link inside the form, which this test
  // has no use for.
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // A song naming the label -- the live reference archive_music_reference
  // (0102) refuses to break.
  await page.goto('/music/songs');
  await page.getByTestId('song-create').click();
  const songForm = page.locator('[data-testid="song-create-form"]');
  await songForm.getByLabel('Title').fill('Música Vinculada 20c');
  await songForm.getByLabel('Artist').selectOption({ label: 'Artista Vinculado 20c' });
  await songForm.getByLabel('Label').selectOption({ label: 'Selo Vinculado 20c' });
  await songForm.getByRole('button', { name: 'Register song' }).click();
  await expect(songForm.getByText('Song registered.')).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();

  // Back on the label's own screen, the archive is attempted and refused.
  // exact: true -- the row's pencil and dropdown menu both carry this name
  // as a substring of their own aria-label (Task 11).
  await page.goto('/catalog/labels');
  await page.getByRole('button', { name: 'Selo Vinculado 20c', exact: true }).click();
  await page.getByTestId('reference-archive').click();
  await page.getByTestId('reference-archive-confirm').click();

  // describeMusicWriteError's BusinessRuleError branch, worded for LABEL via
  // ACTION_KEYS.LABEL.archive ('actionArchiveThisLabel' -> "archive this
  // label") -- the operator sees a sentence naming the rule, not a raw
  // Postgres error and not a dialog that quietly did nothing.
  await expect(
    page.getByText(
      'You cannot archive this label yet — it still has other records registered against it. Move or archive them first.',
    ),
  ).toBeVisible();

  // The record survives: archiveReferenceAction never reached 'archived', so
  // no revalidatePath ran and the row is exactly where it was. Dismissed
  // through the UI's own Cancel/Close rather than asserted on a DOM node
  // still technically present under an open dialog -- the same claim the
  // successful-archive test above makes for the opposite outcome.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('references-grid')).toContainText('Selo Vinculado 20c');
});

test('an album is registered with its details and carries a picture', async ({ page }) => {
  // Sign in as an owner with music.manage — provision_customer's owner bypass
  // (has_permission, 0024) grants an Organization's owner every permission,
  // music.view and music.manage included, in every active Company of that
  // Organization, with no role to compose or assign.
  await signInAlbumsOwner(page);

  await page.goto('/catalog/albums');
  await expect(page.getByRole('heading', { name: 'Albums' })).toBeVisible();

  await page.getByTestId('album-create').click();
  await page.getByTestId('album-title').fill('Álbum Teste 20c');
  await page.getByTestId('album-upc').fill('123456789012');
  await page.getByTestId('album-release-date').fill('2026-03-01');
  await page.getByTestId('album-save').click();

  await expect(page.getByTestId('albums-grid')).toContainText('Álbum Teste 20c');

  // D6: the release date is a field this screen can actually write. Before
  // Block 20c, update_album had no parameter to send it to -- so an assertion
  // that only checked the title would have passed against the old door.
  await expect(page.getByTestId('albums-grid')).toContainText('2026');
});

test("an album's cover reaches the bucket, keyed under its own record", async ({ page }) => {
  await signInAlbumsOwner(page);

  await page.goto('/catalog/albums');
  await page.getByTestId('album-create').click();
  await page.getByTestId('album-title').fill('Álbum Capa 20c');
  await page.getByTestId('album-save').click();

  // The create form auto-opens the new album's own record (the same shape
  // music/artists/artists-grid.tsx uses for its own create), which is where
  // the picture control lives -- D4, and why this journey needs no separate
  // click to get there.
  await page.getByTestId('album-cover-input').setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });

  // Proves the upload reached the bucket under the right key, not merely that
  // a form submitted: artworkKey (src/lib/storage/artwork-keys.ts) names the
  // object `album-covers/<company_id>/<album_id>`. Matching only the slot
  // name (`/album-covers/`) cannot tell that key apart from one with the
  // segments swapped or dropped -- and the segment order is exactly what
  // may_write_artwork (0187) reads via `storage.foldername(name)[2]` to
  // decide who may write it. Asserting the company id as the SECOND segment
  // is what actually proves the key, not merely the slot.
  const row = page.getByTestId('album-row').filter({ hasText: 'Álbum Capa 20c' });
  await expect(row.getByTestId('album-thumb')).toHaveAttribute(
    'src',
    new RegExp(`/album-covers/${companyId}/`),
  );
});
