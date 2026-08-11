import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';

/**
 * Block 18's whole journey: an operator reaches Programmes from the sidebar,
 * registers one with two bands — ONE OF THEM OVERNIGHT — reads it back
 * unchanged, and ends it rather than deleting it.
 *
 * THE ROUND TRIP IS THE POINT, and it is the one thing no other test proves.
 * pgTAP proves save_show splits a band crossing midnight into two rows on two
 * days; the unit suite proves toBands puts such rows back together. Only this
 * proves that what the operator TYPED is what the operator READS, through the
 * real form, the real door and the real screen — and the split is invisible
 * from either end, which is exactly the kind of thing that survives two green
 * suites and still shows the wrong hours.
 *
 * Sign-in preamble copied from music-catalogue.spec.ts, and simplified the same
 * way: provision_customer's owner bypass (has_permission, 0024) grants an
 * Organization's owner every permission in every active Company of that
 * Organization, music.manage included, with no role to compose.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-shows-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-shows-admin-${stamp}-pw`;
const ownerEmail = `e2e-shows-owner-${stamp}@example.test`;
const orgName = `Shows Org ${stamp}`;
const stationName = `Shows Station ${stamp}`;
const showName = `Madrugada ${stamp}`;
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

test('an operator registers a programme with an overnight band and reads it back unchanged', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail,
  });

  const { data: ownerProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', ownerEmail)
    .single();
  if (!ownerProfile) throw new Error(`no profile row for ${ownerEmail}`);
  createdUserIds.push(ownerProfile.id);

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

  // --- Programmes, reached from the sidebar under Audiência ----------------
  await ownerPage.getByRole('link', { name: 'Programmes' }).click();
  await expect(ownerPage).toHaveURL(/\/shows/);
  await expect(ownerPage.getByTestId('shows-empty')).toBeVisible();

  await ownerPage.getByTestId('show-add').click();
  await ownerPage.getByTestId('show-name').fill(showName);
  await ownerPage.getByTestId('show-kind').selectOption('MUSICAL');
  await ownerPage.getByTestId('show-age-rating').selectOption('16');
  await ownerPage.getByTestId('show-presenter').fill('Quem fica acordado');
  await ownerPage.getByTestId('show-starts-on').fill('2026-01-01');

  // Band one: an ordinary weekday morning.
  await ownerPage.getByTestId('show-band-add').click();
  for (const day of [1, 2, 3, 4, 5]) {
    await ownerPage.getByTestId(`show-band-0-day-${day}`).check();
  }
  await ownerPage.getByTestId('show-band-0-starts').fill('10:00');
  await ownerPage.getByTestId('show-band-0-ends').fill('12:30');

  // Band two: SATURDAY NIGHT INTO SUNDAY. The end is earlier than the start,
  // which the editor accepts and labels rather than refusing.
  await ownerPage.getByTestId('show-band-add').click();
  await ownerPage.getByTestId('show-band-1-day-6').check();
  await ownerPage.getByTestId('show-band-1-starts').fill('23:00');
  await ownerPage.getByTestId('show-band-1-ends').fill('02:00');
  await expect(ownerPage.getByTestId('show-band-1-overnight')).toBeVisible();

  await ownerPage.getByTestId('show-save').click();
  await expect(ownerPage.getByTestId('show-row')).toBeVisible({ timeout: 30_000 });
  // The register dialog closes itself once the row it produced is on the list.
  await expect(ownerPage.getByTestId('show-dialog')).toBeHidden();

  // THE DATABASE SPLIT IT. Six rows for a five-day band plus a night that
  // covers two days, all under two markers.
  const { data: station } = await admin
    .from('companies')
    .select('id')
    .eq('name', stationName)
    .single();
  const { data: rows } = await admin
    .from('show_schedules')
    .select('band,weekday,starts_at,ends_at,shows!inner(name)')
    .eq('company_id', station?.id ?? '');

  expect(rows?.length, 'five weekday rows plus the two halves of one night').toBe(7);
  expect(rows?.filter((r) => r.ends_at === '24:00:00').length, 'the head of the night').toBe(1);
  expect(rows?.filter((r) => r.starts_at === '00:00:00').length, 'its tail on the next day').toBe(1);

  // THE OPERATOR READS BACK WHAT THEY TYPED. The split is bookkeeping and must
  // never surface: reopening shows 23:00–02:00 on Saturday, not 23:00–24:00
  // and a second band on Sunday.
  await ownerPage.reload();
  await ownerPage.getByTestId('show-edit').first().click();
  // The record opens OVER the list rather than navigating: the address gains
  // the record, and the table behind it is still there.
  await expect(ownerPage).toHaveURL(/record=/);
  await expect(ownerPage.getByTestId('shows-table')).toBeVisible();
  await expect(ownerPage.getByTestId('show-band-1-starts')).toHaveValue('23:00');
  await expect(ownerPage.getByTestId('show-band-1-ends')).toHaveValue('02:00');
  await expect(ownerPage.getByTestId('show-band-1-day-6')).toBeChecked();
  await expect(ownerPage.getByTestId('show-band-1-day-7')).not.toBeChecked();

  // Closing takes the record out of the address without leaving the page, and
  // without reloading the list underneath.
  await ownerPage.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(ownerPage.getByTestId('show-dialog')).toBeHidden();
  await expect(ownerPage).not.toHaveURL(/record=/);

  // --- ended, not deleted (D8) ---------------------------------------------
  // Encerrar lives in the row's own menu, where every other list here keeps its
  // retiring action.
  await ownerPage.getByRole('button', { name: `Actions for ${showName}` }).click();
  await ownerPage.getByTestId('show-end').click();
  await ownerPage.getByTestId('show-end-date').fill('2026-01-31');
  await ownerPage.getByTestId('show-end-confirm').click();
  await expect(ownerPage.getByTestId('show-ended')).toBeVisible({ timeout: 30_000 });

  // The row is still there, with its schedule intact — which is the whole
  // reason ending exists rather than deleting.
  const { data: ended } = await admin
    .from('shows')
    .select('ends_on,deleted_at')
    .eq('name', showName)
    .single();

  expect(ended?.ends_on).toBe('2026-01-31');
  expect(ended?.deleted_at, 'ending is not deleting').toBeNull();

  const { data: survivingRows } = await admin
    .from('show_schedules')
    .select('band')
    .eq('company_id', station?.id ?? '');
  expect(survivingRows?.length, 'the schedule outlives the programme going off air').toBe(7);

  // Hidden by default, reachable through the filter — which navigates on the
  // tick rather than waiting for a Filter button.
  await ownerPage.goto('/shows');
  await expect(ownerPage.getByTestId('shows-empty')).toBeVisible();
  await ownerPage.getByTestId('shows-include-ended').check();
  await expect(ownerPage.getByTestId('show-row')).toBeVisible({ timeout: 30_000 });

  // A second filter narrows the first rather than replacing it: the kind
  // changes and the ended tick survives. The GET form this replaced could not
  // do that — it carried only the parameters somebody remembered to hide in it.
  await ownerPage.getByTestId('shows-kind-filter').selectOption('NEWS');
  await expect(ownerPage.getByTestId('shows-empty')).toBeVisible({ timeout: 30_000 });
  await ownerPage.getByTestId('shows-kind-filter').selectOption('MUSICAL');
  await expect(ownerPage.getByTestId('show-row')).toBeVisible({ timeout: 30_000 });

  // A PASTED ADDRESS OPENS THE SAME RECORD. Nothing on this page put the row in
  // memory, so this is the read path rather than the row the dialog was opened
  // from — the half that used to be impossible when the form was inline.
  const { data: registered } = await admin.from('shows').select('id').eq('name', showName).single();
  await ownerPage.goto(`/shows?record=${registered?.id ?? ''}`);
  await expect(ownerPage.getByTestId('show-name')).toHaveValue(showName, { timeout: 30_000 });

  await ownerContext.close();
});
