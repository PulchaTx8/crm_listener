import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';

/**
 * The whole audience journey through the real UI (Block 3, Task 10).
 *
 * An owner composes an "Audience Manager" role from the permission catalogue —
 * members.view, members.create, members.edit and members.block — deliberately
 * withholding members.erase, and assigns it to a delegate in one Station. That
 * delegate registers a listener, records the rules consent, blocks the
 * listener until a date, sees the block on both the detail page and the list,
 * and finds no way to erase — no heading, no form — because they were never
 * given that permission.
 *
 * A second delegate, holding the very same role but assigned at a SECOND
 * Station in the same Organization, cannot find that listener at all: not in
 * their own audience list, not by direct URL, and — the sharpest case — not
 * even through the registration desk's own duplicate check. Registering a new
 * listener with the first listener's exact phone number surfaces
 * find_member_by_identifier's 'elsewhere' outcome (0033_member_dedup.sql):
 * proof that someone in the Organization already holds that phone number,
 * without ever saying who or where. The panel this renders into
 * (register-member-form.tsx, data-testid="member-check-elsewhere") is
 * asserted on its rendered subtree text, not on the absence of one hand-picked
 * string, so a field added carelessly later — an id, a Station name, a count —
 * fails this test.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-members-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-members-admin-${stamp}-pw`;
const ownerEmail = `e2e-members-owner-${stamp}@example.test`;
// All-lowercase: createInvitationSchema (schemas/invitations.ts) lower-cases
// every invitation e-mail before it is stored, so a mixed-case literal here
// would be accepted at the invite step and then silently fail every
// `.eq('email', …)` profile lookup below it — caught by running this file
// once with capitals in these two addresses.
const delegateAEmail = `e2e-members-delegate-a-${stamp}@example.test`;
const delegateAPassword = `DelegateA-${stamp}-pw`;
const delegateBEmail = `e2e-members-delegate-b-${stamp}@example.test`;
const delegateBPassword = `DelegateB-${stamp}-pw`;
const orgName = `Members Org ${stamp}`;
const stationAName = `Members Station A ${stamp}`;
const stationBName = `Members Station B ${stamp}`;
const roleName = 'Audience Manager';
const listenerName = `Festival Listener ${stamp}`;
// Digits only, unique to this run — the same identifier both delegates act
// on: delegate A registers it, delegate B later tries to register the SAME
// phone number and must be told, without detail, that it already exists.
const listenerPhone = `5511${stamp}`;
const blockReason = `Missed the last three community draws (case ${stamp})`;
const createdUserIds: string[] = [];

// The one thing that must never appear in an 'elsewhere' answer's rendered
// text, in any of its three forms (Task-3/Task-9 review, carried into this
// journey by the Task 10 dispatch): an id, in this Organization always a
// uuid. Matched generically, not against the one memberId this run happens to
// mint, so a DIFFERENT id leaking (a company id, an audit log id) still fails
// this the same way.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

test('a delegate holding a scoped Audience Manager role runs the whole listener journey, and a delegate at another Station finds nothing', async ({
  page,
  browser,
}) => {
  // Two delegates, a role composed from scratch, a full registration +
  // consent + block round trip, and a duplicate check that must leak
  // nothing — measured at 25.5-32.5s in isolation, past the 30s default.
  // Sized to the work (~2x measured), not left at a round number: per-
  // assertion waits stay at Playwright's 5s default, and the two
  // network-bound steps that need longer already carry their own explicit
  // 15s overrides below.
  test.setTimeout(60_000);

  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(platformAdminEmail);
  await page.getByPlaceholder('Password').fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // Identity #1: the "Platform admin" role label and the Customers console
  // link only render for this identity (lib/auth/shell.ts) — asserting both
  // here, not just that /admin/customers happened to be reachable, is the
  // same pair inventory-flow.spec.ts checks for its own platform admin.
  await expect(page.getByText(platformAdminEmail)).toBeVisible();
  await expect(page.getByText('Platform admin')).toBeVisible();

  await page.getByRole('link', { name: 'Customers' }).click();
  await page.getByTestId('customer-create').click();
  await page.getByPlaceholder('Organization name').fill(orgName);
  await page.getByPlaceholder('Company (Station) name').fill(stationAName);
  await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
  await page.getByRole('button', { name: 'Provision' }).click();

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

  // --- a second Station, via a signed-in RPC call, not the console UI ------
  // add_company (0017) is platform-admin only — everyone reaching
  // /admin/customers already is one, the same fact roles-flow.spec.ts's own
  // "Add Station" step relies on — but driving that specific form through
  // the browser is not itself part of the members journey this spec exists
  // to prove, and it was the exact step this spec's own full-suite run
  // failed at under contention (Task 10 review, Important 3/minor 2).
  //
  // Not a raw service-role table insert: `companies` carries no INSERT grant
  // for service_role (this schema's default ACL, same as rate_limit_counters'
  // own comment describes — DML only where explicitly granted), and
  // add_company's own `is_platform_admin()` check reads auth.uid(), which is
  // null under the service-role JWT's own claims (no `sub`), so even calling
  // the RPC with the `admin` client would be refused. Signing in as the
  // already-provisioned platform admin and calling the RPC on THAT client
  // mirrors tests/isolation/harness.ts's own `addCompany` helper exactly
  // (`customer.adminClient.rpc('add_company', ...)`) — a real platform-admin
  // session, just not one driven through a browser page. `status` defaults
  // to 'active' (0003_identity_tenant.sql), so this Station is immediately
  // usable for the invite below.
  const { data: stationA, error: stationALookupError } = await admin
    .from('companies')
    .select('organization_id')
    .eq('name', stationAName)
    .single();
  expect(stationALookupError).toBeNull();
  if (!stationA) throw new Error(`no company row for ${stationAName}`);

  const platformAdminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: platformAdminSignInError } = await platformAdminClient.auth.signInWithPassword({
    email: platformAdminEmail,
    password: platformAdminPassword,
  });
  expect(platformAdminSignInError).toBeNull();

  const { error: stationBInsertError } = await platformAdminClient.rpc('add_company', {
    p_organization_id: stationA.organization_id,
    p_name: stationBName,
  });
  expect(stationBInsertError).toBeNull();

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

  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: 'Customers' })).toHaveCount(0);

  // --- the owner composes "Audience Manager" from the permission catalogue -
  await ownerPage.getByRole('link', { name: 'Roles' }).click();
  await expect(ownerPage).toHaveURL(/\/roles$/);

  // The test of whether the permission catalogue was built to be extended:
  // migration 0031 (Task 1 of this block) inserted these six rows into
  // `permissions`, and the role editor was never touched to know about
  // "members" as a module — not when it was role-form.tsx, and not when Block
  // 3c moved it into role-record-dialog.tsx. Each label is read straight out
  // of that migration's `label` column, not paraphrased.
  await ownerPage.getByTestId('role-create').click();
  await ownerPage.getByRole('tab', { name: 'Powers' }).click();
  const catalogueLabels = [
    'See the audience and their history', // members.view
    'Register a listener and link them to this Station', // members.create
    'Edit a listener, record consent and add notes', // members.edit
    'Bar a listener from draws, or suspend them', // members.block
    'Archive a listener', // members.archive
    "Erase a listener's personal data permanently", // members.erase
  ];
  for (const label of catalogueLabels) {
    await expect(ownerPage.getByLabel(label)).toBeVisible();
  }

  await ownerPage.getByLabel('See the audience and their history').check();
  await ownerPage.getByLabel('Register a listener and link them to this Station').check();
  await ownerPage.getByLabel('Edit a listener, record consent and add notes').check();
  await ownerPage.getByLabel('Bar a listener from draws, or suspend them').check();
  // Deliberately left unchecked: "Archive a listener" (members.archive) and
  // "Erase a listener's personal data permanently" (members.erase). The
  // whole point of this role, and of the absence assertions later in this
  // test, is that its holders cannot erase.
  await ownerPage.getByRole('tab', { name: 'Role data' }).click();
  await ownerPage.getByLabel('Name').fill(roleName);
  await ownerPage.getByTestId('role-save').click();

  const roleRow = ownerPage.locator('[data-testid="role-row"]', { hasText: roleName });
  await expect(roleRow).toBeVisible();
  await expect(roleRow.getByText('held by 0 user(s)')).toBeVisible();

  // --- the owner assigns it to delegate A, in Station A only ---------------
  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/team$/);

  await ownerPage.getByTestId('team-invite').click();
  const inviteForm = ownerPage.locator('form', {
    has: ownerPage.getByPlaceholder("Colleague's e-mail"),
  });
  await inviteForm.getByPlaceholder("Colleague's e-mail").fill(delegateAEmail);
  await inviteForm.getByRole('combobox').selectOption({ label: roleName });
  await inviteForm.getByLabel(stationAName).check();
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

  const linkBoxA = ownerPage.locator('code').first();
  await expect(linkBoxA).toBeVisible({ timeout: 15_000 });
  const acceptUrlA = (await linkBoxA.innerText()).trim();
  expect(acceptUrlA).toContain('/invite/');

  // --- the owner assigns the SAME role to delegate B, in Station B only ----
  // Reloaded first: the invite form above is an uncontrolled checkbox list,
  // and Station A's box was just checked and submitted — a stale DOM would
  // carry that checked state into this second invitation. The reload also
  // closes the invite dialog, which is deliberately left open on success so
  // that the accept link above cannot be lost.
  await ownerPage.reload();
  await expect(ownerPage).toHaveURL(/\/team$/);

  await ownerPage.getByTestId('team-invite').click();
  const inviteFormAgain = ownerPage.locator('form', {
    has: ownerPage.getByPlaceholder("Colleague's e-mail"),
  });
  await inviteFormAgain.getByPlaceholder("Colleague's e-mail").fill(delegateBEmail);
  await inviteFormAgain.getByRole('combobox').selectOption({ label: roleName });
  await inviteFormAgain.getByLabel(stationBName).check();
  await inviteFormAgain.getByRole('button', { name: 'Send invitation' }).click();

  const linkBoxB = ownerPage.locator('code').first();
  await expect(linkBoxB).toBeVisible({ timeout: 15_000 });
  const acceptUrlB = (await linkBoxB.innerText()).trim();
  expect(acceptUrlB).toContain('/invite/');

  // --- delegate A accepts and signs in --------------------------------------
  const delegateAContext = await browser.newContext();
  const delegateAPage = await delegateAContext.newPage();

  await delegateAPage.goto(acceptUrlA);
  await expect(delegateAPage.getByRole('heading', { name: `Join ${orgName}` })).toBeVisible();
  await delegateAPage.getByPlaceholder('Choose a password').fill(delegateAPassword);
  await delegateAPage.getByPlaceholder('Repeat the password').fill(delegateAPassword);
  await delegateAPage.getByRole('button', { name: 'Create my account' }).click();
  await expect(delegateAPage).toHaveURL(/\/login/);

  const { data: delegateAProfile, error: delegateALookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', delegateAEmail)
    .single();
  expect(delegateALookupError).toBeNull();
  if (!delegateAProfile) throw new Error(`no profile row for ${delegateAEmail}`);
  createdUserIds.push(delegateAProfile.id);

  await delegateAPage.getByPlaceholder('E-mail').fill(delegateAEmail);
  await delegateAPage.getByPlaceholder('Password').fill(delegateAPassword);
  await delegateAPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(delegateAPage).toHaveURL(/\/app$/);

  // Identity actually switched: delegate A's own e-mail is visible, the
  // owner's is nowhere, and exactly Station A (not Station B) is reachable.
  await expect(delegateAPage.getByText(delegateAEmail)).toBeVisible();
  await expect(delegateAPage.getByText(ownerEmail)).toHaveCount(0);
  await expect(delegateAPage.locator('[data-testid="station-card"]')).toHaveCount(1);
  await expect(
    delegateAPage.locator('[data-testid="station-card"]', { hasText: stationAName }),
  ).toBeVisible();

  // --- delegate A registers a listener --------------------------------------
  await delegateAPage.getByRole('link', { name: 'Members' }).click();
  await expect(delegateAPage).toHaveURL(/\/members$/);

  // Rendered only because delegate A holds members.create — a courtesy gate,
  // not the boundary (create_member re-checks its own permission), but its
  // presence is what lets the rest of this step use the real form.
  const checkForm = delegateAPage.locator('[data-testid="member-check-form"]');
  await expect(checkForm).toBeVisible();
  await checkForm.getByLabel('Phone').fill(listenerPhone);
  await checkForm.getByRole('button', { name: 'Check for an existing listener' }).click();

  const registerForm = delegateAPage.locator('[data-testid="register-member-form"]');
  await expect(registerForm).toBeVisible();
  await registerForm.getByLabel('Name').fill(listenerName);
  await registerForm.getByRole('button', { name: 'Register listener' }).click();
  await expect(registerForm.getByText('Registered.')).toBeVisible();

  await registerForm.getByRole('link', { name: 'View listener' }).click();
  await expect(delegateAPage).toHaveURL(/\/members\/[0-9a-f-]+$/);
  const memberId = delegateAPage.url().split('/members/')[1];
  if (!memberId) throw new Error('could not read the listener id off the URL');

  await expect(delegateAPage.getByRole('heading', { name: listenerName })).toBeVisible();

  // --- records the rules consent --------------------------------------------
  // Every default on this form already matches the brief: the one Station
  // delegate A can reach, consent type "rules", granted. Nothing to change.
  const consentForm = delegateAPage.locator('[data-testid="consent-form"]');
  await expect(consentForm).toBeVisible();
  await consentForm.getByRole('button', { name: 'Record consent' }).click();
  await expect(consentForm.getByText('Consent recorded.')).toBeVisible();

  // --- blocks them until a date ---------------------------------------------
  const blockForm = delegateAPage.locator('[data-testid="block-form"]');
  await expect(blockForm).toBeVisible();
  await blockForm.getByLabel('Reason').fill(blockReason);
  // A direct data-testid locator, not getByLabel('Ends'): that label also
  // wraps a long sibling help paragraph ("Leave blank for an indefinite
  // block…"), which the accessible-name computation folds into the same
  // label text — a substring match would likely still resolve correctly, but
  // there is no reason to depend on that when the input carries its own
  // unambiguous test id. Not `input[name="endsAt"]` any more (whole-branch
  // review, C1): the visible datetime-local input carries no `name` at all
  // now — block-form.tsx converts its naive, offset-less value to an ISO
  // instant in the browser and carries THAT in a hidden `endsAt` field, so a
  // naive wall-clock string is never sent to the server to be parsed in the
  // wrong zone. `.fill()` on the visible input still drives this correctly:
  // it dispatches a real `input` event, which React's `onChange` picks up
  // and mirrors into the hidden field before this form ever submits.
  await blockForm.locator('[data-testid="block-ends-at-input"]').fill(futureDateTimeLocal());
  await blockForm.getByRole('button', { name: 'Block this listener' }).click();
  await expect(blockForm.getByText('Block recorded.')).toBeVisible();

  // The block is reflected on this same page without a reload — the same
  // revalidatePath('/members/[id]') mechanism inventory-flow.spec.ts relies
  // on for its own movement rows.
  await expect(delegateAPage.locator('[data-testid="member-blocked-banner"]')).toBeVisible();
  const blockRow = delegateAPage.locator('[data-testid="member-block-row"]', {
    hasText: 'Barred from draws',
  });
  await expect(blockRow).toBeVisible();
  await expect(blockRow.getByText(blockReason)).toBeVisible();
  // "blocks them until a date," not merely "a block exists": the row renders
  // either "until <date>" or ", no end date set" (BLOCK_KIND_LABELS' sibling
  // text, [memberId]/page.tsx:353-356), distinguishing a dated block from an
  // indefinite one. Without this, endsAt being dropped between the action
  // and block_member's p_ends_at — or the RPC ignoring it — would still
  // produce a block matching every assertion above (Task 10 review,
  // Important 2).
  await expect(blockRow).toContainText('until');

  // --- finds no way to erase --------------------------------------------------
  // The Audience Manager role never held members.erase. The "Erase personal
  // data" card — its heading AND its underlying form — both live behind
  // canErase in [memberId]/page.tsx (memberReachable(..., 'members.erase',
  // ...)). Either assertion below fails the instant that card renders for
  // this delegate: a courtesy gate that quietly stopped gating.
  await expect(
    delegateAPage.getByRole('heading', { name: 'Erase personal data' }),
  ).toHaveCount(0);
  await expect(delegateAPage.locator('[data-testid="erase-member-form"]')).toHaveCount(0);

  // --- the block is visible on the list, not only the detail page ----------
  await delegateAPage.getByRole('link', { name: 'Back to members' }).click();
  await expect(delegateAPage).toHaveURL(/\/members$/);
  const listenerRow = delegateAPage.locator('[data-testid="member-row"]', {
    hasText: listenerName,
  });
  await expect(listenerRow).toBeVisible();
  await expect(listenerRow.locator('[data-testid="member-blocked-badge"]')).toBeVisible();

  // --- delegate B accepts and signs in, at the OTHER Station ----------------
  const delegateBContext = await browser.newContext();
  const delegateBPage = await delegateBContext.newPage();

  await delegateBPage.goto(acceptUrlB);
  await expect(delegateBPage.getByRole('heading', { name: `Join ${orgName}` })).toBeVisible();
  await delegateBPage.getByPlaceholder('Choose a password').fill(delegateBPassword);
  await delegateBPage.getByPlaceholder('Repeat the password').fill(delegateBPassword);
  await delegateBPage.getByRole('button', { name: 'Create my account' }).click();
  await expect(delegateBPage).toHaveURL(/\/login/);

  const { data: delegateBProfile, error: delegateBLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', delegateBEmail)
    .single();
  expect(delegateBLookupError).toBeNull();
  if (!delegateBProfile) throw new Error(`no profile row for ${delegateBEmail}`);
  createdUserIds.push(delegateBProfile.id);

  await delegateBPage.getByPlaceholder('E-mail').fill(delegateBEmail);
  await delegateBPage.getByPlaceholder('Password').fill(delegateBPassword);
  await delegateBPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(delegateBPage).toHaveURL(/\/app$/);

  // Identity actually switched, and to the OTHER Station: delegate B's own
  // e-mail is visible, nobody else's is, and exactly Station B (not Station
  // A) is reachable — the crux of the isolation this second half of the
  // journey exists to prove.
  await expect(delegateBPage.getByText(delegateBEmail)).toBeVisible();
  await expect(delegateBPage.getByText(ownerEmail)).toHaveCount(0);
  await expect(delegateBPage.getByText(delegateAEmail)).toHaveCount(0);
  await expect(delegateBPage.locator('[data-testid="station-card"]')).toHaveCount(1);
  await expect(
    delegateBPage.locator('[data-testid="station-card"]', { hasText: stationBName }),
  ).toBeVisible();
  await expect(
    delegateBPage.locator('[data-testid="station-card"]', { hasText: stationAName }),
  ).toHaveCount(0);

  // --- delegate B cannot find the listener at all ---------------------------
  await delegateBPage.getByRole('link', { name: 'Members' }).click();
  await expect(delegateBPage).toHaveURL(/\/members$/);
  // members_select_reachable (0035) filters this listener's row out of the
  // very query behind this list — not a client-side hide — so with no other
  // Member registered anywhere delegate B can reach, the list is empty.
  await expect(
    delegateBPage.getByText('No listener registered yet at a Station you can reach.'),
  ).toBeVisible();
  await expect(delegateBPage.locator('[data-testid="member-row"]')).toHaveCount(0);

  // Direct URL, not only the list: the same RLS policy makes getMember
  // return null for this id under delegate B's session, which
  // [memberId]/page.tsx renders as "not found" rather than leaking that the
  // row exists but is out of reach.
  await delegateBPage.goto(`/members/${memberId}`);
  await expect(delegateBPage.getByRole('heading', { name: 'Listener not found' })).toBeVisible();
  await delegateBPage.getByRole('link', { name: 'Back to members' }).click();
  await expect(delegateBPage).toHaveURL(/\/members$/);

  // --- the sharpest case: the registration desk's own duplicate check ------
  // Delegate B registers a DIFFERENT listener, entering the SAME phone
  // number delegate A's listener already carries. find_member_by_identifier
  // (0033) must answer 'elsewhere': someone in this Organization holds this
  // phone number, and delegate B may not see who or where.
  const checkFormB = delegateBPage.locator('[data-testid="member-check-form"]');
  await expect(checkFormB).toBeVisible();
  await checkFormB.getByLabel('Phone').fill(listenerPhone);
  await checkFormB.getByRole('button', { name: 'Check for an existing listener' }).click();

  const elsewherePanel = delegateBPage.locator('[data-testid="member-check-elsewhere"]');
  await expect(elsewherePanel).toBeVisible();
  // The registration step never opens for this outcome — showRegistrationStep
  // (register-member-form.tsx) is gated on outcome === 'none' specifically.
  await expect(delegateBPage.locator('[data-testid="register-member-form"]')).toHaveCount(0);

  // The falsifiable core of this journey: find_member_by_identifier's
  // 'elsewhere' branch returns existence and NOTHING else (0033's own
  // comment: "no id, no name, no Station name, no count"). Asserted against
  // the panel's whole rendered text, not the absence of one hand-picked
  // string, so a field added carelessly later — this member's own id, either
  // Station's name, or a count of anything — fails this test the same way a
  // deliberate leak would.
  const elsewhereText = await elsewherePanel.innerText();
  expect(elsewhereText).not.toMatch(UUID_PATTERN);
  expect(elsewhereText).not.toContain(stationAName);
  expect(elsewhereText).not.toContain(stationBName);
  // "Who" — a name — is exactly what 0033 says must never leak. Checked
  // BEFORE the digit catch-all below, not after: listenerName ends in the
  // same `${stamp}` run that dominates the two stationName checks above, and
  // listenerPhone is entirely digits, so both are equally dominated by
  // `/[0-9]/` — neither is "independent, non-overlapping" coverage (an
  // earlier version of both this comment and the task report claimed
  // otherwise; Task 10 re-review). Ordering these two ahead of the digit
  // check has no effect on what this test can catch, only on which
  // assertion reports first: a real name/phone leak now fails here, with a
  // message that names the defect ("the listener's name leaked into the
  // elsewhere panel"), instead of failing one line down with a message that
  // only names the symptom ("a digit appeared").
  expect(elsewhereText).not.toContain(listenerName);
  expect(elsewhereText).not.toContain(listenerPhone);
  // No digit at all: the panel's copy is static prose with no dynamic value
  // in it today, so a stray digit of any kind — a count, a fragment of an
  // id, a fragment of the very phone number delegate B just typed — is
  // exactly the class of regression this line exists to catch. Both
  // stationName checks above AND both listenerName/listenerPhone checks
  // above are currently dominated by this one, since every one of those four
  // values ends in or consists of `${stamp}` — none of the five checks in
  // this block are independent of this line today. They stay for
  // documentation of intent, and for the ordering benefit noted above, but
  // this line is what actually guards against an undominated leak (e.g. a
  // Station name that happened not to embed a digit).
  expect(elsewhereText).not.toMatch(/[0-9]/);

  // innerText() cannot see an id sitting in an attribute — href, title,
  // data-*, aria-label — only in rendered text. The single most likely real
  // regression is someone copying the adjacent 'visible' branch's
  // `<Link href={\`/members/${checkState.memberId}\`}>View this listener
  // </Link>` (register-member-form.tsx:199-204) into this panel: its
  // rendered text ("View this listener") contains no UUID, no digit, no
  // Station name, and every assertion above would still pass while the
  // member id sits one hover away in the href. Checked against the raw HTML
  // specifically to close that gap (Task 10 review, Important 1).
  const elsewhereHtml = await elsewherePanel.innerHTML();
  expect(elsewhereHtml).not.toMatch(UUID_PATTERN);

  await delegateBContext.close();
  await delegateAContext.close();
  await ownerContext.close();
});

/**
 * A datetime-local input value roughly two years out — far enough that no
 * plausible test run duration or clock skew crosses it, close enough to
 * remain a legible "until a date" rather than a magic distant constant. Local
 * wall-clock components, matching what a <input type="datetime-local"> value
 * actually represents; this journey never asserts the exact rendered date,
 * only that a block with an end date shows up, so the input's own timezone
 * interpretation is not load-bearing here.
 */
function futureDateTimeLocal(): string {
  const d = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
