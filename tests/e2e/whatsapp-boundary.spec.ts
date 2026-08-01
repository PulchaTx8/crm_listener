import { createHash, createHmac } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';
import { WHATSAPP_APP_SECRET_FOR_TESTS, WORKER_TICK_SECRET_FOR_TESTS } from '../whatsapp-test-env';

/**
 * The HTTP-and-privilege boundary the isolation suite cannot reach: it drives
 * real Supabase clients over real HTTP but never runs the Next app (see its
 * own file's comment). This spec does, through playwright.config.ts's
 * webServer — the only suite in this repository that puts a real request
 * through src/middleware.ts and the two machine routes it must exclude.
 *
 * Two real defects in this block lived only on this side of that line, and a
 * unit test could not have caught either: the webhook route once sat behind
 * the session-cookie middleware and answered Meta's POST with a 307 redirect
 * to /login, and had it stayed there, the middleware's getUser() — a Supabase
 * Auth round trip — would have run on every inbound WhatsApp message and
 * every ten-second worker tick. tests/unit/whatsapp-route.test.ts and
 * worker-tick-route.test.ts import the handler and call it directly, which is
 * precisely why neither could see it: nothing there ever crosses
 * src/middleware.ts. Only a real server, reachable at a real URL, proves the
 * exclusion in the matcher config holds at runtime and not only in the regex
 * unit test (tests/unit/middleware-matcher.test.ts) that compiles it.
 */

const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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
              metadata: { phone_number_id: `e2e-boundary-${Date.now()}` },
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

test.describe('the WhatsApp webhook and worker routes, running for real', () => {
  test('a correctly signed POST reaches the route (not a 307, not a 401) and leaves a row', async ({
    request,
  }) => {
    const wamid = `wamid.e2e-boundary-${Date.now()}`;
    const raw = metaBody(wamid, '5511999990000', '#E2E');

    const response = await request.post('/api/webhooks/whatsapp', {
      data: raw,
      headers: { 'x-hub-signature-256': signBody(raw), 'content-type': 'application/json' },
      // APIRequestContext follows redirects by default (up to 20), which would
      // silently turn a middleware 307-to-/login into a followed 200 from the
      // login PAGE and mask the exact defect this case exists to catch — the
      // route sitting behind src/middleware.ts's session-cookie gate (0d47a83).
      // maxRedirects: 0 makes the assertion below see the real, first status.
      maxRedirects: 0,
    });

    // Not 307 — the middleware never intercepted this request and bounced it
    // to /login — and not 401, because the signature verifies. 200 is the
    // only answer this route ever gives a caller it accepted.
    expect(response.status()).toBe(200);

    const externalId = sha256Hex(wamid);
    const { data, error } = await admin
      .from('webhook_events')
      .select('id, external_id, payload')
      .eq('external_id', externalId)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data?.external_id).toBe(externalId);
    // The raw id lives only in payload (0058's own contract); external_id
    // holds only its hash.
    expect((data?.payload as { wamid?: string } | null)?.wamid).toBe(wamid);
  });

  test('a wrongly signed POST is refused with 401 and writes nothing', async ({ request }) => {
    const wamid = `wamid.e2e-boundary-bad-sig-${Date.now()}`;
    const raw = metaBody(wamid, '5511999990001', '#E2E');

    const response = await request.post('/api/webhooks/whatsapp', {
      data: raw,
      headers: {
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
        'content-type': 'application/json',
      },
      // Consistent with the signed case above: a 401 is not a redirect status,
      // so APIRequestContext's default redirect-following cannot launder this
      // one the way it could a 307 — but pinning maxRedirects: 0 here too
      // means this assertion does not silently depend on that distinction
      // holding, if the route's behavior on a bad signature ever changes.
      maxRedirects: 0,
    });

    expect(response.status()).toBe(401);

    const { data, error } = await admin
      .from('webhook_events')
      .select('id')
      .eq('external_id', sha256Hex(wamid))
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  test('a worker tick carrying the shared secret answers 200 with dbErrors at zero', async ({
    request,
  }) => {
    const response = await request.post('/api/worker/tick', {
      headers: { 'x-worker-secret': WORKER_TICK_SECRET_FOR_TESTS },
    });

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { dbErrors: number };
    // 200 alone is not proof of a healthy tick: every RPC call inside runTick
    // can fail — a missing grant, for instance — and the route still answers
    // 200 with an all-zero body, which reads exactly like an empty queue.
    // dbErrors is the one field that tells the two apart (src/services/
    // whatsapp.ts's own `failed()` helper is what increments it).
    expect(body.dbErrors).toBe(0);
  });
});
