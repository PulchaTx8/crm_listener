import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * Block 8a's round trip (Task 10): the branches that live only in the three
 * dashboard pages, which lint and typecheck cannot reach and which the pgTAP
 * suite (20_dashboards.test.sql) and the isolation suite (tests/isolation/
 * dashboards.test.ts) do not exercise either — both run against the RPCs
 * directly, never against a rendered screen.
 *
 * FIXTURE SETUP IS RPC-ONLY, DELIBERATELY. Every other journey in this
 * directory drives its OWN feature through the browser (inventory-flow
 * registers a prize because prizes are what it proves); the feature this file
 * proves is how the three dashboard pages RENDER permission and period
 * branches, not how a listener, a prize or a promotion gets created — those
 * are members-flow.spec.ts's, inventory-flow.spec.ts's and
 * promotions-flow.spec.ts's jobs. So every listener, role, invitation and
 * participation below is created directly through the same RPCs
 * tests/isolation/harness.ts calls (create_member, create_role,
 * create_invitation + accept_invitation, assign_company_role, create_prize,
 * record_stock_entry, create_promotion, link_prize_to_promotion,
 * record_participation), signed in as the owner, who bypasses has_permission
 * for their own Organization (0024) the same way every other e2e fixture in
 * this codebase already leans on. The five Playwright `page`s below are spent
 * entirely on what only a rendered screen can prove: a card, a chart, a nav
 * link, a redirect, a hand-crafted URL.
 *
 * ONE Organization, FIVE Stations, so each scenario gets its own uncontaminated
 * population without re-provisioning a customer five times over:
 *   - RT: the round trip's known figures (three listeners, created "now").
 *   - WH: the withheld figure (a listener, and a real participation the
 *     delegate below is never granted participations.view to see).
 *   - SW: the Station-search scenarios (one delegate who can reach it, one who
 *     cannot reach ANY Station at all).
 *   - TZA / TZB: two different timezones, for the consolidated toggle and the
 *     mixed-timezone note — America/Sao_Paulo and America/New_York share no
 *     digit of their offset on any date this suite could run.
 *
 * THE CUSTOM-RANGE PERSISTENCE CASE, READ BEFORE THE CODE BELOW: 0117's
 * `custom` branch takes p_from/p_to verbatim, for any Station or any
 * consolidated set — the comparison window is the only thing it derives, the
 * chosen window itself is never recomputed. That means switching Station or
 * toggling consolidated while custom is active can never make the payload's
 * OWN `period.from`/`period.to` differ from what was already on screen, so
 * this file cannot prove that period-control.tsx's resync effect picks up a
 * genuinely DIFFERENT value from a sibling control's navigation. What it does
 * prove, and what the component's own header comment actually promises, is
 * the concrete regression this codebase has paid for before
 * (station-switch.ts's own history, and members-filters.tsx's near-identical
 * resync): that a custom range typed by the operator SURVIVES a Station
 * switch or a consolidated toggle unchanged — not blanked, not silently
 * reverted to a default, not left disagreeing with the "Custom range" pill's
 * own active state.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`could not create a profile for ${email}: ${profileError.message}`);
  return data.user.id;
}

async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

/**
 * create_invitation (as the owner) + accept_invitation (as service_role, the
 * one grant that function carries — 0018) — the exact pair
 * harness.ts#addMemberByInvitation calls, skipping only the browser's own
 * /invite/<token> form, which members-flow.spec.ts and inventory-flow.spec.ts
 * already prove works. The auth user is created (with a password THIS file
 * chooses) before accept_invitation runs, the same order harness.ts uses and
 * for the same reason: create_invitation refuses an address that already has
 * an account, so the invitation has to exist first.
 */
async function inviteAndAccept(
  ownerClient: SupabaseClient,
  organizationId: string,
  email: string,
  password: string,
  roleId: string,
  companyIds: string[],
): Promise<string> {
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
  if (inviteError) throw new Error(`create_invitation(${email}) failed: ${inviteError.message}`);

  const userId = await createAuthUser(email, password);
  const { error: acceptError } = await admin.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: userId,
  });
  if (acceptError) throw new Error(`accept_invitation(${email}) failed: ${acceptError.message}`);
  return userId;
}

