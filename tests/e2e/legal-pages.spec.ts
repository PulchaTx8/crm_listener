import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY } from '../local-supabase';

/**
 * service_role, because `data_deletion_requests` grants anon nothing at all
 * (0188). Reading the row back is the point of having it: the screen saying a
 * protocol is the page's opinion of what happened, and the row is the fact.
 */
const admin = createClient(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Stamped rather than the fixed address the plan sketched. This suite leaves
 * its rows behind -- there is no fixture teardown for a public form, and a
 * deletion request is not something a test should be deleting -- so a fixed
 * e-mail would match every previous run's row on the second run onward, and the
 * read-back below would be asserting against whichever one Postgres returned.
 */
const stamp = Date.now();
const requesterEmail = `maria.teste-${stamp}@example.test`;

/**
 * NO SIGN-IN ANYWHERE IN THIS FILE, and that is the point.
 *
 * PUBLIC_PATHS in src/middleware.ts is an explicit list, and a path missing
 * from it sends a signed-out visitor to /login. Asserting these pages while
 * signed in would pass with the middleware misconfigured and tell us nothing
 * about the listener who will actually open them -- from a link inside
 * WhatsApp, with no account.
 */
for (const { path, heading } of [
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Service' },
  { path: '/delete-data', heading: 'Data Deletion Request' },
]) {
  test(`${path} is readable with no session at all`, async ({ page }) => {
    await page.goto(path);

    // Not redirected to the sign-in screen.
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

    // Semantic structure a legal document needs, asserted rather than assumed.
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('article')).toBeVisible();
    expect(await page.getByRole('heading', { level: 2 }).count()).toBeGreaterThan(3);

    // The header links the three documents to each other and nothing else.
    await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
  });
}

test('a legal page offers no way into the signed-in product', async ({ page }) => {
  await page.goto('/privacy');
  // The listener reading this has no account. A link into the app would be a
  // dead end that looks like a door.
  await expect(page.getByRole('link', { name: 'My stations' })).toHaveCount(0);
});

test('a deletion request is recorded and answered with a protocol', async ({ page }) => {
  await page.goto('/delete-data');

  await page.getByTestId('deletion-name').fill('Maria Teste');
  await page.getByTestId('deletion-phone').fill('+5511999990000');
  await page.getByTestId('deletion-email').fill(requesterEmail);
  await page.getByTestId('deletion-station').fill('Rádio Teste');
  await page.getByTestId('deletion-notes').fill('Quero meus dados apagados.');
  await page.getByTestId('deletion-confirm').check();
  await page.getByTestId('deletion-submit').click();

  // The receipt, not a thank-you: the protocol is the thing they were promised.
  const protocol = page.getByTestId('deletion-protocol');
  await expect(protocol).toBeVisible();
  await expect(protocol).toHaveText(/^PX-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // And the row, which is what the protocol is a receipt FOR. Read with the
  // service client because the page could print a protocol it invented and this
  // assertion is the only thing that would notice.
  const { data: row, error } = await admin
    .from('data_deletion_requests')
    .select('protocol, name, email, phone, company_name, message, status, ip_hash')
    .eq('email', requesterEmail)
    .single();

  expect(error).toBeNull();
  expect(row?.protocol).toBe((await protocol.textContent())?.trim());
  expect(row?.name).toBe('Maria Teste');
  expect(row?.phone).toBe('+5511999990000');
  expect(row?.company_name).toBe('Rádio Teste');
  expect(row?.message).toBe('Quero meus dados apagados.');
  expect(row?.status).toBe('new');
  // Hashed, never the address itself -- the rule 0188 states on the column.
  expect(row?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
});

test('a deletion request without the confirmation is refused', async ({ page }) => {
  await page.goto('/delete-data');
  await page.getByTestId('deletion-name').fill('Maria Teste');
  await page.getByTestId('deletion-phone').fill('+5511999990001');
  await page.getByTestId('deletion-email').fill(`maria2-${stamp}@example.test`);
  // The confirmation box is deliberately NOT checked. It is the difference
  // between typing a telephone number and stating a request.
  await page.getByTestId('deletion-submit').click();

  await expect(page.getByTestId('deletion-protocol')).toHaveCount(0);

  // Refused by the schema and not merely unrendered: no row exists either. The
  // assertion above would pass just as well against a page that recorded the
  // request and forgot to print the receipt.
  const { data: rows } = await admin
    .from('data_deletion_requests')
    .select('id')
    .eq('email', `maria2-${stamp}@example.test`);
  expect(rows ?? []).toHaveLength(0);
});
