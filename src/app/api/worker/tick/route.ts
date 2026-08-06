import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service-client';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import type { RedisClientType } from 'redis';
import type { ConversationStore } from '@/lib/conversation/store';
import { RedisConversationStore, connectRedis } from '@/lib/conversation/redis-store';
import { runTick } from '@/services/whatsapp';
import { drainStorageErasures } from '@/lib/storage/erasure';
import type { ErasureDrainResult } from '@/lib/storage/erasure';
import { drainReportRuns } from '@/lib/reports/drain';
import type { ReportDrainResult } from '@/lib/reports/drain';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * What pg_cron calls, through pg_net, every ten seconds. The shared secret is
 * the whole of its authentication: this endpoint drains queues and must not be
 * reachable by anyone who finds the URL.
 *
 * It is excluded from the middleware matcher (src/middleware.ts). pg_net sends
 * an HTTP request and holds no session cookie, so matched it would be answered
 * with a 307 to /login and none of this would run — and pg_cron reads no
 * response body, so both queues would stop draining without a single error
 * anywhere. Nothing below can be tested for that: this file's tests import the
 * handler and call it directly, which is the same reason the identical defect
 * reached the webhook route.
 *
 * NOT where `sweep_pickup_deadlines` (0094) or its Block Templates sibling
 * `sweep_pickup_reminders` (0112) run, and a reader looking for either here is
 * the reason this paragraph exists. Both are procedures, scheduled directly by
 * `cron.schedule` inside their own migrations, called by pg_cron as plain SQL
 * with no HTTP and no application code in the path — 0094's header gives the
 * reasoning in full, and 0112 restates it rather than departing from it.
 * `sweep_pickup_reminders` only ENQUEUES a template send (through
 * `enqueue_whatsapp_outbound`, 0111); the row it writes is an ordinary
 * `outbox_messages` PENDING row, and it is THIS tick's own `drainOutbox`
 * (`runTick`, services/whatsapp.ts) that claims and actually sends it, on its
 * ordinary ten-second cadence, the same as any other queued message.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = env.WORKER_TICK_SECRET;
  if (!secret) {
    // A deployment fault, not a caller fault. Refusing beats draining queues
    // for whoever asks.
    return new Response('not configured', { status: 503 });
  }
  if (!secretMatches(request.headers.get('x-worker-secret'), secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const token = env.WHATSAPP_ACCESS_TOKEN;
  // No token configured means no real sending is possible. The fake keeps the
  // ingestion half working in a local stack rather than failing the tick.
  const transport = token ? new GraphTransport(token) : new FakeTransport();

  const supabase = createServiceClient();

  const result = await runTick({
    supabase,
    transport,
    store: await conversationStore(),
  });

  // Block 6b. Beside the conversation tick rather than inside it: this drains a
  // queue that anonymize_member writes and has nothing to do with WhatsApp, and
  // folding it into runTick would tie an LGPD obligation to whether the bot is
  // configured. A failure here must not lose the conversation tick's own
  // counters, which are already computed above -- so it is caught and reported
  // rather than thrown, and a queue that cannot be drained shows up as a
  // standing `failed` count in every tick instead of a 500 nobody reads.
  let erasures: ErasureDrainResult | { error: string };
  try {
    erasures = await drainStorageErasures(supabase);
  } catch (cause) {
    erasures = { error: cause instanceof Error ? cause.message : 'unknown' };
  }

  // Block 8b, the third drain. Wrapped exactly like the second and for the same
  // reason, which this block sharpens: a report is the biggest and slowest thing
  // this tick will ever do, so it is also the likeliest to throw -- and a
  // listener waiting on a WhatsApp reply must not wait because somebody
  // exported a spreadsheet. One run per tick, and its failure shows up as a
  // standing count rather than as a 500 that loses the two drains above it.
  let reports: ReportDrainResult | { error: string };
  try {
    reports = await drainReportRuns(supabase);
  } catch (cause) {
    reports = { error: cause instanceof Error ? cause.message : 'unknown' };
  }

  // pg_net stores the response in net._http_response, so these counters are
  // the only account of a tick anybody can read afterwards.
  return Response.json({ ...result, erasures, reports });
}

/**
 * Where conversations live for this process (design spec D6).
 *
 * The connection is opened ONCE and kept, not per tick: pg_cron fires every ten
 * seconds, and a socket per tick would be a socket per ten seconds for the life
 * of the container. The store itself is cheap and made per call.
 *
 * A Redis that cannot be reached does NOT take the tick with it. It falls back
 * to the default driver and says so, because a Station whose Redis is down
 * should have a slower bot rather than no bot -- and because the fallback is
 * safe: the two drivers hold the same shape, and the only cost of switching
 * mid-flight is that conversations in the other store look expired, which is a
 * state the design already handles (D5, D10).
 */
let redis: Promise<RedisClientType> | null = null;

async function conversationStore(): Promise<ConversationStore | undefined> {
  const url = env.REDIS_URL;
  if (!url) return undefined;
  try {
    redis ??= connectRedis(url);
    return new RedisConversationStore(await redis);
  } catch (cause) {
    // Cleared so the next tick tries again rather than holding a rejected
    // promise for the life of the process.
    redis = null;
    console.error(
      `worker tick: REDIS_URL is set but unreachable, falling back to the Postgres store: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return undefined;
  }
}

/**
 * Constant-time, for the reason signature.ts gives about Meta's HMAC: this
 * compares a value an unauthenticated caller controls against a secret. No
 * test in the suite fails if it is swapped for `===` — both return the same
 * boolean for every input — so that swap has to be caught by review.
 */
function secretMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would leak the length
  // through an exception rather than a comparison.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
