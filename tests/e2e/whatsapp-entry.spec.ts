import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
  LOCAL_SUPABASE_DB_URL,
} from '../local-supabase';
import { WHATSAPP_APP_SECRET_FOR_TESTS, WORKER_TICK_SECRET_FOR_TESTS } from '../whatsapp-test-env';
import { provisionCustomer } from './provision';

/**
 * Block 19a, Task 9. The journey this whole block exists for: a WhatsApp
 * hashtag becomes a real, addressed link, and the link opens the widget
 * already identified.
 *
 * WHY THIS RUNS OVER REAL HTTP RATHER THAN CALLING THE RPCS DIRECTLY, the
 * same reasoning tests/e2e/whatsapp-boundary.spec.ts's own header gives:
 * it is the only place a signed POST crosses src/middleware.ts, the only
 * place `/api/worker/tick` runs for real, and the only place a browser
 * actually follows the 303 `/enter` redirects, stores the `pw_session`
 * cookie and renders the widget from it. tests/isolation/whatsapp.test.ts
 * and whatsapp-link-load.test.ts drive the database side of this same path
 * — the ingest, the mint, the enqueue — at a scale (two hundred at once)
 * this file could never afford; this file is the one proof that a REAL
 * inbound message, decided by a REAL worker tick, produces a link a REAL
 * browser can open and finish the journey from.
 *
 * FIVE CASES BEYOND THE JOURNEY ITSELF, carried here rather than faked at
 * unit level because every one of them is either a full server round trip
 * (`page.tsx` deciding between the identify form and the menu) or a genuine
 * cross-cutting failure (a Station switched off between the link being
 * minted and the link being opened):
 *
 *   1. `open=music` lands on the song panel, identified, and a request
 *      recorded from it lands in `music_requests` with `channel = 'WEB'`
 *      (the door used to submit it, not the channel the listener arrived
 *      by — those are two different facts).
 *   2. `open=promotion&id=<uuid>` lands on THAT promotion's panel.
 *   3. A malformed or unknown `id` lands on the menu — never an error.
 *   4. `?link=expired` shows the sentence above the identify form, both
 *      when a used link is opened a second time and when the parameter is
 *      visited directly.
 *   5. THE ONE THIS CASE EXISTS FOR: the same sentence, not a 404, at a
 *      Station switched off after the link was minted. `page.tsx` 404s a
 *      dark Station on every other path; only `?link=expired` makes it
 *      render the identify form instead (`page.tsx`'s own comment on
 *      `installationExists`).
 */

const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const adminEmail = `whatsapp-entry-admin-${stamp}@example.test`;
const adminPassword = `Admin-${stamp}-aA1!`;
const ownerEmail = `whatsapp-entry-owner-${stamp}@example.test`;
const ownerPassword = `Init-${stamp}-aA1!`;

/** Distinct per listener, so a rerun mints its own member and its own code. */
const JOURNEY_LOCAL_PHONE = `11${String(stamp).slice(-9)}`;
const JOURNEY_DELIVERED_PHONE = `55${JOURNEY_LOCAL_PHONE}`;
const DARK_STATION_LOCAL_PHONE = `21${String(stamp).slice(-9)}`;
const DARK_STATION_DELIVERED_PHONE = `55${DARK_STATION_LOCAL_PHONE}`;

const MUSIC_HASHTAG = '#MUSICA';
const PHONE_NUMBER_ID = `e2e-entry-${stamp}`;

const PROMOTION_NAME = `Entry Journey Promotion ${stamp}`;
const PROMOTION_RULES = `Regras exclusivas da promoção aberta por link direto, edição ${stamp}.`;
const LISTENER_NOTE = 'pode tocar essa pra mim, por favor';

let organizationId: string;
let companyId: string;
let publicKey: string;
let promotionId: string;

