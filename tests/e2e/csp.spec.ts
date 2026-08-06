import { test, expect } from '@playwright/test';

/**
 * Block 11b, D1. THE PROBE.
 *
 * Block 11a shipped a nonce CSP and got `11 passed, 23 failed` with no error
 * message anywhere: journeys timed out clicking things that did nothing,
 * because no client component had hydrated. The cause could not be seen from
 * the outside, so this test looks at the one artefact that settles it -- the
 * HTML actually delivered -- and names the failure instead of timing out.
 *
 * A `<script>` without the nonce is a script the browser will refuse to run.
 * Next stamps its own inline bootstrap scripts only when the REQUEST carries a
 * Content-Security-Policy header it can read the nonce out of; forwarding
 * `x-nonce` alone leaves the renderer with nothing.
 */
// `/login` is where every journey in this suite begins, and `/` is the one
// route `next build` still prerendered when this block started -- prerendered
// HTML has no request nonce, so its bootstrap shipped unstamped. Both, so the
// regression cannot come back through either door.
for (const path of ['/login', '/']) {
  test(`every script tag delivered by ${path} carries the nonce`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);

    const header = response.headers()['content-security-policy'];
    expect(header, 'the response carries a CSP at all').toBeTruthy();
    const nonce = /'nonce-([^']+)'/.exec(header)?.[1];
    expect(nonce, 'the CSP carries a nonce').toBeTruthy();

    const html = await response.text();
    const tags = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(tags.length, 'the page delivered any script at all').toBeGreaterThan(0);

    const unstamped = tags.filter((attrs) => !attrs.includes(`nonce="${nonce}"`));
    expect(
      unstamped,
      `script tags without the nonce -- the renderer never received it:\n${unstamped.join('\n')}`,
    ).toEqual([]);
  });
}
