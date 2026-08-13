import { expect, type Page } from '@playwright/test';

/**
 * Open a collapsed sidebar section so its links can be clicked.
 *
 * Block 20b, D4 made every section a disclosure, closed by default except the
 * one holding the current page — so a spec that reaches a screen by clicking a
 * sidebar link has to open its section first. EIGHTEEN specs do that, and this
 * exists so the next navigation change costs one edit rather than eighteen.
 *
 * Idempotent: a section that is already open (because the caller is standing in
 * it) is left alone rather than toggled shut, which is what a bare click would
 * do.
 *
 * Whole-branch review, I2. Wrapped in `toPass` because the heading is
 * server-rendered before React attaches: a click landing in that window is
 * swallowed (there is no handler yet), and the follow-up assertion below used
 * to time out with a message that points at navigation rather than at
 * hydration. `retries: 0` (playwright.config.ts) and CI's parallel workers
 * against a production build make that window real rather than theoretical,
 * across roughly thirty-five call sites. Re-checking `aria-expanded` before
 * clicking again keeps the retry idempotent for the same reason the original
 * single check was: a section already open because the caller is standing in
 * it is left alone.
 */
export async function openNavSection(page: Page, name: string): Promise<void> {
  const heading = page.getByRole('button', { name, exact: true });
  await expect(heading).toBeVisible();
  await expect(async () => {
    if ((await heading.getAttribute('aria-expanded')) !== 'true') await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
