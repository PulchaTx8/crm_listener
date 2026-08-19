import { Client } from 'pg';
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
  LOCAL_SUPABASE_DB_URL,
} from '../local-supabase';
import { WORKER_TICK_SECRET_FOR_TESTS } from '../whatsapp-test-env';
import { provisionCustomer } from './provision';
import { openNavSection } from './nav';

/**
 * Block 29d-2, Task 9. The journey this block was built for: an operator
 * builds a send list, builds a campaign from it on the real screen, the
 * worker drains it, and a real listener's row shows a real provider id.
 *
 * THE TRAP THIS FILE IS BUILT AGAINST. `FakeTransport` (src/lib/integrations/
 * whatsapp/fake.ts) returns success WITHOUT a network call -- it is what
 * `/api/worker/tick` uses here, because `WHATSAPP_ACCESS_TOKEN` is unset for
 * this whole suite (playwright.config.ts's own `env` block). A spec that
 * only checked a recipient's status became `sent` -- or, worse, only read the
 * screen's own "enviado" text -- would pass against the fake while proving
 * nothing was ever assembled and handed anywhere. Every assertion below that
 * matters is against the DATABASE: the campaign's own counters, and the
 * recipient row's `provider_message_id`, in FakeTransport's own
 * `wamid.FAKE<n>` shape -- the one thing on the row that could only have
 * arrived by the fake actually being called.
 *
 * FIXTURE SETUP IS RPC-ONLY for everything this file does not itself prove:
 * the listener, their consent, the WhatsApp integration and the marketing
 * template. Block 29d-1's own send-lists.spec.ts already proves the list
 * screen; templates.spec.ts already proves the templates screen. What is
 * novel here, and driven through the real screen, is the campaigns screen
 * itself -- choosing a list, a channel and a template, and sending.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const platformAdminEmail = `campaigns-admin-${stamp}@example.test`;
const platformAdminPassword = `Admin-${stamp}-aA1!`;
const ownerEmail = `campaigns-owner-${stamp}@example.test`;
const ownerInitialPassword = `Init-${stamp}-aA1!`;
const ownerChosenPassword = `Chosen-${stamp}-aA1!`;
const orgName = `Campaigns Org ${stamp}`;
const stationName = `Campaigns Station ${stamp}`;
const listenerName = `E2E Campaign Listener ${stamp}`;
const listenerPhone = `+5511${String(stamp).slice(-9)}`;
const templateInternalName = `E2E Campaign Template ${stamp}`;
const templateMetaName = `e2e_campaign_template_${stamp}`;
const listName = `E2E Campaign List ${stamp}`;
const phoneNumberId = `e2e-campaigns-${stamp}`;

let companyId: string;
let organizationId: string;
let memberId: string;
let templateId: string;
let listId: string;

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

/**
 * A live WhatsApp integration, written straight into Postgres as its
 * superuser -- `integrations` carries no PostgREST grant for any role, the
 * same escape hatch whatsapp-entry.spec.ts's and widget.spec.ts's own
 * seedIntegration document at length. Without this the drain settles the
 * campaign's one recipient `failed` with `no_whatsapp_integration` rather
 * than reaching the transport at all.
 */
async function seedIntegration(orgId: string, compId: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query(
      `insert into public.integrations
         (organization_id, company_id, provider, phone_number_id, enabled)
       values ($1, $2, 'WHATSAPP', $3, true)`,
      [orgId, compId, phoneNumberId],
    );
  } finally {
    await client.end();
  }
}

