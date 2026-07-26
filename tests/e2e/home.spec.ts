import { test, expect } from '@playwright/test';

test('home mostra o título da fundação', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Fundação OK/ })).toBeVisible();
});
