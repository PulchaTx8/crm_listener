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
 * Block 28. The geography panel, end to end, WITH NO MAP KEY.
 *
 * That is not a limitation of the suite — it is the path this journey exists to
 * prove. Design D6 says a deployment without `NEXT_PUBLIC_GOOGLE_MAPS_KEY` gets
 * the ranked tables and the coverage line unchanged, plus one muted line saying
 * the map is not configured. That is the state every deployment is in until
 * somebody buys a key, so it is the state most likely to ship, and it is the one
 * a test can assert without spending real quota on every CI run.
 *
 * THE SHARPEST ASSERTION IS THE NEGATIVE ONE: no request to maps.googleapis.com
 * was made. Without it "the map is not configured" is a sentence on a page, and
 * a page can print that sentence while a client component quietly loads the
 * library anyway — which is exactly what a key gate is supposed to prevent and
 * exactly what nothing else here would notice.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-geo-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-geo-admin-${stamp}-pw`;
const ownerEmail = `e2e-geo-owner-${stamp}@example.test`;
const ownerPassword = `Owner-geo-${stamp}-provisional`;
const ownerFinalPassword = `Owner-geo-${stamp}-chosen`;

const CITY = 'São Luís';
const COHAB = 'Cohab';
const CENTRO = 'Centro';

const createdUserIds: string[] = [];
let companyId = '';

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser(${email}) failed: ${error?.message}`);
  createdUserIds.push(data.user.id);
  // The profile row too. auth.admin.createUser writes only to auth.users, and
  // provision_organization refuses a user with no profile — the same pair
  // dashboards.spec.ts's own helper makes, for the same reason.
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`profile insert for ${email} failed: ${profileError.message}`);
  return data.user.id;
}