const platformAdminEmail = `e2e-dash-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-dash-admin-${stamp}-pw`;
const ownerEmail = `e2e-dash-owner-${stamp}@example.test`;
const ownerInitialPassword = `Owner-${stamp}-initial`;
const ownerChosenPassword = `Owner-${stamp}-chosen`;

const stationRTName = `Dash RT Station ${stamp}`;
const stationWHName = `Dash WH Station ${stamp}`;
const stationSWName = `Dash Search Station ${stamp}`;
const stationTZAName = `Dash TZA Station ${stamp}`;
const stationTZBName = `Dash TZB Station ${stamp}`;

const listenerNames = [`RT Listener One ${stamp}`, `RT Listener Two ${stamp}`, `RT Listener Three ${stamp}`];

const delegateWithheldEmail = `e2e-dash-withheld-${stamp}@example.test`;
const delegateWithheldPassword = `Withheld-${stamp}-pw`;
const delegateSearchEmail = `e2e-dash-search-${stamp}@example.test`;
const delegateSearchPassword = `Search-${stamp}-pw`;
const delegateOutsiderEmail = `e2e-dash-outsider-${stamp}@example.test`;
const delegateOutsiderPassword = `Outsider-${stamp}-pw`;
const delegateConsolidatedEmail = `e2e-dash-consolidated-${stamp}@example.test`;
const delegateConsolidatedPassword = `Consolidated-${stamp}-pw`;
const delegateWeakEmail = `e2e-dash-weak-${stamp}@example.test`;
const delegateWeakPassword = `Weak-${stamp}-pw`;

const noMatchTerm = `zz-no-such-station-${stamp}`;

let stationTZA = '';
let stationTZB = '';

