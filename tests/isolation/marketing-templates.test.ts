import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
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
    // Not a collision case: a plain unique index never treats NULL as equal to
    // NULL, so two rows with a null purpose were never going to raise 23505
    // against (company_id, purpose), narrowed or not. What this proves is
    // simpler and still real: a Station may hold more than one marketing
    // template, because this door inserts by id rather than upserting on
    // purpose the way register_message_template does.
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

  it('recognizes a placeholder case-insensitively, mixed case and all', async () => {
    // {{Listener_First_Name}} is the shape that slipped through unchecked
    // before the capture was widened past [a-z_]+: not the enum's own
    // lower-case spelling, but a real substitution point, and it must be
    // recognized as one rather than silently waved through as unchecked prose.
    const result = await save(manager, {
      p_channel: 'EMAIL',
      p_internal_name: `misto_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi {{Listener_First_Name}}!',
    });
    expect(result.code, result.message).toBeUndefined();
    expect(result.id).toBeTruthy();
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

  // The UPDATE branch re-states company_id and `purpose is null` in its own
  // WHERE clause rather than trusting p_id alone -- these three cases are what
  // that re-statement is FOR. Nothing else in this file drives the UPDATE
  // branch with an id that fails one of those terms.

  it('refuses an update whose id belongs to a different Station', async () => {
    const stationB = await addCompany(customer, `Station B ${STAMP}`);
    const ownerClient = await signInAs(customer.email, customer.password);
    const { data: otherId, error: seedError } = await ownerClient.rpc('save_marketing_template', {
      p_company_id: stationB,
      p_channel: 'EMAIL',
      p_internal_name: `outra_estacao_${STAMP}`,
      p_subject: 'Original',
      p_body: 'Oi!',
    });
    if (seedError) throw new Error(`fixture seed at Station B failed: ${seedError.message}`);

    // p_company_id here is Station A -- `save` always sends the manager's own
    // -- while p_id names a row that belongs to Station B. The id alone must
    // not be enough to reach it.
    const result = await save(manager, {
      p_id: otherId,
      p_channel: 'EMAIL',
      p_internal_name: `outra_estacao_${STAMP}`,
      p_subject: 'Sequestrado',
      p_body: 'Oi!',
    });
    expect(result.code).toBe('P0002');

    const { data } = await admin
      .from('message_templates')
      .select('subject')
      .eq('id', otherId!)
      .single();
    expect(data?.subject).toBe('Original');
  }, 60_000);

  it('refuses an update whose id names a SYSTEM registration', async () => {
    const ownerClient = await signInAs(customer.email, customer.password);
    const { data: systemId, error: seedError } = await ownerClient.rpc(
      'register_message_template',
      {
        p_company_id: customer.companyId,
        p_purpose: 'WEB_VERIFICATION',
        p_name: `sistema_${STAMP}`,
        p_language: 'pt_BR',
        p_body: 'Codigo: {{1}}',
        p_variables: ['VERIFICATION_CODE'],
      },
    );
    if (seedError) throw new Error(`fixture SYSTEM registration failed: ${seedError.message}`);

    // Same Station, a real id -- but this row's purpose is NOT null, and this
    // door's own WHERE clause requires `purpose is null`. That row belongs to
    // register_message_template and its own validations, not this one.
    const result = await save(manager, {
      p_id: systemId,
      p_channel: 'EMAIL',
      p_internal_name: `sequestro_${STAMP}`,
      p_subject: 'Sequestrado',
      p_body: 'Oi!',
    });
    expect(result.code).toBe('P0002');

    const { data } = await admin
      .from('message_templates')
      .select('name, body')
      .eq('id', systemId!)
      .single();
    expect(data?.name).toBe(`sistema_${STAMP}`);
    expect(data?.body).toBe('Codigo: {{1}}');
  }, 60_000);

  it('refuses an update whose id names nothing at all', async () => {
    const result = await save(manager, {
      p_id: crypto.randomUUID(),
      p_channel: 'EMAIL',
      p_internal_name: `fantasma_${STAMP}`,
      p_subject: 'Oi',
      p_body: 'Oi!',
    });
    expect(result.code).toBe('P0002');
  }, 60_000);
});