/** `pw_` + 16 random bytes, base64url — `widget_installations_key_shape` (0159). */
function generatePublicKeyLocal(): string {
  return `pw_${randomBytes(16).toString('base64url')}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The same HMAC verifyMetaSignature checks (src/lib/integrations/whatsapp/signature.ts). */
function signBody(raw: string): string {
  return `sha256=${createHmac('sha256', WHATSAPP_APP_SECRET_FOR_TESTS).update(raw).digest('hex')}`;
}

/** A minimal, structurally valid Meta webhook body carrying one text message. */
function metaBody(wamid: string, from: string, text: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) {
    throw new Error(`could not create a profile for ${email}: ${profileError.message}`);
  }
  return data.user.id;
}

/**
 * A live WhatsApp integration, written straight into Postgres as its
 * superuser — `integrations` carries no PostgREST grant for any role, the
 * same escape hatch tests/e2e/widget.spec.ts's own seedIntegration and
 * tests/isolation/harness.ts's seedIntegration document at length.
 */
async function seedIntegration(organizationId: string, companyId: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query(
      `insert into public.integrations
         (organization_id, company_id, provider, phone_number_id, enabled)
       values ($1, $2, 'WHATSAPP', $3, true)`,
      [organizationId, companyId, PHONE_NUMBER_ID],
    );
  } finally {
    await client.end();
  }
}

/**
 * Reads a queued outbox row by dedupe key, polling because the worker tick
 * this file triggers explicitly still runs asynchronously relative to the
 * POST that requested it — the same shape widget.spec.ts's own
 * codeFromTheOutbox uses, and for the same reason.
 */
async function readOutboxBody(dedupeKey: string): Promise<{ body: string; toPhone: string }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await admin
      .from('outbox_messages')
      .select('body, to_phone')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (error) throw new Error(`could not read the outbox: ${error.message}`);
    if (data?.body) return { body: data.body, toPhone: data.to_phone };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no outbox row for dedupe key ${dedupeKey}; no link was ever enqueued`);
}

