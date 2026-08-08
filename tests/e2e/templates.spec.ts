import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * The Templates block's round trip (Task 11): an operator reaches both new
 * screens through the sidebar section this block adds, gives one system text
 * this Station's own wording, puts it back, and records the approved template
 * that lets the Station start a conversation at all.
 *
 * Both halves reload the page before asserting. That is the point of the spec
 * rather than a precaution: a Server Action returning `{ status: 'saved' }`
 * proves the round trip reached the action, not that anything was written —
 * the two screens' whole job is that a Station's words survive the request
 * that set them, and only a fresh read from the database proves it.
 *
 * Sign-in and Station-selection preamble copied from music-catalogue.spec.ts,
 * one identity for the same reason: provision_customer's owner bypass
 * (has_permission, 0024) grants an Organization's owner every permission —
 * templates.view and templates.manage included — in every active Company of
 * that Organization, with no role to compose or assign. tests/isolation/
 * templates.test.ts is where the two codes are proved apart from each other;
 * nothing about this journey needs a scoped role.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const platformAdminEmail = `e2e-templates-admin-${stamp}@example.test`;
const platformAdminPassword = `E2e-templates-admin-${stamp}-pw`;
const ownerEmail = `e2e-templates-owner-${stamp}@example.test`;
const orgName = `Templates Org ${stamp}`;
const stationName = `Templates Station ${stamp}`;

// PORTUGUESE, like every string in this file that a listener would read — the
// block's one language exception, and the thing it exists to make editable.
const ownRefusal = 'Beleza! Fica pra próxima. Obrigado por ouvir a gente!';
const shortBody = 'Oi {{1}}! Seu prêmio {{2}} está te esperando aqui na rádio.';
const approvedBody =
  'Oi {{1}}! Seu prêmio {{2}} está te esperando aqui na rádio. Você tem até {{3}} para retirar.';
const templateName = 'pickup_reminder';
const templateLanguage = 'pt_BR';

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

