import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer, provisionThroughConsole } from './provision';

/**
 * Block 4c's proof, over the four surfaces Tasks 6 to 8 built: an entry
 * recorded from the promotion record's fifth tab changes the count on that tab
 * without the promotions list behind the dialog being re-queried once, and
 * /participations then lists it, opening on the entries that counted and saying
 * so.
 *
 * Four journeys, and each names a claim that would otherwise rest on reasoning:
 *
 *   1. the write, the count, and the list that must not move (design spec D8);
 *   2. the VALID default announcing itself, and "Any status" undoing it (D5);
 *   3. a delegate who may read entries but not the audience being told their
 *      search was dropped — and still shown every row (Task 7 §5);
 *   4. the debounced search losing to a navigation it did not make.
 *
 * The fourth is the one that had never been driven. It was written first
 * against the guard as Task 7 left it and FAILED — that guard cancelled the
 * pending timer from an effect keyed on the address, so it could only fire
 * once the destination render had committed, which on this screen is 276-305ms
 * of server time against a 350ms debounce. Six runs per case in a production
 * build: the Station chip held 5 of 6 and the page turn 0 of 6. The guard now
 * cancels when the navigation is STARTED (participations-filters.tsx's
 * document click listener), and both cases hold 6 of 6. That history is here
 * because this journey looks like it is testing a detail, and what it is
 * actually holding down is the difference between a guard that works and one
 * that wins a race most of the time.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-entry-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-entry-admin-${stamp}-pw`;

// --- the first journey's world: ONE Organization holding exactly ONE Station -
//
// Its own Organization, and that is load-bearing rather than tidiness. The
// render counter below cannot tell a Station chip's <Link> prefetch on
// /promotions apart from the re-query this block forbids: both are RSC requests
// for /promotions. An owner who can reach two Stations gets that chip row
// (promotions/page.tsx renders it above one), and in CI — where the suite runs
// a production build, and only there is <Link> prefetching enabled at all — it
// would fire an RSC request this counter would count. So the operator whose
// renders are being counted can reach exactly one Station, which is the
// condition promotion-prizes.spec.ts already proves the counter under. It also
// keeps this journey's promotions list at exactly one row whatever else the
// file grows, which is what lets the compensating assertion below be a count
// rather than a comparison against a number somebody has to keep up to date.
const entryOwnerEmail = `e2e-entry-owner-${stamp}@example.test`;
const entryOwnerPassword = `Entry-owner-${stamp}-chosen`;
const entryOrgName = `Entry Org ${stamp}`;
const entryStationName = `Entry Station ${stamp}`;
const entryPromotionName = `Ana Entry Promo ${stamp}`;
/**
 * Registered on the owner's own session AFTER the promotions list is on screen
 * and while the record is open. Nothing in that journey ever navigates to
 * /promotions again, so the only way this name can reach the screen is a
 * re-render of the list — which is exactly what must not happen. Named to sort
 * last so that a list which DID rebuild would also have to re-sort, and cannot
 * hide the extra row off the end of a page.
 */
const unseenPromotionName = `Zoe Unseen Promo ${stamp}`;
/** The listener whose entry is planted out of band — see PLANTED, below. */
const unseenListenerName = `Bruno Unseen ${stamp}`;
const unseenListenerPhone = `1197${String(stamp).slice(-7)}`;
/** The listener the operator types into the manual form, who does not exist yet. */
const typedListenerName = `Carla Typed ${stamp}`;
const typedListenerPhone = `1196${String(stamp).slice(-7)}`;

// --- the other three journeys' world: one Organization, two Stations --------
const listOwnerEmail = `e2e-list-owner-${stamp}@example.test`;
const listOrgName = `List Org ${stamp}`;
const stationAName = `List Station A ${stamp}`;
const stationBName = `List Station B ${stamp}`;
const managerEmail = `e2e-list-manager-${stamp}@example.test`;
const readerEmail = `e2e-list-reader-${stamp}@example.test`;
/**
 * promotions.view and nothing else. The one delegate in this file who can open
 * a promotion record and may NOT read its entries, which is the only way to
 * drive the fifth tab's "it is not a count of nothing — it is a count you may
 * not read" branch. The reader below holds participations.view, so it can
 * never reach it.
 */
const promotionsOnlyEmail = `e2e-list-promo-only-${stamp}@example.test`;
const listingPromotionName = `Listing Promo ${stamp}`;
const pagingPromotionName = `Paging Promo ${stamp}`;
const anaName = `Ana Listed ${stamp}`;
const brunoName = `Bruno Listed ${stamp}`;
const caioName = `Caio Paged ${stamp}`;
/**
 * Deliberately carries no digit. The service ORs the term against
 * `cpf_last_digits` and `phone_normalized` as well as the name, but only once
 * the term contains a digit — including the stamp here would put five- and
 * six-digit substrings of it against every phone in the Station and make "this
 * term matches exactly one listener" an accident rather than a fact.
 */
const searchTerm = 'Ana Listed';

/** How many entries the paging journey needs: one more than a full page (25). */
const PAGING_ENTRIES = 26;
const PARTICIPATION_PAGE_SIZE = 25;

const createdUserIds: string[] = [];

interface World {
  stationAId: string;
  stationBId: string;
  listingPromotionId: string;
  pagingPromotionId: string;
  managerPassword: string;
  readerPassword: string;
  promotionsOnlyPassword: string;
}
/**
 * Built once in beforeAll and read by the last three journeys. The definite
 * assignment assertion is honest here rather than a way round the compiler: a
 * beforeAll that throws fails every test in the file, so no journey can reach
 * this while it is unset.
 */
