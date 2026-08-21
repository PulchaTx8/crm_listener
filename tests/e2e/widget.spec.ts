import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
  LOCAL_SUPABASE_DB_URL,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 17a, Task 12. A visitor identifying themselves on a radio station's own
 * website — ACROSS TWO ORIGINS, which is the only configuration in which any of
 * this means anything.
 *
 * THE WHOLE POINT IS THE PAIR OF ORIGINS. The embedding page is served from
 * `http://127.0.0.1:<port>` by the throwaway server below; the widget is served
 * from `http://localhost:3000` by the application. Those are different origins
 * to a browser — different hosts — and that is what makes the iframe a
 * THIRD-PARTY frame. Same-origin, `SameSite=None` and `Partitioned` do nothing
 * observable at all (a Lax cookie would be sent just the same) and
 * `frame-ancestors` is never consulted, so a test pointing the iframe at
 * localhost from localhost is green and worthless. tests/e2e/widget-headers.spec
 * .ts asserts the HEADER VALUE from an API request; this file is the only thing
 * that asserts a BROWSER acts on it.
 *
 * WHAT ONLY THIS FILE CAN SHOW:
 *   - the cookie is stored at all in a third-party frame, with SameSite=None and
 *     a CHIPS partition key. Neither attribute is observable anywhere else, and
 *     both are load-bearing: without 'none' the browser silently drops the
 *     cookie and the widget forgets a visitor it just identified; without
 *     `Partitioned` it goes with Chrome's removal of unpartitioned third-party
 *     cookies, on a day nobody here deployed anything;
 *   - `frame-ancestors` actually refusing an origin the Station did not name,
 *     which is what makes the allowed case above a permission rather than a
 *     coincidence.
 *
 * THE FIXTURE IS ITS OWN. Nothing here reads scripts/seed-demo.mjs: a journey
 * that depended on the demo dataset would break the day somebody changed the
 * demo, with nothing in that diff to explain why.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const adminEmail = `widget-journey-admin-${stamp}@example.test`;
const adminPassword = `Admin-${stamp}-aA1!`;
const ownerEmail = `widget-journey-owner-${stamp}@example.test`;
const ownerPassword = `Init-${stamp}-aA1!`;

/**
 * The listener. Stamped, so each run mints its own code and its own bucket.
 *
 * SPLIT THE WAY THE SCREEN SPLITS IT, in two boxes: the country code the widget
 * prefills and the national number the visitor types. Kept as one constant
 * until 2026-08-11, when the form grew the country box — and the reason the
 * form grew it is that a single box sent Meta `11985954985`, a national number
 * with no country in front of it, which reaches a different subscriber in every
 * country that has one.
 */
const VISITOR_COUNTRY_CODE = '55';
const VISITOR_LOCAL_PHONE = `11${String(stamp).slice(-9)}`;
const VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${VISITOR_LOCAL_PHONE}`;
const VISITOR_NAME = 'Cross Origin Listener';

/**
 * Block 19b. The listener who exits, below — a phone distinct from
 * VISITOR_LOCAL_PHONE above, deliberately, and not a name-only distinction.
 * `CODE_PER_PHONE_MINUTE` (`src/app/(widget)/w/[publicKey]/actions.ts`) allows
 * one code every 60 seconds per number; every test in this file shares a
 * worker and runs back to back, and a shared phone would make this file's own
 * runtime the thing standing between the exit journey and a `rate_limited`
 * refusal that has nothing to do with what either test proves.
 */
const EXIT_VISITOR_LOCAL_PHONE = `21${String(stamp).slice(-9)}`;
const EXIT_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${EXIT_VISITOR_LOCAL_PHONE}`;
const EXIT_VISITOR_NAME = 'Listener Who Leaves';

/**
 * Block 20a, Task 4, fix round 1. The listener who leaves the field blank —
 * a third phone, for the same reason the exit journey above needed a second
 * one: `CODE_PER_PHONE_MINUTE` is per number, and every journey in this file
 * shares a worker and runs back to back.
 */
const MISSING_FIELD_VISITOR_LOCAL_PHONE = `31${String(stamp).slice(-9)}`;
const MISSING_FIELD_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${MISSING_FIELD_VISITOR_LOCAL_PHONE}`;
const MISSING_FIELD_VISITOR_NAME = 'Listener Who Forgets A Field';

/**
 * Block 20a, whole-branch review. The listener who ticks one promotion's
 * agreement box and then switches to another — a fourth phone, for the same
 * per-number reason the other three journeys in this file each needed their
 * own.
 */
const CONSENT_SWITCH_VISITOR_LOCAL_PHONE = `41${String(stamp).slice(-9)}`;
const CONSENT_SWITCH_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${CONSENT_SWITCH_VISITOR_LOCAL_PHONE}`;
const CONSENT_SWITCH_VISITOR_NAME = 'Listener Who Switches Promotions';

/**
 * Two promotions this journey needs open and visible at once. The `beforeAll`
 * fixture above seeds exactly one (Block 17c's own), which is not enough to
 * prove a listener can switch between two — so these are seeded alongside it,
 * in the same style, through the same door.
 */
const CONSENT_SWITCH_PROMOTION_A_NAME = `Widget Journey Promotion Reset A ${stamp}`;
const CONSENT_SWITCH_PROMOTION_B_NAME = `Widget Journey Promotion Reset B ${stamp}`;

/**
 * Block 20a, second round. The listener who is refused on one promotion and
 * then switches to another — a fifth phone, same per-number reason as the
 * four before it.
 */
const REFUSAL_SWITCH_VISITOR_LOCAL_PHONE = `51${String(stamp).slice(-9)}`;
const REFUSAL_SWITCH_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${REFUSAL_SWITCH_VISITOR_LOCAL_PHONE}`;
const REFUSAL_SWITCH_VISITOR_NAME = 'Listener Whose Refusal Follows Them';

/**
 * .superpowers/ci-widget-failure-diagnosis.md. The listener who answers the
 * question, steps back, and steps forward again — a sixth phone, same
 * per-number reason as the five before it.
 */
const PHANTOM_ENTRY_VISITOR_LOCAL_PHONE = `61${String(stamp).slice(-9)}`;
const PHANTOM_ENTRY_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${PHANTOM_ENTRY_VISITOR_LOCAL_PHONE}`;
const PHANTOM_ENTRY_VISITOR_NAME = 'Listener Whose Next Button Writes Early';

/**
 * Block 29c, Task 10. The marketing checkbox's three-way rule, end to end —
 * a seventh phone, same per-number reason as the six before it.
 */
const MARKETING_CONSENT_VISITOR_LOCAL_PHONE = `71${String(stamp).slice(-9)}`;
const MARKETING_CONSENT_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${MARKETING_CONSENT_VISITOR_LOCAL_PHONE}`;
const MARKETING_CONSENT_VISITOR_NAME = 'Listener Who Ticks Once';

/**
 * Block 30d, Task 6. The listener whose browser disagrees with the Station —
 * an eighth phone, same per-number reason as the seven before it.
 */
const LOCALE_VISITOR_LOCAL_PHONE = `81${String(stamp).slice(-9)}`;
const LOCALE_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${LOCALE_VISITOR_LOCAL_PHONE}`;
const LOCALE_VISITOR_NAME = 'Listener Whose Browser Disagrees With The Station';

/**
 * Block 30d, Task 9 (D8, D10). The listener a promotion asks nothing of — a
 * ninth phone, same per-number reason as the eight before it.
 */
const FAST_ENTRY_VISITOR_LOCAL_PHONE = `91${String(stamp).slice(-9)}`;
const FAST_ENTRY_VISITOR_PHONE = `+${VISITOR_COUNTRY_CODE}${FAST_ENTRY_VISITOR_LOCAL_PHONE}`;
const FAST_ENTRY_VISITOR_NAME = 'Listener Who Is Asked Nothing';

/**
 * Block 30d, Task 9. THE ONLY PROMOTION IN THIS FILE THAT DECLARES NO
 * REQUESTED FIELD AND NO QUESTION, which is what makes it the fast path: a
 * step list of `consent` alone, for any listener at all. The other three carry
 * a requested field each precisely so that they do NOT take this path — see
 * the seeding comment on the two consent-switch promotions below.
 */
const FAST_ENTRY_PROMOTION_NAME = `Widget Journey Promotion No Walk ${stamp}`;

/** Names the outbox row this run's code arrives on, and nobody else's. */
const TEMPLATE_NAME = `web_verification_journey_${stamp}`;

/**
 * `pw_` + 16 random bytes, base64url — `widget_installations_key_shape` (0159).
 *
 * REPRODUCED RATHER THAN IMPORTED from src/lib/widget/code.ts, for the reason
 * tests/e2e/widget-headers.spec.ts records at the same line: that module is
 * `import 'server-only'` at its first line, which vitest aliases to a stub and
 * Playwright does not, so importing it here would throw before the first test
 * ran.
 */
const publicKey = `pw_${randomBytes(16).toString('base64url')}`;

/** What the listener types alongside the request — Block 17b's note (D3). */
const LISTENER_NOTE = 'toca pra minha mae, ela ouve todo dia';

/** Block 17c. Without rules a promotion does not appear in the widget at all (D3). */
const PROMOTION_RULES = 'Promoção válida para maiores de 18 anos. Um cupom por pessoa.';

/**
 * Block 30d, item 1a. The quiz question's own text, seeded through
 * `save_promotion_question` below and asserted on screen further down. Lifted
 * to a constant read by both sites so the two cannot drift into a test that
 * passes against a sentence that merely looks like the one the door sent.
 */
const QUESTION_PROMPT = 'Qual é a capital do estado?';

/**
 * The Block 17c fixture promotion's own name — named here, not just inlined
 * where it is created, because Block 20a's refusal-switch journey below
 * needs to pick it out of a list by role rather than by position: that list
 * holds three promotions once the two consent-switch fixtures join it, and
 * `ends_at` ties between them (all seeded with the same offset) make
 * position an unreliable way to tell them apart.
 */
