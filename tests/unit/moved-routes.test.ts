import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { MOVED_FROM_TEMPLATES, config } from '@/middleware';

/**
 * Block 29a. The two addresses that moved when the Templates section became
 * Messages, and the three ways the redirect that carries them can be wrong.
 *
 * A TEST AGAINST THE FILE SYSTEM, deliberately, and not a test of the literal.
 * Asserting that the map says what the map says proves nothing; what can
 * actually go wrong is that a destination names no route (a bookmark answered
 * with a 404), that a source is still a live route (a page shadowed by its own
 * redirect), or that the matcher never runs the middleware for these paths at
 * all (the redirect present in the source and dead in production — exactly the
 * class of defect `middleware-matcher.test.ts` exists for, whose header records
 * that no unit test importing a handler directly can see it).
 *
 * The App Router's mapping from URL to file is mechanical here — every path in
 * this map is a plain segment path under the `(app)` route group, no dynamic
 * segments, no parallel routes — so resolving it by hand is exact rather than
 * an approximation of Next's resolver.
 */
const APP_GROUP = 'src/app/(app)';

function pageFor(pathname: string): string {
  return `${APP_GROUP}${pathname}/page.tsx`;
}

function compileMatcher(source: string): RegExp {
  const { regexStr, error } = tryToParsePath(source);
  if (error || !regexStr) throw new Error(`could not compile matcher: ${String(error)}`);
  return new RegExp(regexStr);
}

describe('the routes Block 29a moved', () => {
  const entries = Object.entries(MOVED_FROM_TEMPLATES);

  it('is not empty, so the assertions below are about something', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('sends %s to a route that exists', (_from, to) => {
    expect(existsSync(pageFor(to))).toBe(true);
  });

  // The other direction, and the one a find-and-replace breaks: if a screen is
  // ever restored at its old address, the redirect silently wins and the
  // restored page is unreachable with nothing in any log.
  it.each(entries)('leaves nothing behind at %s', (from) => {
    expect(existsSync(pageFor(from))).toBe(false);
  });

  // A destination that is itself a source would be a redirect chain — two hops
  // for every bookmark, and a loop the day somebody maps them the other way.
  it('never points at another entry of its own', () => {
    for (const [, to] of entries) {
      expect(MOVED_FROM_TEMPLATES[to]).toBeUndefined();
    }
  });

  // Without this the redirect is written, reviewed, merged, and never runs:
  // the middleware body is only reached for paths the matcher admits, and the
  // matcher's exclusions are a regex nobody reads when adding a redirect.
  it('is reachable at all — the matcher admits every old address', () => {
    const matcher = compileMatcher(config.matcher[0]!);
    for (const [from] of entries) {
      expect(matcher.test(from)).toBe(true);
    }
  });
});
