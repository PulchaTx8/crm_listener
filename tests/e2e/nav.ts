import { expect, type Page } from '@playwright/test';

/**
 * Open a collapsed sidebar section so its links can be clicked.
 *
 * Block 20b, D4 made every section a disclosure, closed by default except the
 * one holding the current page — so a spec that reaches a screen by clicking a
 * sidebar link has to open its section first. THIRTEEN specs do that, and this
 * exists so the next navigation change costs one edit rather than thirteen.
 *
 * Idempotent: a section that is already open (because the caller is standing in
 * it) is left alone rather than toggled shut, which is what a bare click would
 * do.
 */
export async function openNavSection(page: Page, name: string): Promise<void> {
  const heading = page.getByRole('button', { name, exact: true });
  await expect(heading).toBeVisible();
  if ((await heading.getAttribute('aria-expanded')) !== 'true') {
    await heading.click();
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
  }
}
