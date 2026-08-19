import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { Client } from 'pg';
import {
  LOCAL_SUPABASE_DB_URL,
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 29d-1, Task 8. The journey the whole block was built around: filter a
 * listing (Requests, here), name what the filter caught, save it as a FIXED
 * list, and see the SAME count in two independent places — the lists screen's
 * own reach reveal, and send_list_members itself. A screen saying "salvo" only
 * proves createSendListAction was reached; it says nothing about whether
 * create_send_list actually froze anyone in, which is why this spec's last
 * step reads the database directly rather than trusting the second screen.
 *
 * Preamble copied from music-requests.spec.ts (Block 7b, Task 10): the owner's
 * bypass grants messaging.manage in every active Company of the Organization
 * (has_permission, 0024), so nothing about reaching the button needs a scoped
 * delegate — CreateSendListDialog's own comment states permission is the
 * caller's job, not this component's, and that job is exercised by Task 8's
 * isolation cases (tests/isolation/send-lists.test.ts), not by this journey.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-send-lists-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-send-lists-admin-${stamp}-pw`;
const ownerEmail = `e2e-send-lists-owner-${stamp}@example.test`;
const orgName = `Send Lists Org ${stamp}`;
const stationName = `Send Lists Station ${stamp}`;
const artistName = `E2E Send List Artist ${stamp}`;
const songTitle = `E2E Send List Song ${stamp}`;
const songCode = `E2E-SL-${stamp}`;
const listenerAName = `E2E Send List Listener A ${stamp}`;
const listenerAPhone = `5511${stamp}`;
const listenerBName = `E2E Send List Listener B ${stamp}`;
const listenerBPhone = `5521${stamp}`;
const listName = `E2E Send List ${stamp}`;
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

test('a filtered Requests listing becomes a named fixed send list, proven on screen and in the database', async ({
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

  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(
    ownerPage.locator('[data-testid="station-card"]', { hasText: stationName }),
  ).toBeVisible();

  // ===========================================================================
  // 1. Enough catalogue for two requests: one artist, one song.
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

  await ownerPage.getByTestId('song-create').click();
  const songCreateForm = ownerPage.locator('[data-testid="song-create-form"]');
  await songCreateForm.getByLabel('Title').fill(songTitle);
  await songCreateForm.getByLabel('Artist').selectOption({ label: artistName });
  await songCreateForm.getByLabel('Integration code').fill(songCode);
  await songCreateForm.getByRole('button', { name: 'Register song' }).click();
  await expect(songCreateForm.getByText('Song registered.')).toBeVisible();
  await songCreateForm.getByRole('button', { name: 'View song' }).click();
  await expect(ownerPage.getByRole('heading', { name: songTitle, level: 2 })).toBeVisible();
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // ===========================================================================
  // 2. Requests: two rows, two different listeners, both freshly recorded and
  //    therefore both UNREAD (music-requests.spec.ts's own precedent for that
  //    default) — the filter in step 3 narrows on that shared, known state.
  // ===========================================================================
  await openNavSection(ownerPage, 'Audience');
  await ownerPage.getByRole('link', { name: 'Requests' }).click();
  await expect(ownerPage).toHaveURL(/\/music\/requests$/);

  for (const [name, phone] of [
    [listenerAName, listenerAPhone],
    [listenerBName, listenerBPhone],
  ] as const) {
    await ownerPage.getByTestId('request-record').click();
    const requestForm = ownerPage.locator('[data-testid="request-record-form"]');
    await expect(requestForm).toBeVisible();

    await requestForm.getByTestId('request-song-search').fill(songCode);
    await expect(requestForm.getByTestId('request-song-option')).toHaveCount(1);
    await requestForm.getByTestId('request-song-option').click();
    await expect(requestForm.getByTestId('request-picked-song')).toHaveText(
      `${songTitle} — ${artistName}`,
    );

    await requestForm.getByTestId('request-full-name').fill(name);
    await requestForm.getByTestId('request-phone').fill(phone);

    await requestForm.getByTestId('request-record-submit').click();
    await expect(requestForm.getByText('Request recorded.')).toBeVisible();
    await requestForm.getByRole('button', { name: 'Close', exact: true }).click();
  }

  // ===========================================================================
  // 3. The filter this list is cut from: UNREAD, exactly the two rows above.
  // ===========================================================================
  await ownerPage.getByTestId('request-read-filter').selectOption('UNREAD');
  const requestRows = ownerPage.getByTestId('request-row');
  await expect(requestRows).toHaveCount(2);

  // ===========================================================================
  // 4. Criar lista de envio: name it, choose Fixed, wait for the preview to
  //    settle on 2 (resolveSendListPreviewAction re-runs the SAME filter this
  //    screen is showing), save.
  // ===========================================================================
  await ownerPage.getByTestId('create-send-list-button').click();
  await ownerPage.getByTestId('create-send-list-name').fill(listName);
  await ownerPage.getByTestId('create-send-list-kind-fixed').check();
  await expect(ownerPage.getByTestId('create-send-list-count')).toHaveText(
    'This list will hold 2 people.',
  );
  await expect(ownerPage.getByTestId('create-send-list-save')).toBeEnabled();
  await ownerPage.getByTestId('create-send-list-save').click();
  // The dialog is a native <dialog>; handleSubmit only calls setOpen(false) on
  // a non-error result, so this hiding IS the assertion that the save reported
  // success — a failed save would leave the name field, and saveError beside
  // it, on screen.
  await expect(ownerPage.getByTestId('create-send-list-name')).toBeHidden();

  // ===========================================================================
  // 5. The lists screen: the row exists, and revealing its reach shows the
  //    same 2 the dialog's own preview and the filtered grid both already
  //    agreed on.
  // ===========================================================================
  await openNavSection(ownerPage, 'Messages');
  await ownerPage.getByRole('link', { name: 'Send lists' }).click();
  await expect(ownerPage).toHaveURL(/\/messages\/lists$/);

  const listRow = ownerPage.locator('[data-testid="send-list-row"]', { hasText: listName });
  await expect(listRow).toHaveCount(1);
  await listRow.getByTestId('send-list-reveal-reach').click();
  // Name, Station, Kind, People — the fourth cell, per lists-grid.tsx's own
  // TableHead order (listNameLabel/stationColumnLabel/kindColumnLabel/
  // peopleColumnLabel), read positionally because ReachCells renders the
  // count into a bare TableCell with no testid of its own.
  await expect(listRow.locator('td').nth(3)).toHaveText('2');

  // ===========================================================================
  // 6. THE POINT OF THIS SPEC: the database, not just the second screen. Both
  //    listeners resolveOrCreateMember (Block 3) registered while recording
  //    the requests above are exactly who create_send_list froze into
  //    send_list_members — not merely two rows, but these two specific people.
  // ===========================================================================
  const { data: list, error: listError } = await admin
    .from('send_lists')
    .select('id, kind, source, company_id')
    .eq('name', listName)
    .single();
  expect(listError, listError?.message).toBeNull();
  if (!list) throw new Error(`no send_lists row named ${listName}`);
  expect(list.kind).toBe('fixed');
  expect(list.source).toBe('requests');

  const { data: memberA } = await admin
    .from('members')
    .select('id')
    .eq('full_name', listenerAName)
    .single();
  const { data: memberB } = await admin
    .from('members')
    .select('id')
    .eq('full_name', listenerBName)
    .single();
  if (!memberA) throw new Error(`no members row named ${listenerAName}`);
  if (!memberB) throw new Error(`no members row named ${listenerBName}`);

  // A direct connection, not admin.from(): 0238 grants send_lists a bare
  // `select` to service_role and gives send_list_members no SELECT at all, so
  // the ONE way anything outside a SECURITY DEFINER door reads this table's
  // real rows is a superuser connection. "Nothing reads this as a user"
  // (0238's own comment) is about the missing POLICY and says nothing about
  // what the service key holds — which is why the same review that corrected
  // this sentence also had 0238 revoke service_role's default-ACL TRUNCATE
  // here (whole-branch review, F9).
  //
  // draw-flow.spec.ts's own preamble reaches for the same connection, but NOT
  // for the same reason (F15): there the table is perfectly readable and it is
  // one UPDATE grant on promotions that is missing, so raw SQL substitutes for
  // a seventeen-argument door. Here nothing can READ the table at all. Same
  // escape hatch, different hole — and calling them identical is how the next
  // reader concludes send_list_members is merely un-writable.
  const sql = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await sql.connect();
  let memberIds: string[];
  try {
    const result = await sql.query<{ member_id: string }>(
      'select member_id from public.send_list_members where list_id = $1',
      [list.id],
    );
    memberIds = result.rows.map((row) => row.member_id);
  } finally {
    await sql.end();
  }
  expect(memberIds.sort()).toEqual([memberA.id, memberB.id].sort());

  await ownerContext.close();
});
