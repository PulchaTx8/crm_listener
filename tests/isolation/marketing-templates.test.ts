import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29b-1. The marketing door, against real sessions.
 *
 * pgTAP runs as superuser with a null auth.uid(), so has_permission answers true
 * unconditionally and every gate reads open. It can hold the grants and the
 * shape; it cannot prove the door refuses anybody. These cases can.
 */
const STAMP = Date.now();

describe('Block 29b-1 — the marketing template door', () => {
  let customer: ProvisionedCustomer;
  let manager: { email: string; password: string };
  let viewer: { email: string; password: string };

  beforeAll(async () => {
    customer = await provisionCustomer(`marketing-tpl-${STAMP}`);
    manager = await grantRoleWith(customer, `mtpl-manage-${STAMP}`, [
      'templates.view',
      'templates.manage',
    ]);
    viewer = await grantRoleWith(customer, `mtpl-view-${STAMP}`, ['templates.view']);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  async function save(
    who: { email: string; password: string },
    args: Record<string, unknown>,
  ): Promise<{ id?: string; code?: string; message?: string }> {
    const client = await signInAs(who.email, who.password);
    const { data, error } = await client.rpc('save_marketing_template', {
      p_company_id: customer.companyId,
      ...args,
    });
    return { id: data as string | undefined, code: error?.code, message: error?.message };
  }

  it('creates an email template for a caller holding templates.manage', async () => {
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `natal_${STAMP}`,
      p_subject: 'Feliz Natal!',
      p_body: 'Oi {{listener_first_name}}, boas festas da {{station_name}}!',
    });
    expect(result.code, result.message).toBeUndefined();
    expect(result.id).toBeTruthy();

    const { data } = await admin
      .from('message_templates')
      .select('channel, purpose, subject, variables, name, language')
      .eq('id', result.id!)
      .single();
    expect(data?.channel).toBe('EMAIL');
    // The discriminator: a marketing template has no purpose, which is what
    // keeps it out of the partial unique index the system half depends on.
    expect(data?.purpose).toBeNull();
    // An email row declares no positional array -- its body names its places.
    expect(data?.variables).toEqual([]);
    expect(data?.name).toBeNull();
  }, 60_000);

  it('lets a second marketing template exist beside the first', async () => {
    // THE CASE THE NARROWED INDEX EXISTS FOR. Against the old index both rows
    // collide on "purpose is null" and the second save raises 23505.
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `aniversario_${STAMP}`,
      p_subject: 'Parabéns!',
      p_body: 'Parabéns, {{listener_first_name}}!',
    });
    expect(result.code, result.message).toBeUndefined();
  }, 60_000);

  it('refuses a body naming something this system does not substitute', async () => {
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `ruim_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi {{listener_shoe_size}}!',
    });
    expect(result.code).toBe('22023');
  }, 60_000);

  it('refuses a caller who may see templates but not manage them', async () => {
    const result = await save(viewer, {
      p_channel: 'EMAIL',
      p_internal_name: `negado_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi!',
    });
    expect(result.code).toBe('42501');
  }, 60_000);

  it('updates in place when given an id, rather than inserting a second row', async () => {
    const created = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `editar_${STAMP}`,
      p_subject: 'Antes',
      p_body: 'Oi!',
    });
    expect(created.code, created.message).toBeUndefined();

    const updated = await save(manager, {
      p_id: created.id,
      p_channel: 'EMAIL',
      p_internal_name: `editar_${STAMP}`,
      p_subject: 'Depois',
      p_body: 'Oi!',
    });
    expect(updated.id).toBe(created.id);

    const { data } = await admin
      .from('message_templates')
      .select('subject')
      .eq('id', created.id!)
      .single();
    expect(data?.subject).toBe('Depois');
  }, 60_000);
});
