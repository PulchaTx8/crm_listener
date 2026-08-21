import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 30e, item 18, through a real browser.
 *
 * THE RISK THIS EXISTS TO CATCH is a filter that looks like it narrowed. Two
 * shapes of that, and each has its own assertion below:
 *
 *   1. A window derived wrongly — off by the Station's offset, or open at the
 *      end — still returns SOME rows, and a list with rows in it reads as an
 *      answer. So the fixture puts one entry INSIDE the band and one OUTSIDE it
 *      on the same day, and the assertion is a two-way split rather than "a row
 *      came back".
 *   2. A day the Programme does not air. There the danger is the opposite: no
 *      window at all is not "no filter", and a screen that quietly widened to
 *      the whole day would also hand the DRAW everyone who entered that day.
 *      So the Sunday case asserts an empty list, the explanation beside it, AND
 *      that the draw is not offered.
 *
 * The third assertion is D10 itself: the hat the draw offers counts the band,
 * not the promotion. That is not visible anywhere on the screen the filter
 * changes, which is exactly why it is driven here.
 *
 * The Station's zone is pinned to America/Sao_Paulo and the two entries are
 * stamped with explicit -03:00 offsets — Brazil has run no daylight saving
 * since 2019, so those instants are unambiguous. The conversion itself is
 * proven without a browser in tests/unit/programme-window.test.ts; what this
 * journey adds is that the screen, the door and the RPC agree about it.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-band-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-band-admin-${stamp}-pw`;
const ownerEmail = `e2e-band-owner-${stamp}@example.test`;
const ownerPassword = `Owner-band-${stamp}-provisional`;
const ownerFinalPassword = `Owner-band-${stamp}-chosen`;

const PROGRAMME_NAME = `Manha Total ${stamp}`;
const PROMOTION_NAME = `Promo com programa ${stamp}`;
/** Neither name is a substring of the other, so `hasText` cannot match the wrong row. */
const INSIDE_NAME = `Ouvinte dentro ${stamp}`;
const OUTSIDE_NAME = `Ouvinte fora ${stamp}`;

/** A Monday, and the Sunday of the same week — the Programme airs Monday to Friday. */
const MONDAY = '2026-08-17';
const SUNDAY = '2026-08-23';

const createdUserIds: string[] = [];
let companyId = '';

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
  const provisioned = await provisionCustomer(adminClient, {
    userId: ownerId,
    organizationName: `Band Org ${stamp}`,
    companyName: `Band Station ${stamp}`,
  });
  companyId = provisioned.company_id;

  // Pinned rather than assumed: every instant below is written with an explicit
  // -03:00 offset, and a Station in another zone would make the band cover
  // different entries than the ones this journey names.
  await admin.from('companies').update({ timezone: 'America/Sao_Paulo' }).eq('id', companyId);

  const owner = await signIn(ownerEmail, ownerPassword);

  // EVERY WRITE BELOW GOES THROUGH ITS OWN DOOR, because no table in this schema
  // takes an insert grant from any role, service_role included (0044's own
  // comment). The owner holds every permission in the Organization they own
  // (has_permission's owner bypass, 0024), so one signed-in client is enough.
  //
  // The Programme: Monday to Friday, 10:00-12:30, written as ONE band the way an
  // operator would type it — save_show is what expands it into five rows.
  const show = await owner.rpc('save_show', {
    p_company_id: companyId,
    p_name: PROGRAMME_NAME,
    p_kind: 'MUSICAL',
    p_age_rating: 'L',
    p_starts_on: '2026-01-01',
    p_bands: [{ days: [1, 2, 3, 4, 5], starts: '10:00', ends: '12:30' }],
  });
  if (show.error) throw new Error(`save_show failed: ${show.error.message}`);

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: PROMOTION_NAME,
    p_starts_at: '2026-01-01T00:00:00-03:00',
    p_ends_at: '2026-12-31T23:59:59-03:00',
    p_show_id: show.data as string,
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);

  const entries: [name: string, at: string][] = [
    // 11:00 on the Monday: inside 10:00-12:30.
    [INSIDE_NAME, `${MONDAY}T11:00:00-03:00`],
    // 15:00 the same day: the same promotion, the same listener population, and
    // outside the band. This is the row a wrongly derived window keeps.
    [OUTSIDE_NAME, `${MONDAY}T15:00:00-03:00`],
  ];

  for (const [name, at] of entries) {
    const member = await owner.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: name,
    });
    if (member.error) throw new Error(`create_member failed for ${name}: ${member.error.message}`);

    const recorded = await owner.rpc('record_participation', {
      p_promotion_id: promotion.data as string,
      p_member_id: member.data as string,
      p_participated_at: at,
      p_source: 'MANUAL',
    });
    if (recorded.error) {
      throw new Error(`record_participation failed for ${name}: ${recorded.error.message}`);
    }
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a promotion with a Programme is filtered by day and band, and the draw inherits that window', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // provision_customer marks the owner's password provisional, so the first
  // sign-in lands on the change-password screen.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto('/participations');
  const rowFor = (name: string) =>
    page.locator('[data-testid="participation-row"]', { hasText: name });

  // Both entries are there before any Programme narrowing — so a later absence
  // reads as the band filtering rather than as the seed having failed.
  await expect(rowFor(INSIDE_NAME)).toBeVisible({ timeout: 30_000 });
  await expect(rowFor(OUTSIDE_NAME)).toBeVisible();

  await page.getByTestId('participation-promotion-filter').selectOption({ label: PROMOTION_NAME });

  // ITEM 18's first sentence, on the screen: with a Programme the second instant
  // is gone, because the band's own end IS the end and a control that could
  // contradict it would be a way to.
  await expect(page.getByTestId('participation-day-filter')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('participation-to-filter')).toHaveCount(0);

  await page.getByTestId('participation-day-filter').fill(MONDAY);
  await expect(page).toHaveURL(new RegExp(`day=${MONDAY}`), { timeout: 30_000 });

  // The band the Programme airs that day, offered by name.
  await expect(page.getByTestId('participation-band-filter')).toBeVisible();
  await expect(page.getByTestId('participation-band-filter')).toContainText('10:00');

  // THE TWO-WAY SPLIT. One entry inside the band, one outside it, on the same
  // day and in the same promotion: a window off by the Station's offset, or one
  // left open at its end, keeps the 15:00 row.
  await expect(rowFor(INSIDE_NAME)).toBeVisible();
  await expect(rowFor(OUTSIDE_NAME)).toHaveCount(0);

  // D10, and the reason it is driven here: the hat is built from the same filter
  // state the list was rendered from, so the band narrows the DRAW as well —
  // and that is invisible on the screen the filter changes.
  await page.getByTestId('open-draw-panel').click();
  await expect(page.getByTestId('draw-hat-summary')).toContainText('1', { timeout: 30_000 });
  await page.getByTestId('close-draw-panel').click();

  // D9. A day the Programme does not air is a window with nothing in it, not the
  // absence of a filter: the list is empty, the screen says why, and the draw is
  // not offered at all — a hat built with no window would hold the whole
  // promotion, which is the fail-open shape this project keeps finding.
  await page.getByTestId('participation-day-filter').fill(SUNDAY);
  await expect(page).toHaveURL(new RegExp(`day=${SUNDAY}`), { timeout: 30_000 });
  await expect(page.getByTestId('participation-programme-silent')).toBeVisible();
  await expect(page.getByTestId('participation-row')).toHaveCount(0);
  await expect(page.getByTestId('participations-draw')).toHaveCount(0);
});
