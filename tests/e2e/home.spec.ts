import { test, expect } from '@playwright/test';

test('home shows the product and links to contact', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'PulchatX' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Get in touch/i })).toBeVisible();
});

test('contact page renders the form', async ({ page }) => {
  await page.goto('/contato');
  await expect(page.getByRole('heading', { name: /Get in touch/i })).toBeVisible();
  await expect(page.getByPlaceholder('Your name')).toBeVisible();
});

test('login page renders the credentials form', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Sign in/i })).toBeVisible();
  await expect(page.getByPlaceholder('E-mail')).toBeVisible();
});
