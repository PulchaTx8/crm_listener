import { describe, expect, it } from 'vitest';
// The exact function Next.js's own build step uses to compile a `matcher`
// source string into the regex actually evaluated against every request
// (see node_modules/next/dist/build/analysis/get-page-static-info.js,
// getMiddlewareMatchers -> tryToParsePath(...).regexStr). A hand-rolled
// `new RegExp(source)` is NOT equivalent: the raw source is unanchored, so
// `.test('/api/webhooks/whatsapp')` finds a spurious match starting at the
// LATER `/webhooks/...` slash and reports `true` even when Next's real,
// path-to-regexp-compiled version (anchored with ^...$) reports `false`.
// Using Next's own compiler is what makes this test trustworthy rather than
// merely comforting.
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { config } from '@/middleware';

function compileMatcher(source: string): RegExp {
  const { regexStr, error } = tryToParsePath(source);
  if (error || !regexStr) throw new Error(`could not compile matcher: ${String(error)}`);
  return new RegExp(regexStr);
}

describe('middleware matcher', () => {
  const matcher = compileMatcher(config.matcher[0]!);

  // C1: without this exclusion, Meta's GET verification handshake and every
  // POST hit the middleware, find no session cookie, and are 307-redirected
  // to /login before src/app/api/webhooks/whatsapp/route.ts ever runs.
  it('does not match the WhatsApp webhook route', () => {
    expect(matcher.test('/api/webhooks/whatsapp')).toBe(false);
  });

  // The exclusion is a prefix, not a single route: it must cover the whole
  // family under /api/webhooks/, not just today's one provider.
  it('does not match another provider under the same webhook prefix', () => {
    expect(matcher.test('/api/webhooks/telegram')).toBe(false);
  });

  // C1 again, for the worker. pg_cron calls this through pg_net every ten
  // seconds with no session cookie; matched, it is answered with a 307 to
  // /login and src/app/api/worker/tick/route.ts never runs. The scheduler
  // reads no response body, so both queues would stop draining in silence —
  // and no unit test can see it, because a test imports the handler and
  // calls it directly, never passing through the middleware at all.
  it('does not match the worker tick route', () => {
    expect(matcher.test('/api/worker/tick')).toBe(false);
  });

  // A prefix, like the webhook one: everything under /api/worker/ is a
  // machine endpoint called without a session and carrying its own shared
  // secret, so a second one must not have to rediscover this.
  it('does not match another route under the same worker prefix', () => {
    expect(matcher.test('/api/worker/anything')).toBe(false);
  });

  // Kept narrow: a page still needs a session, and an unrelated API route
  // still needs a session too. Excluding all of /api would silently strip
  // auth from things that need it.
  it('still matches an ordinary protected page', () => {
    expect(matcher.test('/promotions')).toBe(true);
  });

  it('still matches an API route outside the webhook prefix', () => {
    expect(matcher.test('/api/some-other-route')).toBe(true);
  });

  // /api/health stays reachable through PUBLIC_PATHS inside the middleware
  // body, exactly as before this fix — it must still be MATCHED by the
  // matcher (so the middleware runs and applies its own public-path check),
  // just not excluded like the webhook prefix is.
  it('still matches /api/health, which opts out via PUBLIC_PATHS instead', () => {
    expect(matcher.test('/api/health')).toBe(true);
  });
});
