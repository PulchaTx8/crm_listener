import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { createServiceClient } from '@/lib/supabase/service-client';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import { runTick } from '@/services/whatsapp';

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

  const result = await runTick({ supabase: createServiceClient(), transport });

  // pg_net stores the response in net._http_response, so these counters are
  // the only account of a tick anybody can read afterwards.
  return Response.json(result);
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
