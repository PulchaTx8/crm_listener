import type { Page } from '@playwright/test';

/**
 * Block 11b, D3. The listener Block 11a did not have.
 *
 * That run produced `11 passed, 23 failed` and NOT ONE CSP error anywhere in
 * the output -- because the violations were raised in the BROWSER, and nothing
 * there was listening. Journeys simply timed out clicking things that did
 * nothing.
 *
 * The returned array fills as the page runs. Assert on it at the end of a
 * journey; a violation names the directive and the blocked URI, which is the
 * information that was missing.
 */
export async function collectCspViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];

  await page.exposeFunction('__cspViolation', (entry: string) => {
    violations.push(entry);
  });

  // addInitScript, not an evaluate: this has to be installed before the page's
  // own scripts run, or the violations raised during bootstrap -- the ones that
  // matter most -- happen before anything is listening.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { __cspViolation: (entry: string) => void }).__cspViolation(
        `${event.violatedDirective} blocked ${event.blockedURI || 'an inline resource'}`,
      );
    });
  });

  return violations;
}
