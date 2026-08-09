import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 6b through the screen: an operator hands a prize over, files the
 * receipt, and then undoes the delivery — and the winner is waiting again.
 *
 * The fixtures go in through the real RPCs on a signed-in client, including the
 * draw itself, for the reason draw-flow.spec.ts gives: those screens are other
 * blocks' to prove and they do prove them. What is new here is what happens to
 * a winner after the draw.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-deliv-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-deliv-admin-${stamp}-pw`;
const ownerEmail = `e2e-deliv-owner-${stamp}@example.test`;
const ownerPassword = `Owner-deliv-${stamp}-provisional`;
const ownerFinalPassword = `Owner-deliv-${stamp}-chosen`;

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
    organizationName: `Deliv Org ${stamp}`,
    companyName: `Deliv Station ${stamp}`,
  });

  const owner = await signIn(ownerEmail, ownerPassword);

  const prize = await owner.rpc('create_prize', {
    p_company_id: companyId,
    p_name: `Deliv Prize ${stamp}`,
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
    p_name: `Deliv Promo ${stamp}`,
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

  const member = await owner.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: `Deliv Listener ${stamp}`,
  });
  await owner.rpc('record_participation', {
    p_promotion_id: promotionId,
    p_member_id: member.data as string,
    p_participated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    p_source: 'MANUAL',
    p_answers: [],
  });

  // The draw is fixture here; draw-flow.spec.ts is what proves it through the
  // screen.
  const drawn = await owner.rpc('run_draw', {
    p_promotion_id: promotionId,
    p_units: null,
  });
  if (drawn.error) throw new Error(`run_draw failed: ${drawn.error.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('an operator hands a prize over, files the receipt, and undoes the delivery', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto(`/promotions/${promotionId}/draws`);

  // Awaiting pickup: the three deliberate actions, and never the undo.
  await expect(page.getByTestId('winner-status-1')).toHaveText('AWAITING_PICKUP');
  await expect(page.getByTestId('winner-deliver')).toBeVisible();
  await expect(page.getByTestId('winner-cancel_delivery')).toHaveCount(0);
  await expect(page.getByTestId('winner-no-receipt')).toBeVisible();

  await page.getByTestId('winner-deliver').click();
  await expect(page.getByTestId('winner-status-1')).toHaveText('DELIVERED', { timeout: 15_000 });

  // And now the undo, and only the undo.
  await expect(page.getByTestId('winner-cancel_delivery')).toBeVisible();
  await expect(page.getByTestId('winner-deliver')).toHaveCount(0);

  // The receipt form appears only after the delivery is on the record (D1).
  //
  // Block 11b, D7: the wrong kind of file first. The bucket would refuse it too
  // and that refusal is the real boundary; what is proved here is that the
  // operator is told WHY, in a sentence, instead of reading a Storage error.
  await page.getByTestId('receipt-input').setInputFiles({
    name: 'not-a-receipt.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<h1>not a receipt</h1>'),
  });
  await page.getByTestId('receipt-attach').click();
  // By its text rather than by role: the screen carries more than one alert.
  await expect(page.getByText(/must be an image/i)).toBeVisible();
  await expect(page.getByTestId('winner-receipt')).toHaveCount(0);

  // And then a file a receipt can actually be. Before Block 11b this was a
  // text/plain receipt.txt, which the allow-list now refuses.
  await page.getByTestId('receipt-input').setInputFiles({
    name: 'receipt.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from('signed by the winner'),
  });
  await page.getByTestId('receipt-attach').click();
  await expect(page.getByTestId('winner-receipt')).toBeVisible({ timeout: 15_000 });

  // Undoing keeps the receipt: clearing it would delete a photograph of a real
  // handover because somebody corrected a record.
  await page.getByTestId('winner-cancel_delivery').click();
  await page.getByLabel('Reason').fill('recorded against the wrong winner');
  await page.getByRole('button', { name: 'Confirm' }).click();

  await expect(page.getByTestId('winner-status-1')).toHaveText('AWAITING_PICKUP', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('winner-receipt')).toBeVisible();
});
