import { test, expect } from '@playwright/test';

test('home shows the foundation heading', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Foundation OK/ })).toBeVisible();
});