const PRIMARY_PROMOTION_NAME = `Widget Journey Promotion ${stamp}`;

/** The city this listener types into the one field the promotion asks for. */
const LISTENER_CITY = 'Santos';

/**
 * The Station this journey provisions, lifted to module scope by Block 17b so
 * the request can be read back out of `music_requests` after the widget claims
 * to have recorded it. The panel's confirmation is the widget's opinion of what
 * happened; the row is the fact.
 */
let journeyCompanyId: string;

let appOrigin: string;
/** The Station's own website: the origin its installation names. */
let embedder: Server;
let embedOrigin: string;
/** Somebody else's website: the same host, a different port, therefore a different origin. */
let stranger: Server;
let strangerOrigin: string;

/**
 * A page whose entire content is the iframe, exactly as a Station's webmaster
 * would paste it. `id` so the spec can name the frame without matching on a URL
 * that carries a generated key.
 */
function embeddingPage(): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Station site</title></head>' +
    '<body><h1>Rádio Example</h1>' +
    `<iframe id="widget" title="widget" src="${appOrigin}/w/${publicKey}" width="420" height="420"></iframe>` +
    '</body></html>'
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // 127.0.0.1 RATHER THAN localhost, and the two are not interchangeable here:
  // `localhost` is the host the application is served on, so an embedding page
  // there would be SAME-ORIGIN with the widget and every assertion in this file
  // would hold for the wrong reason. Port 0 lets the operating system choose,
  // because a fixed port is a fixture that fails on whichever machine already
  // has something on it.
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
 * A live WhatsApp integration, written straight into Postgres as its superuser.
 *
 * THERE IS NO OTHER ROUTE, and this is the same escape hatch — with the same
 * justification — that tests/isolation/harness.ts's seedIntegration documents at
 * length: `integrations` (0057) carries no PostgREST grant for ANY role,
 * service_role included, because every reader of it in production is inside a
 * SECURITY DEFINER body. Without one, widget_request_code refuses with
 * `no_integration` (0161) and the journey below never leaves its first screen.
 * tests/e2e/deadline.spec.ts and draw-flow.spec.ts already reach Postgres this
 * way from a spec.
 */
async function seedIntegration(organizationId: string, companyId: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    // `enabled` explicitly true: it defaults to false (0057, "a half-configured
    // row cannot start taking traffic") and widget_request_code's lookup
    // requires it.
    await client.query(
      `insert into public.integrations
         (organization_id, company_id, provider, phone_number_id, enabled)
       values ($1, $2, 'WHATSAPP', $3, true)`,
      [organizationId, companyId, `widget-journey-${stamp}`],
    );
  } finally {
    await client.end();
  }
}

/**
 * The six digits, out of the one place in this system they exist in the clear:
 * `outbox_messages.template_variables` (0161's header comment says so in
 * writing, and `body` beside it holds the masked text instead).
 *
 * Read with the SERVICE CLIENT, the way tests/isolation/conversation.test.ts
 * reads what the bot enqueued. Nothing else can: this row belongs to a table no
 * user-scoped client reaches, which is the property that lets the code travel
 * there at all.
 *
 * KEYED ON THE TEMPLATE NAME, which is stamped per run, so this can never pick
 * up a code left behind by an earlier run or by the demo seed. Both listeners
 * in this file register through the same template (one per Station, not per
 * visitor), so the row this reads back is always the most recently enqueued
 * one — which, since the two identify journeys in this file run one after the
 * other in the same worker, is always the caller's own.
 *
 * `expectedPhone` IS A PARAMETER, NOT A CONSTANT, because Block 19b's exit
 * journey below identifies as a second, distinct listener (see
 * EXIT_VISITOR_PHONE's own comment) rather than reusing VISITOR_PHONE — so
 * the number this function checks the row against has to travel with the
 * call, not be assumed.
 */
