import { test, expect } from '@playwright/test';

/**
 * Block 11a. The headers, on the wire.
 *
 * `tests/unit/security/headers.test.ts` reads `next.config.mjs` and proves the
 * values are declared. This proves they were SENT — which is a different claim,
 * and the one that matters: a `headers()` block that never matched, or a
 * deployment that stripped them at a proxy, looks identical in the config.
 */
const EXPECTED: Array<[string, string]> = [
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
];

test('every response carries the security headers', async ({ request }) => {
  const response = await request.get('/login');
  expect(response.status()).toBe(200);

  const headers = response.headers();
  for (const [name, value] of EXPECTED) {
    expect(headers[name], `${name} on /login`).toBe(value);
  }
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['strict-transport-security']).toContain('max-age=63072000');
});

test('the redirect from the bare domain carries them too', async ({ request }) => {
  // THE ASSERTION THAT PINS WHERE THE `/` REDIRECT LIVES, and it exists because
  // the obvious place is the wrong one.
  //
  // `/` sends every visitor to /login. Written as a `redirects()` entry in
  // next.config.mjs it is answered before the middleware runs, and MEASURED
  // that way it carried none of these headers and no CSP — 0 of 6. Issued from
  // src/middleware.ts instead, it carries all six. `/` is the likeliest first
  // request anybody ever makes against this product, which makes it the one
  // response where Strict-Transport-Security is worth the most.
  //
  // maxRedirects: 0, or this would follow the hop and assert about /login,
  // which the test above already covers and which would pass either way.
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(307);

  const headers = response.headers();
  for (const [name, value] of EXPECTED) {
    expect(headers[name], `${name} on the / redirect`).toBe(value);
  }
  expect(headers['strict-transport-security']).toContain('max-age=63072000');
  expect(headers['content-security-policy'], 'the redirect carries a CSP').toBeTruthy();
});

test('the machine endpoints carry them too', async ({ request }) => {
  // THE ASSERTION THAT JUSTIFIES PUTTING THESE IN next.config.mjs RATHER THAN
  // IN THE MIDDLEWARE. Its matcher deliberately excludes /api/webhooks/ and
  // /api/worker/ -- including them would 307 Meta's verification handshake and
  // stop both queues in silence -- so headers set there would never reach the
  // two endpoints an outside system actually calls.
  const response = await request.get('/api/health');
  expect(response.status()).toBeLessThan(500);
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
});