async function signIn(email: string, password: string) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign in failed for ${email}: ${error.message}`);
  return client;
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(platformAdminEmail, platformAdminPassword);
  const { error: promoteError } = await admin
    .from('platform_admins')
    .insert({ user_id: adminUserId });
  if (promoteError) throw new Error(`platform_admins insert failed: ${promoteError.message}`);

  const adminClient = await signIn(platformAdminEmail, platformAdminPassword);
  const ownerUserId = await createAuthUser(ownerEmail, ownerPassword);
  const { company_id } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: `Geo Org ${stamp}`,
    companyName: `Geo Station ${stamp}`,
  });
  companyId = company_id;

  // THREE LISTENERS IN TWO NEIGHBOURHOODS OF ONE CITY, and one with no address
  // at all. The uneven split is the fixture: two-in-Cohab and one-in-Centro is
  // what makes the ranking assertion below say something a list of equals could
  // not, and the placeless fourth is what makes the coverage line's two numbers
  // differ — without it "3 of 3" would be true and would prove nothing.
  const ownerClient = await signIn(ownerEmail, ownerPassword);
  const listeners: [string, string | null][] = [
    [`Cohab One ${stamp}`, COHAB],
    [`Cohab Two ${stamp}`, COHAB],
    [`Centro One ${stamp}`, CENTRO],
    [`No Address ${stamp}`, null],
  ];
  const memberIds: string[] = [];
  for (const [fullName, neighbourhood] of listeners) {
    const { data, error } = await ownerClient.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: fullName,
      ...(neighbourhood
        ? { p_city: CITY, p_state: 'MA', p_neighbourhood: neighbourhood, p_country: 'BR' }
        : {}),
    });
    if (error) throw new Error(`create_member(${fullName}) failed: ${error.message}`);
    if (!data) throw new Error(`create_member(${fullName}) returned no id`);
    memberIds.push(data as unknown as string);
  }

  // BLOCK 30e, item 19. One entry per listener, the placeless one included: the
  // promotions map counts ENTRIES, so its coverage line reads three of four for
  // the same reason the audience one does — and if it counted only the entries
  // it could place, both numbers would be three and the line would prove nothing.
  const promotion = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: `Geo Promo ${stamp}`,
    p_starts_at: new Date(Date.now() - 86_400_000).toISOString(),
    p_ends_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);

  for (const memberId of memberIds) {
    const { error } = await ownerClient.rpc('record_participation', {
      p_promotion_id: promotion.data as unknown as string,
      p_member_id: memberId,
      p_participated_at: new Date().toISOString(),
      p_source: 'MANUAL',
    });
    if (error) throw new Error(`record_participation failed: ${error.message}`);
  }

  // The worker's own two steps, through the service role because that is who
  // the worker is. Nothing here is under test; without it every place is queued
  // and unresolved, and the panel would legitimately render its empty state.
  const { error: sweepError } = await admin.rpc('enqueue_missing_places', { p_limit: 1000 });
  if (sweepError) throw new Error(`enqueue_missing_places failed: ${sweepError.message}`);

  const { data: claimed, error: claimError } = await admin.rpc('claim_places_to_geocode', {
    p_limit: 200,
  });
  if (claimError) throw new Error(`claim_places_to_geocode failed: ${claimError.message}`);

  for (const place of claimed ?? []) {
    const { error } = await admin.rpc('record_place_geocode', {
      p_id: place.id,
      p_latitude: -2.53,
      p_longitude: -44.31,
      p_precision: 'neighbourhood',
    });
    if (error) throw new Error(`record_place_geocode failed: ${error.message}`);
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('the geography panels: the tables and the coverage lines stand without a map key, and nothing reaches Google', async ({
  page,
}) => {
  // Watched from before the first navigation, so a request made during the
  // initial render is caught too.
  const googleRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('maps.googleapis.com') || request.url().includes('maps.gstatic.com')) {
      googleRequests.push(request.url());
    }
  });

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await openNavSection(page, 'Dashboards');
  await page.getByRole('link', { name: 'Audience overview' }).click();
  await expect(page).toHaveURL(/\/dashboards\/audience/);

  const panel = page.getByTestId('geography-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // THE COVERAGE LINE NAMES BOTH NUMBERS. Three of the four listeners have an
  // address; the fourth has none. A panel that printed only "3" would imply
  // that is everybody, which is the reading this line exists to prevent.
  await expect(page.getByTestId('geography-coverage')).toContainText('3 of 4');

  // The neighbourhood table lists the seeded places, in the order their counts
  // put them: Cohab has two listeners and Centro one.
  const neighbourhoods = page.getByTestId('geography-by-neighbourhood');
  await expect(neighbourhoods).toContainText(COHAB);
  await expect(neighbourhoods).toContainText(CENTRO);
  const rows = await neighbourhoods.getByRole('row').allInnerTexts();
  const cohabRow = rows.findIndex((row) => row.includes(COHAB));
  const centroRow = rows.findIndex((row) => row.includes(CENTRO));
  expect(cohabRow).toBeGreaterThan(-1);
  // Ranked, not merely present: two beats one, so Cohab is above Centro.
  expect(cohabRow).toBeLessThan(centroRow);

  await expect(page.getByTestId('geography-by-city')).toContainText(CITY);

  // The degraded path says so, out loud, and the map is absent rather than
  // broken.
  await expect(page.getByTestId('map-not-configured')).toBeVisible();
  await expect(page.getByTestId('place-map')).toHaveCount(0);

  // BLOCK 30e, ITEM 19. The same panel on the Promotions overview, counting a
  // different population.
  await page.goto('/dashboards/promotions');
  await expect(page.getByTestId('geography-panel')).toBeVisible({ timeout: 30_000 });

  // D11's noun, on the screen. Four entries were made and three came from a
  // listener with an address, so the line reads the same two numbers the audience
  // panel does — which is exactly why the WORD has to differ: a map of entries
  // under a sentence about listeners would be the disagreement D12b exists to
  // prevent, wearing the right numbers.
  await expect(page.getByTestId('geography-coverage')).toContainText('3 of 4');
  await expect(page.getByTestId('geography-coverage')).toContainText('entries');

  // The promotion most played in a place, which is what this map has instead of
  // the music panel's most-requested song.
  await expect(page.getByTestId('geography-top-promotions')).toContainText(`Geo Promo ${stamp}`);
  await expect(page.getByTestId('map-not-configured')).toBeVisible();
  await expect(page.getByTestId('place-map')).toHaveCount(0);

  // THE CLAIM THAT THE KEY GATE ACTUALLY GATES, now over both panels. Everything
  // above is satisfied by a page that prints the right words while loading the
  // library anyway.
  expect(googleRequests).toEqual([]);
});
