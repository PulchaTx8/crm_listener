import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * Block 3c's proof.
 *
 * The promise this block makes is a negative one — opening a record, moving
 * between its tabs, saving it and closing it does NOT re-run the list query
 * behind it — and a negative is verified by counting, not by looking. Every
 * request the browser makes for the /members route is recorded; at the end of a
 * journey that touches every one of those operations, the count must still be
 * zero.
 *
 * The rest of the file is what the count cannot see: focus returning to the
 * control that opened the record, ESC, Back, a saved row keeping its position,
 * and the address of a listener the caller cannot reach saying nothing about
 * whether it exists.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-dialog-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-dialog-admin-${stamp}-pw`;
const ownerEmail = `e2e-dialog-owner-${stamp}@example.test`;
const ownerPassword = `Owner-${stamp}-chosen`;
const orgName = `Dialog Org ${stamp}`;
const stationName = `Dialog Station ${stamp}`;
const strangerOwnerEmail = `e2e-dialog-stranger-${stamp}@example.test`;
const strangerStationName = `Dialog Station B ${stamp}`;
const strangerName = `Stranger ${stamp}`;
// Three listeners, named so that sorting by name is a known order: the save
// below renames the first one to something that would sort last if the list
// were ever re-queried.
const listenerNames = [`Ana Dialog ${stamp}`, `Bruno Dialog ${stamp}`, `Carla Dialog ${stamp}`];
const renamed = `Zoe Dialog ${stamp}`;

const createdUserIds: string[] = [];
const reachableMemberIds: string[] = [];
let unreachableMemberId = '';

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

/**
 * Counts the requests that would re-render the audience list: a document
 * navigation to /members, or an RSC payload fetch for it. Next marks the latter
 * with an `RSC` header and an `_rsc` query parameter, and either one is enough
 * to identify it.
 *
 * The record read and every save are POSTs to the server-action endpoint on the
 * same path, and those are expected — the block forbids re-running the LIST,
 * not talking to the server at all. They are excluded by resource type rather
 * than by URL: a server action POST is a `fetch`, never a document, and carries
 * no `_rsc`.
 *
 * WHAT THIS CANNOT SEE, stated plainly because the gap is the whole reason the
 * assertion beside the save exists: a revalidatePath() inside a server action
 * does NOT produce a request of its own. Next returns the freshly rendered tree
 * in the action's own POST response, which this counter deliberately ignores —
 * so the exact regression this block most fears would slip past it. What
 * catches that one is the row-position assertion made at the moment of the
 * save: a re-rendered list re-sorts, and the row moves. This counter guards the
 * other shape of the same mistake — reaching for the Next router where the
 * history API is what the hook is written to use — which does put a request on
 * the wire. Verified by mutation, both ways round; see docs/block-3c-report.md.
 */
function countListRenders(page: Page): string[] {
  const renders: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/members')) return;
    const isRsc = url.searchParams.has('_rsc') || request.headers()['rsc'] === '1';
    if (request.resourceType() === 'document' || isRsc) renders.push(request.url());
  });
  return renders;
}

test('the record opens over a list that is never re-queried', async ({ page, browser }) => {
  // --- seed a customer, an owner and three listeners ------------------------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const provisionalPassword = await provisionThroughConsole(page, {
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

  // A second customer, for the security case at the end of this journey: its
  // listener is the one the first owner must not be able to address. The helper
  // reloads between the two provisionings rather than refilling the open dialog,
  // so the password it reads cannot be the previous customer's still on screen.
  const strangerPassword = await provisionThroughConsole(page, {
    organizationName: `${orgName} B`,
    companyName: strangerStationName,
    ownerEmail: strangerOwnerEmail,
  });

  const { data: strangerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', strangerOwnerEmail)
    .single();
  if (!strangerProfile) throw new Error(`no profile row for ${strangerOwnerEmail}`);
  createdUserIds.push(strangerProfile.id);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/login');
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(provisionalPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);
  await ownerPage.getByPlaceholder('New password').fill(ownerPassword);
  await ownerPage.getByPlaceholder('Repeat the password').fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  // The listeners are seeded through create_member on the owner's own session
  // rather than through the registration dialog three times over: this spec is
  // about what happens to a list once it is on screen, and driving the desk's
  // two-step duplicate check is members-flow.spec.ts's job.
  const asOwner = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: ownerSignInError } = await asOwner.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  expect(ownerSignInError).toBeNull();

  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  if (!station) throw new Error(`no company row for ${stationName}`);

  for (const name of listenerNames) {
    const { data: createdId, error } = await asOwner.rpc('create_member', {
      p_company_id: station.id,
      p_full_name: name,
    });
    expect(error).toBeNull();
    // Kept for the deep link near the end of this journey, which needs an id it
    // can put in an address rather than a row it can click.
    reachableMemberIds.push(String(createdId));
  }

  // The listener the first owner must never reach, created on the second
  // customer's own session — RLS is what hides it, so it has to be a real row
  // in a real other Organization rather than an id nobody owns.
  const asStranger = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: strangerSignInError } = await asStranger.auth.signInWithPassword({
    email: strangerOwnerEmail,
    password: strangerPassword,
  });
  expect(strangerSignInError).toBeNull();

  const { data: strangerStation } = await admin
    .from('companies')
    .select('id')
    .eq('name', strangerStationName)
    .single();
  if (!strangerStation) throw new Error(`no company row for ${strangerStationName}`);

  const { data: strangerMemberId, error: strangerMemberError } = await asStranger.rpc(
    'create_member',
    { p_company_id: strangerStation.id, p_full_name: strangerName },
  );
  expect(strangerMemberError).toBeNull();
  unreachableMemberId = String(strangerMemberId);

  // --- the count starts here ------------------------------------------------
  const listRenders = countListRenders(ownerPage);

  await openNavSection(ownerPage, 'Audience');
  await ownerPage.getByRole('link', { name: 'Members' }).click();
  await expect(ownerPage).toHaveURL(/\/members$/);
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  // Sorted by name, deliberately: the default is newest-first, under which a
  // rename could not move a row even if the list WERE re-queried, and the
  // "position never moves" assertion below would prove nothing. Under a name
  // sort, renaming the first row to "Zoe" is exactly the case that would
  // reorder the list if anything re-ran the query.
  await ownerPage.getByRole('link', { name: /^Name/ }).click();
  await expect(ownerPage).toHaveURL(/sort=name/);
  await expect(ownerPage.locator('[data-testid="member-row"]').first()).toContainText(
    listenerNames[0] as string,
  );

  // The two navigations that put this list on screen are renders of the list,
  // and they are the last ones this journey is allowed. Cleared rather than
  // tolerated in the final assertion, so that the number checked at the end is
  // zero and not a magic constant somebody would later "fix" by incrementing.
  listRenders.length = 0;

  const firstRow = ownerPage.locator('[data-testid="member-row"]').first();

  // --- open, switch two tabs, save, close -----------------------------------
  // Matched on the action rather than the name: the save below renames this
  // listener, and a locator carrying the old name would stop resolving to the
  // very control whose focus this test is about to check.
  const pencil = firstRow.getByRole('button', { name: /^Edit / });
  await pencil.click();
  await expect(ownerPage.getByRole('heading', { name: listenerNames[0], level: 2 })).toBeVisible();
  await expect(ownerPage).toHaveURL(/record=[0-9a-f-]+/);

  await ownerPage.getByRole('tab', { name: 'Stations' }).click();
  await expect(ownerPage.getByText(stationName)).toBeVisible();
  await ownerPage.getByRole('tab', { name: 'Consents' }).click();
  await expect(ownerPage.locator('[data-testid="consent-form"]')).toBeVisible();
  await expect(ownerPage).toHaveURL(/tab=consents/);

  await ownerPage.getByRole('tab', { name: 'Data' }).click();
  const dataForm = ownerPage.locator('[data-testid="member-data-form"]');
  await dataForm.getByLabel('Name').fill(renamed);
  await dataForm.getByRole('button', { name: 'Save' }).click();

  // The first assertion after the write, deliberately. This list is sorted by
  // name, so a list rebuilt from the server would put "Zoe" last; the row
  // staying first is the rule row-patch.ts exists to keep AND the only thing
  // that catches a revalidatePath reintroduced into updateMemberAction, whose
  // re-render arrives inside the action's own response where the request
  // counter cannot see it. Asserted here rather than five steps later so the
  // failure names its cause.
  await expect(ownerPage.locator('[data-testid="member-row"]').first()).toContainText(renamed);
  await expect(dataForm.getByText('Saved.')).toBeVisible();

  // --- ESC closes, and focus goes back to the control that opened it --------
  // Closing takes the record out of the address and leaves the list's own state
  // — the name sort chosen above — exactly as it was. That is withRecord's job:
  // it removes `record` and `tab` and touches nothing else in the query.
  await ownerPage.keyboard.press('Escape');
  await expect(ownerPage.getByRole('heading', { name: renamed, level: 2 })).toHaveCount(0);
  await expect(ownerPage).toHaveURL(/\/members\?sort=name$/);
  await expect(pencil).toBeFocused();

  // --- the saved row shows the new value IN ITS ORIGINAL POSITION -----------
  // The list is sorted by name, so a re-query would move "Zoe" to the end. It
  // is still first, which is the rule row-patch.ts exists to keep: an operator
  // halfway through editing a page of listeners does not have the page
  // rearranged under them.
  await expect(ownerPage.locator('[data-testid="member-row"]').first()).toContainText(renamed);
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  // --- Back closes the record and leaves the list on screen -----------------
  const secondRow = ownerPage.locator('[data-testid="member-row"]').nth(1);
  await secondRow.getByRole('button', { name: `Edit ${listenerNames[1]}` }).click();
  await expect(ownerPage.getByRole('heading', { name: listenerNames[1], level: 2 })).toBeVisible();
  await ownerPage.goBack();
  await expect(ownerPage.getByRole('heading', { name: listenerNames[1], level: 2 })).toHaveCount(0);
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  // --- the count ------------------------------------------------------------
  // Everything above — two records opened, three tabs, a save, ESC, Back —
  // without one re-render of the list route. This is the assertion the whole
  // block exists to make; if a revalidatePath ever finds its way back into
  // members/actions.ts, this is where it says so.
  expect(listRenders).toEqual([]);

  // --- a record address arriving cold, on the tab it names ------------------
  // Every open above went through useRecordDialog in the browser. This one does
  // not: a pasted or bookmarked address is parsed by the PAGE, on the server,
  // and that is the only path on which parseRecordParam runs there. It threw on
  // this screen from Block 3c until Block 4b, because the tab tuple it validates
  // against was exported from a 'use client' module and a Server Component
  // importing across that boundary gets a client reference rather than the
  // array. See src/lib/record-params.ts.
  //
  // `tab=consents` deliberately: not the first tab, so a silent fall back to
  // `data` fails here rather than passing by accident — and, unlike the
  // `?record=` address at the end of this journey, a tab is what makes the
  // parse actually touch the tuple. That address was already here and still
  // passed throughout, which is why it never gave the defect away.
  //
  // No render assertion around this one — a cold address IS a document render
  // of the list, which is the whole point of it. The counter is deliberately
  // left behind at the line above.
  await ownerPage.goto(`/members?record=${reachableMemberIds[2]}&tab=consents`);
  await expect(ownerPage.getByRole('tab', { name: 'Consents' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(ownerPage.locator('[data-testid="consent-form"]')).toBeVisible();
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  // --- CLOSING that cold record stays on the page ---------------------------
  // The other half of the deep link, and the half nothing tested until Block
  // 4b: every close asserted above followed an open() that had pushed a history
  // entry of its own, so close()'s history.back() had something of ours to pop.
  // A pasted address pushed nothing, and back() from it left the document
  // altogether — a full navigation to whatever the operator was looking at
  // before, which on this journey is /members?sort=name. The list came back
  // looking right, so the damage was invisible from here and surfaced in
  // another journey instead, as a dialog that opened and then closed itself
  // (members-flow.spec.ts, "the registration desk's own duplicate check").
  //
  // The counter is re-armed for this one step, having been deliberately left
  // behind above: the cold goto IS a render of the list and is not the subject
  // here. What is measured is only what the Close button costs.
  listRenders.length = 0;

  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();

  // The address drops `record` and `tab` and keeps everything else — here,
  // nothing else, so the bare path. Before the fix this read
  // `/members?sort=name`, the address of the page the browser had walked back
  // to.
  await expect(ownerPage).toHaveURL(/\/members$/);
  await expect(ownerPage.locator('[data-testid="consent-form"]')).toHaveCount(0);
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  // And it cost nothing on the wire. This is the assertion that says "still on
  // the page" rather than "on a page that looks like it": a document
  // navigation, an RSC fetch or a router.push reaching for the same effect all
  // land here, and the list surviving cannot tell them apart because the server
  // would hand back the same three rows.
  expect(listRenders, 'closing a record that arrived in the first URL').toEqual([]);

  // Forward does not put the record back — the requirement close() has carried
  // since Block 3c, now true on the path where it never was. goForward() on an
  // empty forward stack is a no-op, which is exactly the claim being made.
  //
  // This is what keeps the tempting alternative fix out: give the cold address
  // an entry of its own on mount (replaceState the closed URL, then pushState
  // the record back over it) and close() needs no branch at all, because there
  // is always something to pop. It also leaves the record sitting one Forward
  // away, and this line is what says so.
  await ownerPage.goForward();
  await expect(ownerPage).toHaveURL(/\/members$/);
  await expect(ownerPage.locator('[data-testid="consent-form"]')).toHaveCount(0);

  // --- a record the caller cannot reach -------------------------------------
  // A real listener, at a Station in another Organization: RLS is what hides
  // it, so an id nobody owns would be testing something easier than the real
  // case. The dialog must say the same sentence for both — "no such listener"
  // and "not yours" collapse on purpose (record.ts), or ?record= becomes an
  // oracle telling somebody pasting ids which ones exist.
  await ownerPage.goto(`/members?record=${unreachableMemberId}`);

  await expect(
    ownerPage.getByText('No such listener, or you do not have permission to see this one.'),
  ).toBeVisible();
  // Nothing about that listener reaches this page, in text or in markup —
  // checked against the whole document, because a name sitting in a title or a
  // data attribute is a leak that innerText cannot see.
  await expect(ownerPage.getByText(strangerName)).toHaveCount(0);
  expect(await ownerPage.content()).not.toContain(strangerName);
  // The list behind it rendered as usual and is still usable.
  await expect(ownerPage.locator('[data-testid="member-row"]')).toHaveCount(3);

  await ownerContext.close();
});
