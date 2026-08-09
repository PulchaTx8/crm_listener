import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Block 11a. The five headers that must reach every route.
 *
 * They live in `next.config.mjs`, which cannot be imported here — it is ESM
 * config loaded by Next's own machinery, and importing it would pull the
 * config loader into the test. Reading it is the honest alternative to
 * asserting nothing, and what it catches is the realistic failure: a header
 * deleted, renamed, or quietly weakened.
 *
 * `tests/e2e/headers.spec.ts` asserts the other half — that they are actually
 * on the wire — because a config file that names a header proves nothing about
 * whether it was sent.
 */
const config = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8');

function headerValue(name: string): string | undefined {
  return new RegExp(`${name}[\\s\\S]{0,160}?value:\\s*'([^']+)'`).exec(config)?.[1];
}

describe('the security headers', () => {
  it.each([
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Strict-Transport-Security',
  ])('%s is configured', (header) => {
    expect(headerValue(header), `${header} has a value`).toBeTruthy();
  });

  it('refuses framing outright', () => {
    // A clickjacked draw or delivery is a real action taken by a real operator
    // who did not mean to take it, so every screen in this product refuses to
    // be embedded. Block 17a adds ONE route with an embedding story --
    // `/w/<publicKey>`, a Station's own widget -- and it is served by taking
    // that path out of this entry's source rather than by weakening this
    // value; see the source assertions below.
    expect(headerValue('X-Frame-Options')).toBe('DENY');
  });

  it('does not leak a record id in the Referer', () => {
    // Every record screen in this product carries a ?record=<uuid>. Without
    // this, that full URL travels in the Referer of every outbound request.
    expect(headerValue('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('stops a browser guessing a download proxy is HTML', () => {
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sets HSTS for two years without preloading', () => {
    const hsts = headerValue('Strict-Transport-Security');
    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    // Preload is a one-way door on the apex domain and belongs to whoever owns
    // DNS, not to a config file in this repository. Asserted on the VALUE and
    // not on the file's text: a first version searched the whole file and
    // matched the comment explaining why preload is absent.
    expect(hsts).not.toContain('preload');
  });

  it('applies to every path but the widget, including the routes the middleware excludes', () => {
    // The reason these are here rather than in middleware.ts at all:
    // its matcher deliberately excludes /api/webhooks/ and /api/worker/,
    // because including them would 307 Meta's verification handshake and stop
    // both queues in silence.
    //
    // `/w/` IS THE ONE EXCLUSION, and it is written as one because
    // X-Frame-Options cannot be relaxed by a later, more specific entry: Next
    // applies every matching entry and the browser obeys the strictest, so a
    // second entry carrying a looser value would ship a widget that frames
    // nowhere. src/middleware.ts sets that route's frame-ancestors instead,
    // per Station.
    expect(config).toContain("source: '/((?!w/).*)'");
    expect(config).toContain("source: '/w/:path*'");
  });

  it('gives the widget route back every header except the framing refusal', () => {
    // A `source` excludes an ENTRY, not a header: the exclusion above was aimed
    // at X-Frame-Options and would have taken nosniff, Referrer-Policy,
    // Permissions-Policy and HSTS with it. The second entry restores those
    // four -- and must never grow a fifth.
    //
    // Sliced from the widget source to the end of the file, and asserted on
    // `key:` rather than on the bare header name, because the comment above
    // that entry names X-Frame-Options in prose precisely to forbid it -- the
    // trap the HSTS case below already records once.
    const widgetEntry = config.slice(config.indexOf("source: '/w/:path*'"));

    expect(widgetEntry).not.toContain("key: 'X-Frame-Options'");
    expect(widgetEntry).toContain('notAboutFraming');
  });
});
