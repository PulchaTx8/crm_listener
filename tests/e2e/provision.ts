import { expect, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openNavSection } from './nav';

/**
 * Provisions a customer with one Station THROUGH THE CONSOLE, and returns the
 * provisional password it revealed once.
 *
 * TWO SCREENS SINCE BLOCK 16. Provisioning creates the group and its owner and
 * no Station — a customer's radio count is not known when the customer is taken
 * on — so the radio is added afterwards, from the record's Stations tab. That is
 * two steps here because it is two steps for an operator.
 *
 * HERE RATHER THAN INLINE IN FOURTEEN SPECS. Every one of them wanted the same
 * fixture and drove the same six lines to get it, which is why splitting one
 * screen into two would otherwise have been fourteen near-identical edits. What
 * each of those files actually proves starts after this call returns; several
 * assert the platform nav is scoped just before it, and that assertion stays
 * where it is, because it is about their own admin rather than about this.
 *
 * The dialog is CLOSED on the way out. It stays open in the product on purpose —
 * the password is shown once and stored nowhere — so this reads it before
 * closing, and hands it back as the return value.
 */
export async function provisionThroughConsole(
  page: Page,
  input: { organizationName: string; companyName: string; ownerEmail: string },
): Promise<string> {
  // Block 20b. Platform is a collapsed section like every other one now, and
  // this helper is not among the thirteen specs that call openNavSection
  // themselves -- it is the ONE place ~14 of them reach this link through,
  // so fixing it here is the one edit rather than fourteen.
  await openNavSection(page, 'Platform');
  await page.getByRole('link', { name: 'Organizations' }).click();
  await page.getByTestId('organization-create').click();
  await page.getByPlaceholder('Organization name').fill(input.organizationName);
  await page.getByPlaceholder('Owner e-mail').fill(input.ownerEmail);
  await page.getByRole('button', { name: 'Provision', exact: true }).click();

  const revealed = page.locator('code').first();
  await expect(revealed).toBeVisible({ timeout: 15_000 });
  const password = (await revealed.innerText()).trim();

  // It must never have travelled in the URL (spec §6). Asserted here so every
  // caller gets the guarantee rather than the one file that remembered to.
  expect(page.url()).not.toContain(password);

  // Escape closes the provisioning dialog; the reload is what makes the new
  // group's row appear, because the grid patches rows rather than re-reading
  // the screen and the row it patched is the one this then opens.
  await page.keyboard.press('Escape');
  await page.reload();

  const row = page.locator('[data-testid="organization-row"]', {
    hasText: input.organizationName,
  });
  // exact: the row also carries "Open <name>" and "Actions for <name>" buttons,
  // and a substring match would resolve to all three.
  await row.getByRole('button', { name: input.organizationName, exact: true }).click();
  await page.getByRole('tab', { name: 'Stations' }).click();
  await page.getByPlaceholder('New Station name').fill(input.companyName);
  await page.getByTestId('organization-add-station').click();
  await expect(page.getByRole('link', { name: input.companyName })).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');

  return password;
}

/**
 * Provisions a customer with exactly one Station, as the platform admin.
 *
 * TWO CALLS SINCE BLOCK 16, WHERE THERE USED TO BE ONE. provision_customer
 * created an Organization and a Company together and was dropped in 0157,
 * because a customer's Station count is not known when the customer is taken
 * on. The console provisions the group and adds each radio afterwards, and this
 * performs the same sequence.
 *
 * HERE RATHER THAN INLINE IN EIGHT SPECS, which is where it was. Every one of
 * them wanted the identical fixture — one group, one radio, one owner — and
 * each had written its own three-line version of it, so the drop turned one
 * change into eight near-identical ones. The next change to how a customer is
 * created is one edit.
 *
 * It THROWS rather than returning an error, because every caller did the same
 * `if (error) throw` and none of them tests provisioning itself: a fixture that
 * fails silently produces a test failure three assertions later, pointing at the
 * wrong thing. provisioning-flow.spec.ts is where the real console path is
 * exercised, through the screen.
 */
export async function provisionCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  adminClient: SupabaseClient<any, any, any>,
  input: {
    userId: string;
    organizationName: string;
    companyName: string;
    timezone?: string;
  },
): Promise<{ organization_id: string; company_id: string }> {
  const { data: organizationId, error } = await adminClient.rpc('provision_organization', {
    p_user_id: input.userId,
    p_organization_name: input.organizationName,
  });
  if (error) throw new Error(`provision_organization failed: ${error.message}`);
  if (typeof organizationId !== 'string') {
    throw new Error('provision_organization returned no organization id');
  }

  const { data: companyId, error: companyError } = await adminClient.rpc('add_company', {
    p_organization_id: organizationId,
    p_name: input.companyName,
    p_timezone: input.timezone ?? 'America/Sao_Paulo',
  });
  if (companyError) throw new Error(`add_company failed: ${companyError.message}`);
  if (typeof companyId !== 'string') throw new Error('add_company returned no company id');

  return { organization_id: organizationId, company_id: companyId };
}