async function codeFromTheOutbox(expectedPhone: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await admin
      .from('outbox_messages')
      .select('template_variables, body, to_phone')
      .eq('template_name', TEMPLATE_NAME)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(`could not read the outbox: ${error.message}`);

    const row = data?.[0];
    if (row) {
      const variables = row.template_variables;
      if (!Array.isArray(variables) || typeof variables[0] !== 'string') {
        throw new Error(
          `the outbox row carries no code in template_variables: ${JSON.stringify(variables)}`,
        );
      }
      // The masked body is asserted here rather than in a case of its own
      // because this is the only place in the suite that holds both halves at
      // once. 0161 overwrites `body` with the masked text in the same
      // transaction as the insert, precisely because `body` is never pruned and
      // a live code left in it would outlive its own ten-minute expiry.
      expect(row.body, 'the code is masked in the column retention never prunes').not.toContain(
        variables[0],
      );
      // THE NUMBER THE WORKER WILL HAND TO META, at the end of the chain that
      // starts in the browser: two boxes, a hidden field, a server action, an
      // RPC, and this column. Between 2026-08-10 and 2026-08-11 it held
      // `11985954985` — no country code — and every layer was behaving as
      // documented while the send went nowhere. Asserted against the full
      // international number so no layer can quietly drop the front of it again.
      expect(row.to_phone, 'the queued number carries its country code').toBe(expectedPhone);
      return variables[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no outbox row for template ${TEMPLATE_NAME}; no code was ever enqueued`);
}

/**
 * Block 19b. The two-step identify flow — request a code, confirm it — reused
 * by every journey in this file that needs to reach the menu inside the
 * cross-origin frame. EXTRACTED RATHER THAN COPIED: a second, hand-written
 * version of what "identifying" means is exactly how it could quietly drift
 * from what the door actually requires, and the exit journey below would then
 * be proving a shortcut rather than the real thing (the same reasoning
 * whatsapp-entry.spec.ts's own case 5a/5b split gives for never sharing a
 * listener across cases that must stay independent).
 *
 * Returns the `FrameLocator` once `widget-menu` is visible — the same point
 * the identify journey below continues from, and the same point the exit
 * journey clicks "Sair" from.
 */
async function identifyInFrame(
  page: Page,
  { localPhone, phone, name }: { localPhone: string; phone: string; name: string },
): Promise<FrameLocator> {
  await page.goto(`${embedOrigin}/`);

  const widget = page.frameLocator('#widget');
  await expect(widget.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });

  // The country box comes prefilled with Brazil; filled explicitly anyway, so
  // this journey states the number it means rather than inheriting a default a
  // later edit could change underneath it.
  await widget.locator('#widget-country-code').fill(VISITOR_COUNTRY_CODE);
  await widget.locator('#widget-phone').fill(localPhone);
  await widget.locator('#widget-name').fill(name);

  // THE NUMBER THE SEND WILL ACTUALLY CARRY, read off the screen the visitor is
  // looking at. Asserted here rather than only against the outbox because the
  // whole defect this box exists for was invisible on screen: the visitor typed
  // a number that looked right, and the country code was missing everywhere
  // downstream.
  await expect(widget.getByTestId('widget-phone-preview')).toContainText(phone);
  // PORTUGUESE: Block 30d/D7 makes the fixture Station's chosen
  // `listener_locale` ('pt', seeded in `beforeAll`) win over this browser's
  // pinned `en-US`, for every visitor to this installation -- this helper
  // included.
  await widget.getByRole('button', { name: 'Enviar código' }).click();

  // Either the second screen or a refusal — whichever arrives, so a refusal is
  // reported as itself rather than as a timeout waiting for the screen it
  // prevented.
  await widget
    .locator('[data-testid="widget-code-form"], [data-testid="widget-problem"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await assertNotRefused(widget);

  const code = await codeFromTheOutbox(phone);
  expect(code, 'six digits, leading zeros intact').toMatch(/^\d{6}$/);

  // THE BOX HAS TO BE EMPTY, and this is not fussiness about tidiness. The two
  // forms live in the same slot of one ternary, so React reconciles them child
  // by child: when the label holding the name input and the label holding the
  // code input land on the same index, React REUSES the DOM node. The name
  // input is controlled and the code input is not, so nothing clears it and the
  // visitor is asked to type six digits into a box that already says their
  // name. Asserted before the fill, because `fill` would paper over it.
  await expect(widget.locator('#widget-code')).toHaveValue('');

  await widget.locator('#widget-code').fill(code);
  await widget.getByRole('button', { name: 'Confirmar' }).click();

  // THE MENU, INSIDE THE FRAME. Reaching it means the whole chain worked in a
  // third-party context: the action wrote the cookie, the browser STORED it (a
  // Lax cookie would have been dropped here), `router.refresh()` sent it back,
  // and the page's readSessionFor accepted it for this installation.
  await expect(widget.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });
  await assertNotRefused(widget);

  return widget;
}

/**
 * Fails with WHAT THE WIDGET SAID rather than with a timeout three steps later.
 *
 * Every refusal this journey can hit — an unconfigured secret, a spent rate
 * limit, a Station with no template — renders one sentence in `widget-problem`
 * and leaves the form exactly where it was. Without this, all of them present as
 * "the code form never appeared", which is the least informative description of
 * any of them.
 */
async function assertNotRefused(widget: FrameLocator): Promise<void> {
  const problem = widget.getByTestId('widget-problem');
  if ((await problem.count()) > 0) {
    throw new Error(`the widget refused the submission: "${(await problem.innerText()).trim()}"`);
  }
}

test.beforeAll(async ({}, testInfo) => {
  // FROM THE PROJECT'S OWN baseURL rather than a second copy of it here: the
  // iframe must point at the application Playwright started, and a constant that
  // drifted from playwright.config.ts would silently point this journey at
  // nothing (or, worse, at a developer's other server).
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('this spec needs the project baseURL to build the iframe src');
  appOrigin = new URL(baseURL).origin;

  embedder = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(embeddingPage());
  });
  embedOrigin = await listen(embedder);

  stranger = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(embeddingPage());
  });
  strangerOrigin = await listen(stranger);

  const adminUserId = await createAuthUser(adminEmail, adminPassword);
  const { error } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (error) throw new Error(`could not seed platform admin: ${error.message}`);

  const ownerUserId = await createAuthUser(ownerEmail, ownerPassword);

  const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await adminClient.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signInError) throw new Error(`could not sign in the platform admin: ${signInError.message}`);

  const { organization_id: organizationId, company_id: companyId } = await provisionCustomer(
    adminClient,
    {
      userId: ownerUserId,
      organizationName: `Widget Journey Org ${stamp}`,
      companyName: `Widget Journey Station ${stamp}`,
    },
  );

  await seedIntegration(organizationId, companyId);

  // AS THE OWNER, not as the platform admin: register_message_template is gated
  // on has_permission('templates.manage', …) (0113), which reads Organization
  // membership — a platform admin is not a member of anything.
  const ownerClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: ownerSignInError } = await ownerClient.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (ownerSignInError) throw new Error(`could not sign in the owner: ${ownerSignInError.message}`);

  // ONE placeholder, because widget_request_code passes exactly one variable and
  // enqueue_whatsapp_outbound (0111) refuses a count that does not match.
  const { error: templateError } = await ownerClient.rpc('register_message_template', {
    p_company_id: companyId,
    p_purpose: 'WEB_VERIFICATION',
    p_name: TEMPLATE_NAME,
    p_language: 'pt_BR',
    p_body: 'Seu código é {{1}}.',
    // Block 29b-1: p_variables is now a closed vocabulary (0223) rather than
    // prose an operator typed -- VERIFICATION_CODE matches the single {{1}}
    // above.
    p_variables: ['VERIFICATION_CODE'],
  });
  if (templateError) throw new Error(`could not register the template: ${templateError.message}`);

  // Through the console's own door (0162/0163), signed in as the platform admin
  // it is gated on. THE ONE ALLOWED ORIGIN IS THE THROWAWAY SERVER'S, which is
  // why the installation is written after that server has a port: the value has
  // to be the real origin, port and all, because `frame-ancestors` compares
  // ports and an allowlist naming the wrong one would refuse the very page this
  // spec serves.
  const { error: upsertError } = await adminClient.rpc('upsert_widget_installation', {
    p_company_id: companyId,
    p_public_key: publicKey,
    p_enabled: true,
    p_allowed_origins: [embedOrigin],
  });
  if (upsertError) throw new Error(`could not seed the installation: ${upsertError.message}`);

  // Block 30d, Task 6, D7. THIS Station's own choice, seeded once here rather
  // than only right before the test that needs it, because every test in this
  // file shares this one installation -- the same reason `journeyCompanyId`
  // below is set once. AS THE OWNER, same client the template registration
  // above already signed in: set_listener_locale is gated on
  // templates.manage, which a platform admin does not hold (Organization
  // membership is what has_permission reads, and a platform admin is not a
  // member of anything).
  const { error: localeError } = await ownerClient.rpc('set_listener_locale', {
    p_company_id: companyId,
    p_locale: 'pt',
  });
  if (localeError) throw new Error(`could not seed the listener locale: ${localeError.message}`);

  // Block 17b reads the request back from this Station, and the cooldown stays
  // at its default of zero: this journey makes one request, and a ceiling it
  // never reaches would prove nothing while making the test's own second run
  // fail for a reason that is not a defect.
  journeyCompanyId = companyId;

  // Block 17c. A promotion the widget will actually show: ticked for the web
  // AND carrying rules, which are two conditions rather than one (D1, D3).
  //
  // THROUGH create_promotion AS THE OWNER, not a service-key insert. The first
  // draft inserted directly and took `permission denied for table promotions` —
  // service_role has SELECT on this schema and almost no INSERT — and the
  // refusal pointed at the better route: this exercises 0172's own door,
  // including the two parameters it gained, so the journey proves the write
  // path a real operator uses rather than one only a test can reach.
  // The owner client the template registration above already signed in — one
  // session, not a second one for the sake of a second statement.
  const { error: promotionError } = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: PRIMARY_PROMOTION_NAME,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
    // Two fields, on ONE screen: `screensFor` groups every field step together,
    // so the walk still has two screens -- consent, then the fields. Allowed on
    // the strength of p_web_enabled alone, which is exactly what 0171's
    // promotions_conversational_shape replaced promotions_whatsapp_shape to
    // permit, and what this journey proves end to end.
    //
    // THE SECOND ONE IS THE GENDER BLOCK'S, and it is here rather than in a
    // spec of its own because it is the only CHOICE-shaped field: the widget
    // draws it as a <select> instead of a text box, and the value it posts has
    // to survive gender_normalize (0220) on the way into a column with a CHECK
    // constraint. Nothing short of this journey exercises that chain.
    p_requested_fields: ['city', 'gender'],
  });
  if (promotionError) throw new Error(`could not seed the promotion: ${promotionError.message}`);

  // Block 17c, first repair. A QUIZ ON THE JOURNEY, because the defect this
  // file missed was exactly the difference between the two answer shapes:
  // participation_answers_shape (0052) wants `option_id` for a question with
  // alternatives and `answer_text` for an open one, and a panel that drew a
  // text box for both reached a listener as "something went wrong".
  const { data: promotionRows } = await admin
    .from('promotions')
    .select('id')
    .eq('company_id', companyId)
    .limit(1);
  const seededPromotionId = promotionRows?.[0]?.id as string;

  const { error: questionError } = await ownerClient.rpc('save_promotion_question', {
    p_promotion_id: seededPromotionId,
    p_kind: 'QUIZ',
    p_prompt: QUESTION_PROMPT,
    // Required for a question with alternatives (promotion_questions_list_fields)
    // even on a promotion that only converses on the web — a one-door assumption
    // still standing, and noted rather than fixed as a passenger here.
    p_menu_title: 'Escolha uma',
    p_button_label: 'Responder',
    p_options: [
      { label: 'São Paulo', is_correct: true },
      { label: 'Santos', is_correct: false },
    ],
  });
  if (questionError) throw new Error(`could not seed the quiz: ${questionError.message}`);

  // Block 20a, whole-branch review. TWO MORE PROMOTIONS, each asking for ONE
  // requested field and no question, because the journeys below need their
  // consent screen to exist at all. It exists to prove what carries across a
  // promotion SWITCH, not to prove a promotion can be entered; that is already
  // proved above and by the missing-field case below. Seeded AFTER
  // `seededPromotionId` is read back, on purpose: that lookup has no filter
  // beyond `company_id`, and seeding these two first would leave it free to
  // pick either one instead of Block 17c's own.
  //
  // BLOCK 30d, TASK 9 GAVE THEM THAT FIELD, and both halves of the choice
  // matter. These two were consent only until 0268; from 0268 a promotion with
  // no field and no question is the FAST PATH — `needsNoWalk`
  // (promotion-mapping.ts) — and the panel submits it straight from the list
  // with no consent screen drawn, so all three journeys below would have found
  // no checkbox to tick. A field restores the screen without weakening
  // anything they assert: none of them is about what the field is.
  //
  // TWO DIFFERENT FIELDS, NOT ONE. The marketing journey enters A and then B
  // with the same listener; had both asked for `city`, filling it on A would
  // have satisfied B (`whatsapp_conversation_steps` asks only for what a
  // listener has not got), B would have become the fast path for that listener
  // alone, and that journey's second consent screen would have vanished
  // mid-test.
  const { error: promotionAError } = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: CONSENT_SWITCH_PROMOTION_A_NAME,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
    p_requested_fields: ['city'],
  });
  if (promotionAError) {
    throw new Error(`could not seed the consent-switch promotion A: ${promotionAError.message}`);
  }

  const { error: promotionBError } = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: CONSENT_SWITCH_PROMOTION_B_NAME,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
    p_requested_fields: ['address'],
  });
  if (promotionBError) {
    throw new Error(`could not seed the consent-switch promotion B: ${promotionBError.message}`);
  }

  // Block 30d, Task 9 (D8, D10). THE PROMOTION THAT ASKS NOTHING, and the only
  // one in this file: no requested field and no question, so
  // `whatsapp_conversation_steps` answers `consent` and nothing else for every
  // listener alive. That is the pair the fast path is a fact about, and it is
  // why this journey needs a promotion of its own rather than a listener of
  // its own on an existing one.
  const { error: fastPromotionError } = await ownerClient.rpc('create_promotion', {
    p_company_id: companyId,
    p_name: FAST_ENTRY_PROMOTION_NAME,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
  });
  if (fastPromotionError) {
    throw new Error(`could not seed the no-walk promotion: ${fastPromotionError.message}`);
  }

  // THE PER-IP HOURLY BUCKETS, CLEARED, and they are the one piece of state
  // this journey shares with its own previous runs. Every limit in actions.ts
  // is keyed by the telephone number except these two, which are keyed by
  // `x-forwarded-for` — absent on a direct connection, so every local run of
  // this file spends one of ten per hour from the same address-less bucket. The
  // eleventh would fail with `rate_limited`, which is not a defect in anything
  // this file tests and reads exactly like one. The phone and Station buckets
  // are stamped per run and left alone.
  //
  // MATCHED ON THE PREFIX, NOT ON THE WHOLE KEY, and that is the point rather
  // than a shortcut. These were written as the literals
  // `widget:code:ip:unknown` and `widget:verify:ip:unknown`, which is what the
  // keys were until actions.ts started hashing its rate-limit subjects — after
  // which the suffix became a digest, `.in([...])` matched zero rows, and A
  // DELETE THAT MATCHES NOTHING RAISES NOTHING. The guard was gone and nothing
  // said so; it would have surfaced on somebody's tenth run inside an hour,
  // wearing the costume of a real failure. That suffix has now moved twice, so
  // it is not pinned here at all: everything after `widget:<step>:ip:` is
  // whatever the action decides, and this deliberately does not have an opinion
  // about it. The prefixes below are still named separately rather than
  // collapsed into one pattern, because they are independent limits and a
  // reader has to be able to see that all of them were cleared.
  //
  // `widget:promo:list:ip:` and `widget:promo:enter:ip:`
  // (`promotion-actions.ts`) joined the first two once this branch added a
  // journey that calls `widget_enter_promotion`: `ENTER_PER_IP_HOUR` is the
  // same shape of address-less, 20-per-hour bucket as the other two, and a
  // full local run now spends two of the twenty instead of one. Left
  // uncleared, that halves the headroom before an unrelated `rate_limited`
  // for every run after the first.
  //
  // `unsubscribe:` (Block 29c, Task 10) joined the same way, for the
  // sharpest ceiling of the five: `unsubscribe/[token]/page.tsx`'s own
  // MAX_PER_WINDOW is 5 per hour, not 10 or 20, so it is the first of these
  // buckets a repeated local run would exhaust.
  for (const prefix of [
    'widget:code:ip:',
    'widget:verify:ip:',
    'widget:promo:enter:ip:',
    'widget:promo:list:ip:',
    'unsubscribe:',
  ]) {
    const { error: bucketError } = await admin
      .from('rate_limit_counters')
      .delete()
      .like('key', `${prefix}%`);
    if (bucketError) {
      throw new Error(`could not clear the ${prefix} buckets: ${bucketError.message}`);
    }
  }
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => embedder.close(() => resolve()));
  await new Promise<void>((resolve) => stranger.close(() => resolve()));
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test('a visitor identifies themselves from another origin, and asks for a song', async ({
  page,
  context,
}) => {
  const widget = await identifyInFrame(page, {
    localPhone: VISITOR_LOCAL_PHONE,
    phone: VISITOR_PHONE,
    name: VISITOR_NAME,
  });

  // THE ASSERTION THAT KEEPS THIS FILE HONEST, and it is taken from the browser
  // rather than from the constants above. If a later edit ever pointed the
  // iframe at the same host as the top-level page, every other assertion here
  // would still pass — the cookie would be a first-party cookie, `SameSite` and
  // `Partitioned` would be inert, and `frame-ancestors` would never be
  // consulted. This is the line that fails instead.
  const frame = page.frames().find((candidate) => candidate.url().includes(`/w/${publicKey}`));
  expect(frame, 'the widget document is a frame of this page').toBeTruthy();
  expect(new URL(page.url()).origin).not.toBe(new URL(frame!.url()).origin);

  // Block 19b. The counterpart to whatsapp-entry.spec.ts's assertion, and the
  // pair is what makes either one mean anything: the SAME address, framed,
  // draws no header and keeps the 28rem column a Station's designer laid out
  // for.
  await expect(widget.getByTestId('widget-station-header')).toHaveCount(0);

  // -------------------------------------------------------------------------
  // The cookie, read with `context.cookies()`.
  //
  // NOT THE CDP `Network.getAllCookies`, which was the other candidate and is
  // not needed: MEASURED against this Playwright (1.62), `context.cookies()`
  // returns `sameSite: 'None'` and a `partitionKey` for exactly the cookies that
  // carry CHIPS. Proved rather than assumed, with a control: a probe that set
  // two identical cookies differing only in `Partitioned` came back with a
  // partitionKey on the partitioned one and NO partitionKey field at all on the
  // other — so this assertion distinguishes the two states rather than merely
  // reporting a value. CDP answers the same facts in a nested
  // `{topLevelSite, hasCrossSiteAncestor}` object; it would be a second
  // mechanism to keep working for no extra proof.
  // -------------------------------------------------------------------------
  const cookies = await context.cookies(`${appOrigin}/w/${publicKey}`);
  const session = cookies.find((cookie) => cookie.name === 'pw_session');

  expect(session, 'the visitor session cookie was stored in a third-party frame').toBeTruthy();
  // 'None' AND Secure together: a browser drops a SameSite=None cookie that is
  // not Secure, so neither half is observable without the other. (Chromium
  // treats http://localhost as a trustworthy origin, which is why a Secure
  // cookie is storable at all over the dev server's plain HTTP.)
  expect(session!.sameSite).toBe('None');
  expect(session!.secure).toBe(true);
  expect(session!.httpOnly).toBe(true);
  // '/w' and not '/': the cookie is kept off every other route in the product,
  // including the signed-in application, so it can never be confused for an
  // authentication cookie.
  expect(session!.path).toBe('/w');
  // The partition key is the embedding SITE — scheme and host, no port — so the
  // cookie exists only for the pair (this Station's website, this deployment).
  // Its mere presence is the proof that `Partitioned` was honoured.
  expect(session!.partitionKey).toBe(`http://${new URL(embedOrigin).hostname}`);

  // ---------------------------------------------------------------------------
  // BLOCK 17b. The first button, which 17a left disabled.
  //
  // It continues this journey rather than starting its own, because the thing
  // being proved is that a request can be made BY A SESSION MINTED IN A
  // THIRD-PARTY FRAME -- and a test that seeded its own cookie would prove the
  // door works while skipping the only part that was ever in doubt.
  //
  // Deezer is the fixture transport here: DEEZER_FAKE=1 in playwright.config.ts.
  // A journey that reached api.deezer.com would spend the platform's shared
  // per-IP limit on every CI run and go red when a third party is having a bad
  // afternoon.
  // ---------------------------------------------------------------------------
  await widget.getByTestId('widget-request-song').click();
  await expect(widget.getByTestId('widget-song-panel')).toBeVisible({ timeout: 30_000 });

  // Two characters is searchSchema's floor and the panel's own guard; one
  // character must produce no search at all, which is what the 400 ms debounce
  // and this minimum exist for together.
  await widget.getByTestId('widget-song-search').fill('s');
  await expect(widget.getByTestId('widget-song-results')).toHaveCount(0);

  await widget.getByTestId('widget-song-search').fill('sozinho');
  await expect(widget.getByTestId('widget-song-results')).toBeVisible({ timeout: 30_000 });

  // The fixture's first recording. Its id (921568) is what the browser will
  // post -- D4 says the browser sends an integer and the SERVER resolves the
  // record, and FakeDeezerTransport.track resolves out of the same fixture the
  // search answered from, so this journey cannot pick something the search
  // never offered.
  await widget.getByTestId('widget-song-results').getByRole('button').first().click();

  await widget.getByTestId('widget-song-note').fill(LISTENER_NOTE);

  // Block 20a, item 1. THE NOTE SCREEN IS THE ONE PLACE TWO WAYS BACK ARE ON
  // SCREEN AT ONCE -- the outline button returns to the search, the Shell's
  // returns to the menu -- and until this block both of them read the same
  // word. Asserted by accessible NAME rather than by counting buttons: a
  // count of two passed before this change as well, which is the shape of
  // assertion that proves nothing.
  //
  // PORTUGUESE, not the 'en-US' playwright.config.ts pins for the whole
  // suite: Block 30d/D7 makes this Station's chosen `listener_locale`
  // ('pt', seeded in `beforeAll`) win over Accept-Language for every visitor
  // to this installation, this one included. `exact: true` is load-bearing:
  // without it "Voltar" matches "Voltar ao menu" by substring and the first
  // assertion reports two.
  await expect(widget.getByRole('button', { name: 'Voltar', exact: true })).toHaveCount(1);
  await expect(
    widget.getByRole('button', { name: 'Voltar ao menu', exact: true }),
  ).toHaveCount(1);

  await widget.getByTestId('widget-song-send').click();

  await expect(widget.getByTestId('widget-song-recorded')).toBeVisible({ timeout: 30_000 });

  // THE DATABASE, NOT THE SCREEN. The panel saying "your request is with the
  // station" is the widget's own opinion of what happened; this is the fact.
  const { data: recorded, error: readError } = await admin
    .from('music_requests')
    .select('channel, listener_note, show_id, created_by, member_id')
    .eq('company_id', journeyCompanyId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (readError) throw new Error(`could not read the request back: ${readError.message}`);

  const request = recorded?.[0];
  expect(request, 'the request reached music_requests').toBeTruthy();
  expect(request!.channel).toBe('WEB');
  expect(request!.listener_note).toBe(LISTENER_NOTE);
  // D5: a visitor does not know a programme's name, so a web request carries
  // none. created_by is null because a website visitor is not an auth.users row.
  expect(request!.show_id).toBeNull();
  expect(request!.created_by).toBeNull();

  // ---------------------------------------------------------------------------
  // BLOCK 17c. The second button, which 17a left disabled and 17b left alone.
  //
  // It continues the same journey for the same reason 17b did: the session was
  // minted inside a third-party frame, and that is the part a test seeding its
  // own cookie would skip.
  // ---------------------------------------------------------------------------
  await widget.getByTestId('widget-promotion-panel').waitFor({ state: 'detached' }).catch(() => {});
  await widget.getByRole('button', { name: 'Voltar' }).first().click();
  await expect(widget.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  // BY NAME, NOT `.first()`. Block 20a's whole-branch review added two more
  // promotions to this same fixture pool (`CONSENT_SWITCH_PROMOTION_A/B`),
  // seeded with the same `ends_at` offset as this one -- `widget_promotions`
  // (0186) orders `by p.ends_at` alone, so a tie between three rows is not
  // something Postgres promises to break the same way on every run. This walk
  // needs the field and quiz question only `PRIMARY_PROMOTION_NAME` has.
  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: PRIMARY_PROMOTION_NAME, exact: true })
    .click();

  // THE RULES ARE ON SCREEN, which is the whole reason that column exists: an
  // agreement box above nothing is what D2 was decided to prevent.
  await expect(widget.getByTestId('widget-promotion-rules')).toContainText(PROMOTION_RULES);

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  await widget.getByTestId('widget-promotion-field-city').fill(LISTENER_CITY);
  // A SELECT, NOT A TEXT BOX, and selecting by VALUE rather than by label: the
  // three codes are what the column stores, the labels are translated, and a
  // test that drove this by visible text would break in a language nobody
  // changed the feature in.
  await widget.getByTestId('widget-promotion-field-gender').selectOption('F');
  await widget.getByTestId('widget-promotion-next').click();

  // Block 30d, item 1a. THE QUESTION'S OWN WORDS, ABOVE THE ALTERNATIVES --
  // before 0264 the step carried only the question's id and kind, and this
  // screen drew a list of options under nothing at all.
  await expect(widget.getByTestId('widget-question-prompt')).toHaveText(QUESTION_PROMPT);

  // THE ALTERNATIVES, WHICH IS THE REPAIR. Before it, this screen was a text
  // box: the listener typed prose, participation_answers_shape refused it and
  // the panel said "something went wrong".
  await expect(widget.getByTestId('widget-promotion-options')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-options').getByRole('radio').first().check();

  await widget.getByTestId('widget-promotion-send').click();

  await expect(widget.getByTestId('widget-promotion-done')).toBeVisible({ timeout: 30_000 });

  // THE DATABASE, NOT THE SCREEN.
  const { data: entries, error: entryError } = await admin
    .from('participations')
    .select('source, status, created_by, member_id, promotion_id')
    .eq('company_id', journeyCompanyId)
    .limit(1);

  if (entryError) throw new Error(`could not read the entry back: ${entryError.message}`);

  const entry = entries?.[0];
  expect(entry, 'the entry reached participations').toBeTruthy();
  expect(entry!.source).toBe('WEB');
  expect(entry!.status).toBe('VALID');
  expect(entry!.created_by).toBeNull();

  // The consent this block records and the WhatsApp door does not (§5 of the
  // spec, and the owner's ruling that WhatsApp will follow).
  const { data: consents } = await admin
    .from('member_consents')
    .select('consent_type, granted, origin, promotion_id')
    .eq('member_id', entry!.member_id)
    .eq('consent_type', 'rules');

  expect(consents?.length, 'agreeing to the rules left a consent row').toBe(1);
  expect(consents?.[0]?.granted).toBe(true);
  expect(consents?.[0]?.origin).toBe('web-widget');
  // Block 30d, D10. THE WALKED ROW NAMES ITS PROMOTION TOO — the half of that
  // decision that is easy to forget, because the fast path is the visible one.
  // Read from the participation rather than from a seeded id, so the two
  // cannot be made to agree by a test that fetched the same wrong value twice.
  expect(consents?.[0]?.promotion_id, 'the rules consent names the promotion').toBe(
    entry!.promotion_id,
  );

  // The field the listener typed reached their record, through the shared
  // writer 0171 extracted rather than a third copy of the eight-way mapping.
  const { data: listener } = await admin
    .from('members')
    .select('city, gender')
    .eq('id', entry!.member_id)
    .limit(1);

  expect(listener?.[0]?.city).toBe(LISTENER_CITY);
  // The gender block, end to end: a <select> in a browser, through the widget's
  // door, through apply_member_field_values, through gender_normalize, into a
  // column that would have refused anything else with a 23514.
  expect(listener?.[0]?.gender).toBe('F');
});

/**
 * Block 19b, D4/D5/D6. A listener who is done can say so, and the session
 * leaves with them.
 *
 * ⚠ THIS TEST DOES NOT MATCH TASK 7's OWN BRIEF, ON PURPOSE. The brief's step 3
 * asked for a reload after "Sair" to land on 17a's identify form — true of an
 * earlier version of `signOutAction`, and false of the code this test runs
 * against. That version held `left` as state inside `WidgetMenu`; a Server
 * Action that mutates a cookie forces Next.js to refresh the route deciding
 * `<WidgetMenu>` vs `<IdentifyForm>` from that SAME cookie, and a DOM poll at
 * 25ms resolution caught the farewell rendering and then being replaced
 * roughly 30ms later — a listener never got the chance to read it.
 * `signOutAction` (`src/app/(widget)/w/[publicKey]/actions.ts`) now clears the
 * cookie and `redirect()`s to `?left=1`, and `page.tsx` renders the farewell
 * for THAT request, server-side, before it ever reaches the cookie-driven
 * branch — so a reload of `?left=1` now answers the farewell again, every
 * time, and only a request carrying no `left` param at all sees what the
 * cookie's absence actually means.
 */
test('a listener who finishes an errand can leave, and the session leaves with them', async ({
  page,
}) => {
  // Reaches the menu exactly as the identify journey above does — the same
  // fixture, the same frame, the same two steps. A test that set `pw_session`
  // itself would prove the button and skip everything that makes a session
  // real.
  const widget = await identifyInFrame(page, {
    localPhone: EXIT_VISITOR_LOCAL_PHONE,
    phone: EXIT_VISITOR_PHONE,
    name: EXIT_VISITOR_NAME,
  });

  // The real `Frame`, not the `FrameLocator` above — only the former exposes
  // `.url()`, which is what proves the click below is a NAVIGATION rather
  // than a client-side flip of a flag.
  const framedWidget = page.frames().find((candidate) => candidate.url().includes(`/w/${publicKey}`));
  expect(framedWidget, 'the widget document is a frame of this page').toBeTruthy();

  await widget.getByTestId('widget-exit').click();

  // THE BROWSER LANDS ON `?left=1` — `signOutAction`'s `redirect()`, not a
  // state update `router.refresh()` would have to race against.
  await expect.poll(() => framedWidget!.url()).toContain('left=1');

  await expect(widget.getByTestId('widget-farewell')).toBeVisible({ timeout: 30_000 });

  // STAYS VISIBLE — THE ASSERTION THE OLD, BROKEN CODE WOULD HAVE PASSED
  // ANYWAY. Checking only that the farewell appeared once is exactly what let
  // the 30ms-disappearing version through; polling across a full second is
  // what the vanished screen could never have survived.
  // A plain wait, deliberately: what is being proved is an ABSENCE (the screen
  // not disappearing) over a span of time, which is not a state `expect.poll`
  // or `toBeVisible`'s own retry can wait FOR — those succeed on the first
  // matching poll and stop looking.
  for (let waited = 0; waited < 1_000; waited += 200) {
    await page.waitForTimeout(200);
    await expect(widget.getByTestId('widget-farewell')).toBeVisible();
  }

  // NO WAY BACK TO A CONVERSATION FROM A STATION'S OWN WEBSITE: this listener
  // never came from WhatsApp, and the identity door was never read for a framed
  // request, so the farewell offers the other button.
  await expect(widget.getByTestId('widget-identify-again')).toBeVisible();
  await expect(widget.getByTestId('widget-back-to-whatsapp')).toHaveCount(0);

  // A REAL ADDRESS, NOT CLIENT STATE: fetched a second time, `?left=1` answers
  // the farewell again rather than whatever the cookie alone would now decide.
  // `page.reload()` is not this — it would reload the EMBEDDING page and
  // recreate the iframe from its static `src` (no `left=1` in it at all,
  // `embeddingPage()`'s own template), proving nothing about this address.
  // The frame itself is what has to be asked again.
  await framedWidget!.goto(framedWidget!.url());
  await expect(widget.getByTestId('widget-farewell')).toBeVisible({ timeout: 30_000 });

  // THE ASSERTION THAT MATTERS: the SAME installation, visited with no `left`
  // param at all, has nothing left to identify. The screen changing when
  // "Sair" was pressed proved a state update; this is what proves the cookie
  // signOutAction cleared is actually gone, because the server decides which
  // of the two states this page renders and it decides from the cookie alone.
  await framedWidget!.goto(`${appOrigin}/w/${publicKey}`);
  await expect(widget.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });
});

/**
 * Block 20a, Task 4, fix round 1. `firstUnansweredScreen`'s jump, exercised by
 * a browser rather than reasoned about — the unit tests reach only the pure
 * function, and the happy-path journey above never produces a refusal at all.
 *
 * THE ROUTE TASK 3 LEFT OPEN. Task 3 stopped offering a promotion whose
 * question has no alternatives, closing one way to `missing_answers`; the
 * ordinary one stays wide open. A listener leaves a REQUESTED FIELD BLANK,
 * walks to the end of the form, and submits — nothing on the fields screen
 * stops "Next" from advancing over an empty box. The client then posts an
 * empty string for it, and `widget_enter_promotion` (0171) tests
 * `nullif(btrim(coalesce(p_fields ->> field, '')), '') is null`, which that
 * empty string satisfies: the door refuses with `missing_answers`, same as
 * any other listener mistake.
 *
 * REUSES THE JOURNEY FIXTURE rather than seeding a second promotion for one
 * test: `beforeAll` already seeds one with a requested field ('city') and a
 * QUIZ question, which is exactly the shape this case needs. A FRESH
 * LISTENER (a third phone) rather than the one from the journey above, so
 * this test does not depend on that one having run first, or on this
 * promotion still being open to a listener who already entered it.
 *
 * A SEPARATE TEST, not a branch folded into the journey above: a test that
 * asserts two different things breaks for two different reasons, and the
 * journey above already has its own point to make (a session minted in a
 * third-party frame can enter a promotion at all).
 */
test('a listener who skips a field is refused, and the panel jumps back to it', async ({ page }) => {
  const widget = await identifyInFrame(page, {
    localPhone: MISSING_FIELD_VISITOR_LOCAL_PHONE,
    phone: MISSING_FIELD_VISITOR_PHONE,
    name: MISSING_FIELD_VISITOR_NAME,
  });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  // BY NAME, NOT `.first()`. This walk needs the QUIZ QUESTION that only
  // `PRIMARY_PROMOTION_NAME` carries -- the other three promotions the fixture
  // seeds have none, and one of them (`FAST_ENTRY_PROMOTION_NAME`) has no
  // requested field either and would be entered on the tap. `.first()` relied
  // on `widget_promotions` (0186) ordering the list `by p.ends_at` with every
  // promotion sharing that column's value, which Postgres does not promise to
  // break ties on the same way twice.
  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: PRIMARY_PROMOTION_NAME, exact: true })
    .click();

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  // THE FIELD, LEFT BLANK -- the mistake this test exists to make. Nothing on
  // this screen validates before "Next" advances the walk, which is exactly
  // what lets a listener leave it empty and never notice.
  await expect(widget.getByTestId('widget-promotion-field-city')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-next').click();

  await expect(widget.getByTestId('widget-promotion-options')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-options').getByRole('radio').first().check();

  await widget.getByTestId('widget-promotion-send').click();

  // THE JUMP, NOT JUST THE MESSAGE. An assertion that stopped at the error
  // text would have passed before this task existed -- 20a's starting
  // behaviour was this same sentence, rendered under whichever screen the
  // listener happened to submit from. The fields screen coming back into
  // view is the only thing that proves firstUnansweredScreen's answer
  // actually drove `setScreen`, rather than merely being correct in
  // isolation.
  await expect(widget.getByTestId('widget-promotion-field-city')).toBeVisible({ timeout: 30_000 });
  await expect(widget.getByTestId('widget-promotion-error')).toBeVisible();
  await expect(widget.getByTestId('widget-promotion-error')).toContainText(
    'Faltou alguma coisa. Volte e confira suas respostas.',
  );

  // AND STILL EMPTY -- the panel's own state surviving the round trip, not a
  // stray value that would leave the listener looking at a field that
  // appears to explain nothing.
  await expect(widget.getByTestId('widget-promotion-field-city')).toHaveValue('');
});

/**
 * Block 20a, whole-branch review. Block 17c's own defect, found reading the
 * whole branch rather than introduced by this one: the list entry's
 * `onClick` (`enter-promotion.tsx`) set `chosen` and `screen` for the newly
 * picked promotion and left `consent` exactly where the LAST promotion's walk
 * left it. A listener who ticked promotion A's agreement box, went back to
 * the list through "Other promotions", and chose promotion B found B's box
 * ALREADY TICKED -- an agreement B never showed them, for rules they never
 * read. Submitting from there would write a `member_consents` row
 * (`widget_enter_promotion`, 0171's `rules` consent) recording exactly that.
 * A system that takes consent seriously enough to write a row for it cannot
 * let that row exist for an agreement nobody gave, which is why the product
 * owner ruled this fixed in this block rather than deferred with the rest of
 * the review.
 *
 * STOPS AT EACH PROMOTION'S CONSENT SCREEN, deliberately never submitting
 * either: the defect is entirely in what a promotion SWITCH carries forward,
 * and reaching it needs nothing past the first screen of the second
 * promotion.
 */
test("choosing a different promotion clears the previous one's agreement", async ({ page }) => {
  const widget = await identifyInFrame(page, {
    localPhone: CONSENT_SWITCH_VISITOR_LOCAL_PHONE,
    phone: CONSENT_SWITCH_VISITOR_PHONE,
    name: CONSENT_SWITCH_VISITOR_NAME,
  });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  // BY NAME, NOT BY POSITION -- the list is ordered by `ends_at`
  // (`widget_promotions`, 0186), which this journey has no reason to pin, and
  // picking by name proves the fix regardless of where either promotion lands.
  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: CONSENT_SWITCH_PROMOTION_A_NAME, exact: true })
    .click();

  await expect(widget.getByTestId('widget-promotion-consent')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-consent').check();
  await expect(widget.getByTestId('widget-promotion-consent')).toBeChecked();

  await widget.getByRole('button', { name: 'Outras promoções' }).click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: CONSENT_SWITCH_PROMOTION_B_NAME, exact: true })
    .click();

  // THE ASSERTION THAT MATTERS: a box this listener never touched, on a
  // promotion whose rules they have not seen this walk, must not read as
  // agreed.
  await expect(widget.getByTestId('widget-promotion-consent')).toBeVisible({ timeout: 30_000 });
  await expect(widget.getByTestId('widget-promotion-consent')).not.toBeChecked();
});

