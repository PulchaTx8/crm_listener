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
    // This product has no embedding story: nothing renders it in an iframe, and
    // a clickjacked draw or delivery is a real action taken by a real operator
    // who did not mean to take it.
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

  it('applies to every path, including the routes the middleware excludes', () => {
    // The reason these are here rather than in middleware.ts at all:
    // its matcher deliberately excludes /api/webhooks/ and /api/worker/,
    // because including them would 307 Meta's verification handshake and stop
    // both queues in silence.
    expect(config).toContain("source: '/:path*'");
  });
});
