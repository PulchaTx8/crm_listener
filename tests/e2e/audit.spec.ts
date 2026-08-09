import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 10a's round trip, and it closes the block's own loop in one assertion:
 * an administrator connects a Station to WhatsApp on one screen, and the audit
 * row that write produced appears on the other.
 *
 * WHAT ONLY THIS FILE PROVES. 23_audit_and_integrations exercises the SQL and
 * tests/isolation/audit.test.ts exercises the RPCs with real sessions; neither
 * renders a screen. The two things that live only here are the rendered
 * boundary between them -- the integration form writing through the action, and
 * the viewer reading it back through the policies -- and the credentials panel,
 * whose whole job is to be legible to somebody debugging.
 *
 * Fixture setup is RPC-only, the choice dashboards.spec.ts and reports.spec.ts
 * both make: what this file proves is the two screens, not how a customer gets
 * provisioned.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const adminEmail = `audit-admin-${stamp}@example.test`;
const adminPassword = `Admin-${stamp}-aA1!`;
const ownerEmail = `audit-owner-${stamp}@example.test`;
const ownerInitialPassword = `Init-${stamp}-aA1!`;
const ownerChosenPassword = `Chosen-${stamp}-aA1!`;

let companyName: string;
let companyId: string;
let organizationId: string;

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`could not create a profile for ${email}: ${profileError.message}`);
  return data.user.id;
}

async function signInAs(email: string, password: string) {
  const client = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(adminEmail, adminPassword);
  const { error } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (error) throw new Error(`could not seed platform admin: ${error.message}`);

  const ownerUserId = await createAuthUser(ownerEmail, ownerInitialPassword);
  companyName = `Audit Station ${stamp}`;
  const adminClient = await signInAs(adminEmail, adminPassword);
  ({ organization_id: organizationId, company_id: companyId } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: `Audit Org ${stamp}`,
    companyName,
  }));
});

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test('an administrator connects a Station, and the owner reads it in the trail', async ({
  page,
}) => {
  // --- The platform console -------------------------------------------------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for the login to land before navigating: the admin's own
  // must_change_password gate is clear, so the change screen bounces them to
  // /app, and a goto issued before that redirect settles races it. This is the
  // shape provisioning-flow.spec.ts already uses.
  await expect(page).toHaveURL(/\/app$/);

  // Through the sidebar rather than by URL, so reaching the console also
  // asserts the nav entry exists and is scoped to a platform admin.
  //
  // BLOCK 16 MOVED THIS FORM. It used to live on /admin/integrations, a list of
  // every Station on the platform with a card each — which was a Stations screen
  // wearing another name. A Station's connection is a fact about the Station, so
  // it is now the second tab of its record, reached by choosing the customer and
  // opening the radio.
  await page.getByRole('link', { name: 'Stations', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/stations$/);
  await page.getByTestId('station-organization-select').selectOption(organizationId);

  const stationRow = page.locator('[data-testid="station-row"]', { hasText: companyName });
  await expect(stationRow).toBeVisible();
  await stationRow.getByRole('button', { name: companyName, exact: true }).click();
  await page.getByRole('tab', { name: 'WhatsApp' }).click();

  // The credentials panel: three booleans and no values. The e2e webServer sets
  // WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN (tests/whatsapp-test-env.ts)
  // and NOT the access token, which makes this the realistic shape -- a
  // half-configured installation is exactly when somebody opens this screen.
  await expect(page.getByText('WHATSAPP_ACCESS_TOKEN')).toBeVisible();
  await expect(page.getByText('not set').first()).toBeVisible();
  // And the values themselves never appear.
  await expect(page.getByText('e2e-whatsapp-app-secret')).toHaveCount(0);

  const phoneNumberId = `55${stamp}`;
  // By Station id, not by text: the Station's NAME is in the dialog header,
  // OUTSIDE the form, so no text inside the form identifies which radio it
  // configures. The first version of this test filtered forms by hasText and
  // matched none.
  const form = page.getByTestId(`integration-${companyId}`);
  await expect(form).toBeVisible();

  // The Station was provisioned with no integration, so its form offers
  // "Connect" rather than "Save" -- which is get_integration returning a row of
  // nulls for a Station rather than no row at all.
  await expect(form.getByRole('button', { name: 'Connect' })).toBeVisible();

  await form.getByPlaceholder('1234567890').fill(phoneNumberId);
  await form.getByRole('button', { name: 'Connect' }).click();

  await expect(form.getByPlaceholder('1234567890')).toHaveValue(phoneNumberId, {
    timeout: 15_000,
  });

  // --- The Organization's own trail ----------------------------------------
  await page.goto('/logout').catch(() => undefined);
  await page.context().clearCookies();

  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerInitialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerChosenPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerChosenPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();

  // THE ASSERTION THE BLOCK IS NAMED FOR: the write on the other screen is here,
  // under its human label, read through audit_logs' own policies as the
  // Organization's owner.
  await expect(page.getByText('WhatsApp integration configured').first()).toBeVisible();

  // The filter, which is a plain GET -- so this URL is the thing somebody
  // pastes into a ticket.
  await page.goto('/audit?action=configure_integration');
  await expect(page.getByText('WhatsApp integration configured').first()).toBeVisible();

  // And the detail, which is never summarised: the number that was configured
  // is in the row, in full.
  // Scoped to the table on purpose. `<details>` carries the implicit role
  // `group`, and since Block 12b the shell's language gear is one too — so an
  // unscoped `getByRole('group').first()` opens the gear and never touches the
  // audit row.
  await page.getByRole('table').getByRole('group').first().locator('summary').click();
  await expect(page.getByText(phoneNumberId).first()).toBeVisible();
});