/**
 * Block 20a, second round. The residual the consent fix above did not close:
 * `state` (`useActionState`) cannot be reset from `enter-promotion.tsx` when a
 * different promotion is chosen -- nothing outside that hook's own reducer
 * can -- so a REFUSAL survives a promotion switch even after
 * consent/fields/answers/flagged do not.
 *
 * REACHABLE ONLY ON A SCREEN WHERE `last` IS TRUE. The error message's gate is
 * `state.status === 'refused' && refusalFor === chosen.id && (last || screen
 * === flagged)`, and `last` is computed from the CHOSEN PROMOTION'S OWN screen
 * count alone -- nothing the consent fix touches. So this journey has to WALK
 * promotion B to its last screen before the assertion means anything: stopping
 * on B's consent screen would leave `last` false and the test would pass
 * whether or not `refusalFor` existed.
 *
 * IT USED TO NEED NO WALK AT ALL, and Block 30d, Task 9 is why it does now.
 * `CONSENT_SWITCH_PROMOTION_B_NAME` was consent only, which made it a
 * one-screen promotion: `last` was true on its first render, before the
 * listener touched anything. Since 0268 a promotion with nothing to ask is the
 * FAST PATH -- entered from the list with no screen at all -- so a one-screen
 * walk is not a thing that exists any more, and the fixture gained a requested
 * field. The defect this test pins did not go away with it: a refusal left in
 * `state` by promotion A still reaches B's last screen, which is the click
 * below.
 *
 * PROMOTION A IS THE BLOCK 17c FIXTURE (a requested field plus a QUIZ), the
 * same one "a listener who skips a field is refused..." above uses, and for
 * the same reason: it is the route to an actual `refused` state that leaves
 * the walk open. Declining (an unchecked box, submitted) was considered and
 * rejected -- the panel treats `declined` as an ending screen of its own,
 * with no "Other promotions" button back to the list, so it cannot set up the
 * switch this test needs at all.
 */
