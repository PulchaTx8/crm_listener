import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/** The local stack's own database, the same target tests/isolation/harness.ts connects to. */
const LOCAL_SUPABASE_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

/**
 * Block 6a through the screen: an operator opens a closed promotion's draws,
 * runs one, and sees the winners — with the seed and the algorithm version on
 * the same page, which is the block's whole claim made visible.
 *
 * The fixtures are seeded through the real RPCs on a signed-in client rather
 * than clicked through the registration screens, unlike promotion-prizes.spec.ts.
 * Those screens are Block 2's and 4b's to prove and they do prove them; what is
 * new here is the draws route, and thirty clicks of setup in front of it would
 * make this test fail for reasons that have nothing to do with the draw.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-draw-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-draw-admin-${stamp}-pw`;
const ownerEmail = `e2e-draw-owner-${stamp}@example.test`;
const ownerPassword = `Owner-draw-${stamp}-provisional`;
const ownerFinalPassword = `Owner-draw-${stamp}-chosen`;
const promotionName = `Draw Promo ${stamp}`;

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
    organizationName: `Draw Org ${stamp}`,
    companyName: `Draw Station ${stamp}`,
  });

  const owner = await signIn(ownerEmail, ownerPassword);

  const prize = await owner.rpc('create_prize', {
    p_company_id: companyId,
    p_name: `Draw Prize ${stamp}`,
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

  for (let i = 0; i < 3; i += 1) {
    const member = await owner.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: `Draw Listener ${i + 1} ${stamp}`,
    });
    await owner.rpc('record_participation', {
      p_promotion_id: promotionId,
      p_member_id: member.data as string,
      p_participated_at: new Date(Date.now() - (i + 1) * 60 * 60 * 1000).toISOString(),
      p_source: 'MANUAL',
      p_answers: [],
    });
  }

  // Closed, which is the ordinary case for a draw: the window ended and the
  // entries are all in. Done here rather than at creation because
  // record_participation refuses a promotion outside its window and the three
  // entries above would never have been written.
  //
  // Through a direct connection rather than through PostgREST or an RPC.
  // service_role holds no UPDATE on promotions — this schema revokes the
  // default ACL and grants back by hand, and that refusal is correct and worth
  // leaving alone — while update_promotion is a seventeen-argument door whose
  // whole field set would have to be restated here to move one timestamp.
  const sql = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await sql.connect();
  try {
    await sql.query(
      "update public.promotions set ends_at = now() - interval '1 minute' where id = $1",
      [promotionId],
    );
  } finally {
    await sql.end();
  }
});

test.afterAll(async () => {
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

test('an operator runs a draw on a closed promotion and sees the winner and the proof', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // provision_customer marks the owner's password provisional, so the first
  // browser sign-in lands on the change-password screen rather than the app —
  // the same step promotion-prizes.spec.ts takes. The API client that seeded
  // the fixtures above is not subject to it, which is why the seeding worked
  // with this same password.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerFinalPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerFinalPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto(`/promotions/${promotionId}/draws`);

  await expect(page.getByTestId('no-draws')).toBeVisible();
  await expect(page.getByTestId('run-draw-dialog')).toBeVisible();

  await page.getByTestId('run-draw').click();

  // One unit, three eligible listeners: one winner.
  const winners = page.getByTestId('draw-winners');
  await expect(winners).toBeVisible({ timeout: 15_000 });
  await expect(winners.locator('li')).toHaveCount(1);

  // The proof, on the same screen as the names rather than in an export.
  await expect(page.getByTestId('draw-seed')).toHaveText(/^[0-9a-f]{64}$/);
  await expect(page.getByTestId('draw-algorithm-version')).toHaveText('v1');

  // The owner holds every permission, so the name is theirs to see.
  await expect(winners).toContainText(`Draw Listener`);

  await expect(page.getByTestId('draw-list').locator('li')).toHaveCount(1);
});
