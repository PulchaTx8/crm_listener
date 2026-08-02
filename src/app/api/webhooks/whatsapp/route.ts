import { createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service-client';
import { flattenWebhookBody, type FlattenStats } from '@/lib/integrations/whatsapp/payload';
import { verifyMetaSignature } from '@/lib/integrations/whatsapp/signature';

// The raw body is the signed artefact. Next must not parse it for us.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Meta's payloads are kilobytes. This is headroom, not a proof of anything —
// a caller that omits Content-Length, or lies about it, is caught by nothing
// here — but it is a cheap way to stop an unauthenticated caller from making
// this route read and HMAC a huge body before there is any chance to reject
// it on signature.
const MAX_BODY_BYTES = 1_000_000;

/**
 * Meta's one-time verification handshake. It is how the callback URL is
 * registered, and it runs again whenever the URL is re-saved in the App
 * dashboard.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = env.WHATSAPP_VERIFY_TOKEN;

  if (
    !token ||
    url.searchParams.get('hub.mode') !== 'subscribe' ||
    url.searchParams.get('hub.verify_token') !== token
  ) {
    return new Response('forbidden', { status: 403 });
  }
  return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
}

/**
 * Receipt, and nothing more. The order below is the security of this route:
 * verify the signature over the bytes received, then store, then answer 200
 * fast — Meta re-delivers anything slow, and a duplicate delivery is normal
 * traffic rather than an attack.
 *
 * Nothing here decides anything about a promotion. That is
 * ingest_whatsapp_event's, called by the worker, so this route stays inside
 * Meta's timeout however slow the database is.
 */
export async function POST(request: Request): Promise<Response> {
  const appSecret = env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    // Refusing to serve beats accepting unverified traffic. This is a
    // deployment fault, not a caller fault, and 503 says so.
    return new Response('not configured', { status: 503 });
  }

  // Checked ahead of the read, so an oversized body is rejected before it is
  // ever pulled into memory and HMAC'd. A missing header is let through —
  // this cannot force a caller to declare one honestly, so it is a guard
  // against an easy case, not a guarantee.
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return new Response('payload too large', { status: 413 });
  }

  // Read as text, not json(): the signature below is over these exact bytes,
  // and Next's body parser would hand back a re-serialised object whose
  // whitespace and key order Meta never signed.
  const raw = await request.text();

  if (!verifyMetaSignature(raw, request.headers.get('x-hub-signature-256'), appSecret)) {
    // Nothing is written. Storing unverified events would let anyone fill the
    // table by POSTing to a URL that is, by design, public.
    return new Response('unauthorized', { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('ok', { status: 200 });
  }

  // One row per MESSAGE, never one per POST: Meta packs several into one
  // request and idempotency (provider, external_id) is per message (0058).
  const stats: FlattenStats = { seen: 0, dropped: 0 };
  const messages = flattenWebhookBody(body, stats);

  if (stats.dropped > 0) {
    // Counts only, never a field from the payload — this runs after the
    // signature check above, so it cannot be triggered by an unverified
    // caller. Without this, an entry a sibling entry's malformation drops
    // leaves no row, no FAILED status and no log: nothing an operator asked
    // "why didn't it arrive?" could ever find.
    console.warn(
      `whatsapp webhook: dropped ${stats.dropped} of ${stats.seen} entries (malformed structure)`,
    );
  }

  if (messages.length === 0) {
    // Delivery and read receipts land here. They carry no participation and
    // storing them would make the table mostly noise before anything reads it.
    return new Response('ok', { status: 200 });
  }

  const { error } = await createServiceClient()
    .from('webhook_events')
    .upsert(
      messages.map((message) => ({
        provider: 'WHATSAPP' as const,
        // The SHA-256 of the wamid, lowercase hex, hashed HERE in Node rather
        // than passed raw into the RPC — the same reason members.cpf_hash
        // (0031) is hashed before it reaches the database: a wamid decodes to
        // bytes containing the counterparty's phone number, and an argument
        // passed to an RPC lands in query logs and backups. 0058 carries a
        // CHECK (`^[0-9a-f]{64}$`) that refuses a raw id, but that is a
        // backstop, not a reason to rely on it here.
        external_id: createHash('sha256').update(message.wamid).digest('hex'),
        payload: {
          // The RAW id of an INBOUND message, and the only place THAT lives
          // until this column is pruned at 30 days (design spec D9,
          // prune_webhook_payloads). The qualification is the correction: an
          // earlier version of this comment said "the only place it lives"
          // unqualified, which is not true of raw provider ids in general —
          // outbox_messages.external_id holds the raw id Meta returns for every
          // message we SEND, unhashed (0059). That one has a retention rule of
          // its own -- prune_outbox_messages nulls it beside to_phone on
          // terminal rows past the cut -- so it is not unprotected; it is simply
          // not THIS column, and a reader who took the unqualified sentence at
          // face value would go looking for the outbound id here and conclude
          // there wasn't one.
          //
          // The ingest function never reads this key — it exists for the
          // operator debugging against Meta's dashboard before the prune.
          wamid: message.wamid,
          metadata: { phone_number_id: message.phoneNumberId },
          from: message.from,
          profile_name: message.profileName,
          text: message.text,
          timestamp: message.timestamp,
          // Block 5b. Present only on an answer to something the bot asked, and
          // it is what makes the conversation answerable at all: the id here is
          // one the bot itself put in the message it sent. `text` is empty on
          // these, so the hashtag match in ingest_whatsapp_event cannot see a
          // button's label.
          reply: message.reply,
        },
      })),
      { onConflict: 'provider,external_id', ignoreDuplicates: true },
    );

  if (error) {
    // 500 makes Meta re-deliver, which is what we want: the message is not
    // stored, so it is not lost either.
    return new Response('storage failed', { status: 500 });
  }

  // Design spec D9. Without this every turn waits up to a full cron interval,
  // and a six-step conversation accumulates half a minute of silence between
  // messages somebody is sitting there watching for.
  triggerTick();
  return new Response('ok', { status: 200 });
}

/**
 * Fires a tick and does not wait for it.
 *
 * NOT AWAITED, and safe here for a reason worth naming: this application is a
 * long-running Node process in a container behind EasyPanel, not a platform
 * that freezes execution the moment a response is returned. On one of those
 * this would be a request that never happens; here the process outlives the
 * response and the tick runs. (An earlier round of Block 5a had to correct
 * comments in this same area that named the wrong runtime.)
 *
 * Every failure is swallowed on purpose. The message is already stored, so the
 * only thing a failing tick may not do is turn a 200 into an error and make
 * Meta re-deliver a message we have: pg_cron is still running every ten
 * seconds, and this is an optimisation on top of it, never the mechanism.
 */
function triggerTick(): void {
  const secret = env.WORKER_TICK_SECRET;
  const base = env.NEXT_PUBLIC_SITE_URL;
  // Neither configured means the local stack or a build: the cron job is the
  // only caller, and there is nothing to fire.
  if (!secret || !base) return;

  void fetch(`${base}/api/worker/tick`, {
    method: 'POST',
    headers: { 'x-worker-secret': secret },
  }).catch((cause: unknown) => {
    console.error(
      `whatsapp webhook: could not trigger a tick (the cron job will pick it up): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  });
}
