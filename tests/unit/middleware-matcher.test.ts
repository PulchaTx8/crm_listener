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

  // The negative space, which the assertions above cannot see. Every one of
  // them names a path that IS excluded, so all of them would still pass if the
  // exclusions lost their trailing slash and became `api/webhooks` and
  // `api/worker` — and then any route whose name merely STARTS with those
  // words would silently lose its session check too. The slash is what makes
  // the prefixes safe, and these are the only tests that hold it.
  it('still matches a route that merely begins like the excluded prefixes', () => {
    expect(matcher.test('/api/webhooksfoo')).toBe(true);
    expect(matcher.test('/api/workerfoo')).toBe(true);
  });

  // BLOCK 17a, AND THE ONLY TEST THAT HOLDS THE THREE SPELLINGS OF "THE WIDGET
  // ROUTE" TOGETHER. next.config.mjs excludes `/w/` from the entry carrying
  // X-Frame-Options; src/middleware.ts's WIDGET_PATH decides which requests get
  // a per-Station frame-ancestors instead. If this matcher does not agree with
  // both, a `/w/` path exists that is served by NEITHER mechanism.
  //
  // `/w/<key>.png` is that path, and it was real: `[publicKey]` is a dynamic
  // segment, so it matches `abc.png` as happily as `pw_xxx`, and the image
  // extension alternative -- written for static pictures -- excluded it from
  // the middleware entirely. MEASURED before the fix: 404 with no
  // X-Frame-Options and no CSP at all. After: the CSP is there, refusing.
  it('matches a widget path that ends in an image extension', () => {
    expect(matcher.test('/w/pw_abcdefghijklmnopqrstuv.png')).toBe(true);
    expect(matcher.test('/w/pw_abcdefghijklmnopqrstuv.svg')).toBe(true);
  });

  // Both compiled `headers()` sources are case-insensitive (path-to-regexp's
  // default), and WIDGET_PATH is `/i` to agree with them. A case-sensitive
  // spelling here would leave exactly one path in the gap above.
  it('matches an upper-case widget path ending in an image extension', () => {
    expect(matcher.test('/W/pw_abcdefghijklmnopqrstuv.png')).toBe(true);
  });

  // The negative space of the two cases above: the exclusion still does its
  // original job everywhere else, or every static picture in the product would
  // start paying for a middleware invocation it has no use for.
  /**
   * NOT A NEW BEHAVIOUR — a newly load-bearing one, which is why it is pinned
   * here rather than left implied by the case below.
   *
   * `src/app/icon.png` and `src/app/apple-icon.png` are Next's file
   * conventions for the browser tab and the iOS home screen, and `next build`
   * publishes them at exactly these two paths (read off the build output, not
   * assumed). They are requested by a browser that may hold no session at all
   * — the sign-in screen is the first page most visitors ever load — so a
   * matcher that caught them would 307 the favicon to /login and the tab would
   * go back to the blank sheet this change existed to replace, with nothing
   * broken enough to notice.
   */
  it('skips the icon routes Next publishes for the browser tab', () => {
    expect(matcher.test('/icon.png')).toBe(false);
    expect(matcher.test('/apple-icon.png')).toBe(false);
    // The mark the sign-in screen and the sidebar draw, from /public.
    expect(matcher.test('/brand/pulchatx-mark.png')).toBe(false);
  });

  it('still skips an ordinary picture outside the widget route', () => {
    expect(matcher.test('/logo.png')).toBe(false);
    expect(matcher.test('/images/hero.webp')).toBe(false);
    // A path that merely BEGINS with a w, which the `(?![wW]/)` must not catch
    // -- the slash is what makes it the widget route.
    expect(matcher.test('/wombat.png')).toBe(false);
  });
});
