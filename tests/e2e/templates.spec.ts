import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { provisionThroughConsole } from './provision';
import { openNavSection } from './nav';

/**
 * The Templates block's round trip (Task 11): an operator reaches both new
 * screens through the sidebar section this block adds, gives one system text
 * this Station's own wording, puts it back, and records the approved templates
 * that let the Station start a conversation at all — BOTH purposes since Block
 * 17a's fix wave, for the reason step 6 sets out.
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

// Block 17a's purpose, registered through this same screen in step 6 below.
const webTemplateName = `web_verification_${stamp}`;
const webBody = 'Seu código de verificação é {{1}}. Ele vale por dez minutos.';

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
  // MEASURED at 28s against Playwright's 30s default before step 6 existed:
  // this one test provisions a customer through the console, clears the
  // provisional-password gate in a second browser context, and walks two
  // screens with a reload between each half. Adding the second template
  // registration put it over, and the failure that produced was a timeout in
  // the middle of the new section rather than anything about the section. The
  // convention here is members-flow.spec.ts's and participations-flow.spec
  // .ts's — a journey that is genuinely long says so, rather than being split
  // into tests that would each have to re-provision a customer to run at all.
  test.setTimeout(60_000);

  // --- the platform admin provisions the customer with one Station ---------
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(platformAdminEmail);
  await page.getByLabel('Password', { exact: true }).fill(platformAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('Platform admin')).toBeVisible();

  const ownerPassword = await provisionThroughConsole(page, {
    organizationName: orgName,
    companyName: stationName,
    ownerEmail: ownerEmail,
  });

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
  await expect(ownerPage.getByRole('link', { name: 'Organizations' })).toHaveCount(0);

  // ===========================================================================
  // 0. Block 29a. The pairing card, in its new home, reached by the OWNER.
  //
  //    THIS IS THE ASSERTION THE BLOCK EXISTS TO EARN, and nothing covered it
  //    before: the card had no e2e coverage at all while it lived on the
  //    template screen. The move's whole risk is that pairing ends up somewhere
  //    the Organization owner cannot reach — the platform console was the
  //    obvious destination and is behind `is_platform_admin()`, which would have
  //    handed the act to support alone. So the test is not "the card renders",
  //    it is "this owner, who is not a platform admin, can open it" — and the
  //    assertion two lines above (no Organizations link) is what proves this
  //    identity is not one.
  //
  //    The card is asserted by its container rather than by its button: the
  //    button is there only when WHATSAPP_EMBEDDED_SIGNUP_URL is configured, and
  //    the card deliberately renders either way (an owner who finds an empty
  //    screen cannot tell a missing feature from a missing variable). Which
  //    branch shows is an installation's business; that the owner reaches the
  //    card is this block's.
  // ===========================================================================
  const stationCard = ownerPage.getByTestId('station-card').filter({ hasText: stationName });
  await stationCard.getByTestId('station-settings-open').click();

  await expect(ownerPage.getByRole('heading', { name: stationName })).toBeVisible();
  // Nothing has been paired, and the status says so in words rather than by
  // being absent — 0218 answers connected = false for a Station with no
  // integration precisely so this line can exist.
  await expect(ownerPage.getByTestId('station-whatsapp-status')).toContainText('Not connected');
  await expect(ownerPage.getByTestId('connect-whatsapp')).toBeVisible();

  await ownerPage.getByRole('button', { name: 'Close' }).click();
  await expect(ownerPage.getByTestId('connect-whatsapp')).toHaveCount(0);

  // ===========================================================================
  // 0b. The two addresses that moved, and the query string that had to survive.
  //
  //     A bookmark is the only reason these redirects exist, and a bookmark on
  //     either of these screens carries `?companyId=` — the Station picker puts
  //     it there on every switch. A redirect that dropped it would land the
  //     operator on the same screen looking at a different Station, which is
  //     worse than a 404 because nothing about it looks wrong.
  // ===========================================================================
  await ownerPage.goto('/templates/messages');
  await expect(ownerPage).toHaveURL(/\/messages\/promo$/);

  await ownerPage.goto('/templates/whatsapp?station=keep-me');
  await expect(ownerPage).toHaveURL(/\/messages\/templates\?station=keep-me$/);

  await ownerPage.goto('/app');

  // ===========================================================================
  // 1. The thirteen texts are all there before anything has been overridden.
  //
  //    This is the assertion the screen exists to earn: a brand-new Station has
  //    no rows in station_message_templates at all, and listSystemMessages
  //    builds the thirteen from SYSTEM_MESSAGE_DEFAULTS regardless. A screen
  //    rendering the query's own rows would show an empty page here and pass
  //    every other check in this file.
  //
  //    Ten until Block 19a, thirteen since: `system_message_key` (0180) grew
  //    LINK_MUSIC, LINK_MENU and LINK_PROMOTION alongside the original ten,
  //    one for each of the three texts a hashtag's reply can carry
  //    (src/lib/conversation/engine.ts's own LINK_MESSAGE_KEYS). This screen
  //    is generic over the enum (§4's own point — a card renders per key,
  //    not per hand-written row), so the three new keys showed up here with
  //    no change to this screen's own code at all, and this count is the
  //    only thing in this file that needed to know the number moved.
  // ===========================================================================
  // Block 29a renamed both the section and this item, and moved the route.
  // The section's KEY is still 'templates' (shell.ts says why at length); what
  // changed here is what a member reads and clicks.
  await openNavSection(ownerPage, 'Messages');
  await ownerPage.getByRole('link', { name: 'Promo Messages' }).click();
  await expect(ownerPage).toHaveURL(/\/messages\/promo$/);
  // FIFTEEN since the gender block's GENDER, fourteen since Block 28's COUNTRY.
  // Pinned rather than counted from the enum, deliberately: this is the SCREEN's
  // own list, and the whole point is that a key added to system_message_key must
  // REACH it — a test deriving the number from the same enum the page derives it
  // from would pass while the page rendered nothing.
  //
  // The gender block is what proved that the pin earns its keep, by paying for
  // it: every count in the unit suite was updated in the same commit and this
  // one was not, because the block ran `widget.spec.ts` and not this file. CI
  // caught it, which is the whole arrangement working — but the cheaper lesson
  // is that a block adding a `system_message_key` value has THIS line to change
  // and no compiler that will say so.
  await expect(ownerPage.getByTestId('system-message-list').locator('> li')).toHaveCount(15);

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
  await openNavSection(ownerPage, 'Messages');
  // `exact` because without it Playwright matches accessible names by
  // case-insensitive SUBSTRING, and this section now holds an item called
  // 'Promo Messages' whose name contains... nothing of 'Templates', but the
  // sibling case is one rename away and nav.ts's own helper already learned it.
  await ownerPage.getByRole('link', { name: 'Templates', exact: true }).click();
  await expect(ownerPage).toHaveURL(/\/messages\/templates$/);

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

  await pickupCard.getByLabel('What {{1}} means').selectOption('LISTENER_FIRST_NAME');
  await pickupCard.getByLabel('What {{2}} means').selectOption('PRIZE_NAME');
  await pickupCard.getByLabel('What {{3}} means').selectOption('PICKUP_DEADLINE');
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

  // ===========================================================================
  // 6. THE SECOND PURPOSE, THROUGH THIS SCREEN AND NOTHING ELSE.
  //
  //    This is the case whose absence let Block 17a ship a widget that could
  //    never send a code. 0160 added WEB_VERIFICATION to `template_purpose` and
  //    `widget_request_code` looks for a row carrying it — but the screen
  //    renders one card per entry in TEMPLATE_PURPOSES and the registration
  //    schema is a `z.enum` over the same array, and that array was hand-written
  //    with PICKUP_REMINDER alone. So `message_templates` could not hold a
  //    WEB_VERIFICATION row through any path a human could reach, every Station
  //    answered `no_template` for ever, and the console's Widget tab told
  //    operators to register it on a screen where no such card existed.
  //
  //    EVERY GATE STAYED GREEN BECAUSE EVERY HARNESS WENT AROUND THE SCREEN:
  //    tests/e2e/widget.spec.ts and tests/isolation/widget.test.ts call
  //    register_message_template directly, supabase/tests/40 INSERTs the row.
  //    Each of those is right for what it proves and none of them can see this.
  //    The assertion that closes it is a card, filled in by a browser, posted
  //    through the real server action — so a third purpose added to the enum
  //    and forgotten here fails as a missing card rather than as a Station that
  //    silently never sends.
  // ===========================================================================
  const webCard = ownerPage.getByTestId('purpose-WEB_VERIFICATION');
  await expect(webCard.getByText('Not registered — nothing sends')).toBeVisible();

  await webCard.getByLabel('Name at Meta').fill(webTemplateName);
  await webCard.getByLabel('Language').fill(templateLanguage);
  // ONE placeholder, which is this purpose's whole contract: widget_request_code
  // (0161) calls enqueue_whatsapp_outbound with jsonb_build_array(p_code_plain)
  // and nothing else, and 0111 refuses a count that disagrees with the body.
  await ownerPage.getByTestId('template-body-WEB_VERIFICATION').fill(webBody);
  await expect(ownerPage.getByTestId('template-contract-warning-WEB_VERIFICATION')).toHaveCount(0);
  await webCard.getByLabel('What {{1}} means').selectOption('VERIFICATION_CODE');

  // THE BOX THAT DID NOT EXIST UNTIL A DAY OF PRODUCTION SILENCE. Meta's
  // Authentication category carries an OTP button, the send has to name it, and
  // between 2026-08-10 and 2026-08-11 every widget verification came back
  // `(#131008) Required parameter is missing` because nothing on this screen
  // ever asked. Ticked BY TESTID rather than by label: `getByLabel` matches on
  // substring, and this screen already learned what that costs.
  await webCard.getByTestId('template-otp-button-WEB_VERIFICATION').check();

  await webCard.getByRole('button', { name: 'Record this template' }).click();

  await expect(webCard.getByText('Registered', { exact: true })).toBeVisible();

  // The proof is the ROW, read back as the widget's own door reads it — the
  // screen saying "Registered" only proves the action answered. `purpose` is
  // what widget_request_code filters on, so asserting it is asserting that this
  // screen can produce the row that endpoint needs.
  const { data: webRow, error: webRowError } = await admin
    .from('message_templates')
    .select('purpose, name, language, body, otp_button')
    .eq('name', webTemplateName)
    .is('deleted_at', null)
    .single();
  expect(webRowError).toBeNull();
  expect(webRow?.purpose).toBe('WEB_VERIFICATION');
  expect(webRow?.body).toBe(webBody);
  // The tick survived the form, the action, the schema and 0113's door — the
  // whole path a human takes. Every earlier proof of the OTP button starts
  // further down than this: the payload test builds a Template by hand,
  // supabase/tests/18 calls the RPC. None of them can see a checkbox that
  // posts nothing.
  expect(webRow?.otp_button).toBe(true);

  // ===========================================================================
  // 7. Block 29b-1. The OTHER half of this same page: a marketing template,
  //    EMAIL, created and read back through save_marketing_template (0225) —
  //    the door register_message_template cannot serve, because a marketing
  //    template has no purpose to give that ON CONFLICT clause as a target.
  //    MarketingGrid renders beside TemplateRegistry on the SAME page
  //    (page.tsx's own layout), so nothing above this needed to navigate away.
  // ===========================================================================
  const marketingTemplateName = `boas_vindas_email_${stamp}`;
  const marketingSubject = 'Bem-vindo à nossa rádio!';
  const marketingBody = 'Oi {{listener_first_name}}! Que bom ter você com a gente.';

  await ownerPage.getByTestId('marketing-template-create').click();
  const createForm = ownerPage.getByTestId('marketing-template-form');
  await createForm.getByTestId('marketing-template-channel').selectOption('EMAIL');
  await createForm.getByTestId('marketing-template-internal-name').fill(marketingTemplateName);
  await createForm.getByTestId('marketing-template-subject').fill(marketingSubject);
  await createForm.getByTestId('marketing-template-body').fill(marketingBody);
  await ownerPage.getByTestId('marketing-template-save').click();

  // TemplateDialog unmounts itself once the action answers `saved` (its own
  // effect) — proves the action returned, not that anything reached the
  // database. The row after a reload is what proves that.
  await expect(createForm).toHaveCount(0);
  await ownerPage.reload();

  const marketingRow = ownerPage
    .getByTestId('marketing-template-row')
    .filter({ hasText: marketingTemplateName });
  await expect(marketingRow).toBeVisible();

  // Reopened rather than checked from the create dialog above: this is also
  // the READ path, the same one an operator uses a week later to see what is
  // actually recorded, and the preview button is identical either way.
  await marketingRow.getByText(marketingTemplateName).click();
  const editDialog = ownerPage.getByRole('dialog');
  await editDialog.getByTestId('marketing-template-preview-button').click();
  const previewFrame = ownerPage.frameLocator('[data-testid="marketing-template-preview-frame"]');
  // The Station's own name, framed by renderCampaignEmail (frame.ts) —
  // appears twice (header and footer), never substituted: previewCampaignEmailAction
  // shows the body AS TYPED, and the one thing this preview can prove without
  // a listener behind it is that the frame around that body is this Station's.
  await expect(previewFrame.getByText(stationName).first()).toBeVisible();
  await editDialog.getByRole('button', { name: 'Cancel' }).click();

  // The proof is the ROW, read back by the admin client directly — a Server
  // Action answering `saved` proves the round trip reached
  // save_marketing_template, not that anything was written. `variables` is
  // empty because an EMAIL body names its own placeholders inline (0223's
  // CHECK refuses a non-empty array on this channel) and `purpose` is null
  // because that column is what tells a marketing template apart from a
  // SYSTEM registration (services/templates.ts's own comment).
  const { data: marketingDbRow, error: marketingDbError } = await admin
    .from('message_templates')
    .select('channel, purpose, variables')
    .eq('internal_name', marketingTemplateName)
    .is('deleted_at', null)
    .single();
  expect(marketingDbError).toBeNull();
  expect(marketingDbRow?.channel).toBe('EMAIL');
  expect(marketingDbRow?.purpose).toBeNull();
  expect(marketingDbRow?.variables).toEqual([]);

  await ownerContext.close();
});