let world!: World;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function anonClient(): SupabaseClient {
  return createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return client;
}

/** A real auth user with a profile row, recorded for afterAll. */
async function createAuthUser(email: string): Promise<{ id: string; password: string }> {
  const password = `Pw-${stamp}-${email.slice(0, 12)}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError)
    throw new Error(`could not create profile for ${email}: ${profileError.message}`);
  return { id: data.user.id, password };
}

/**
 * Adds a colleague to an Organization through the real invitation RPCs, the
 * long way round tests/isolation/harness.ts goes: Block 1a leaves the tenant
 * tables read-only for service_role on purpose, so there is no shortcut to
 * insert the membership rows, and going the long way means the seeding path is
 * the production path.
 *
 * The RPCs, not the /invite screen. The accept screen is rate limited to ten
 * per hour per IP (src/lib/rate-limit), which is an APPLICATION-layer limiter —
 * accept_invitation itself has no counter — and four unrelated specs in this
 * suite already spend against it. Driving the browser here would add two more
 * for a screen invitation-flow.spec.ts already proves.
 *
 * Order matters: the invitation is created BEFORE the auth user exists, because
 * create_invitation refuses an address that already has an account.
 */
async function addDelegate(
  ownerClient: SupabaseClient,
  organizationId: string,
  email: string,
  roleId: string,
  companyIds: string[],
): Promise<{ id: string; password: string }> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const { error: inviteError } = await ownerClient.rpc('create_invitation', {
    p_organization_id: organizationId,
    p_email: email,
    p_is_owner: false,
    p_role_id: roleId,
    p_company_ids: companyIds,
    p_token_hash: tokenHash,
    p_ttl_days: 7,
  });
  if (inviteError) throw new Error(`create_invitation failed: ${inviteError.message}`);

  const user = await createAuthUser(email);

  const { error: acceptError } = await admin.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: user.id,
  });
  if (acceptError) throw new Error(`accept_invitation failed: ${acceptError.message}`);
  return user;
}

async function createPromotion(
  client: SupabaseClient,
  companyId: string,
  name: string,
): Promise<string> {
  const { data, error } = await client.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: name,
    p_starts_at: new Date(Date.now() - 30 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + 30 * DAY).toISOString(),
  });
  if (error) throw new Error(`create_promotion(${name}) failed: ${error.message}`);
  return data as string;
}

async function createListener(
  client: SupabaseClient,
  companyId: string,
  fullName: string,
  phone: string,
): Promise<string> {
  const { data, error } = await client.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: fullName,
    p_phone: phone,
  });
  if (error) throw new Error(`create_member(${fullName}) failed: ${error.message}`);
  return data as string;
}

/** One entry through the real RPC, returning the status the database chose. */
async function recordEntry(
  client: SupabaseClient,
  promotionId: string,
  memberId: string,
  participatedAt: Date,
): Promise<string> {
  const { data, error } = await client.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: memberId,
    p_participated_at: participatedAt.toISOString(),
    p_source: 'MANUAL',
  });
  if (error) throw new Error(`record_participation failed: ${error.message}`);
  return (data as { status: string }).status;
}

test.beforeAll(async () => {
  // Two Organizations, two delegates, one promotion with three entries and one
  // with twenty-six: past the 30s default, and sized to the work rather than
  // rounded up.
  test.setTimeout(120_000);

  const platformAdmin = await admin.auth.admin.createUser({
    email: platformAdminEmail,
    password: platformAdminPassword,
    email_confirm: true,
  });
  if (platformAdmin.error || !platformAdmin.data.user) {
    throw new Error(`could not create admin: ${platformAdmin.error?.message}`);
  }
  createdUserIds.push(platformAdmin.data.user.id);
  await admin
    .from('profiles')
    .insert({ id: platformAdmin.data.user.id, email: platformAdminEmail });
  await admin.from('platform_admins').insert({ user_id: platformAdmin.data.user.id });

  // --- the second Organization, seeded through the real RPCs -----------------
  //
  // Not through the Customers screen, unlike the first journey below, and the
  // difference is deliberate: journey 1 is about what happens on a screen, so
  // it walks in through the screens; journeys 2 to 4 are about what a list
  // shows, and provisioning is already proved by provisioning-flow.spec.ts and
  // driven again in journey 1. The owner here never opens a browser at all —
  // every write below is a signed-in RPC call, which the provisional-password
  // gate does not stand in front of (it is middleware over page requests), so
  // nothing about that gate is being worked around.
  const adminClient = await signIn(platformAdminEmail, platformAdminPassword);
  const listOwner = await createAuthUser(listOwnerEmail);

  const { organization_id: organizationId, company_id: stationAId } = await provisionCustomer(
    adminClient,
    {
      userId: listOwner.id,
      organizationName: listOrgName,
      companyName: stationAName,
    },
  );

  // add_company is platform-admin only (0017), so it goes through the admin's
  // own session — the same call tests/isolation/harness.ts's addCompany makes
  // and the same one members-flow.spec.ts makes for its second Station.
  const { data: stationBId, error: stationBError } = await adminClient.rpc('add_company', {
    p_organization_id: organizationId,
    p_name: stationBName,
    p_timezone: 'America/Sao_Paulo',
  });
  if (stationBError) throw new Error(`add_company failed: ${stationBError.message}`);

  const ownerClient = await signIn(listOwnerEmail, listOwner.password);

  // Two roles, and the ONE permission between them is the whole of journey 3:
  // both read entries and promotions, only the manager can see the audience.
  const { data: managerRoleId, error: managerRoleError } = await ownerClient.rpc('create_role', {
    p_organization_id: organizationId,
    p_name: `Entry Manager ${stamp}`,
    p_permission_codes: ['participations.view', 'promotions.view', 'members.view'],
  });
  if (managerRoleError) throw new Error(`create_role(manager) failed: ${managerRoleError.message}`);

  const { data: readerRoleId, error: readerRoleError } = await ownerClient.rpc('create_role', {
    p_organization_id: organizationId,
    p_name: `Entry Reader ${stamp}`,
    p_permission_codes: ['participations.view', 'promotions.view'],
  });
  if (readerRoleError) throw new Error(`create_role(reader) failed: ${readerRoleError.message}`);

  // A third role, one permission narrower again: promotions.view alone. It is
  // the only actor in this file that can open a promotion record without being
  // allowed to read its entries, and it is what the fifth tab's hidden-count
  // branch needs — a branch that, until this role existed, could have been
  // deleted with every suite still green.
  const { data: promotionsOnlyRoleId, error: promotionsOnlyRoleError } = await ownerClient.rpc(
    'create_role',
    {
      p_organization_id: organizationId,
      p_name: `Promotions Only ${stamp}`,
      p_permission_codes: ['promotions.view'],
    },
  );
  if (promotionsOnlyRoleError) {
    throw new Error(`create_role(promotions only) failed: ${promotionsOnlyRoleError.message}`);
  }

  // The manager holds it at BOTH Stations, so the Station chip row journey 4
  // needs is rendered for them. The reader holds it at Station A only.
  const manager = await addDelegate(
    ownerClient,
    organizationId,
    managerEmail,
    managerRoleId as string,
    [stationAId, stationBId as string],
  );
  const reader = await addDelegate(
    ownerClient,
    organizationId,
    readerEmail,
    readerRoleId as string,
    [stationAId],
  );
  const promotionsOnly = await addDelegate(
    ownerClient,
    organizationId,
    promotionsOnlyEmail,
    promotionsOnlyRoleId as string,
    [stationAId],
  );

  // --- the listing promotion: two entries that counted, one that did not -----
  const listingPromotionId = await createPromotion(ownerClient, stationAId, listingPromotionName);
  const anaId = await createListener(
    ownerClient,
    stationAId,
    anaName,
    `1191${String(stamp).slice(-7)}`,
  );
  const brunoId = await createListener(
    ownerClient,
    stationAId,
    brunoName,
    `1192${String(stamp).slice(-7)}`,
  );

  const anaFirst = await recordEntry(
    ownerClient,
    listingPromotionId,
    anaId,
    new Date(Date.now() - 3 * HOUR),
  );
  const brunoOnly = await recordEntry(
    ownerClient,
    listingPromotionId,
    brunoId,
    new Date(Date.now() - 2 * HOUR),
  );
  // The promotion takes one entry each (create_promotion's own default), so the
  // second attempt by the same listener is RECORDED as DUPLICATE rather than
  // refused — design spec D5, and the whole reason the default filter has to
  // announce itself. Asserted here rather than assumed: if this ever came back
  // VALID the fixture would silently become three counted entries and journey
  // 2's numbers would still add up, against nothing.
  const anaAgain = await recordEntry(
    ownerClient,
    listingPromotionId,
    anaId,
    new Date(Date.now() - HOUR),
  );
  expect([anaFirst, brunoOnly, anaAgain]).toEqual(['VALID', 'VALID', 'DUPLICATE']);

  // --- the paging promotion: one page and one row over it --------------------
  const pagingPromotionId = await createPromotion(ownerClient, stationAId, pagingPromotionName);
  const caioId = await createListener(
    ownerClient,
    stationAId,
    caioName,
    `1193${String(stamp).slice(-7)}`,
  );
  for (let i = 0; i < PAGING_ENTRIES; i += 1) {
    // One listener, twenty-six rows: the first counts and the rest are
    // DUPLICATEs, which are rows on the record all the same. Twenty-six
    // listeners would have proved nothing more and cost twenty-five extra
    // registrations.
    await recordEntry(
      ownerClient,
      pagingPromotionId,
      caioId,
      new Date(Date.now() - (i + 1) * 60_000),
    );
  }

  world = {
    stationAId,
    stationBId: stationBId as string,
    listingPromotionId,
    pagingPromotionId,
    managerPassword: manager.password,
    readerPassword: reader.password,
    promotionsOnlyPassword: promotionsOnly.password,
  };
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

/**
 * Counts the requests that would re-render the promotions list: a document
 * navigation to /promotions, or an RSC payload fetch for it. Next marks the
 * latter with an `RSC` header and an `_rsc` query parameter.
 *
 * Server-action POSTs on the same path are expected and excluded by resource
 * type: the block forbids re-running the LIST, not talking to the server.
 *
 * WHAT THIS CANNOT SEE — a revalidatePath() inside a server action does NOT
 * produce a request of its own. Next returns the freshly rendered tree inside
 * the action's own POST response, which this counter deliberately ignores, so
 * the exact regression this block most fears would slip straight past it. What
 * catches that one is the compensating assertion made AT THE MOMENT OF THE
 * WRITE, and it has to be invented per spec, because it depends on what the
 * write in question changes.
 *
 * THIS SPEC'S COMPENSATION, and why it is a PAIR rather than the single
 * assertion promotion-prizes.spec.ts makes.
 *
 * Half of it is that spec's: a SECOND promotion is registered out of band,
 * after the list is on screen, so a list rebuilt from the server would grow a
 * row. That half transfers unchanged, and the check that it still applies here
 * was not skipped — PromotionSummary (services/promotions.ts) carries name,
 * window, cancellation, hashtag, question count and archive date, and NOT a
 * participation count. So recording an entry changes nothing this list shows,
 * a re-render would come back byte-identical, and an assertion about the rows
 * already on screen could not fail. A row only the server knows about is still
 * the only thing that separates the two.
 *
 * The second half is what this journey has and that one did not, and it is
 * there because "the list did not change" is a NEGATIVE claim: it is satisfied
 * just as well by a screen where nothing happened at all — a write that failed
 * quietly, a refresh that never fired, a tab that reads from a stale prop.
 * Against that, a counter of zero and an unchanged list are exactly what a dead
 * screen produces. So an ENTRY is planted out of band at the same instant as
 * the promotion, by the same session, for a listener the browser has never
 * heard of; and after the operator's own entry the fifth tab must read TWO. Two
 * is a number the browser cannot compute — it knows about precisely one entry,
 * the one it just made — so it can only have come from a fresh read of the
 * record, made after both writes landed.
 *
 * One planted fact must appear, the other must not, and the same round trip
 * decides both. That asymmetry — the record re-read, the list left alone — is
 * the block's rule stated as something that can go red, rather than as the
 * absence of evidence.
 */
function countListRenders(page: Page): string[] {
  const renders: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/promotions')) return;
    const isRsc = url.searchParams.has('_rsc') || request.headers()['rsc'] === '1';
    if (request.resourceType() === 'document' || isRsc) renders.push(request.url());
  });
  return renders;
}

/**
 * The debounce the guard journey below has to interrupt, repeated from
 * participations-filters.tsx rather than imported: importing it would make the
 * test agree with the screen by construction, and a debounce lengthened by
 * accident would then still look interrupted.
 */
const DEBOUNCE_MS = 350;

/**
 * The guard journey has a setup step that can silently stop being a test.
 *
 * It types a term and clicks a link, and the whole case rests on that click
 * landing INSIDE the debounce window. On a loaded machine — a full suite under
 * one worker, a slow CI box — `fill()` and `click()` can take longer than the
 * window between them, the search fires on its own, and the journey then fails
 * on the very assertion that catches the defect it was written for. A false red
 * shaped exactly like a guard regression, which is the most expensive kind:
 * somebody spends the afternoon this task already spent.
 *
 * So the precondition is asserted as a precondition. Two checks, because
 * neither is sufficient alone: the elapsed time is measured from BEFORE the
 * fill, so it over-counts and can only ever be conservative about "we were
 * inside the window"; and the address is read immediately after the click,
 * where a debounce that had already fired AND landed shows up as a `q=` that
 * has no business being there yet. A failure of either says setup, not screen.
 */
function assertClickBeatTheDebounce(page: Page, startedAt: number, what: string) {
  const elapsed = Date.now() - startedAt;
  expect(
    elapsed,
    `setup, not the screen: ${what} had to be clicked within the ${DEBOUNCE_MS}ms debounce and this machine took ${elapsed}ms to type and click. The case did not run.`,
  ).toBeLessThan(DEBOUNCE_MS);
  expect(
    page.url(),
    `setup, not the screen: the search had already reached the address before ${what} was clicked, so nothing was pending to interrupt.`,
  ).not.toContain('q=');
}

/** The Listener cell of a row on /participations: Listener, Promotion, Status, Source, Entered. */
function listenerCell(page: Page, index: number) {
  return page.getByTestId('participation-row').nth(index).locator('td').first();
}

test('an entry recorded from the fifth tab moves the count, leaves the list behind the dialog alone, and lands on /participations', async ({
  page,
  browser,
}) => {
  // A provisioning round trip, a promotion, a planted listener, a manual entry
  // and two screens — measured past the 30s default.
  test.setTimeout(90_000);

  // --- seed a customer and an owner ------------------------------------------
  // The same sequence promotion-prizes.spec.ts performs in its own first test,
  // and through the same real screens.
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const provisionalPassword = await provisionThroughConsole(page, {
    organizationName: entryOrgName,
    companyName: entryStationName,
    ownerEmail: entryOwnerEmail,
  });

  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', entryOwnerEmail)
    .single();
  if (!ownerProfile) throw new Error(`no profile row for ${entryOwnerEmail}`);
  createdUserIds.push(ownerProfile.id);

  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/login');
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(entryOwnerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(provisionalPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);
  await ownerPage.getByPlaceholder('New password').fill(entryOwnerPassword);
  await ownerPage.getByPlaceholder('Repeat the password').fill(entryOwnerPassword);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  const asOwner = await signIn(entryOwnerEmail, entryOwnerPassword);

  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', entryStationName)
    .single();
  if (!station) throw new Error(`no company row for ${entryStationName}`);

  // The promotion is seeded through create_promotion on the owner's own session
  // rather than by driving the registration dialog, for the reason
  // promotions-flow.spec.ts gives for its own three: this spec is about what
  // happens to a list once it is on screen.
  const promotionId = await createPromotion(asOwner, station.id, entryPromotionName);
  // Registered NOW, before the list is on screen, so that the ENTRY planted
  // further down can be recorded for somebody the promotion will accept. The
  // listener existing is not the planted fact; their entry is.
  const unseenListenerId = await createListener(
    asOwner,
    station.id,
    unseenListenerName,
    unseenListenerPhone,
  );

  // --- the journey -----------------------------------------------------------
  const renders = countListRenders(ownerPage);

  await ownerPage.goto('/promotions');
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByTestId('promotion-row').first()).toContainText(entryPromotionName);

  // The navigation that put this list on screen is a render of it, and it is
  // the last one this journey is allowed. Cleared rather than tolerated in the
  // assertions below, so that the number checked is zero and not a magic
  // constant somebody would later "fix" by incrementing.
  renders.length = 0;

  // A button, not a link: the promotions grid opens a record with
  // `window.history.pushState` from a click handler, and a real anchor would be
  // a navigation, which is the one thing this screen is built not to do.
  // `exact`, because the row also carries "Edit <name>" and "Actions for
  // <name>" controls and an accessible-name match is a substring match by
  // default.
  await ownerPage.getByRole('button', { name: entryPromotionName, exact: true }).click();
  await expect(ownerPage.getByTestId('promotion-tab-data')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await ownerPage.getByTestId('promotion-tab-participations').click();
  await expect(ownerPage).toHaveURL(/tab=participations/);

  // Nothing has been entered yet, and BOTH figures are read: a tab that showed
  // "2" at the end would satisfy an assertion about the first number even if it
  // had been counting something else all along.
  await expect(ownerPage.getByTestId('promotion-participations-valid')).toHaveText('0');
  await expect(ownerPage.getByTestId('promotion-participations-refused')).toHaveText('0');

  // Asserted, not merely asserted-about-in-a-comment: the tab renders from the
  // record that was already read when the dialog opened — Task 8 moved the
  // counts onto PromotionDetail for exactly that reason — so reaching it costs
  // nothing at all. Checked here rather than only at the end so that a failure
  // names which half of the journey caused it.
  expect(renders, 'opening the record and switching to the Entries tab').toEqual([]);

  // The footer's Save submits the promotion's own form, which this tab shows
  // none of. Checked against the two tabs that must still offer it, so this is
  // an assertion about THIS tab rather than about a button that has gone
  // missing everywhere.
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(0);
  await ownerPage.getByTestId('promotion-tab-data').click();
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(1);
  await ownerPage.getByTestId('promotion-tab-participations').click();
  await expect(ownerPage.getByTestId('promotion-save')).toHaveCount(0);

  // --- PLANTED: the two facts the browser cannot know ------------------------
  // Both on the owner's own session, both with the list already on screen and
  // the record open. One must never reach the list; the other must reach the
  // tab. See countListRenders' comment for why it takes both.
  const unseenPromotionId = await createPromotion(asOwner, station.id, unseenPromotionName);
  expect(unseenPromotionId).toBeTruthy();
  const plantedStatus = await recordEntry(
    asOwner,
    promotionId,
    unseenListenerId,
    new Date(Date.now() - 5 * 60_000),
  );
  // If this ever came back anything but VALID the count below would be 1 and
  // the failure would read as a broken tab rather than as a broken fixture.
  expect(plantedStatus, 'the planted entry must be one that counts').toBe('VALID');

  // Neither has been able to reach the screen yet, and the screen has not been
  // given any reason to go and look.
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByTestId('promotion-participations-valid')).toHaveText('0');

  // --- the operator records an entry by hand ---------------------------------
  await ownerPage.getByTestId('promotion-participation-record-open').click();
  await expect(ownerPage.getByTestId('participation-record-form')).toBeVisible();
  await ownerPage.getByTestId('participation-full-name').fill(typedListenerName);
  await ownerPage.getByTestId('participation-phone').fill(typedListenerPhone);
  await ownerPage.getByTestId('participation-record-submit').click();

  // What comes back is an OUTCOME, not a verdict: the badge names the status
  // the database chose and the sentence beside it says the entry is on the
  // record. Nobody held that phone, so the listener was registered too (D4).
  await expect(ownerPage.getByTestId('participation-record-status')).toHaveText('Counted');
  await expect(ownerPage.getByTestId('participation-listener-created')).toBeVisible();

  // --- the compensating pair -------------------------------------------------
  // TWO, not one. The browser made one entry and has never been told about the
  // other, so this number can only have come from a fresh read of the record —
  // which is also the synchronisation point for everything below it: once the
  // count has moved, the refresh round trip is provably finished, and a list
  // rebuilt inside that same response would already be on screen.
  await expect(
    ownerPage.getByTestId('promotion-participations-valid'),
    'the tab must read the count off the server, not off its own write',
  ).toHaveText('2');
  await expect(ownerPage.getByTestId('promotion-participations-refused')).toHaveText('0');

  // The whole point of the block's screen rule: the write and the re-read both
  // happened, and the list behind the dialog was rendered neither time.
  expect(renders, 'recording an entry from the fifth tab').toEqual([]);
  // And the half the counter cannot make for itself. A revalidatePath in
  // recordParticipationAction returns a rebuilt list inside the action's own
  // response, and that list has two promotions in it.
  await expect(ownerPage.getByTestId('promotion-row')).toHaveCount(1);
  await expect(ownerPage.getByText(unseenPromotionName)).toHaveCount(0);

  // --- and /participations lists it ------------------------------------------
  // Through the tab's own link rather than a hand-built URL: the link is what
  // an operator has, and it carries status=all deliberately, because the two
  // figures above it add up to every entry.
  await ownerPage.getByTestId('promotion-participations-link').click();
  await expect(ownerPage).toHaveURL(/\/participations\?/);
  await expect(ownerPage).toHaveURL(new RegExp(`promotion=${promotionId}`));
  await expect(ownerPage).toHaveURL(/status=all/);

  await expect(ownerPage.getByTestId('participation-row')).toHaveCount(2);
  await expect(ownerPage.getByTestId('page-total')).toHaveText('2 entries');
  // Newest first, fixed (participations_listing_idx, 0052): the entry just made
  // is stamped now and the planted one five minutes ago, so this order is the
  // ordering under test rather than an accident of insertion.
  const typedRow = ownerPage.getByTestId('participation-row').first();
  await expect(typedRow).toContainText(typedListenerName);
  await expect(typedRow).toContainText(entryPromotionName);
  await expect(typedRow.getByTestId('participation-status')).toHaveText('Counted');
  await expect(typedRow).toContainText('Entered by hand');
  await expect(ownerPage.getByTestId('participation-row').nth(1)).toContainText(unseenListenerName);

  await ownerContext.close();
});

test('the list opens on the entries that counted and says so, and Any status brings the refusal back', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const context = await browser.newContext();
  const managerPage = await context.newPage();
  await managerPage.goto('/login');
  await managerPage.getByLabel('E-mail', { exact: true }).fill(managerEmail);
  await managerPage.getByLabel('Password', { exact: true }).fill(world.managerPassword);
  await managerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(managerPage).toHaveURL(/\/app$/);

  // Narrowed to this journey's own promotion, so the numbers below are facts
  // about the fixture rather than about whatever else lives in this Station.
  const base = `/participations?companyId=${world.stationAId}&promotion=${world.listingPromotionId}`;
  await managerPage.goto(base);

  // Two of the three, because the screen opens on VALID.
  await expect(managerPage.getByTestId('participation-row')).toHaveCount(2);
  await expect(managerPage.getByTestId('page-total')).toHaveText('2 entries');
  await expect(managerPage.getByTestId('participation-status').first()).toHaveText('Counted');

  // THE assertion of this journey, and not the row count. Two rows alone also
  // pass against a screen that silently lost the refusal — that is exactly what
  // "two of three" looks like from the outside — and design spec D5's whole
  // claim is that the refusal was written down and can be found. The sentence
  // that says a default is narrowing the list is the only thing on screen that
  // distinguishes the two, so it is what is asserted.
  await expect(managerPage.getByTestId('participation-status-note')).toBeVisible();
  await expect(managerPage.getByTestId('participation-status-note')).toContainText('Any status');

  await managerPage.getByTestId('participation-status-filter').selectOption('all');
  await expect(managerPage).toHaveURL(/status=all/);

  await expect(managerPage.getByTestId('participation-row')).toHaveCount(3);
  await expect(managerPage.getByTestId('page-total')).toHaveText('3 entries');
  // The refusal is a row with a status, not an error and not an absence — and
  // the whole column is read in order rather than the one new badge being
  // counted. `getByText('Already entered')` would have matched the status
  // filter's own <option> as well as the row, which is a locator that answers
  // two before it answers one. Newest first: the second attempt is the most
  // recent instant in the fixture, so this order is the ordering under test.
  await expect(managerPage.getByTestId('participation-status')).toHaveText([
    'Already entered',
    'Counted',
    'Counted',
  ]);
  // And the note goes, because it is now telling the truth about nothing.
  await expect(managerPage.getByTestId('participation-status-note')).toHaveCount(0);

  // Narrowing to the refusals alone: the third row was not merely appended to
  // the end of an unfiltered list.
  await managerPage.getByTestId('participation-status-filter').selectOption('DUPLICATE');
  await expect(managerPage.getByTestId('participation-row')).toHaveCount(1);
  await expect(managerPage.getByTestId('participation-status')).toHaveText('Already entered');
  await expect(managerPage.getByTestId('participation-status-note')).toHaveCount(0);

  await context.close();
});

test('a delegate who cannot see the audience is told their search was dropped, and is still shown every entry', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const base = `/participations?companyId=${world.stationAId}&promotion=${world.listingPromotionId}`;
  const searched = `${base}&q=${encodeURIComponent(searchTerm)}`;

  // --- first, somebody who CAN search, so the term is known to narrow --------
  //
  // Without this the journey below proves nothing: an unfiltered row count that
  // happens to equal the filtered one passes whether the term was dropped or
  // forwarded. This is what makes "two rows" mean "the term was not applied".
  const managerContext = await browser.newContext();
  const managerPage = await managerContext.newPage();
  await managerPage.goto('/login');
  await managerPage.getByLabel('E-mail', { exact: true }).fill(managerEmail);
  await managerPage.getByLabel('Password', { exact: true }).fill(world.managerPassword);
  await managerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(managerPage).toHaveURL(/\/app$/);

  await managerPage.goto(searched);
  await expect(managerPage.getByTestId('participation-search-input')).toBeEnabled();
  await expect(managerPage.getByTestId('participation-search-note')).toHaveCount(0);
  await expect(
    managerPage.getByTestId('participation-row'),
    'the term must narrow the list for somebody holding members.view',
  ).toHaveCount(1);
  await expect(listenerCell(managerPage, 0)).toContainText(anaName);
  await managerContext.close();

  // --- and now somebody who cannot ------------------------------------------
  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  await readerPage.goto('/login');
  await readerPage.getByLabel('E-mail', { exact: true }).fill(readerEmail);
  await readerPage.getByLabel('Password', { exact: true }).fill(world.readerPassword);
  await readerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(readerPage).toHaveURL(/\/app$/);

  // The premise, checked rather than assumed: this delegate really cannot read
  // the audience, so every listener name renders as a dash — the same dash an
  // anonymised listener gets, deliberately, so the column cannot answer "has
  // this person been erased?". If this ever showed a name the whole journey
  // would be about a permission the delegate in fact holds.
  await readerPage.goto(base);
  await expect(readerPage.getByTestId('participation-row')).toHaveCount(2);
  await expect(listenerCell(readerPage, 0)).toHaveText('—');
  const unfiltered = await readerPage.getByTestId('participation-row').count();

  await readerPage.goto(searched);

  await expect(readerPage.getByTestId('participation-search-note')).toBeVisible();
  await expect(readerPage.getByTestId('participation-search-note')).toContainText(
    'was not applied',
  );
  // The note names the term back, so the operator can see WHICH search was
  // dropped rather than being told that searching is unavailable in general.
  await expect(readerPage.getByTestId('participation-search-note')).toContainText(searchTerm);
  // Rendered disabled rather than dropped, and pointing at the sentence that
  // explains it.
  await expect(readerPage.getByTestId('participation-search-input')).toBeDisabled();
  await expect(readerPage.getByTestId('participation-search-input')).toHaveAttribute(
    'aria-describedby',
    'participation-search-note',
  );

  // The half that cannot be skipped. A screen that showed the note and still
  // forwarded the term would pass on the note alone, while displaying exactly
  // the empty "nobody matched" the whole decision exists to prevent — and the
  // manager's single row above is the proof that forwarding it WOULD empty this
  // list rather than leave it as it is.
  await expect(
    readerPage.getByTestId('participation-row'),
    'the term is dropped, so the list is every entry matching the other filters',
  ).toHaveCount(unfiltered);
  await expect(readerPage.getByTestId('page-total')).toHaveText('2 entries');

  await readerContext.close();
});

test('a Station chip and a page turn both beat a search still waiting to fire', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const context = await browser.newContext();
  const managerPage = await context.newPage();
  await managerPage.goto('/login');
  await managerPage.getByLabel('E-mail', { exact: true }).fill(managerEmail);
  await managerPage.getByLabel('Password', { exact: true }).fill(world.managerPassword);
  await managerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(managerPage).toHaveURL(/\/app$/);

  const searchInput = managerPage.getByTestId('participation-search-input');

  // --- the Station chip ------------------------------------------------------
  await managerPage.goto(`/participations?companyId=${world.stationAId}`);
  await expect(searchInput).toBeEnabled();

  // fill() dispatches ONE input event carrying the whole term, which is how the
  // stale-closure half of this defect was found in the first place: the
  // scheduled callback held the value from the render before the keystroke, so
  // it navigated with the EMPTY initial string and no q= at all. Here it is the
  // debounce that matters — the chip is clicked with the 350ms timer still
  // pending, which is the window the guard exists for. Nothing is awaited
  // between the two lines on purpose: the click has to land inside it.
  const clickedAt = Date.now();
  await searchInput.fill(brunoName);
  await managerPage.getByRole('link', { name: stationBName }).click();
  assertClickBeatTheDebounce(managerPage, clickedAt, 'the Station chip');

  await expect(managerPage).toHaveURL(`/participations?companyId=${world.stationBId}`);

  // Past the debounce, on purpose. Everything this case is about happens AFTER
  // 350ms: a timer that survived the navigation fires here, calls the navigate
  // it closed over, and replaces the Station the operator just picked with the
  // one they left plus the search they abandoned. A polling assertion cannot
  // express "and then nothing happened", so the wait is the assertion's subject
  // rather than a sleep hiding a race.
  await managerPage.waitForTimeout(700);

  await expect(
    managerPage,
    'a pending search must not reassert itself over the Station the operator picked',
  ).toHaveURL(`/participations?companyId=${world.stationBId}`);
  await expect(searchInput, 'and the input must agree with the URL it landed on').toHaveValue('');

  // --- the page turn ---------------------------------------------------------
  //
  // Its own case, and not a variation on the one above. Previous and Next
  // differ from the current address ONLY in the cursor, which is why the
  // address the guard compares carries one — and, before this was driven, it
  // was also the slowest destination on the screen and the one the old
  // commit-time guard never once beat: 0 of 6, where the chip managed 5.
  await managerPage.goto(
    `/participations?companyId=${world.stationAId}&promotion=${world.pagingPromotionId}&status=all`,
  );
  await expect(managerPage.getByTestId('participation-row')).toHaveCount(PARTICIPATION_PAGE_SIZE);
  await expect(managerPage.getByTestId('page-total')).toHaveText(`${PAGING_ENTRIES} entries`);

  const turnedAt = Date.now();
  await searchInput.fill(caioName);
  await managerPage.getByTestId('page-next').click();
  assertClickBeatTheDebounce(managerPage, turnedAt, 'the page turn');

  await expect(managerPage).toHaveURL(/[?&]after=/);
  await managerPage.waitForTimeout(700);

  await expect(managerPage, 'the page turn must stand').toHaveURL(/[?&]after=/);
  await expect(managerPage, 'and must not have acquired the abandoned search').not.toHaveURL(
    /[?&]q=/,
  );
  await expect(searchInput).toHaveValue('');
  // Really on the second page, rather than on a first page that kept its
  // cursor in the address: twenty-six entries, twenty-five to a page.
  await expect(managerPage.getByTestId('participation-row')).toHaveCount(
    PAGING_ENTRIES - PARTICIPATION_PAGE_SIZE,
  );

  await context.close();
});

/**
 * The fifth tab, driven by somebody who is NOT the owner.
 *
 * Journey 1 opens that tab as an Organization owner, who holds everything, so
 * every permission-conditional branch on it renders the same way and none of
 * them is under test. Delete `powers.participationsCreate` from the guard
 * around "Record an entry", or either explanatory note, and the whole suite
 * stayed green — on a tab whose entire job is to offer somebody exactly what
 * they may do.
 *
 * Two delegates, one permission apart at each step, so each assertion is about
 * one code rather than about a role:
 *
 *   - the READER holds participations.view and promotions.view. The counts are
 *     theirs to see; neither writing surface is.
 *   - PROMOTIONS ONLY holds promotions.view alone. Even the counts are refused,
 *     and the tab has to say that it is a count they may not read rather than
 *     render "0 in the draw" as a fact — which is the one failure mode a
 *     count-shaped hole cannot express by itself.
 *
 * Reached by URL rather than by clicking through the list, deliberately: that
 * is the `?record=&tab=` shape record-params.ts exists to support, and it is
 * how an operator arrives from a link somebody sent them.
 */
test('the fifth tab offers a delegate only what they hold, and names what it is not showing', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const recordUrl = `/promotions?companyId=${world.stationAId}&record=${world.listingPromotionId}&tab=participations`;

  // --- participations.view, and neither writing code -------------------------
  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  await readerPage.goto('/login');
  await readerPage.getByLabel('E-mail', { exact: true }).fill(readerEmail);
  await readerPage.getByLabel('Password', { exact: true }).fill(world.readerPassword);
  await readerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(readerPage).toHaveURL(/\/app$/);

  await readerPage.goto(recordUrl);

  // The counts arrive, which is what makes the two absences below absences and
  // not a tab that failed to render. Two of the three fixture entries counted.
  await expect(readerPage.getByTestId('promotion-participations-valid')).toHaveText('2');
  await expect(readerPage.getByTestId('promotion-participations-refused')).toHaveText('1');
  await expect(readerPage.getByTestId('promotion-participations-hidden')).toHaveCount(0);

  // Neither writing surface is offered, and the note that says why is on
  // screen. Both halves: a tab that hid the buttons and said nothing would look
  // to an operator exactly like a tab that had failed to load them.
  await expect(readerPage.getByTestId('promotion-participation-record-open')).toHaveCount(0);
  await expect(readerPage.getByTestId('promotion-participation-import-open')).toHaveCount(0);
  await expect(readerPage.getByText('neither participations.create nor')).toBeVisible();

  // The link out IS offered — it leads to a list this caller may read.
  await expect(readerPage.getByTestId('promotion-participations-link')).toBeVisible();
  // And the qualification on the two figures, which is the tab's own answer to
  // the fact that they are estimated above a thousand entries while the list
  // one click away counts exactly.
  await expect(readerPage.getByTestId('promotion-participations-note')).toContainText('estimates');

  await readerContext.close();

  // --- promotions.view alone: even the counts are refused --------------------
  const blindContext = await browser.newContext();
  const blindPage = await blindContext.newPage();
  await blindPage.goto('/login');
  await blindPage.getByLabel('E-mail', { exact: true }).fill(promotionsOnlyEmail);
  await blindPage.getByLabel('Password', { exact: true }).fill(world.promotionsOnlyPassword);
  await blindPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(blindPage).toHaveURL(/\/app$/);

  await blindPage.goto(recordUrl);

  // 0053's policy answers a caller without participations.view with no rows
  // rather than with an error, so the counts would BOTH read "0" — the screen
  // asserting as fact something it was refused. The tab says so instead.
  await expect(blindPage.getByTestId('promotion-participations-hidden')).toBeVisible();
  await expect(blindPage.getByTestId('promotion-participations-valid')).toHaveCount(0);
  await expect(blindPage.getByTestId('promotion-participations-refused')).toHaveCount(0);
  await expect(blindPage.getByTestId('promotion-participations-note')).toHaveCount(0);
  // No link out either: that screen would redirect them off it or open on a
  // different Station, so offering it is a promise this tab cannot keep.
  await expect(blindPage.getByTestId('promotion-participations-link')).toHaveCount(0);

  await blindContext.close();
});

/**
 * `?companyId=<A>&record=<a promotion at B>` — a stale or pasted link, not a
 * forged one.
 *
 * getPromotionRecord reads by id alone with no company filter, so the record
 * comes back and the dialog used to render it against Station A's timezone,
 * Station A's permissions, and Station A's list. The timezone is the one that
 * writes data: both writing surfaces on the fifth tab convert the operator's
 * wall clock to an instant with it, Brazil spans three zones, and the value
 * they would silently shift by an hour or two is the one design spec D7
 * measures the minimum interval against.
 *
 * The manager drives it because they hold promotions.view at BOTH Stations —
 * so the record genuinely IS readable to them, and the refusal below is about
 * the mismatch rather than about permission.
 */
test('a promotion opened under another Station is refused, with the way to open it properly', async ({
  browser,
}) => {
  test.setTimeout(60_000);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(managerEmail);
  await page.getByLabel('Password', { exact: true }).fill(world.managerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Station B in the address, a promotion that belongs to Station A.
  await page.goto(
    `/promotions?companyId=${world.stationBId}&record=${world.listingPromotionId}&tab=participations`,
  );

  await expect(page.getByTestId('promotion-record-elsewhere')).toBeVisible();
  // Nothing from the record is rendered under it — this is a refusal, not a
  // banner over a working dialog. The fifth tab in particular, since it is the
  // one carrying the two writing surfaces that would have used the wrong zone.
  await expect(page.getByTestId('promotion-participations-valid')).toHaveCount(0);
  await expect(page.getByTestId('promotion-tab-participations')).toHaveCount(0);
  await expect(page.getByTestId('promotion-save')).toHaveCount(0);

  // And the way out is one click, so the pasted link still works — it just goes
  // through the Station that owns the promotion.
  await page.getByTestId('promotion-record-elsewhere-link').click();
  await expect(page).toHaveURL(new RegExp(`companyId=${world.stationAId}`));
  await expect(page).toHaveURL(/tab=participations/);
  await expect(page.getByTestId('promotion-record-elsewhere')).toHaveCount(0);
  await expect(page.getByTestId('promotion-participations-valid')).toHaveText('2');

  await context.close();
});