test('a refusal on one promotion does not linger onto a different one', async ({ page }) => {
  const widget = await identifyInFrame(page, {
    localPhone: REFUSAL_SWITCH_VISITOR_LOCAL_PHONE,
    phone: REFUSAL_SWITCH_VISITOR_PHONE,
    name: REFUSAL_SWITCH_VISITOR_NAME,
  });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: PRIMARY_PROMOTION_NAME, exact: true })
    .click();

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  // THE FIELD, LEFT BLANK -- same mistake the "skips a field" journey makes,
  // for the same reason: nothing on this screen stops "Next" from advancing
  // over an empty box.
  await expect(widget.getByTestId('widget-promotion-field-city')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-next').click();

  await expect(widget.getByTestId('widget-promotion-options')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-options').getByRole('radio').first().check();

  await widget.getByTestId('widget-promotion-send').click();

  // THE REFUSAL, ON SCREEN -- about the promotion it is actually about.
  await expect(widget.getByTestId('widget-promotion-error')).toBeVisible({ timeout: 30_000 });

  await widget.getByRole('button', { name: 'Outras promoções' }).click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: CONSENT_SWITCH_PROMOTION_B_NAME, exact: true })
    .click();

  await expect(widget.getByTestId('widget-promotion-consent')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  // THE ASSERTION THAT MATTERS: this is B's LAST screen, so `last` is true and
  // the message's only remaining gate is `refusalFor`. Without it, the
  // `refused` state left over from promotion A is, on its own, enough to show
  // A's message under a field of B's that this listener has not even been
  // given the chance to get wrong.
  await expect(widget.getByTestId('widget-promotion-field-address')).toBeVisible({
    timeout: 30_000,
  });
  await expect(widget.getByTestId('widget-promotion-error')).toHaveCount(0);
});

