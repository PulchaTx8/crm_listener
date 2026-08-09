import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_ANON_KEY,
  LOCAL_SUPABASE_SERVICE_ROLE_KEY,
} from '../local-supabase';
import { provisionCustomer } from './provision';

/**
 * Block 17a, Task 9. THE ONE PLACE THIS PRODUCT LETS ITSELF BE FRAMED, and the
 * proof that the exception did not leak anywhere else.
 *
 * WHY AN E2E AND NOT A UNIT TEST. Two independent mechanisms refuse framing
 * (Block 11a): the `X-Frame-Options: DENY` header declared in next.config.mjs,
 * and the CSP's `frame-ancestors 'none'` built in src/middleware.ts. Only one of
 * them is a function a unit test can call. The other is a `source` regex applied
 * by Next's own routing layer, and the only way to learn whether a path is
 * inside or outside it is to ask a running server for that path — which is
 * exactly the class of defect tests/e2e/whatsapp-boundary.spec.ts exists for,
 * where a middleware/routing mistake reached the WhatsApp webhook and the worker
 * tick with every unit test green.
 *
 * The case that matters most in this file is the /app one. Everything else here
 * proves a hole was opened; that one proves it is the size it was meant to be.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const stamp = Date.now();
const createdUserIds: string[] = [];

const adminEmail = `widget-admin-${stamp}@example.test`;
const adminPassword = `Admin-${stamp}-aA1!`;
const ownerEmail = `widget-owner-${stamp}@example.test`;
const ownerPassword = `Init-${stamp}-aA1!`;

/** The origin this Station names, and the only one its widget may be framed by. */
const ALLOWED_ORIGIN = 'https://radio.com.br';

/**
 * `pw_` + 16 random bytes, base64url — `widget_installations_key_shape` (0159).
 *
 * REPRODUCED RATHER THAN IMPORTED from src/lib/widget/code.ts, which is
 * `import 'server-only'` at its first line: vitest aliases that package to a
 * stub (vitest.config.ts) and Playwright does not, so importing it here would
 * throw before the first test ran. The duplication is three characters and a
 * base64url call; what it buys is a spec that does not need the app's module
 * graph to seed a row.
 */
const publicKey = `pw_${randomBytes(16).toString('base64url')}`;
const unknownKey = `pw_${randomBytes(16).toString('base64url')}`;

/**
 * WHAT A BROWSER SENDS FOR A DOCUMENT, and this header is load-bearing.
 *
 * Playwright's APIRequestContext sends a wildcard `accept` header by default,
 * and the middleware branch answers `'none'` to anything that is not a document
 * request — the lookup exists to decide whether a PAGE may be framed, and a server
 * action POSTing from inside the frame carries no framing question. Without
 * this header every assertion below would read the widget's own refusal branch
 * and pass for the wrong reason.
 */
const DOCUMENT = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

async function createAuthUser(email: string, password: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  createdUserIds.push(data.user.id);
  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`could not create a profile for ${email}: ${profileError.message}`);
  return data.user.id;
}

test.beforeAll(async () => {
  const adminUserId = await createAuthUser(adminEmail, adminPassword);
  const { error } = await admin.from('platform_admins').insert({ user_id: adminUserId });
  if (error) throw new Error(`could not seed platform admin: ${error.message}`);

  const ownerUserId = await createAuthUser(ownerEmail, ownerPassword);

  // Through the console's own door (0162), signed in as the platform admin it
  // is gated on, rather than by inserting into widget_installations with the
  // service key: 0159 gives that table RLS with no policy precisely so that
  // every writer is inside a SECURITY DEFINER body, and a fixture that goes
  // around the door would also go around the CHECKs that make an origin an
  // origin.
  const adminClient = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await adminClient.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signInError) throw new Error(`could not sign in the platform admin: ${signInError.message}`);

  const { company_id: companyId } = await provisionCustomer(adminClient, {
    userId: ownerUserId,
    organizationName: `Widget Org ${stamp}`,
    companyName: `Widget Station ${stamp}`,
  });

  const { error: upsertError } = await adminClient.rpc('upsert_widget_installation', {
    p_company_id: companyId,
    p_public_key: publicKey,
    p_enabled: true,
    p_allowed_origins: [ALLOWED_ORIGIN],
  });
  if (upsertError) throw new Error(`could not seed the installation: ${upsertError.message}`);
});