/** What pg_cron calls, driven by hand -- the same helper reports.spec.ts and whatsapp-entry.spec.ts already establish for this route. */
async function runWorkerTick(baseURL: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseURL}/api/worker/tick`, {
    method: 'POST',
    headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
  });
  if (!response.ok) throw new Error(`worker tick returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(platformAdminEmail, platformAdminPassword);
  const { error: adminError } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (adminError) throw new Error(`could not seed platform admin: ${adminError.message}`);

  const ownerUserId = await createAuthUser(ownerEmail, ownerInitialPassword);
  const adminClient = await signInAs(platformAdminEmail, platformAdminPassword);
  ({ company_id: companyId, organization_id: organizationId } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: orgName,
    companyName: stationName,
  }));

  await seedIntegration(organizationId, companyId);

  // Everything below this line is fixture setup, not the journey under test
  // -- send-lists.spec.ts already proves list creation on screen and
  // templates.spec.ts already proves template registration on screen. Built
  // through the real doors (never a direct insert) as the owner, who bypasses
  // has_permission for their own Organization.
  const ownerClient = await signInAs(ownerEmail, ownerInitialPassword);

  const { data: createdMemberId, error: memberError } = await ownerClient.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: listenerName,
    p_phone: listenerPhone,
  });
  if (memberError || typeof createdMemberId !== 'string') {
    throw new Error(`create_member failed: ${memberError?.message}`);
  }
  memberId = createdMemberId;

  // WHATSAPP's own default is NOT eligible (0246's channel default) -- an
  // explicit grant is what makes this listener reachable at all.
  const { error: consentError } = await ownerClient.rpc('record_member_consent', {
    p_member_id: memberId,
    p_company_id: companyId,
    p_consent_type: 'whatsapp_marketing',
    p_granted: true,
  });
  if (consentError) throw new Error(`record_member_consent failed: ${consentError.message}`);

  const { data: createdTemplateId, error: templateError } = await ownerClient.rpc('save_marketing_template', {
    p_company_id: companyId,
    p_channel: 'WHATSAPP',
    p_internal_name: templateInternalName,
    p_body: 'Oi {{1}}, hoje tem sorteio na radio!',
    p_name: templateMetaName,
    p_language: 'pt_BR',
    p_variables: ['LISTENER_FIRST_NAME'],
  });
  if (templateError || typeof createdTemplateId !== 'string') {
    throw new Error(`save_marketing_template failed: ${templateError?.message}`);
  }
  templateId = createdTemplateId;

  const { data: createdListId, error: listError } = await ownerClient.rpc('create_send_list', {
    p_company_id: companyId,
    p_name: listName,
    p_source: 'members',
    p_kind: 'fixed',
    p_filters: {},
    p_member_ids: [memberId],
  });
  if (listError || typeof createdListId !== 'string') throw new Error(`create_send_list failed: ${listError?.message}`);
  listId = createdListId;
});

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test('a send list becomes a WhatsApp campaign on the real screen, the worker drains it, and the database shows a real send', async ({
  page,
  baseURL,
}) => {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(ownerEmail);
  await page.getByLabel('Password', { exact: true }).fill(ownerInitialPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // provision_customer always sets must_change_password (0016), regardless of
  // how the password was chosen -- the same first-login detour
  // reports.spec.ts and dashboards.spec.ts both walk through for real.
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByPlaceholder('New password').fill(ownerChosenPassword);
  await page.getByPlaceholder('Repeat the password').fill(ownerChosenPassword);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await openNavSection(page, 'Messages');
  await page.getByRole('link', { name: 'Campaigns' }).click();
  await expect(page).toHaveURL(/\/messages\/campaigns$/);
  await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible();

  await page.getByTestId('new-campaign-open').click();
  await expect(page.getByRole('heading', { name: 'New campaign' })).toBeVisible();

  // Channel stays WHATSAPP, the dialog's own default.
  await page.getByTestId('campaign-list-select').selectOption(listId);

  // The template dropdown is re-fetched once the list (and so the Station)
  // is known; wait for OUR template's option to attach before choosing it,
  // rather than a fixed sleep.
  const templateSelect = page.getByTestId('campaign-template-select');
  await expect(templateSelect.locator(`option[value="${templateId}"]`)).toBeAttached({ timeout: 15_000 });
  await templateSelect.selectOption(templateId);

  // The Send button only renders once the reach check comes back positive
  // (canSubmit, new-campaign-dialog.tsx) -- this listener's own consent is
  // what makes that reach 1 rather than 0.
  const sendButton = page.getByTestId('campaign-send');
  await expect(sendButton).toBeVisible({ timeout: 15_000 });
  await sendButton.click();

  // Reached, not sent: this proves createCampaignAction ran to completion and
  // closed the dialog -- see this file's own header for why nothing here is
  // read as proof that a message went anywhere.
  await expect(page.getByRole('heading', { name: 'New campaign' })).toBeHidden({ timeout: 15_000 });

  await page.reload();
  const row = page.getByTestId('campaign-row').filter({ hasText: templateInternalName });
  await expect(row).toBeVisible();
  await expect(row.getByText('Queued')).toBeVisible();

  // The worker. Production runs this every ten seconds via pg_cron; one call
  // is all a single-recipient campaign needs to drain.
  const tick = await runWorkerTick(baseURL ?? 'http://localhost:3000');
  const campaigns = (tick.campaigns ?? {}) as { error?: string; claimed?: number };
  expect(campaigns.error ?? null, 'the campaign drain reported an error').toBeNull();
  expect(campaigns.claimed, 'the tick claimed no recipient row').toBeGreaterThanOrEqual(1);

  // THE DATABASE, not the screen: the campaign's own counters, read straight
  // from message_campaigns rather than from anything the grid renders.
  const { data: campaignRow, error: campaignReadError } = await admin
    .from('message_campaigns')
    .select('id, status, total_recipients, sent_count, failed_count, suppressed_count')
    .eq('list_id', listId)
    .single();
  expect(campaignReadError, campaignReadError?.message).toBeNull();
  expect(campaignRow?.status).toBe('sent');
  expect(campaignRow?.total_recipients).toBe(1);
  expect(campaignRow?.sent_count).toBe(1);
  expect(campaignRow?.failed_count).toBe(0);
  expect(campaignRow?.suppressed_count).toBe(0);

  // And the recipient row itself: a provider_message_id in FakeTransport's
  // own `wamid.FAKE<n>` shape (src/lib/integrations/whatsapp/fake.ts) is the
  // one thing on this row that could only have arrived by the fake actually
  // being called with a real payload -- not by a status column being flipped
  // by something that merely reached the queue.
  const { data: recipientRow, error: recipientReadError } = await admin
    .from('message_campaign_recipients')
    .select('status, provider_message_id, address')
    .eq('campaign_id', campaignRow!.id)
    .single();
  expect(recipientReadError, recipientReadError?.message).toBeNull();
  expect(recipientRow?.status).toBe('sent');
  expect(recipientRow?.provider_message_id).toMatch(/^wamid\.FAKE\d+$/);
  // The address the drain actually sent to: the screen resolves it from the
  // member's own phoneNormalized (normalize_phone, digits only, 0031), not
  // the raw string this file typed into create_member's p_phone.
  expect(recipientRow?.address).toBe(listenerPhone.replace(/[^0-9]/g, ''));

  // The screen agrees with the database, once reloaded -- a courtesy check,
  // not the proof: an operator reading "Sent" on a row this file already
  // confirmed sent from the database is what the screen is FOR.
  await page.reload();
  await expect(row.getByText('Sent', { exact: true })).toBeVisible();
});
