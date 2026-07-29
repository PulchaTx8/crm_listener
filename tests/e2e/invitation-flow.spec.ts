import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The whole invitation journey through the real UI: an Owner invites, the link
 * is revealed once, a fresh browser context opens it, the invitee chooses a
 * password, signs in, and lands in the app as a member.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-inv-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-inv-admin-${stamp}-pw`;
const ownerEmail = `e2e-inv-owner-${stamp}@example.test`;
const inviteeEmail = `e2e-invitee-${stamp}@example.test`;
const inviteePassword = `Invitee-${stamp}-pw`;
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

test('an owner invites a colleague who joins with their own password', async ({ page }) => {
  // --- provision an Owner to do the inviting ------------------------------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(platformAdminEmail);
  await page.getByPlaceholder('Password').fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole('link', { name: 'Customers' }).click();
  await page.getByTestId('customer-create').click();
  await page.getByPlaceholder('Organization name').fill(`Invite Org ${stamp}`);
  await page.getByPlaceholder('Company (Station) name').fill(`Invite Station ${stamp}`);
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

  // --- the Owner signs in, clears the gate, and invites --------------------
  const ownerContext = await page.context().browser()!.newContext();
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

  // Sidebar entry added in Task 11 Step 4.
  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/team$/);

  // The invite form lives in a dialog over the roster since Block 3c. It stays
  // open on success: the accept link below is shown once and cannot be shown
  // again.
  await ownerPage.getByTestId('team-invite').click();

  // Task 10 replaced the fixed-role dropdown with an owner checkbox, a role
  // select and a Station checklist (schemas/invitations.ts:
  // createInvitationSchema requires a role and at least one Station for a
  // non-owner invite, and rejects either one for an owner invite). This
  // Organization holds no role yet — Block 1c's per-Station roles are the
  // subject of roles-flow.spec.ts, not this one — so the invitee is brought
  // in as a second owner, which needs neither.
  await ownerPage.getByPlaceholder("Colleague's e-mail").fill(inviteeEmail);
  await ownerPage.getByLabel('Invite as owner (full access to every Station)').check();
  await ownerPage.getByRole('button', { name: 'Send invitation' }).click();

  const linkBox = ownerPage.locator('code').first();
  await expect(linkBox).toBeVisible({ timeout: 15_000 });
  const acceptUrl = (await linkBox.innerText()).trim();
  expect(acceptUrl).toContain('/invite/');

  // The token must never have travelled in the page URL.
  expect(ownerPage.url()).not.toContain('/invite/');

  // --- the invitee accepts in a fresh context ------------------------------
  const inviteeContext = await page.context().browser()!.newContext();
  const inviteePage = await inviteeContext.newPage();

  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole('heading', { name: /Join Invite Org/ })).toBeVisible();

  await inviteePage.getByPlaceholder('Choose a password').fill(inviteePassword);
  await inviteePage.getByPlaceholder('Repeat the password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Create my account' }).click();

  await expect(inviteePage).toHaveURL(/\/login/);

  const { data: inviteeProfile } = await admin
    .from('profiles')
    .select('id')
    .eq('email', inviteeEmail)
    .single();
  if (inviteeProfile) createdUserIds.push(inviteeProfile.id);

  // --- the invitee signs in with the password they chose -------------------
  await inviteePage.getByPlaceholder('E-mail').fill(inviteeEmail);
  await inviteePage.getByPlaceholder('Password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Sign in' }).click();

  // Straight to /app: they chose their own password, so there is no gate.
  await expect(inviteePage).toHaveURL(/\/app$/);
  await expect(inviteePage.getByText(`Invite Station ${stamp}`)).toBeVisible();

  // --- the link is single-use ----------------------------------------------
  const secondTry = await inviteeContext.newPage();
  await secondTry.goto(acceptUrl);
  await expect(secondTry.getByRole('heading', { name: /not valid/i })).toBeVisible();

  await inviteeContext.close();
  await ownerContext.close();
});