test.afterAll(async () => {
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

/**
 * NO STATUS ASSERTION ON THE SEEDED KEY, deliberately. The page itself is a
 * later task in this block, so today `/w/<key>` reaches the middleware, is
 * given its headers, and then 404s because no route renders it. Pinning 404
 * here would turn shipping the page into a failure in a file about headers.
 */
test('the widget route carries no X-Frame-Options at all', async ({ request }) => {
  const response = await request.get(`/w/${publicKey}`, { headers: DOCUMENT });

  // Not "some looser value" — ABSENT. X-Frame-Options has no per-origin
  // vocabulary (ALLOW-FROM is dead in every current browser), and Next applies
  // every matching `headers()` entry, so a second, looser entry would sit
  // beside the blanket DENY rather than replace it and the browser would obey
  // the stricter one. Excluding the path from the source regex is the only
  // mechanism, and this is the assertion that proves the exclusion took.
  expect(response.headers()['x-frame-options']).toBeUndefined();
});

test('its policy names the origin the Station allowed, and nothing else', async ({ request }) => {
  const response = await request.get(`/w/${publicKey}`, { headers: DOCUMENT });
  const policy = response.headers()['content-security-policy'] ?? '';

  expect(policy, 'the widget response carries a CSP at all').toBeTruthy();
  expect(policy).toContain(`frame-ancestors ${ALLOWED_ORIGIN}`);
  expect(policy).not.toContain("frame-ancestors 'none'");
});

test('the widget route keeps the four headers that are not about framing', async ({ request }) => {
  // The exclusion in next.config.mjs is written against the ENTRY, not against
  // one header, so a single excluded source would have dropped nosniff,
  // Referrer-Policy, Permissions-Policy and HSTS from this route too. They have
  // nothing to do with framing, and this is the one page in the product served
  // to somebody who may never have loaded any other page of this host — which
  // is precisely when HSTS is worth the most.
  const headers = (await request.get(`/w/${publicKey}`, { headers: DOCUMENT })).headers();

  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['strict-transport-security']).toContain('max-age=63072000');
});

test('an unknown key frames nowhere', async ({ request }) => {
  // One refusal for three causes (0161): an unknown key, a disabled
  // installation and an archived one answer identically, so this case also
  // stands for the other two. 404 today because no route renders /w/ yet, and
  // 404 tomorrow because the page refuses a key it cannot resolve — the header
  // is the part this file is responsible for either way.
  const response = await request.get(`/w/${unknownKey}`, { headers: DOCUMENT });

  expect(response.status()).toBe(404);
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('a widget path ending in an image extension is still governed by something', async ({
  request,
}) => {
  // THE CASE THAT KEEPS THREE REGEXES HONEST. "The widget route" is spelled in
  // next.config.mjs's exclusion, in src/middleware.ts's WIDGET_PATH, and in its
  // `matcher` — and this is the path where they disagreed. `[publicKey]` is a
  // dynamic segment, so `/w/anything.png` is a widget URL; the matcher's image
  // extension exclusion, written for static pictures, sent it past the
  // middleware, and the header exclusion had already taken X-Frame-Options
  // away. MEASURED in that state: 404, no X-Frame-Options, and NO CSP —
  // neither of the product's two framing defences. Task 10's page renders the
  // widget's own not-found there, which would have been framable from anywhere
  // and rendered with no nonce.
  //
  // Asserted on the CSP rather than on X-Frame-Options, because absence is
  // what this route is entitled to for the header and would prove nothing.
  const response = await request.get('/w/pw_notakey.png', { headers: DOCUMENT });

  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('a request that is not a document frames nowhere either', async ({ request }) => {
  // The server action POSTs from inside the frame are answered without the
  // database lookup, on purpose: they carry no framing question, and paying a
  // round trip for one would put it in front of every form submission. The
  // refusal is what they get instead, which is the safe half of that trade.
  const response = await request.post(`/w/${publicKey}`);

  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('the exception did not leak: /app still refuses framing, twice', async ({ request }) => {
  // THE ASSERTION THIS FILE EXISTS FOR. A source regex is a claim about every
  // path in the product, and the failure mode of getting it wrong is not an
  // error anywhere — it is a product that quietly agrees to be embedded, with
  // nothing on any screen to say so.
  //
  // maxRedirects: 0, or this follows the middleware's 307 to /login and asserts
  // about a different route than the one named here. Both mechanisms are
  // checked, because either one alone would still refuse a modern browser and
  // the pair is what Block 11a shipped.
  const response = await request.get('/app', { maxRedirects: 0, headers: DOCUMENT });

  expect(response.status()).toBe(307);
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});
