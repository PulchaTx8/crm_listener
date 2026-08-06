import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import {
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 10a. The audit trail's tenant boundary, and the integration RPCs'.
 *
 * 23_audit_and_integrations.test.sql asserts the SHAPE that makes this
 * possible -- that list_audit_logs is SECURITY INVOKER and restates no
 * permission rule of its own -- and it cannot assert one thing about the
 * behaviour, because pgTAP runs as superuser with a null auth.uid() and RLS
 * never applies to it. The whole point of the function is that RLS applies.
 *
 * TWO PROPERTIES HERE HAVE NO OTHER PROOF ANYWHERE IN THE REPOSITORY:
 *
 *   1. A row whose organization_id is NULL reaches the platform admin and
 *      nobody else. That is the `organization_id is not null` term in
 *      audit_logs_select_org, and it is the specific thing a SECURITY DEFINER
 *      rewrite of this listing would have lost -- silently, because the screen
 *      would still render and still look like an audit trail.
 *   2. audit.view is what separates a member who sees the trail from one who
 *      sees an empty page. Nothing else in the codebase exercises that
 *      permission at all: it has existed since Block 1b and guarded nothing.
 */
const STAMP = Date.now();

describe('Block 10a — the audit trail across Organizations', () => {
  let customer: ProvisionedCustomer;
  let outsider: ProvisionedCustomer;

  /** Holds audit.view in the Organization. */
  let auditor: { email: string; password: string; userId: string };
  /** Holds members.view and NOT audit.view -- the empty-page case. */
  let blind: { email: string; password: string; userId: string };

  beforeAll(async () => {
    customer = await provisionCustomer(`audit-${STAMP}`);
    outsider = await provisionCustomer(`audit-outsider-${STAMP}`);

    auditor = await grantRoleWith(customer, `aud-${STAMP}`, ['audit.view']);
    blind = await grantRoleWith(customer, `blind-${STAMP}`, ['members.view']);

    // provision_customer itself writes an audit row for each customer, so the
    // Organization already has a trail without this file creating one. The
    // platform-level row below is the one that has to be planted, because
    // nothing in the product writes an audit row with a null organization_id
    // today -- and the policy term that excludes it must be proved anyway,
    // because something will.
    const admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { persistSession: false } },
    );
    const { error } = await admin.from('audit_logs').insert({
      actor_id: null,
      action: `platform_event_${STAMP}`,
      target_table: 'platform',
      organization_id: null,
      company_id: null,
      detail: {},
    });
    if (error) throw new Error(`could not plant the platform-level row: ${error.message}`);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 120_000);

  it('shows an auditor their own Organization and nothing of another', async () => {
    const client = await signInAs(auditor.email, auditor.password);
    const { data, error } = await client.rpc('list_audit_logs', { p_limit: 200 });

    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ organization_id: string | null }>;

    // There is a trail to see -- provision_customer wrote one -- so the
    // assertions below are about filtering rather than about an empty table.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.organization_id).toBe(customer.organizationId);
    }
    expect(rows.some((row) => row.organization_id === outsider.organizationId)).toBe(false);
  });

  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * `organization_id is not null` in audit_logs_select_org is not decoration: a
   * row belonging to no customer is a platform-level event, and it reaches the
   * platform admin through the OTHER policy and nobody else. A SECURITY DEFINER
   * listing that restated the rule by hand would drop that term first, and
   * nothing about the rendered screen would show it.
   */
  it('never shows a null-organization row to an Organization auditor', async () => {
    const client = await signInAs(auditor.email, auditor.password);
    const { data, error } = await client.rpc('list_audit_logs', {
      p_action: `platform_event_${STAMP}`,
      p_limit: 50,
    });

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('shows that same row to the platform admin', async () => {
    // The other half, so the assertion above proves a boundary rather than a
    // row that simply is not there.
    const { data, error } = await customer.adminClient.rpc('list_audit_logs', {
      p_action: `platform_event_${STAMP}`,
      p_limit: 50,
    });

    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);
  });

  it('shows an empty page, not an error, to a member without audit.view', async () => {
    const client = await signInAs(blind.email, blind.password);
    const { data, error } = await client.rpc('list_audit_logs', { p_limit: 50 });

    // No refusal: the function holds no permission check and the policies
    // simply match nothing. An empty page IS the correct answer, and the screen
    // says so in words.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('refuses every integration RPC to a non-admin, including the Organization owner', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const listed = await owner.rpc('list_integrations');
    expect(listed.error?.code).toBe('42501');

    const upserted = await owner.rpc('upsert_integration', {
      p_company_id: customer.companyId,
      p_phone_number_id: `55${STAMP}`,
    });
    expect(upserted.error?.code).toBe('42501');

    const disabled = await owner.rpc('disable_integration', {
      p_company_id: customer.companyId,
    });
    expect(disabled.error?.code).toBe('42501');
  });

  it('lets the platform admin connect a Station, and audits it', async () => {
    const phoneNumberId = `55${STAMP}001`;
    const { error } = await customer.adminClient.rpc('upsert_integration', {
      p_company_id: customer.companyId,
      p_phone_number_id: phoneNumberId,
    });
    expect(error).toBeNull();

    // D8: the one screen that changes how a Station reaches its audience leaves
    // rows in the other screen. Read as the AUDITOR, so this also proves the
    // row landed in the customer's Organization rather than nowhere.
    const client = await signInAs(auditor.email, auditor.password);
    const { data } = await client.rpc('list_audit_logs', {
      p_action: 'configure_integration',
      p_limit: 10,
    });

    const rows = (data ?? []) as Array<{ detail: { phone_number_id?: string } }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.detail?.phone_number_id).toBe(phoneNumberId);
  });

  it('refuses a phone number id that already belongs to another Station', async () => {
    // integrations_number_live is a CORRECTNESS constraint: the webhook routes
    // an inbound message by phone_number_id, so a number claimed twice would
    // silently deliver a listener's message to the wrong radio.
    const phoneNumberId = `55${STAMP}002`;
    const first = await customer.adminClient.rpc('upsert_integration', {
      p_company_id: customer.companyId,
      p_phone_number_id: phoneNumberId,
    });
    expect(first.error).toBeNull();

    const second = await outsider.adminClient.rpc('upsert_integration', {
      p_company_id: outsider.companyId,
      p_phone_number_id: phoneNumberId,
    });
    expect(second.error?.code).toBe('23505');
    expect(second.error?.message).toContain('integrations_number_live');
  });
});
