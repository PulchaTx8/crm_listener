import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The whole per-Station roles journey through the real UI: an owner composes a
 * role from the permission catalogue, a platform admin adds a second Station,
 * the owner invites a colleague into only the first Station at that role, the
 * colleague accepts and reaches that Station and not the other. That colleague
 * — who holds users.invite and nothing else — then opens the Team screen
 * themselves and sends a second invitation into the Station they do not
 * belong to, proving the invite checklist is authorised by users.invite
 * specifically and not by users.manage. The owner then grants the second
 * Station and the colleague reaches both, and finally the role cannot be
 * deleted while someone still holds it.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-roles-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-roles-admin-${stamp}-pw`;
const ownerEmail = `e2e-roles-owner-${stamp}@example.test`;
const inviteeEmail = `e2e-roles-manager-${stamp}@example.test`;
const inviteePassword = `Manager-${stamp}-pw`;
const colleagueEmail = `e2e-roles-colleague-${stamp}@example.test`;
const orgName = `Roles Org ${stamp}`;
const stationAName = `Roles Station A ${stamp}`;
const stationBName = `Roles Station B ${stamp}`;
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

test('an owner composes a role and assigns it per Station', async ({ page, browser }) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByPlaceholder('E-mail').fill(platformAdminEmail);
  await page.getByPlaceholder('Password').fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.getByRole('link', { name: 'Customers' }).click();
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

  // --- the owner composes a role from the permission catalogue -------------
  await ownerPage.getByRole('link', { name: 'Roles' }).click();
  await expect(ownerPage).toHaveURL(/\/roles$/);

  await ownerPage.getByLabel('Name').fill('Manager');
  // users.invite is Organization-scoped, so its label also carries a "whole
  // Organization" badge — getByLabel matches by substring, so the plain
  // sentence below still finds the one checkbox unambiguously (it is the only
  // permission whose label contains this text).
  await ownerPage.getByLabel('Invite people to the Organization').check();
  await ownerPage.getByRole('button', { name: 'Create role' }).click();

  const managerRow = ownerPage.locator('[data-testid="role-row"]', { hasText: 'Manager' });
  await expect(managerRow).toBeVisible();
  await expect(managerRow.getByText('held by 0 user(s)')).toBeVisible();

  // --- the platform admin adds a second Station, from the console only -----
  // (the owner has no UI for this — add_company is platform-admin only).
  const stationARow = page.locator('[data-testid="company-row"]', { hasText: stationAName });
  await expect(stationARow).toBeVisible();
  await stationARow.getByPlaceholder('New Station name').fill(stationBName);
  await stationARow.getByRole('button', { name: 'Add Station' }).click();

  await expect(
    page.locator('[data-testid="company-row"]', { hasText: stationBName }),
  ).toBeVisible({ timeout: 15_000 });

  // --- the owner invites a colleague into ONLY the first Station -----------
  await ownerPage.getByRole('link', { name: 'Team' }).click();
  await expect(ownerPage).toHaveURL(/\/team$/);

  // Scoped to the invite form specifically: the Team screen also renders a
  // Select per member per Station in the Members card, and this member has
  // not been invited yet, so at this point the invite form's combobox is the
  // only one anywhere in the "Manager" role's ballpark, but scoping here keeps
  // this true even after that changes later in the test.
  const inviteForm = ownerPage.locator('form', {
    has: ownerPage.getByPlaceholder("Colleague's e-mail"),
  });
  await inviteForm.getByPlaceholder("Colleague's e-mail").fill(inviteeEmail);
  await inviteForm.getByRole('combobox').selectOption({ label: 'Manager' });
  await inviteForm.getByLabel(stationAName).check();
  await inviteForm.getByRole('button', { name: 'Send invitation' }).click();

  const linkBox = ownerPage.locator('code').first();
  await expect(linkBox).toBeVisible({ timeout: 15_000 });
  const acceptUrl = (await linkBox.innerText()).trim();
  expect(acceptUrl).toContain('/invite/');

  // --- the invitee accepts in a fresh context -------------------------------
  const inviteeContext = await browser.newContext();
  const inviteePage = await inviteeContext.newPage();

  await inviteePage.goto(acceptUrl);
  await expect(inviteePage.getByRole('heading', { name: `Join ${orgName}` })).toBeVisible();

  await inviteePage.getByPlaceholder('Choose a password').fill(inviteePassword);
  await inviteePage.getByPlaceholder('Repeat the password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Create my account' }).click();
  await expect(inviteePage).toHaveURL(/\/login/);

  const { data: inviteeProfile, error: inviteeLookupError } = await admin
    .from('profiles')
    .select('id')
    .eq('email', inviteeEmail)
    .single();
  expect(inviteeLookupError).toBeNull();
  if (!inviteeProfile) throw new Error(`no profile row for ${inviteeEmail}`);
  createdUserIds.push(inviteeProfile.id);

  await inviteePage.getByPlaceholder('E-mail').fill(inviteeEmail);
  await inviteePage.getByPlaceholder('Password').fill(inviteePassword);
  await inviteePage.getByRole('button', { name: 'Sign in' }).click();
  await expect(inviteePage).toHaveURL(/\/app$/);

  // --- the per-Station difference: exactly one Station, and the right one --
  // This is the crux of the journey: before the second Station is granted,
  // the colleague must reach Station A and NOT Station B. Asserting only the
  // eventual two-Station state would prove nothing about scoping.
  await expect(inviteePage.locator('[data-testid="station-card"]')).toHaveCount(1);
  await expect(
    inviteePage.locator('[data-testid="station-card"]', { hasText: stationAName }),
  ).toHaveCount(1);
  await expect(
    inviteePage.locator('[data-testid="station-card"]', { hasText: stationBName }),
  ).toHaveCount(0);

  // --- the Manager — not the owner — sends an invitation themselves --------
  // The Manager role holds only users.invite (created above), never
  // users.manage. list_manageable_companies is called once per Team-screen
  // surface with the permission that surface actually needs (0023) — if the
  // invite checklist were still fed by a users.manage-gated call, this
  // Manager would be refused outright and see an empty checklist, unable to
  // invite anyone into any Station at all, including their own. Sending into
  // Station B specifically — the one this Manager does NOT belong to — also
  // proves users.invite's Organization-wide reach, the same shape
  // create_invitation itself checks, not merely action within their own
  // membership.
  await inviteePage.getByRole('link', { name: 'Team' }).click();
  await expect(inviteePage).toHaveURL(/\/team$/);

  const managerInviteForm = inviteePage.locator('form', {
    has: inviteePage.getByPlaceholder("Colleague's e-mail"),
  });
  await expect(managerInviteForm.getByLabel(stationAName)).toBeVisible();
  await expect(managerInviteForm.getByLabel(stationBName)).toBeVisible();

  await managerInviteForm.getByPlaceholder("Colleague's e-mail").fill(colleagueEmail);
  await managerInviteForm.getByRole('combobox').selectOption({ label: 'Manager' });
  await managerInviteForm.getByLabel(stationBName).check();
  await managerInviteForm.getByRole('button', { name: 'Send invitation' }).click();

  const managerInviteLink = inviteePage.locator('code').first();
  await expect(managerInviteLink).toBeVisible({ timeout: 15_000 });
  expect((await managerInviteLink.innerText()).trim()).toContain('/invite/');

  // --- the owner grants the second Station ----------------------------------
  await ownerPage.goto('/team');
  const memberRow = ownerPage.locator('[data-testid="member-row"]', { hasText: inviteeEmail });
  const stationBAccessRow = memberRow.locator('[data-testid="station-access-row"]', {
    hasText: stationBName,
  });
  await stationBAccessRow.getByRole('combobox').selectOption({ label: 'Manager' });
  await stationBAccessRow.getByRole('button', { name: 'Apply' }).click();

  // Wait for the Team screen to reflect the grant before asking the invitee's
  // session, otherwise the reload below races the server action — same
  // concern, same fix, as provisioning-flow.spec.ts's suspend/reactivate step.
  // "Remove" only renders once a company_membership row exists for this user
  // in this Station, so its appearance is proof the write landed, not just
  // that the click happened.
  await expect(stationBAccessRow.getByRole('button', { name: 'Remove' })).toBeVisible({
    timeout: 15_000,
  });

  // --- the colleague now reaches both Stations ------------------------------
  // Back to /app explicitly, not a bare reload: the Manager's own invitation
  // above left inviteePage sitting on /team, which has no station-card at
  // all — a reload there would check the wrong page.
  await inviteePage.goto('/app');
  await expect(inviteePage.locator('[data-testid="station-card"]')).toHaveCount(2);
  await expect(
    inviteePage.locator('[data-testid="station-card"]', { hasText: stationAName }),
  ).toHaveCount(1);
  await expect(
    inviteePage.locator('[data-testid="station-card"]', { hasText: stationBName }),
  ).toHaveCount(1);

  // --- Delete is refused for a role that is held ----------------------------
  await ownerPage.goto('/roles');
  const managerRowAfter = ownerPage.locator('[data-testid="role-row"]', { hasText: 'Manager' });
  await expect(managerRowAfter.getByText(/held by [1-9]\d* user\(s\)/)).toBeVisible();
  await expect(managerRowAfter.getByRole('button', { name: 'Delete' })).toBeDisabled();

  await inviteeContext.close();
  await ownerContext.close();
});
