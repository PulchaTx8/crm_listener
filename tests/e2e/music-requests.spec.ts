import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 7b's whole journey (Task 10): the two doors this task adds to the
 * Music section — Requests and Maintenance — reached from the sidebar for
 * the first time, and the round trip that is this file's entire reason to
 * exist: a request recorded against one of two identically-titled songs
 * survives a merge of those two songs into the OTHER one.
 *
 * §6 of the design spec names the defect a shallower test would miss: a
 * merge that archives the loser and repoints nothing leaves every request
 * that named it pointing at a row RLS can no longer show anyone (0099's
 * `deleted_at is null` policies). The pgTAP suite (0106) already proves
 * apply_music_merge does not do that at the database layer. This test walks
 * the same fact through the real screens: register two songs, record a
 * request against the second, merge the pair into the first, and confirm
 * the request is still legible afterwards — not merely present, but naming
 * a LIVE song rather than the one archive_music_merge just archived.
 *
 * The two songs share a title on purpose (D2 allows the duplicate; the
 * merge is the cure), which means the Song and Artist columns read
 * identically for both — nothing in the catalogue UI can tell them apart by
 * name. Two things still can, and this spec leans on both rather than on
 * row order (list_merge_candidates orders `title, id` — a tie on title
 * breaks on a uuid this test does not control, so "first/second in the
 * list" is not a stable handle):
 *
 *   - internal_code. Distinct per song and searched by searchSongs
 *     (services/music.ts, `title.ilike…,internal_code.ilike…`), so typing
 *     the second song's own code into the request form's song picker finds
 *     exactly it, never the ambiguous title match.
 *   - child_count. list_merge_candidates (0108) counts live *and* archived
 *     children, so the moment the request is recorded against the second
 *     song, that song's Maintenance row reads "1 request" and the first
 *     song's reads "0 requests" — a second, independent handle on which row
 *     is which, unrelated to internal_code, used to name the FIRST song
 *     (the one with nothing recorded against it yet) as the survivor.
 *
 * Step 5's assertion is the one that matters: after the merge,
 * requests-grid.tsx renders a "request-song-archived-badge" if and only if
 * the request's own song_id still names a soft-deleted row
 * (`song_archived := s.deleted_at is not null`, 0107). A merge that moved
 * nothing would leave the loser archived and the request pointing at it —
 * this badge would appear. A merge that repointed it, as apply_music_merge
 * (0106) is written to, leaves the request naming the live survivor — no
 * badge, same title text either way, because both songs shared one. This is
 * the one place in the whole journey where the two possible defects
 * (archived-and-forgotten vs. archived-and-repointed) render two visibly
 * different pages, so it is what this spec checks for, not the title text.
 *
 * Sign-in and Station-selection preamble copied from music-catalogue.spec.ts
 * (Block 7a, Task 11), itself copied from inventory-flow.spec.ts: the
 * owner's bypass (has_permission, 0024) grants every permission in every
 * active Company of the Organization, music.request and music.merge
 * included, with no role to compose — nothing about this journey needs a
 * scoped delegate, so the owner drives every step directly.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-music-req-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-music-req-admin-${stamp}-pw`;
const ownerEmail = `e2e-music-req-owner-${stamp}@example.test`;
const orgName = `Music Requests Org ${stamp}`;
const stationName = `Music Requests Station ${stamp}`;
const artistName = `E2E Merge Artist ${stamp}`;
// Deliberately shared between both songs — see this file's own header on why.
const songTitle = `E2E Duplicate Song ${stamp}`;
const songCodeFirst = `E2E-A-${stamp}`;
const songCodeSecond = `E2E-B-${stamp}`;
const listenerName = `E2E Request Listener ${stamp}`;
const listenerPhone = `5511${stamp}`;
const mergeReason = `Duplicate registered twice while proving the request-to-merge round trip (${stamp}).`;
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

test('a request survives a merge of the song it named, reached from the sidebar', async ({
  page,
  browser,
}) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Platform admin')).toBeVisible();

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail: ownerEmail,
  });

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
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // A separate browser context from the admin above, proven by identity, the
  // same check music-catalogue.spec.ts makes for its own owner.
  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: 'Organizations' })).toHaveCount(0);
  await expect(
    ownerPage.locator('[data-testid="station-card"]', { hasText: stationName }),
  ).toBeVisible();

  // ===========================================================================
  // 1. An artist, then two songs sharing one title — through the sidebar's
  //    Music section, reached for the first time in this journey by this
  //    task's own nav change.
  // ===========================================================================
  await openNavSection(ownerPage, 'Catalog');
  await ownerPage.getByRole('link', { name: 'Artists' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/artists$/);

  await ownerPage.getByTestId('artist-create').click();
  const artistCreateForm = ownerPage.locator('[data-testid="artist-create-form"]');
  await artistCreateForm.getByLabel('Name').fill(artistName);
  await artistCreateForm.getByRole('button', { name: 'Register artist' }).click();
  await expect(artistCreateForm.getByText('Artist registered.')).toBeVisible();
  await artistCreateForm.getByRole('button', { name: 'View artist' }).click();
  await expect(ownerPage.getByRole('heading', { name: artistName, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  await openNavSection(ownerPage, 'Catalog');
  await ownerPage.getByRole('link', { name: 'Songs' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/songs$/);

  // The first song — this is the one named the survivor in step 4, below.
  await ownerPage.getByTestId('song-create').click();
  const firstSongForm = ownerPage.locator('[data-testid="song-create-form"]');
  await firstSongForm.getByLabel('Title').fill(songTitle);
  await firstSongForm.getByLabel('Artist').selectOption({ label: artistName });
  await firstSongForm.getByLabel('Internal code').fill(songCodeFirst);
  await firstSongForm.getByRole('button', { name: 'Register song' }).click();
  await expect(firstSongForm.getByText('Song registered.')).toBeVisible();
  await firstSongForm.getByRole('button', { name: 'View song' }).click();
  await expect(ownerPage.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  await expect(ownerPage.getByRole('cell', { name: songTitle, exact: true })).toHaveCount(1);

  // The second song — same title, its own code. This is the one the
  // request in step 2 names, and the one absorbed by the merge in step 4.
  await ownerPage.getByTestId('song-create').click();
  const secondSongForm = ownerPage.locator('[data-testid="song-create-form"]');
  await secondSongForm.getByLabel('Title').fill(songTitle);
  await secondSongForm.getByLabel('Artist').selectOption({ label: artistName });
  await secondSongForm.getByLabel('Internal code').fill(songCodeSecond);
  await secondSongForm.getByRole('button', { name: 'Register song' }).click();
  await expect(secondSongForm.getByText('Song registered.')).toBeVisible();
  await secondSongForm.getByRole('button', { name: 'View song' }).click();
  await expect(ownerPage.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // Two rows, one title — the duplicate this whole journey exists to clean up.
  await expect(ownerPage.getByRole('cell', { name: songTitle, exact: true })).toHaveCount(2);
  await expect(ownerPage.getByRole('cell', { name: songCodeFirst, exact: true })).toBeVisible();
  await expect(ownerPage.getByRole('cell', { name: songCodeSecond, exact: true })).toBeVisible();

  // ===========================================================================
  // 2. A request, against the SECOND song by name — found through its own
  //    internal_code, which searchSongs matches alongside title
  //    (services/music.ts), so this cannot accidentally land on the first
  //    song despite the two sharing a title.
  // ===========================================================================
  // Requests moved to Audience in Block 20b, D1 -- a different section from
  // Songs/Artists/Maintenance above and below, so this crosses sections rather
  // than staying inside the one already open.
  await openNavSection(ownerPage, 'Audience');
  await ownerPage.getByRole('link', { name: 'Requests' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/requests$/);

  await ownerPage.getByTestId('request-record').click();
  const requestForm = ownerPage.locator('[data-testid="request-record-form"]');
  await expect(requestForm).toBeVisible();

  await requestForm.getByTestId('request-song-search').fill(songCodeSecond);
  await expect(requestForm.getByTestId('request-song-option')).toHaveCount(1);
  await requestForm.getByTestId('request-song-option').click();
  await expect(requestForm.getByTestId('request-picked-song')).toHaveText(
    `${songTitle} — ${artistName}`,
  );

  // A new listener, typed by hand rather than picked — resolveOrCreateMember
  // (Block 3's deduplication) registers them as part of recording the request.
  await requestForm.getByTestId('request-full-name').fill(listenerName);
  await requestForm.getByTestId('request-phone').fill(listenerPhone);

  await requestForm.getByTestId('request-record-submit').click();
  await expect(requestForm.getByText('Request recorded.')).toBeVisible();
  await expect(requestForm.getByTestId('request-listener-created')).toBeVisible();
  await requestForm.getByRole('button', { name: 'Close', exact: true }).click();

  // ===========================================================================
  // 3. The request lists, naming the second song, not yet archived.
  // ===========================================================================
  const requestRows = ownerPage.getByTestId('request-row');
  await expect(requestRows).toHaveCount(1);
  await expect(requestRows.getByRole('cell', { name: songTitle, exact: true })).toBeVisible();
  await expect(ownerPage.getByTestId('request-song-archived-badge')).toHaveCount(0);

  // ===========================================================================
  // 4. Maintenance: both songs staged, the FIRST named survivor — identified
  //    not by list order (list_merge_candidates ties on a uuid this test does
  //    not control) but by child_count: the row reading "0 requests" is the
  //    one nothing has been recorded against yet, which is the first song.
  // ===========================================================================
  await openNavSection(ownerPage, 'Catalog');
  await ownerPage.getByRole('link', { name: 'Maintenance' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/maintenance$/);

  await ownerPage.getByTestId('maintenance-search-input').fill(songTitle);
  const candidateRows = ownerPage.locator('[data-testid="maintenance-candidate-row"]');
  await expect(candidateRows).toHaveCount(2);

  const candidateCheckboxes = ownerPage.getByTestId('maintenance-candidate-checkbox');
  await candidateCheckboxes.nth(0).check();
  await candidateCheckboxes.nth(1).check();

  const stagingRows = ownerPage.locator('[data-testid="maintenance-staging-row"]');
  await expect(stagingRows).toHaveCount(2);
  const survivorStagingRow = stagingRows.filter({ hasText: '0 requests' });
  await expect(survivorStagingRow).toHaveCount(1);
  await survivorStagingRow.getByRole('radio').check();

  await ownerPage.getByTestId('maintenance-reason').fill(mergeReason);
  await ownerPage.getByTestId('maintenance-merge-button').click();

  // mergeConfirmationText (merge-panel.tsx): 1 loser ("record", singular),
  // moved = the loser's own childCount, which is 1 — exactly the request
  // recorded in step 2, and the number this whole test is built to move
  // correctly.
  await expect(ownerPage.getByTestId('maintenance-merge-confirmation-text')).toHaveText(
    `Merge 1 record into “${songTitle}”? 1 request will move. This cannot be undone.`,
  );
  await ownerPage.getByTestId('maintenance-merge-confirm').click();
  await expect(ownerPage.getByTestId('maintenance-merge-result')).toHaveText(
    'Merged. 1 record moved to the surviving entry.',
  );
  await ownerPage.getByTestId('maintenance-merge-done').click();

  // Only the survivor is left among live SONG candidates.
  await expect(ownerPage.locator('[data-testid="maintenance-candidate-row"]')).toHaveCount(1);

  // ===========================================================================
  // 5. Back to Requests. THE POINT OF THIS TEST: the request is still there,
  //    and it is not flagged as naming an archived song. songArchived
  //    (list_music_requests, 0107) is `s.deleted_at is not null` on whichever
  //    song song_id names right now — true only if the merge archived the
  //    loser and left the request pointing at it. Absent here means
  //    apply_music_merge's own UPDATE public.music_requests SET song_id =
  //    p_winner_id really ran, and this request now names the live survivor.
  //    The title text cannot show that difference — both songs shared it —
  //    which is exactly why this badge, not the title, is the assertion.
  // ===========================================================================
  await openNavSection(ownerPage, 'Audience');
  await ownerPage.getByRole('link', { name: 'Requests' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/requests$/);

  const requestRowsAfterMerge = ownerPage.getByTestId('request-row');
  await expect(requestRowsAfterMerge).toHaveCount(1);
  await expect(
    requestRowsAfterMerge.getByRole('cell', { name: songTitle, exact: true }),
  ).toBeVisible();
  await expect(ownerPage.getByTestId('request-song-archived-badge')).toHaveCount(0);

  // ===========================================================================
  // 6. Back to Songs: only the survivor's title and code remain in the
  //    catalogue — songs_select (0099) makes the archived loser unreadable
  //    for every caller, owner included.
  // ===========================================================================
  await openNavSection(ownerPage, 'Catalog');
  await ownerPage.getByRole('link', { name: 'Songs' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/songs$/);

  await expect(ownerPage.getByRole('cell', { name: songTitle, exact: true })).toHaveCount(1);
  await expect(ownerPage.getByRole('cell', { name: songCodeFirst, exact: true })).toBeVisible();
  await expect(ownerPage.getByRole('cell', { name: songCodeSecond, exact: true })).toHaveCount(0);

  await ownerContext.close();
});