/** The full link URL, the last thing on its own line (buildServiceMessage, src/lib/widget/service-link.ts). */
function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`no link found in outbox body: ${body}`);
  return match[0]!;
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(adminEmail, adminPassword);
  const { error: platformAdminError } = await admin
    .from('platform_admins')
    .insert({ user_id: adminUserId });
  if (platformAdminError) {
    throw new Error(`could not seed platform admin: ${platformAdminError.message}`);
  }

  const ownerUserId = await createAuthUser(ownerEmail, ownerPassword);

  const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await adminClient.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signInError) throw new Error(`could not sign in the platform admin: ${signInError.message}`);

  const { organization_id, company_id } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: `WhatsApp Entry Org ${stamp}`,
    companyName: `WhatsApp Entry Station ${stamp}`,
  });
  organizationId = organization_id;
  companyId = company_id;

  await seedIntegration(organizationId, companyId);

  publicKey = generatePublicKeyLocal();
  const { error: installError } = await adminClient.rpc('upsert_widget_installation', {
    p_company_id: companyId,
    p_public_key: publicKey,
    p_enabled: true,
    p_allowed_origins: ['https://whatsapp-entry.example'],
  });
  if (installError) throw new Error(`could not seed the installation: ${installError.message}`);

  const ownerClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: ownerSignInError } = await ownerClient.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (ownerSignInError) throw new Error(`could not sign in the owner: ${ownerSignInError.message}`);

  // The Messages screen's own door (0177), through templates.manage — which
  // the owner bypass satisfies, the same way every other e2e fixture in this
  // suite seeds a permission-gated row.
  const { error: hashtagError } = await ownerClient.rpc('set_service_hashtags', {
    p_company_id: companyId,
    p_music: MUSIC_HASHTAG,
    // '' rather than null: the door folds an empty string to NULL before
    // either check runs (0177's own rule), and every production caller
    // (src/services/templates.ts's own setServiceHashtags) sends exactly
    // this shape for "leave this field closed" — never a bare null, which
    // the generated Args type does not even accept.
    p_service: '',
  });
  if (hashtagError) throw new Error(`could not set the music hashtag: ${hashtagError.message}`);

  // A promotion visible in the widget's own list (Block 17c's two
  // conditions: web_enabled AND rules text) so case 2 below has a real
  // promotion to land on. No hashtag of its own — this journey never sends
  // it one, and the point of case 2 is the PAGE deciding which panel to
  // show a listener already identified, not a second hashtag match.
  const { data: promoData, error: promoError } = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: PROMOTION_NAME,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
  });
  if (promoError || !promoData) {
    throw new Error(`could not seed the promotion: ${promoError?.message}`);
  }
  promotionId = promoData as string;
});

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test('a hashtag becomes a link, the link identifies, and the widget answers the open target it was minted for', async ({
  page,
  context,
  request,
}) => {
  const wamid = `wamid.entry-journey-${stamp}`;
  let link = '';

  await test.step('the signed webhook POST and the worker tick', async () => {
    const raw = metaBody(wamid, JOURNEY_DELIVERED_PHONE, 'quero uma música #MUSICA');
    const webhookResponse = await request.post('/api/webhooks/whatsapp', {
      data: raw,
      headers: { 'x-hub-signature-256': signBody(raw), 'content-type': 'application/json' },
      maxRedirects: 0,
    });
    expect(webhookResponse.status()).toBe(200);

    const tickResponse = await request.post('/api/worker/tick', {
      headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
    });
    expect(tickResponse.status()).toBe(200);
    const tickBody = (await tickResponse.json()) as { dbErrors: number };
    expect(tickBody.dbErrors, 'every database call the tick made succeeded').toBe(0);
  });

  await test.step('one link, addressed to the number that asked', async () => {
    const dedupeKey = `${sha256Hex(wamid)}:link`;
    const { body, toPhone } = await readOutboxBody(dedupeKey);
    expect(toPhone).toBe(JOURNEY_DELIVERED_PHONE);
    link = linkFromBody(body);
    expect(link).toContain(`/w/${publicKey}/enter`);
    expect(link).toContain('open=music');
  });

  await test.step('case 1: opening the link identifies the visitor and opens the song panel', async () => {
    const response = await page.goto(link);
    expect(response?.status()).toBe(200);

    await expect(page.getByTestId('widget-song-panel')).toBeVisible({ timeout: 30_000 });
    // Reaching WidgetMenu at all means claims !== null in page.tsx — the
    // page renders the identify form otherwise, whatever `open` says
    // (src/app/(widget)/w/[publicKey]/page.tsx). The song panel being the
    // one showing, with no click on "Request a song", is what proves
    // `open=music` was honoured rather than merely accepted.
    await expect(page.getByTestId('widget-identify-form')).toHaveCount(0);
  });

  await test.step('a request from the identified visitor lands in music_requests with channel WEB', async () => {
    await page.getByTestId('widget-song-search').fill('sozinho');
    await expect(page.getByTestId('widget-song-results')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('widget-song-results').getByRole('button').first().click();

    await page.getByTestId('widget-song-note').fill(LISTENER_NOTE);
    await page.getByTestId('widget-song-send').click();
    await expect(page.getByTestId('widget-song-recorded')).toBeVisible({ timeout: 30_000 });

    const { data: recorded, error } = await admin
      .from('music_requests')
      .select('channel, listener_note, member_id')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`could not read the request back: ${error.message}`);
    const request0 = recorded?.[0];
    expect(request0, 'the request reached music_requests').toBeTruthy();
    // The DOOR the request went through, not the channel the listener
    // arrived by (docs/WIDGET.md §8, Block 17b): a session minted from a
    // WhatsApp link still submits through the web widget's own action.
    expect(request0!.channel).toBe('WEB');
    expect(request0!.listener_note).toBe(LISTENER_NOTE);
  });

  await test.step('case 2: open=promotion&id=<uuid> lands on that specific promotion\'s panel', async () => {
    await page.goto(`http://localhost:3000/w/${publicKey}?open=promotion&id=${promotionId}`);
    await expect(page.getByTestId('widget-promotion-panel')).toBeVisible({ timeout: 30_000 });
    // THE RULES TEXT IS THIS PROMOTION'S OWN — proof that the id in the
    // query string, not merely "a" promotion, is what opened.
    await expect(page.getByTestId('widget-promotion-rules')).toContainText(PROMOTION_RULES);
  });

  await test.step('case 3: a malformed id lands on the menu, never an error', async () => {
    await page.goto(`http://localhost:3000/w/${publicKey}?open=promotion&id=not-a-uuid`);
    await expect(page.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('widget-problem')).toHaveCount(0);
  });

  await test.step('case 3: a well-formed but unknown id also lands on the menu, never an error', async () => {
    await page.goto(
      `http://localhost:3000/w/${publicKey}?open=promotion&id=00000000-0000-0000-0000-000000000000`,
    );
    await expect(page.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('widget-problem')).toHaveCount(0);
  });

  await test.step('case 4: opening the same link a second time shows the expired line', async () => {
    // The browser still carries the session the first open minted — cleared
    // here so this reaches the IdentifyForm branch rather than the menu
    // (a valid session wins over `link=expired` in page.tsx, which never
    // reads that parameter once claims !== null).
    await context.clearCookies();

    const response = await page.goto(link);
    expect(response?.status(), 'a used link is never a 404').toBe(200);
    await expect(page.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });
    const expiredLine = page.getByTestId('widget-link-expired');
    await expect(expiredLine).toBeVisible();
    await expect(expiredLine).toContainText('expired');

    // ABOVE the identify form, not merely present on the same screen.
    const [expiredBox, formBox] = await Promise.all([
      expiredLine.boundingBox(),
      page.getByTestId('widget-identify-form').boundingBox(),
    ]);
    expect(expiredBox).not.toBeNull();
    expect(formBox).not.toBeNull();
    expect(expiredBox!.y).toBeLessThan(formBox!.y);
  });

  await test.step('case 4: ?link=expired renders the same way visited directly', async () => {
    const response = await page.goto(`http://localhost:3000/w/${publicKey}?link=expired`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('widget-link-expired')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('widget-identify-form')).toBeVisible();
  });
});