/**
 * .superpowers/ci-widget-failure-diagnosis.md, the second consequence, proved
 * directly rather than through the two jump tests above. Those two fail
 * because of this same defect, but indirectly — a `missing_answers` refusal
 * and Block 20a's jump are what a test watching the SCREEN sees. This test
 * watches `participations` instead, because the more serious half of the
 * defect never shows up as a refusal at all: it is a WRITE, and a screen that
 * ends up looking correct a moment later would not prove it never happened.
 *
 * REACHES THE QUESTION SCREEN TWICE. The first arrival (fields screen →
 * question screen) is the walk's only unavoidable trip through the exact
 * transition the bug lives in — landing on the screen that has just become
 * `last` — but nothing has been answered yet at that instant, so even under
 * the bug this arrival can only be refused (missing_answers refuses before
 * apply_participation is ever called, `widget_enter_promotion`, 0171). That
 * is asserted below as a baseline, not the proof. The listener then answers
 * the question, presses "Back" (a genuinely separate, stably-typed button —
 * no defect there), and presses "Next" a second time. That second click is
 * the one enter-promotion.tsx's own comment describes: the same DOM node
 * `identify-form.tsx`'s "THE TWO KEYS ARE LOAD-BEARING" comment names for the
 * name/code labels, reused rather than remounted, now carrying a complete
 * answer when it flips to `type="submit"`. Before the fix, that click alone
 * is enough to write a participation — the listener never touched "Enter
 * now".
 */
