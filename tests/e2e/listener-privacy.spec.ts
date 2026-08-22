import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 30a, end to end. Pickups stopped sending a listener's whole telephone
 * number to the browser and gained a shared, audited listener card; this is
 * the one journey that walks all of it: the masked list, the card that reveals
 * one field on request, and Hand over showing what is being handed over before
 * it delivers.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE ONE ON THE HTML, not on a locator.
 * `list_pickups` (0095, narrowed by 0254) could regress by returning
 * `member_phone_last4` correctly while ALSO still projecting the old
 * `member_phone` column — every UI assertion here would keep passing, reading
 * off the masked field exactly as before, while the whole number sat in the
 * page's initial HTML the whole time. Checking the served document for the
 * seeded number is what a future "restore the column" cannot pass silently.
 *
 * Seeded through the real RPCs on the owner's own session, the way every
 * pickups/participations spec in this suite does (delivery-flow.spec.ts's own
 * comment): Block 1a leaves the tenant tables read-only for service_role on
 * purpose, so there is no shortcut, and going the long way means the seeding
 * path is the production path. The owner drives the whole journey directly —
 * the owner's bypass (has_permission, 0024) grants every permission in every
 * active Company of the Organization, promotions.view and members.view
 * included, with no role to compose.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-privacy-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-privacy-admin-${stamp}-pw`;
const ownerEmail = `e2e-privacy-owner-${stamp}@example.test`;
const ownerPassword = `Owner-privacy-${stamp}-provisional`;
const ownerFinalPassword = `Owner-privacy-${stamp}-chosen`;
const prizeName = `Privacy Prize ${stamp}`;
const promotionName = `Privacy Promo ${stamp}`;
const listenerName = `Privacy Listener ${stamp}`;
// Whole and distinctive: eleven digits, unlikely to turn up as a substring of
// anything else this page renders (an id, a count, a date), which is what
// makes the "not in the HTML" assertion below mean something.
const listenerPhone = `1195${String(stamp).slice(-7)}`;

const createdUserIds: string[] = [];
let promotionId = '';

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
    organizationName: `Privacy Org ${stamp}`,
    companyName: `Privacy Station ${stamp}`,
  });

  const owner = await signIn(ownerEmail, ownerPassword);

  const prize = await owner.rpc('create_prize', {
    p_company_id: companyId,
    p_name: prizeName,
  });
  if (prize.error) throw new Error(`create_prize failed: ${prize.error.message}`);

  await owner.rpc('record_stock_entry', {
    p_company_id: companyId,
    p_prize_id: prize.data as string,
    p_type: 'MANUAL_ENTRY',
    p_quantity: 1,
  });

  const promotion = await owner.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: promotionName,
    p_starts_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    p_ends_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  if (promotion.error) throw new Error(`create_promotion failed: ${promotion.error.message}`);
  promotionId = promotion.data as string;

  await owner.rpc('link_prize_to_promotion', {
    p_promotion_id: promotionId,
    p_prize_id: prize.data as string,
    p_quantity: 1,
  });

  // The whole number, exactly as an operator would type it in — no
  // formatting, so the value seeded here is character-for-character the one
  // the "not in the HTML" assertion searches for.
  const member = await owner.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: listenerName,
    p_phone: listenerPhone,
  });
  if (member.error) throw new Error(`create_member failed: ${member.error.message}`);

  await owner.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: member.data as string,
    p_participated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_source: 'MANUAL',
    p_answers: [],
  });

  // Fixture here, the same as delivery-flow.spec.ts and deadline.spec.ts treat
  // it: draw-flow.spec.ts is what proves the draws screen itself. One unit,
  // one eligible listener: one winner, AWAITING_PICKUP, which is what the
  // journey below opens.
  const drawn = await owner.rpc('run_draw', { p_promotion_id: promotionId, p_units: null });
  if (drawn.error) throw new Error(`run_draw failed: ${drawn.error.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('a masked list, a card that reveals one field on request, and a hand-over that shows what it is handing over', async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  // --- /pickups: the mask, and the number's actual absence -----------------
  await page.goto('/pickups');
  const row = page.getByTestId('pickup-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(listenerName);

  // The phone cell carries no test id of its own — `getByText` with the
  // anchored regex below only matches an element whose whole text is four
  // dots and four digits, so it cannot accidentally match the name cell
  // beside it or the row as a whole.
  await expect(row.getByText(/^•••• \d{4}$/)).toBeVisible();

  // THE ASSERTION THIS JOURNEY EXISTS FOR. Not "the masked span reads right"
  // — that would still pass if the whole number sat elsewhere in the same
  // document — but that the served page contains the seeded number nowhere
  // at all.
  expect(await page.content()).not.toContain(listenerPhone);

  // --- BLOCK 31a: the pencil, and the two actions that moved into it -------
  //
  // The row no longer offers them. That is item 5 of the owner's list, and the
  // point of it: on the row there was nothing on screen naming what was about to
  // be returned to stock or written off as lost.
  await expect(page.getByRole('button', { name: 'Return to stock' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Write off as lost' })).toHaveCount(0);

  await page.getByTestId('pickup-edit').click();
  const record = page.getByTestId('pickup-record-dialog');
  await expect(record).toBeVisible();
  // The summary names what the actions below it would act on.
  await expect(record).toContainText(promotionName);
  await expect(record).toContainText(prizeName);
  // And it is not a way around this screen's own masking.
  await expect(record.getByText(/^•••• \d{4}$/)).toBeVisible();
  await expect(record.getByRole('button', { name: 'Return to stock' })).toBeVisible();
  await expect(record.getByRole('button', { name: 'Write off as lost' })).toBeVisible();
  await page.getByTestId('pickup-record-close').click();
  await expect(page.getByTestId('pickup-record-dialog')).toHaveCount(0);

  // The renamed button is the one that opens the listener (D8).
  await expect(page.getByTestId('pickup-view-listener')).toHaveText('Member');

  // --- the listener card: masked, then revealed -----------------------------
  await page.getByTestId('pickup-view-listener').click();
  await expect(page.getByTestId('listener-card-phone')).toHaveText(
    `•••• ${listenerPhone.slice(-4)}`,
  );

  await page.getByTestId('listener-card-reveal-phone').click();
  await expect(page.getByTestId('listener-card-phone')).toHaveText(listenerPhone);
  // The button that asked is gone — a second click would spend a second
  // audit row to learn the same thing, which listener-card-dialog.tsx's own
  // `asked` guard exists to prevent.
  await expect(page.getByTestId('listener-card-reveal-phone')).toHaveCount(0);

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByTestId('listener-card-phone')).toHaveCount(0);

  // --- Hand over: what is being handed over, before it is handed over ------
  await page.getByTestId('pickup-hand-over').click();
  await expect(page.getByTestId('hand-over-promotion')).toHaveText(promotionName);
  await expect(page.getByTestId('hand-over-listener')).toContainText(listenerName);
  await expect(page.getByTestId('hand-over-prize')).toHaveText(prizeName);

  await page
    .getByTestId('hand-over-note')
    .fill('Handed over at the front desk; photo ID checked against the name on file.');
  await page.getByTestId('hand-over-confirm').click();

  await expect(row.getByTestId('pickup-status')).toHaveText('Delivered', { timeout: 15_000 });
});
