import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { test, expect, type FrameLocator } from '@playwright/test';
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
 * up a code left behind by an earlier run or by the demo seed.
 */
async function codeFromTheOutbox(): Promise<string> {
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
      expect(row.to_phone, 'the queued number carries its country code').toBe(VISITOR_PHONE);
      return variables[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no outbox row for template ${TEMPLATE_NAME}; no code was ever enqueued`);
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
    p_variables: ['o código de seis dígitos'],
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
    p_name: `Widget Journey Promotion ${stamp}`,
    p_starts_at: new Date(Date.now() - 3_600_000).toISOString(),
    p_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    p_web_enabled: true,
    p_rules: PROMOTION_RULES,
    // One field, so the walk has two screens: consent, then the fields. Allowed
    // on the strength of p_web_enabled alone -- which is exactly what 0171's
    // promotions_conversational_shape replaced promotions_whatsapp_shape to
    // permit, and what this journey proves end to end.
    p_requested_fields: ['city'],
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
    p_prompt: 'Qual é a capital do estado?',
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
  // about it. The two prefixes are still named separately rather than collapsed
  // into one pattern, because they are two independent limits and a reader has
  // to be able to see that both were cleared.
  for (const prefix of ['widget:code:ip:', 'widget:verify:ip:']) {
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
  await page.goto(`${embedOrigin}/`);

  const widget = page.frameLocator('#widget');
  await expect(widget.getByTestId('widget-identify-form')).toBeVisible({ timeout: 30_000 });

  // THE ASSERTION THAT KEEPS THIS FILE HONEST, and it is taken from the browser
  // rather than from the constants above. If a later edit ever pointed the
  // iframe at the same host as the top-level page, every other assertion here
  // would still pass — the cookie would be a first-party cookie, `SameSite` and
  // `Partitioned` would be inert, and `frame-ancestors` would never be
  // consulted. This is the line that fails instead.
  const frame = page.frames().find((candidate) => candidate.url().includes(`/w/${publicKey}`));
  expect(frame, 'the widget document is a frame of this page').toBeTruthy();
  expect(new URL(page.url()).origin).not.toBe(new URL(frame!.url()).origin);

  // The country box comes prefilled with Brazil; filled explicitly anyway, so
  // this journey states the number it means rather than inheriting a default a
  // later edit could change underneath it.
  await widget.locator('#widget-country-code').fill(VISITOR_COUNTRY_CODE);
  await widget.locator('#widget-phone').fill(VISITOR_LOCAL_PHONE);
  await widget.locator('#widget-name').fill(VISITOR_NAME);

  // THE NUMBER THE SEND WILL ACTUALLY CARRY, read off the screen the visitor is
  // looking at. Asserted here rather than only against the outbox because the
  // whole defect this box exists for was invisible on screen: the visitor typed
  // a number that looked right, and the country code was missing everywhere
  // downstream.
  await expect(widget.getByTestId('widget-phone-preview')).toContainText(VISITOR_PHONE);
  await widget.getByRole('button', { name: 'Send code' }).click();

  // Either the second screen or a refusal — whichever arrives, so a refusal is
  // reported as itself rather than as a timeout waiting for the screen it
  // prevented.
  await widget
    .locator('[data-testid="widget-code-form"], [data-testid="widget-problem"]')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await assertNotRefused(widget);

  const code = await codeFromTheOutbox();
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
  await widget.getByRole('button', { name: 'Confirm' }).click();

  // THE MENU, INSIDE THE FRAME. Reaching it means the whole chain worked in a
  // third-party context: the action wrote the cookie, the browser STORED it (a
  // Lax cookie would have been dropped here), `router.refresh()` sent it back,
  // and the page's readSessionFor accepted it for this installation.
  await expect(widget.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });
  await assertNotRefused(widget);

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
  await widget.getByRole('button', { name: 'Back' }).first().click();
  await expect(widget.getByTestId('widget-menu')).toBeVisible({ timeout: 30_000 });

  await widget.getByTestId('widget-enter-promotion').click();
  await expect(widget.getByTestId('widget-promotion-list')).toBeVisible({ timeout: 30_000 });

  await widget.getByTestId('widget-promotion-list').getByRole('button').first().click();

  // THE RULES ARE ON SCREEN, which is the whole reason that column exists: an
  // agreement box above nothing is what D2 was decided to prevent.
  await expect(widget.getByTestId('widget-promotion-rules')).toContainText(PROMOTION_RULES);

  await widget.getByTestId('widget-promotion-consent').check();
  await widget.getByTestId('widget-promotion-next').click();

  await widget.getByTestId('widget-promotion-field-city').fill(LISTENER_CITY);
  await widget.getByTestId('widget-promotion-next').click();

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
    .select('source, status, created_by, member_id')
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
    .select('consent_type, granted, origin')
    .eq('member_id', entry!.member_id)
    .eq('consent_type', 'rules');

  expect(consents?.length, 'agreeing to the rules left a consent row').toBe(1);
  expect(consents?.[0]?.granted).toBe(true);
  expect(consents?.[0]?.origin).toBe('web-widget');

  // The field the listener typed reached their record, through the shared
  // writer 0171 extracted rather than a third copy of the eight-way mapping.
  const { data: listener } = await admin
    .from('members')
    .select('city')
    .eq('id', entry!.member_id)
    .limit(1);

  expect(listener?.[0]?.city).toBe(LISTENER_CITY);
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