test('an entry is recorded only when "Enter now" is pressed, never by "Next"', async ({ page }) => {
  const widget = await identifyInFrame(page, {
    localPhone: PHANTOM_ENTRY_VISITOR_LOCAL_PHONE,
    phone: PHANTOM_ENTRY_VISITOR_PHONE,
    name: PHANTOM_ENTRY_VISITOR_NAME,
  });

  const { data: listenerRows, error: listenerError } = await admin
    .from('members')
    .select('id')
    .eq('phone', PHANTOM_ENTRY_VISITOR_PHONE)
    .limit(1);
  if (listenerError) throw new Error(`could not read the listener back: ${listenerError.message}`);
  const memberId = listenerRows?.[0]?.id as string;
  expect(memberId, 'identifying created a member row').toBeTruthy();

  // FILTERED BY MEMBER, NOT BY STATION: earlier tests in this file already
  // wrote rows to `participations` for `journeyCompanyId`, so a count scoped
  // to the Station would be non-zero before this listener ever opened the
  // panel.
  async function participationCount(): Promise<number> {
    const { data, error } = await admin.from('participations').select('id').eq('member_id', memberId);
    if (error) throw new Error(`could not read participations back: ${error.message}`);
    return data?.length ?? 0;
  }

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  // PRIMARY_PROMOTION_NAME, BY NAME: the one fixture with both a requested
  // field and a QUIZ question, same reason the two jump tests above pick it
  // by name rather than position.
  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: PRIMARY_PROMOTION_NAME, exact: true })
    .click();

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  await widget.getByTestId('widget-promotion-field-city').fill(LISTENER_CITY);
  // The gender block's field is on this same screen -- `screensFor` groups every
  // field step together -- so this walk has to answer it before "Next" leads
  // anywhere. Left unanswered, the door refuses with `missing_answers` and the
  // panel sends the listener straight back here, which is the behaviour the
  // assertions below would then be measuring instead of the one they name.
  await widget.getByTestId('widget-promotion-field-gender').selectOption('M');
  await widget.getByTestId('widget-promotion-next').click();

  // THE BASELINE, NOT THE PROOF: the field is filled, so this first arrival
  // at the question screen has nothing wrong to report except the question
  // itself, which nobody has answered yet — the one auto-submit this walk
  // cannot avoid can only be refused.
  await expect(widget.getByTestId('widget-promotion-options')).toBeVisible({ timeout: 30_000 });
  expect(await participationCount(), 'nothing recorded on first arrival').toBe(0);

  await widget.getByTestId('widget-promotion-options').getByRole('radio').first().check();

  await widget.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(widget.getByTestId('widget-promotion-field-city')).toBeVisible({ timeout: 30_000 });
  // Both fields keep what was entered -- the walk is browser state until the
  // end (this file's own header) -- so going back and forward answers nothing
  // again and changes nothing about what the send will carry.
  await expect(widget.getByTestId('widget-promotion-field-gender')).toHaveValue('M');
  await widget.getByTestId('widget-promotion-next').click();

  // THE ASSERTION THAT MATTERS. A plain wait, not a poll for a state that
  // might never arrive — what is being proved is an ABSENCE, and 2s is
  // generous headroom over the 40-80ms round trip the CI traces in the
  // diagnosis measured for either outcome (a write that already happened, or
  // one that was never sent) to settle before asking.
  await page.waitForTimeout(2_000);
  expect(await participationCount(), 'no entry exists before "Enter now" is pressed').toBe(0);

  // ONLY NOW, explicitly.
  await widget.getByTestId('widget-promotion-send').click();
  await expect(widget.getByTestId('widget-promotion-done')).toBeVisible({ timeout: 30_000 });
  expect(await participationCount(), 'the explicit submission is the one that writes').toBe(1);
});

test('a page on an origin the Station did not name cannot frame the widget at all', async ({
  page,
}) => {
  // THE OTHER HALF OF THE ONE ABOVE. Without this case, a `frame-ancestors`
  // directive that had quietly become `*` — or a middleware branch that stopped
  // running for this path, which is exactly what Block 17a Task 9 found for
  // `/w/x.png` — would still let the journey pass, and the allowlist would be
  // decorative. The stranger differs from the embedder in one thing only: its
  // port, which makes it a different ORIGIN and is a difference `frame-ancestors`
  // is defined to notice.
  const refusals: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') refusals.push(message.text());
  });

  await page.goto(`${strangerOrigin}/`);

  // The refusal is reported to the EMBEDDING page's console — the framed
  // document is never rendered, so it has no console of its own to report in and
  // no `securitypolicyviolation` event fires anywhere this suite could listen
  // (which is why tests/e2e/csp-violations.ts's collector is not the tool here).
  await expect
    .poll(() => refusals.filter((text) => text.includes('frame-ancestors')), { timeout: 30_000 })
    .not.toHaveLength(0);
  expect(refusals.join('\n')).toContain(embedOrigin);

  // And nothing of the widget rendered. Short timeout: the assertion above has
  // already proved the load was blocked, so this is confirming a state that is
  // already settled rather than waiting for one to arrive.
  await expect(page.frameLocator('#widget').getByTestId('widget-identify-form')).toBeHidden({
    timeout: 3_000,
  });
});

/**
 * Block 29c, Task 10. The widget's marketing checkbox, end to end — Task 9's
 * three-way rule (`widget_enter_promotion`, 0234): TICKED writes `true`,
 * ALWAYS; UNTICKED with no row yet writes `false`; UNTICKED with a row already
 * present writes NOTHING. The third arm is the Critical this block closed
 * (fix round 1, F23) and the one worth pinning here: a listener who does not
 * re-tick on a LATER promotion must not be read as withdrawing what they
 * already gave.
 *
 * THE TWO ALREADY-SEEDED SWITCH PROMOTIONS (CONSENT_SWITCH_PROMOTION_A/B_NAME)
 * carry this walk: two screens each — consent, then the one field each asks
 * for — so "Enter now" is two clicks away twice over. Neither is entered
 * anywhere else in this file: the two tests that already choose them (the
 * consent-carry-over case above and the refusal-does-not-linger case) both
 * stop before submitting.
 *
 * THE FIELD IS BLOCK 30d, TASK 9's DOING AND THIS JOURNEY IS WHY THEY ASK FOR
 * DIFFERENT ONES. Since 0268 a promotion asking nothing is entered from the
 * list with no consent screen at all, so both promotions had to start asking
 * for something or there would be no marketing checkbox left to tick. A asks
 * for `city` and B for `address` because this is the one journey that enters
 * BOTH with the same listener — with one shared field, filling it on A would
 * have left B asking nothing of this listener, and B would have become the
 * fast path halfway through the test.
 */
test('the marketing checkbox writes true when ticked, and a later unticked entry leaves that true alone', async ({
  page,
}) => {
  const widget = await identifyInFrame(page, {
    localPhone: MARKETING_CONSENT_VISITOR_LOCAL_PHONE,
    phone: MARKETING_CONSENT_VISITOR_PHONE,
    name: MARKETING_CONSENT_VISITOR_NAME,
  });

  const { data: listenerRows, error: listenerError } = await admin
    .from('members')
    .select('id')
    .eq('phone', MARKETING_CONSENT_VISITOR_PHONE)
    .limit(1);
  if (listenerError) throw new Error(`could not read the listener back: ${listenerError.message}`);
  const memberId = listenerRows?.[0]?.id as string;
  expect(memberId, 'identifying created a member row').toBeTruthy();

  // THE DATABASE, NOT THE SCREEN, both times: a panel saying "pronto" proves
  // the action was reached, not that anything was written.
  async function marketingConsentRows() {
    const { data, error } = await admin
      .from('member_consents')
      .select('granted, origin')
      .eq('member_id', memberId)
      .eq('company_id', journeyCompanyId)
      .eq('consent_type', 'whatsapp_marketing');
    if (error) throw new Error(`could not read member_consents back: ${error.message}`);
    return data ?? [];
  }

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: CONSENT_SWITCH_PROMOTION_A_NAME, exact: true })
    .click();

  // UNCHECKED BY DEFAULT — the LGPD posture 0234's own comment names, not a UX
  // preference. Asserted before the box is ever touched.
  await expect(widget.getByTestId('widget-promotion-marketing-consent')).not.toBeChecked();

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-marketing-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  // The one field promotion A asks for. Filled rather than skipped: an empty
  // one is refused with `missing_answers` and no consent row is written at
  // all, which would make every assertion below pass or fail for a reason
  // that has nothing to do with the marketing box.
  await widget.getByTestId('widget-promotion-field-city').fill(LISTENER_CITY);
  await widget.getByTestId('widget-promotion-send').click();
  await expect(widget.getByTestId('widget-promotion-done')).toBeVisible({ timeout: 30_000 });

  const afterFirst = await marketingConsentRows();
  expect(afterFirst, 'ticking wrote one whatsapp_marketing row').toHaveLength(1);
  expect(afterFirst[0]?.granted).toBe(true);
  expect(afterFirst[0]?.origin).toBe('widget');

  // BACK TO THE LIST, A DIFFERENT PROMOTION, THE BOX LEFT UNTICKED.
  //
  // WHAT THIS PROVES, EXACTLY, and it is less than spec D2's "once": no second
  // consent ROW is written, and the earlier `true` survives. It does NOT prove
  // the listener is asked only once — the checkbox is re-rendered, unticked,
  // on this second entry, and the assertion five lines below says so. D2 asks
  // that an existing row for (member, company, whatsapp_marketing) suppress
  // the question forever after; the widget suppresses the WRITE, not the
  // question. That gap is on the screen, not in this test, and the owner has
  // it as a product decision.
  await widget.getByRole('button', { name: 'Voltar', exact: true }).click();
  await expect(widget.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });
  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: CONSENT_SWITCH_PROMOTION_B_NAME, exact: true })
    .click();

  await expect(widget.getByTestId('widget-promotion-marketing-consent')).not.toBeChecked();
  await widget.getByTestId('widget-promotion-consent').check();
  // The marketing box is left unticked here, deliberately — the mistake a
  // repeat participant makes without meaning anything by it.
  await widget.getByTestId('widget-promotion-next').click();

  // Promotion B's own field, which is `address` and not `city`: this listener
  // filled `city` on promotion A a moment ago, so a second promotion asking
  // for it would ask them nothing at all.
  await widget.getByTestId('widget-promotion-field-address').fill('Rua do Teste, 100');
  await widget.getByTestId('widget-promotion-send').click();
  await expect(widget.getByTestId('widget-promotion-done')).toBeVisible({ timeout: 30_000 });

  // THE ASSERTION THAT MATTERS: still one row, still true. A regression back
  // to the blanket insert Task 9's fix round 1 replaced would write a second
  // row here, or flip this one to false.
  const afterSecond = await marketingConsentRows();
  expect(afterSecond, 'the second, unticked entry wrote no second row').toHaveLength(1);
  expect(afterSecond[0]?.granted, 'the earlier true survives an unticked repeat').toBe(true);
});

