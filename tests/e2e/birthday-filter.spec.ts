import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';
import { openNavSection } from './nav';

/**
 * Block 30b, D2/D3, through a real browser.
 *
 * The risk this journey exists to catch is not "the filter finds nobody" — it
 * is the opposite: an EMPTY page that looks like a true answer. Merging the
 * two branches of the window predicate into one `between` turns 20 December
 * to 5 January into `birth_md >= 1220 and birth_md <= 105`, which no row can
 * satisfy, and "nobody has a birthday between Christmas and Epiphany" reads as
 * data rather than as a bug.
 *
 * So this asserts a THREE-WAY split, not "somebody came back": the two
 * end-of-year listeners present, and the July one absent. The two presence
 * checks alone already fail under the empty-page defect above; the July
 * check adds a separate guarantee — that the filter is actually narrowing,
 * rather than a defect leaving it a no-op that shows the whole audience.
 *
 * WHAT THIS ONE WINDOW CANNOT PROVE, and does not claim to: a predicate that
 * dropped the branch on direction entirely and always used `.or()` computes
 * the SAME query as the correct code for a genuine wrap like this one — the
 * correct predicate for `from > to` already is `.or()` (services/members.ts).
 * That collapse only misbehaves on a window that does NOT wrap, which is why
 * tests/isolation/members.test.ts's `finds birthdays across new year, and
 * only those` carries a second, non-wrapping sub-case (July's own range) that
 * this single-window journey does not repeat.
 *
 * Fixtures are seeded through the real RPC on a signed-in client rather than
 * clicked through the registration screen, for the reason filtered-draw.spec.ts
 * gives for its own fixtures: registering a listener by hand is Block 3's
 * screen to prove, and three trips through the check-then-register flow in
 * front of this would make it fail for reasons that have nothing to do with
 * the birthday window.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-birthday-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-birthday-admin-${stamp}-pw`;
const ownerEmail = `e2e-birthday-owner-${stamp}@example.test`;
const ownerPassword = `Owner-birthday-${stamp}-provisional`;
const ownerFinalPassword = `Owner-birthday-${stamp}-chosen`;

// Three names, none a substring of another, so `hasText` cannot match the
// wrong listener's row.
const NYE_NAME = `Birthday NYE ${stamp}`;
const JAN_NAME = `Birthday Jan ${stamp}`;
const JUL_NAME = `Birthday Jul ${stamp}`;

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
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
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
    organizationName: `Birthday Org ${stamp}`,
    companyName: `Birthday Station ${stamp}`,
  });

  const owner = await signIn(ownerEmail, ownerPassword);

  // 31 December (1231), 5 January (105) and 4 July (704) — the same three
  // shapes the spec's own probe and the isolation test use: two either side
  // of the turn of the year, one squarely outside any window that crosses it.
  const listeners: [name: string, birthDate: string][] = [
    [NYE_NAME, '1990-12-31'],
    [JAN_NAME, '1988-01-05'],
    [JUL_NAME, '1979-07-04'],
  ];
  for (const [name, birthDate] of listeners) {
    const member = await owner.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: name,
      p_birth_date: birthDate,
    });
    if (member.error) {
      throw new Error(`create_member failed for ${name}: ${member.error.message}`);
    }
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a birthday window crossing new year finds the two listeners either side of it, and only those', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // provision_customer marks the owner's password provisional, so the first
  // sign-in lands on the change-password screen — the same step
  // filtered-draw.spec.ts takes for the same reason.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await openNavSection(page, 'Audience');
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page).toHaveURL(/\/members$/);

  const rowFor = (name: string) => page.locator('[data-testid="member-row"]', { hasText: name });

  // The whole audience, before any filter is applied — proof the three
  // listeners actually landed, so a later absence reads as the filter
  // narrowing rather than as the seed having failed.
  await expect(rowFor(NYE_NAME)).toBeVisible();
  await expect(rowFor(JAN_NAME)).toBeVisible();
  await expect(rowFor(JUL_NAME)).toBeVisible();

  await page.getByTestId('member-date-mode').selectOption('birthday');
  // This wait is synchronisation, not a workaround for a defect that is still
  // live: selectOption() dispatches the change event and returns before React
  // has necessarily committed the re-render it triggers, so the boxes below
  // could still show the previous label for one tick. Filling them before the
  // relabel lands is exactly the sequence that used to submit
  // startOfLocalDay/endOfLocalDay instants instead of the MM-DD slice
  // birthday mode uses, and drop dates=birthday from the URL — a real race in
  // members-filters.tsx, not a test artifact: the mode selector starts a
  // router.replace() round trip, and until it lands, state.dateMode (a SERVER
  // prop) still says 'registered', which is what both date boxes' onChange
  // used to read. Fixed by holding the mode in local state resynced from the
  // prop by effect (members-filters.tsx), the same shape fromDay/toDay
  // already had, so the boxes and this label now update with the click rather
  // than with the round trip. This wait now closes over React's own render
  // commit rather than the network, but it is real synchronisation either way
  // and stays for that reason.
  await expect(page.getByText('Birthdays from')).toBeVisible();

  // The year is a fixed placeholder the box renders against (members-filters.tsx,
  // birthdayDayInput) and is sliced off before it reaches the URL — only the
  // month and day travel. Each fill is followed by its own URL wait, for the
  // same reason as above: the second box's onChange also reads this
  // component's props, and firing it before the first box's navigation has
  // landed would read a state that does not yet carry `bfrom`, dropping it
  // from the URL the second navigation writes.
  await page.getByTestId('member-date-from').fill('2000-12-20');
  await expect(page).toHaveURL(/bfrom=12-20/);

  await page.getByTestId('member-date-to').fill('2000-01-05');
  await expect(page).toHaveURL(/bto=01-05/);
  // Both ends of the window survived the second navigation, not just the one
  // it just set.
  await expect(page).toHaveURL(/bfrom=12-20/);
  await expect(page).toHaveURL(/dates=birthday/);

  // THE ASSERTION THE WHOLE BLOCK TURNS ON, per D2/D3: merging the two
  // branches into one `between(from, to)` is unsatisfiable for this window
  // (1220..105) and returns an EMPTY page — which the two `toBeVisible`
  // checks below already catch on their own, since an empty page fails both.
  // The July check adds a different guarantee: that the window still
  // narrows, rather than a defect leaving the filter a no-op that shows
  // everyone. See this file's header comment for the one thing this single
  // window cannot prove on its own, and where that proof actually lives.
  await expect(rowFor(NYE_NAME)).toBeVisible();
  await expect(rowFor(JAN_NAME)).toBeVisible();
  await expect(rowFor(JUL_NAME)).toHaveCount(0);

  const urlBeforeRefresh = page.url();
  await page.getByTestId('refresh').click();

  // The filter survived, and so did the page: the same three-way result, and
  // an unchanged URL — router.refresh() re-runs the Server Component for the
  // current route without touching the address bar (refresh-button.tsx).
  await expect(rowFor(NYE_NAME)).toBeVisible();
  await expect(rowFor(JAN_NAME)).toBeVisible();
  await expect(rowFor(JUL_NAME)).toHaveCount(0);
  expect(page.url()).toBe(urlBeforeRefresh);
});