test('a Station takes its own voice and records the template that lets it speak first', async ({
  page,
  browser,
}) => {
  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Platform admin')).toBeVisible();

  await page.getByRole('link', { name: 'Customers' }).click();
  await page.getByTestId('customer-create').click();
  await page.getByPlaceholder('Organization name').fill(orgName);
  await page.getByPlaceholder('Company (Station) name').fill(stationName);
  await page.getByPlaceholder('Owner e-mail').fill(ownerEmail);
  await page.getByRole('button', { name: 'Provision', exact: true }).click();

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
  await ownerPage.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await ownerPage.getByLabel('Password', { exact: true }).fill(ownerPassword);
  await ownerPage.getByRole('button', { name: 'Sign in' }).click();
  await expect(ownerPage).toHaveURL(/\/change-password$/);

  const chosen = `Owner-${stamp}-chosen`;
  await ownerPage.getByPlaceholder('New password').fill(chosen);
  await ownerPage.getByPlaceholder('Repeat the password').fill(chosen);
  await ownerPage.getByRole('button', { name: 'Save' }).click();
  await expect(ownerPage).toHaveURL(/\/app$/);

  await expect(ownerPage.getByText(ownerEmail)).toBeVisible();
  await expect(ownerPage.getByRole('link', { name: 'Customers' })).toHaveCount(0);

  // ===========================================================================
  // 1. The ten texts are all there before anything has been overridden.
  //
  //    This is the assertion the screen exists to earn: a brand-new Station has
  //    no rows in station_message_templates at all, and listSystemMessages
  //    builds the ten from SYSTEM_MESSAGE_DEFAULTS regardless. A screen
  //    rendering the query's own rows would show an empty page here and pass
  //    every other check in this file.
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'Messages' }).click();
  await expect(ownerPage).toHaveURL(/\/templates\/messages$/);
  await expect(ownerPage.getByTestId('system-message-list').locator('> li')).toHaveCount(10);

  const refusalRow = ownerPage.getByTestId('system-message-REFUSAL');
  const refusalBody = ownerPage.getByTestId('system-message-body-REFUSAL');

  // Captured rather than written down: the default is engine.ts's own constant,
  // and hard-coding it here would make this spec a second copy of it that a
  // reword has to remember to update. What matters is that restoring returns
  // the text to whatever the code says — proved at the end against this value.
  const systemDefault = await refusalBody.inputValue();
  expect(systemDefault.trim()).not.toBe('');

  // Nothing is overridden yet, so there is nothing to restore.
  await expect(ownerPage.getByTestId('system-message-clear-REFUSAL')).toHaveCount(0);

  // ===========================================================================
  // 2. The Station takes this one text into its own words.
  // ===========================================================================
  await refusalBody.fill(ownRefusal);
  await refusalRow.getByRole('button', { name: 'Save' }).click();

  // The Restore button renders only for an overridden text, so its appearance
  // is the screen's own statement that this row now carries the Station's
  // wording rather than the code's.
  await expect(ownerPage.getByTestId('system-message-clear-REFUSAL')).toBeVisible();

  // The proof: a fresh read, not the action's own answer.
  await ownerPage.reload();
  await expect(ownerPage.getByTestId('system-message-body-REFUSAL')).toHaveValue(ownRefusal);
  // And the default is still on screen beside it — an operator has to be able
  // to see what they replaced (spec §5).
  await expect(
    ownerPage.getByTestId('system-message-REFUSAL').getByText(systemDefault),
  ).toBeVisible();

  // ===========================================================================
  // 3. And gives it back. Its own button and its own action, never an empty
  //    save — a blank body is refused by the schema, by 0113's door and by
  //    0109's check constraint, so this is the only way back to the default.
  // ===========================================================================
  await ownerPage.getByTestId('system-message-clear-REFUSAL').click();
  await ownerPage.reload();
  await expect(ownerPage.getByTestId('system-message-body-REFUSAL')).toHaveValue(systemDefault);
  await expect(ownerPage.getByTestId('system-message-clear-REFUSAL')).toHaveCount(0);

  // ===========================================================================
  // 4. The approved template, on the other screen in the same section.
  // ===========================================================================
  await ownerPage.getByRole('link', { name: 'WhatsApp' }).click();
  await expect(ownerPage).toHaveURL(/\/templates\/whatsapp$/);

  const pickupCard = ownerPage.getByTestId('purpose-PICKUP_REMINDER');
  await expect(pickupCard.getByText('Not registered — nothing sends')).toBeVisible();

  await pickupCard.getByLabel('Name at Meta').fill(templateName);
  await pickupCard.getByLabel('Language').fill(templateLanguage);

  // A body one placeholder short of the contract first. Nothing in the stack
  // refuses this — the count the door and the enqueue both check is the body's
  // own, and the sweep always sends three — so the screen's warning is the only
  // thing standing between a transcription slip and a reminder that fails in a
  // server log, hourly, forever.
  const bodyField = ownerPage.getByTestId('template-body-PICKUP_REMINDER');
  await bodyField.fill(shortBody);
  await expect(ownerPage.getByTestId('template-contract-warning-PICKUP_REMINDER')).toBeVisible();
  // Two placeholders, two description fields — derived from the body as typed.
  await expect(pickupCard.getByLabel('What {{2}} means')).toBeVisible();
  await expect(pickupCard.getByLabel('What {{3}} means')).toHaveCount(0);

  await bodyField.fill(approvedBody);
  await expect(ownerPage.getByTestId('template-contract-warning-PICKUP_REMINDER')).toHaveCount(0);

  await pickupCard.getByLabel('What {{1}} means').fill('The winner’s first name');
  await pickupCard.getByLabel('What {{2}} means').fill('The prize name');
  await pickupCard.getByLabel('What {{3}} means').fill('The pickup deadline');
  await pickupCard.getByRole('button', { name: 'Record this template' }).click();

  await expect(pickupCard.getByText('Registered', { exact: true })).toBeVisible();

  // ===========================================================================
  // 5. Both survive the reload, which is the only thing that proves either.
  // ===========================================================================
  await ownerPage.reload();
  const registered = ownerPage.getByTestId('purpose-PICKUP_REMINDER');
  await expect(registered.getByText(templateName).first()).toBeVisible();
  await expect(registered.getByText(templateLanguage).first()).toBeVisible();
  // The body with its placeholders intact — what the operator compares against
  // the approval in Meta's console, which is this screen's whole job (D4).
  await expect(registered.getByText(approvedBody).first()).toBeVisible();
  // The form now offers to replace rather than to record: register_message_template
  // upserts on 0110's partial index, so one purpose keeps one live row.
  await expect(registered.getByRole('button', { name: 'Replace what is recorded' })).toBeVisible();

  await ownerContext.close();
});