/**
 * Block 30d, Task 9 (D8, D10). A PROMOTION THAT ASKS NOTHING TAKES THE ENTRY ON
 * THE TAP, and the rules screen the walk shows first does not appear on this
 * path at all — the owner's ruling of 2026-08-21.
 *
 * THE SCREEN ASSERTION IS THAT `done` ARRIVES WITH NOTHING TICKED. This test
 * never touches `widget-promotion-consent`, so against the panel as it was
 * before Task 9 it does not merely fail an extra expectation — it hangs on the
 * consent screen and times out waiting for a confirmation that needs a
 * checkbox and a button first. There is no version of this journey that passes
 * both ways.
 *
 * AND THEN THE ROW, WHICH IS THE HALF A SCREEN CANNOT SHOW. `origin` is what
 * separates a consent produced by the act of entering from one produced by a
 * click, for ever, and `promotion_id` is the column 0032 declared for exactly
 * this consent_type and that the door left null until 0268. A panel that
 * merely LOOKED right — because it drew no screen for a reason of its own —
 * would still write `web-widget` here.
 *
 * A NINTH PHONE AND A PROMOTION OF ITS OWN. The listener has to be one nobody
 * else in this file has entered (the promotion allows a single entry) and the
 * promotion has to be the one that declares no field, because the fast path is
 * a fact about the PAIR: every other promotion here asks this newcomer for
 * something.
 */
test('a promotion that asks nothing is entered from the list, with no rules screen', async ({
  page,
}) => {
  const widget = await identifyInFrame(page, {
    localPhone: FAST_ENTRY_VISITOR_LOCAL_PHONE,
    phone: FAST_ENTRY_VISITOR_PHONE,
    name: FAST_ENTRY_VISITOR_NAME,
  });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget
    .getByTestId('widget-promotion-list')
    .getByRole('button', { name: FAST_ENTRY_PROMOTION_NAME, exact: true })
    .click();

  // NO TICK, NO "PARTICIPAR", NO SECOND SCREEN — the tap was the whole errand.
  await expect(widget.getByTestId('widget-promotion-done')).toBeVisible({ timeout: 30_000 });
  await expect(widget.getByTestId('widget-promotion-consent')).toHaveCount(0);

  // THE RULES ARE STILL READABLE, on the confirmation. This is the whole of
  // what keeps "no rules screen" from meaning "rules nobody can read": the
  // listener agreed to a text, and the text is on the screen they end on.
  await expect(widget.getByTestId('widget-promotion-rules')).toContainText(PROMOTION_RULES);

  // THE DATABASE, NOT THE SCREEN.
  const { data: listenerRows, error: listenerError } = await admin
    .from('members')
    .select('id')
    .eq('phone', FAST_ENTRY_VISITOR_PHONE)
    .limit(1);
  if (listenerError) throw new Error(`could not read the listener back: ${listenerError.message}`);
  const memberId = listenerRows?.[0]?.id as string;
  expect(memberId, 'identifying created a member row').toBeTruthy();

  const { data: promotionRows } = await admin
    .from('promotions')
    .select('id')
    .eq('company_id', journeyCompanyId)
    .eq('name', FAST_ENTRY_PROMOTION_NAME)
    .limit(1);
  const fastPromotionId = promotionRows?.[0]?.id as string;
  expect(fastPromotionId, 'the no-walk promotion is where the fixture put it').toBeTruthy();

  const { data: entries } = await admin
    .from('participations')
    .select('status, source, promotion_id')
    .eq('member_id', memberId);
  expect(entries, 'the tap wrote exactly one entry').toHaveLength(1);
  expect(entries?.[0]?.status).toBe('VALID');
  expect(entries?.[0]?.source).toBe('WEB');
  expect(entries?.[0]?.promotion_id).toBe(fastPromotionId);

  const { data: consents } = await admin
    .from('member_consents')
    .select('granted, origin, promotion_id')
    .eq('member_id', memberId)
    .eq('consent_type', 'rules');

  expect(consents, 'entering left one rules consent row').toHaveLength(1);
  expect(consents?.[0]?.granted).toBe(true);
  // 'web-widget-entry', NOT 'web-widget'. The row says which act produced it,
  // which is the whole answer to the objection the owner ruled on: nobody
  // clicked, and the row does not claim anybody did.
  expect(consents?.[0]?.origin, 'the consent says the entry itself was the agreement').toBe(
    'web-widget-entry',
  );
  expect(consents?.[0]?.promotion_id, 'and it names the promotion whose rules those were').toBe(
    fastPromotionId,
  );
});

/**
 * Block 30d, Task 6, D7. THE COOKIE IS THE DEFECT, so this test plants one.
 * Checked in a clean browser this passes with and without the change --
 * there is nothing for the Station's language to win against, since
 * playwright.config.ts already pins `en-US` and an unset `listener_locale`
 * resolves the same way -- which is the shape of test this project has
 * shipped before while believing it proved something.
 *
 * AND IT RUNS IN THE IFRAME, which is the presentation that matters: the
 * obvious carrier for the language, `widget_station_identity`, is fetched
 * only where `page.tsx` guards its `stationIdentity` call with
 * `presentation === 'app'`, so a test driving the
 * standalone page would pass against a build where the embedded widget --
 * the whole point of the product -- is still wrong. Reached the same way
 * every other journey in this file reaches the menu, through
 * `identifyInFrame`: the button this test asserts on does not exist before a
 * session does, and a test that set `pw_session` itself would prove nothing
 * about the widget's own resolution.
 */
test('the widget renders in the Station language even when the browser carries another', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: appOrigin }]);

  const widget = await identifyInFrame(page, {
    localPhone: LOCALE_VISITOR_LOCAL_PHONE,
    phone: LOCALE_VISITOR_PHONE,
    name: LOCALE_VISITOR_NAME,
  });

  // 'Pedir uma música' -- messages/pt.json's `widget.requestASong` -- not
  // 'Request a song', which is what an English-resolving widget would show
  // this cookie in hand.
  await expect(widget.getByRole('button', { name: 'Pedir uma música' })).toBeVisible();
});

/**
 * Block 29c, Task 10, §7's decision pinned end to end: THE GET WRITES
 * NOTHING. Mail scanners and antivirus prefetch links; a route that acted on
 * GET would unsubscribe every listener whose employer scans mail, silently,
 * with nobody having clicked. `unsubscribe/[token]/page.tsx`'s own header
 * comment states the design; this is the case that would catch a later
 * "simplification" to one-click GET, which would pass every other test in
 * this repository.
 *
 * A FRESH LISTENER, SEEDED DIRECTLY THROUGH create_member — this case is
 * about the token door and the page's GET/POST split, not about identifying
 * through the widget, so there is nothing this journey needs from a WhatsApp
 * code round trip.
 *
 * THE RAW TOKEN AND ITS HASH ARE COMPUTED HERE RATHER THAN IMPORTED from
 * services/consent.ts, for the same reason `publicKey` above is: that module
 * is `import 'server-only'` at its first line, which vitest aliases to a stub
 * and Playwright does not.
 */
test('the GET on an unsubscribe link writes nothing; only the POST does', async ({ page }) => {
  const ownerClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await ownerClient.auth.signInWithPassword({
    email: ownerEmail,
    password: ownerPassword,
  });
  if (signInError) throw new Error(`could not sign in the owner: ${signInError.message}`);

  const { data: memberId, error: memberError } = await ownerClient.rpc('create_member', {
    p_company_id: journeyCompanyId,
    p_full_name: 'Unsubscribe GET Journey Listener',
  });
  if (memberError) throw new Error(`could not seed the listener: ${memberError.message}`);

  const raw = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');

  const { error: tokenError } = await admin.rpc('issue_unsubscribe_token', {
    p_member_id: memberId as string,
    p_company_id: journeyCompanyId,
    p_token_hash: hash,
  });
  if (tokenError) throw new Error(`could not mint the unsubscribe token: ${tokenError.message}`);

  async function consentRowCount(): Promise<number> {
    const { data, error } = await admin.from('member_consents').select('id').eq('member_id', memberId as string);
    if (error) throw new Error(`could not read member_consents back: ${error.message}`);
    return data?.length ?? 0;
  }

  expect(await consentRowCount(), 'nothing recorded before the visit').toBe(0);

  // THE GET. A plain navigation, exactly what a mail scanner's prefetch is.
  await page.goto(`${appOrigin}/unsubscribe/${raw}`);
  expect(await consentRowCount(), 'the GET must write nothing').toBe(0);

  // THE POST. Only a real click reaches the Server Action behind the button.
  await page.getByRole('button', { name: 'Leave this Station' }).click();
  await expect(page.getByTestId('unsubscribe-success')).toBeVisible({ timeout: 30_000 });
  expect(await consentRowCount(), 'the POST is what writes').toBe(1);

  const { data: rows } = await admin
    .from('member_consents')
    .select('consent_type, granted')
    .eq('member_id', memberId as string);
  expect(rows?.[0]?.consent_type).toBe('email_marketing');
  expect(rows?.[0]?.granted).toBe(false);
});