test.beforeAll(async () => {
  // --- the platform admin, and the owner's Organization + first Station ----
  const adminUserId = await createAuthUser(platformAdminEmail, platformAdminPassword);
  const { error: adminFlagError } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (adminFlagError) throw new Error(`could not mark the platform admin: ${adminFlagError.message}`);
  const platformAdminClient = await signInAs(platformAdminEmail, platformAdminPassword);

  const ownerUserId = await createAuthUser(ownerEmail, ownerInitialPassword);
  const { data: provisioned, error: provisionError } = await platformAdminClient.rpc('provision_customer', {
    p_user_id: ownerUserId,
    p_organization_name: `Dash Org ${stamp}`,
    p_company_name: stationRTName,
    p_timezone: 'America/Sao_Paulo',
  });
  if (provisionError) throw new Error(`provision_customer failed: ${provisionError.message}`);
  const { organization_id: organizationId, company_id: stationRT } = provisioned as {
    organization_id: string;
    company_id: string;
  };

  async function addCompany(name: string, timezone: string): Promise<string> {
    const { data, error } = await platformAdminClient.rpc('add_company', {
      p_organization_id: organizationId,
      p_name: name,
      p_timezone: timezone,
    });
    if (error) throw new Error(`add_company(${name}) failed: ${error.message}`);
    return data as string;
  }

  const stationWH = await addCompany(stationWHName, 'America/Sao_Paulo');
  const stationSW = await addCompany(stationSWName, 'America/Sao_Paulo');
  stationTZA = await addCompany(stationTZAName, 'America/Sao_Paulo');
  stationTZB = await addCompany(stationTZBName, 'America/New_York');

  // provision_customer signs the owner in with a KNOWN password (chosen by
  // this file, unlike the UI's own "Provision" action, which generates and
  // reveals one) — must_change_password is still set true by that RPC
  // regardless of how the password was chosen (0016), which is exactly what
  // Test 1 below exercises through the real screen. It gates the Next.js
  // middleware only, not a Postgres session, so calling RPCs directly on this
  // client for pure fixture setup is unaffected by it — the same reasoning
  // tests/isolation/harness.ts#provisionCustomer already relies on.
  const ownerClient = await signInAs(ownerEmail, ownerInitialPassword);

  async function createRole(name: string, permissionCodes: string[]): Promise<string> {
    const { data, error } = await ownerClient.rpc('create_role', {
      p_organization_id: organizationId,
      p_name: name,
      p_permission_codes: permissionCodes,
    });
    if (error) throw new Error(`create_role(${name}) failed: ${error.message}`);
    return data as string;
  }

  const roleFull = await createRole(`Full ${stamp}`, ['members.view', 'reports.consolidated']);
  const roleViewOnly = await createRole(`ViewOnly ${stamp}`, ['members.view']);
  const roleOutsider = await createRole(`Outsider ${stamp}`, ['music.view']);

  await inviteAndAccept(
    ownerClient,
    organizationId,
    delegateWithheldEmail,
    delegateWithheldPassword,
    roleViewOnly,
    [stationWH],
  );
  await inviteAndAccept(
    ownerClient,
    organizationId,
    delegateSearchEmail,
    delegateSearchPassword,
    roleViewOnly,
    [stationSW],
  );
  await inviteAndAccept(
    ownerClient,
    organizationId,
    delegateOutsiderEmail,
    delegateOutsiderPassword,
    roleOutsider,
    [stationSW],
  );
  await inviteAndAccept(
    ownerClient,
    organizationId,
    delegateConsolidatedEmail,
    delegateConsolidatedPassword,
    roleFull,
    [stationTZA, stationTZB],
  );
  const weakUserId = await inviteAndAccept(
    ownerClient,
    organizationId,
    delegateWeakEmail,
    delegateWeakPassword,
    roleFull,
    [stationTZA],
  );
  // The weak delegate's SECOND Station, deliberately at a WEAKER role: this is
  // what Block 1a's assign_company_role (rather than a second invitation, which
  // create_invitation refuses for an address already holding an account) is
  // for — the same pair tests/isolation/dashboards.test.ts's own Case 2 calls.
  const { error: weakAssignError } = await ownerClient.rpc('assign_company_role', {
    p_company_id: stationTZB,
    p_user_id: weakUserId,
    p_role_id: roleViewOnly,
  });
  if (weakAssignError) throw new Error(`assign_company_role(weak) failed: ${weakAssignError.message}`);

  // --- the round trip's three listeners, at Station RT, created just now ----
  async function createMember(companyId: string, fullName: string): Promise<string> {
    const { data, error } = await ownerClient.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: fullName,
    });
    if (error) throw new Error(`create_member(${fullName}) failed: ${error.message}`);
    return data as string;
  }

  for (const name of listenerNames) await createMember(stationRT, name);

  // --- the withheld fixture, at Station WH: a real listener AND a real ------
  // participation, so a regression that quietly zeroed took_part instead of
  // withholding it would be WRONG, not merely unconvincing (the same reasoning
  // tests/isolation/dashboards.test.ts's seedParticipationAndWinner gives).
  const whMemberId = await createMember(stationWH, `WH Listener ${stamp}`);

  const { data: prizeId, error: prizeError } = await ownerClient.rpc('create_prize', {
    p_company_id: stationWH,
    p_name: `WH Prize ${stamp}`,
  });
  if (prizeError) throw new Error(`create_prize failed: ${prizeError.message}`);

  const { error: stockError } = await ownerClient.rpc('record_stock_entry', {
    p_company_id: stationWH,
    p_prize_id: prizeId,
    p_type: 'MANUAL_ENTRY',
    p_quantity: 1,
  });
  if (stockError) throw new Error(`record_stock_entry failed: ${stockError.message}`);

  const DAY = 24 * 60 * 60 * 1000;
  const { data: promotionId, error: promotionError } = await ownerClient.rpc('create_promotion', {
    p_company_id: stationWH,
    p_name: `WH Promo ${stamp}`,
    p_starts_at: new Date(Date.now() - 2 * DAY).toISOString(),
    p_ends_at: new Date(Date.now() + 20 * DAY).toISOString(),
  });
  if (promotionError) throw new Error(`create_promotion failed: ${promotionError.message}`);

  const { error: linkError } = await ownerClient.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prizeId,
    p_quantity: 1,
  });
  if (linkError) throw new Error(`link_prize_to_promotion failed: ${linkError.message}`);

  const { error: participationError } = await ownerClient.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: whMemberId,
    p_participated_at: new Date().toISOString(),
    p_source: 'MANUAL',
    p_answers: [],
  });
  if (participationError) throw new Error(`record_participation failed: ${participationError.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('the round trip: a known figure, the period switch that changes it, a rendered chart, and the nav link', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(ownerEmail);
  await page.getByPlaceholder('Password').fill(ownerInitialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // provision_customer sets must_change_password (0016) regardless of how the
  // password was chosen — the trap Block 5a's own handoff describes, cleared
  // here through the real screen.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerChosenPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerChosenPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // The nav link, reachable: Dashboards > Audience is a real <Link>; the
  // OTHER "Audience" text on this sidebar (the section heading above Members
  // and Participations) is a plain <p> — sidebar-nav.tsx never makes a
  // section label a link — so this is unambiguous despite the visual
  // duplication Task 9 flagged.
  await page.getByRole('link', { name: 'Audience' }).click();
  await expect(page).toHaveURL(/\/dashboards\/audience$/);

  // The owner reaches all five Stations this file provisions; pin to RT
  // explicitly rather than trust which one sorts first alphabetically.
  await page.getByRole('link', { name: stationRTName }).click();

  // dashboard-card-<key>'s DOM order is fixed by DashboardCards/WithheldFigure:
  // CardDescription's label paragraph first, then the value paragraph — so
  // the value is always the SECOND <p>, real or withheld alike.
  const listenersCard = page.getByTestId('dashboard-card-listeners');
  await expect(listenersCard.locator('p').nth(1)).toHaveText(listenerNames.length.toString());

  await expect(page.getByTestId('chart-monthly-bars')).toBeVisible();

  // Switching to the previous month moves BOTH windows entirely before every
  // listener above was linked (all three were created moments ago, by this
  // very setup): the stock figure this card shows, measured as of that
  // window's own end (D6), must read zero.
  await page
    .getByTestId('period-control')
    .getByRole('link', { name: 'Previous month' })
    .click();
  await expect(listenersCard.locator('p').nth(1)).toHaveText('0');
});

test('a caller missing participations.view sees the permission named beside real numbers, never a zero', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(delegateWithheldEmail);
  await page.getByPlaceholder('Password').fill(delegateWithheldPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole('link', { name: 'Audience' }).click();
  await expect(page).toHaveURL(/\/dashboards\/audience$/);

  // A real number for a card this role's members.view genuinely supports.
  const listenersCard = page.getByTestId('dashboard-card-listeners');
  await expect(listenersCard.locator('p').nth(1)).toHaveText('1');

  // A genuine zero (nobody was ever barred here) — no em dash, no permission
  // name — the contrast D13 depends on: "no data" must not render like
  // "not permitted", in either direction.
  const barredCard = page.getByTestId('dashboard-card-barred');
  await expect(barredCard.locator('p').nth(1)).toHaveText('0');
  await expect(barredCard.getByText('participations.view')).toHaveCount(0);

  // The withheld figure itself: a real participation was recorded for this
  // very Station in beforeAll, so a regression that zeroed this instead of
  // withholding it would show "0" here — wrong, not merely unconvincing.
  const tookPartCard = page.getByTestId('dashboard-card-took_part');
  await expect(tookPartCard.locator('p').nth(1)).toHaveText('—');
  await expect(tookPartCard.getByText('participations.view')).toBeVisible();
});

test('a Station search matching nothing is not the same screen as holding the permission nowhere', async ({
  page,
  browser,
}) => {
  // --- a real Station, searched into oblivion -------------------------------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(delegateSearchEmail);
  await page.getByPlaceholder('Password').fill(delegateSearchPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto(`/dashboards/audience?station=${encodeURIComponent(noMatchTerm)}`);
  await expect(page).toHaveURL(/\/dashboards\/audience/);
  const noMatch = page.getByText(/No Station you can reach matches/);
  await expect(noMatch).toBeVisible();
  await expect(noMatch).toContainText(noMatchTerm);
  // Not the redirect branch: still on this page, with no dashboard rendered.
  await expect(page.getByTestId('dashboard-cards')).toHaveCount(0);

  await page.getByRole('link', { name: 'Clear the Station search' }).click();
  await expect(page).toHaveURL(/\/dashboards\/audience$/);
  await expect(page.getByTestId('dashboard-cards')).toBeVisible();

  // --- members.view held NOWHERE at all: the other branch, at the same page -
  const outsiderContext = await browser.newContext();
  const outsiderPage = await outsiderContext.newPage();
  await outsiderPage.goto('/login');
  await outsiderPage.getByPlaceholder('E-mail').fill(delegateOutsiderEmail);
  await outsiderPage.getByPlaceholder('Password').fill(delegateOutsiderPassword);
  await outsiderPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(outsiderPage).toHaveURL(/\/app$/);

  // No `station=` this time: `if (!first) redirect('/app')` fires, not the
  // no-match branch above — the two are reachable at the SAME page and are
  // now told apart by URL alone.
  await outsiderPage.goto('/dashboards/audience');
  await expect(outsiderPage).toHaveURL(/\/app$/);

  await outsiderContext.close();
});

test('the consolidated toggle: gated per Station, absent when ineligible, never satisfied by a hand-crafted URL — and the custom range that survives a sibling control', async ({
  page,
  browser,
}) => {
  // --- eligible: the toggle renders, and the note follows the choice --------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(delegateConsolidatedEmail);
  await page.getByPlaceholder('Password').fill(delegateConsolidatedPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole('link', { name: 'Audience' }).click();
  await expect(page).toHaveURL(/\/dashboards\/audience$/);
  await page.getByRole('link', { name: stationTZAName }).click();

  const toggle = page.getByTestId('consolidated-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId('mixed-timezone-note')).toHaveCount(0);

  await toggle.getByRole('link', { name: /All stations/ }).click();
  await expect(page.getByTestId('mixed-timezone-note')).toBeVisible();

  await toggle.getByRole('link', { name: 'This station' }).click();
  await expect(page.getByTestId('mixed-timezone-note')).toHaveCount(0);

  // --- the custom range survives a sibling control's navigation -------------
  const periodControl = page.getByTestId('period-control');
  await periodControl.getByRole('link', { name: 'Custom range' }).click();
  const fromInput = page.getByTestId('period-from');
  const toInput = page.getByTestId('period-to');
  await expect(fromInput).toBeVisible();

  await fromInput.fill('2020-01-01');
  await expect(page).toHaveURL(/from=2020-01-01/);
  await toInput.fill('2020-02-01');
  await expect(page).toHaveURL(/to=2020-02-01/);

  // A DIFFERENT control (the Station pill, not period-control's own inputs)
  // navigates while custom is active — see this file's header for what this
  // can and cannot prove given 0117's own semantics.
  await page.getByRole('link', { name: stationTZBName }).click();
  await expect(page).toHaveURL(/from=2020-01-01/);
  await expect(page).toHaveURL(/to=2020-02-01/);
  await expect(fromInput).toHaveValue('2020-01-01');
  await expect(toInput).toHaveValue('2020-02-01');
  await expect(periodControl.getByRole('link', { name: 'Custom range' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // A SECOND different control — the consolidated toggle itself.
  await page.getByTestId('consolidated-toggle').getByRole('link', { name: /All stations/ }).click();
  await expect(page).toHaveURL(/from=2020-01-01/);
  await expect(fromInput).toHaveValue('2020-01-01');
  await expect(toInput).toHaveValue('2020-02-01');

  // --- the same two Stations, one grant short: not eligible, and never -----
  // satisfied by asking anyway.
  const weakContext = await browser.newContext();
  const weakPage = await weakContext.newPage();
  await weakPage.goto('/login');
  await weakPage.getByPlaceholder('E-mail').fill(delegateWeakEmail);
  await weakPage.getByPlaceholder('Password').fill(delegateWeakPassword);
  await weakPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(weakPage).toHaveURL(/\/app$/);

  await weakPage.goto('/dashboards/audience');
  // Both Stations are reachable (members.view holds in both) — the switcher
  // itself renders — but reports.consolidated holds only in TZA, so the
  // toggle specifically must not.
  await expect(weakPage.getByRole('link', { name: stationTZAName })).toBeVisible();
  await expect(weakPage.getByRole('link', { name: stationTZBName })).toBeVisible();
  await expect(weakPage.getByTestId('consolidated-toggle')).toHaveCount(0);

  // The hand-crafted URL the toggle never offered: both Stations are valid
  // (members.view holds in each), so this reaches the RPC, which refuses with
  // 42501 because reports.consolidated does not hold in TZB — never narrowed
  // to TZA alone, never a payload of zeros.
  await weakPage.goto(`/dashboards/audience?companyId=${stationTZA}&companyId=${stationTZB}`);
  await expect(
    weakPage.getByText('You do not have permission to see this dashboard in every station selected.'),
  ).toBeVisible();
  await expect(weakPage.getByTestId('dashboard-cards')).toHaveCount(0);

  await weakContext.close();
});