test('case 5: a Station switched off after the link was minted still answers link=expired, never a 404', async ({
  page,
  request,
}) => {
  const wamid = `wamid.entry-dark-station-${stamp}`;
  let link = '';

  await test.step('mint a link for a second listener at the same Station', async () => {
    const raw = metaBody(wamid, DARK_STATION_DELIVERED_PHONE, 'quero uma música #MUSICA');
    const webhookResponse = await request.post('/api/webhooks/whatsapp', {
      data: raw,
      headers: { 'x-hub-signature-256': signBody(raw), 'content-type': 'application/json' },
      maxRedirects: 0,
    });
    expect(webhookResponse.status()).toBe(200);

    const tickResponse = await request.post('/api/worker/tick', {
      headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
    });
    expect(tickResponse.status()).toBe(200);

    const dedupeKey = `${sha256Hex(wamid)}:link`;
    const { body, toPhone } = await readOutboxBody(dedupeKey);
    expect(toPhone).toBe(DARK_STATION_DELIVERED_PHONE);
    link = linkFromBody(body);
  });

  await test.step('the Station goes dark before the link is ever opened', async () => {
    const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await adminClient.auth.signInWithPassword({
      email: adminEmail,
      password: adminPassword,
    });
    if (signInError) throw new Error(`could not sign in the platform admin: ${signInError.message}`);

    const { error: disableError } = await adminClient.rpc('upsert_widget_installation', {
      p_company_id: companyId,
      p_public_key: publicKey,
      p_enabled: false,
      p_allowed_origins: ['https://whatsapp-entry.example'],
    });
    if (disableError) throw new Error(`could not disable the installation: ${disableError.message}`);
  });

  await test.step('the link answers link=expired, not a 404 -- the whole reason this case exists', async () => {
    // A FRESH `page`: no session cookie from any earlier test can smuggle
    // this listener past the branch under test.
    const response = await page.goto(link);
    expect(response?.status(), 'a dark Station answers link=expired, never the plain 404 it gives everywhere else').toBe(
      200,
    );
    await expect(page.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('widget-link-expired')).toBeVisible();
  });
});
