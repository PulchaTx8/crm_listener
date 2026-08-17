import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * The Templates block's tenant boundary, proved the only way it can be: with
 * real users holding real, narrower grants.
 *
 * Nothing in this file is visible to pgTAP, which runs as superuser with a null
 * `auth.uid()` and so gets `true` from has_permission unconditionally. That is
 * not a gap in 18_templates.test.sql — it is the reason this file exists, and
 * the reason it is written in the same task as the doors rather than at the end
 * of the block.
 *
 * TWO PROPERTIES HERE HAVE NO OTHER PROOF ANYWHERE IN THE REPOSITORY:
 *
 *   1. templates.view ALONE can read both tables. 18_templates asserts the
 *      grant exists on station_message_templates and, until this file, only
 *      ever asserted the ABSENCE of an insert grant on message_templates — so
 *      dropping `grant select … to authenticated` from 0110 would have left
 *      every gate green and the WhatsApp screen permanently empty. The
 *      positive branch reads BOTH tables, deliberately.
 *   2. templates.view does NOT confer templates.manage. The block ships two
 *      codes and the whole write side rests on the second one being separate.
 */
// One stamp for the whole file, in the shape music.test.ts settled on: every
// label below feeds a fixed e-mail template in harness.ts, and a bare literal
// would collide on createUser the moment a previous run left a user behind
// that cleanupUsers could not fully delete.
const STAMP = Date.now();

describe('Block Templates — a Station\'s own words, across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;
  /** A live registration in the FIRST Station — visible to the delegates below. */
  let firstStationTemplateId: string;
  /** A live registration in the SECOND Station — reachable by the owner alone. */
  let secondStationTemplateId: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`templates-${STAMP}`);
    secondCompanyId = await addCompany(customer, 'Second Station Templates');

    // Fixtures written by the owner, whose bypass in has_permission makes them
    // pure setup rather than anything under test. Every case below performs
    // the operation it actually names through its own narrower client.
    const owner = await signInAs(customer.email, customer.password);

    const { error: overrideError } = await owner.rpc('set_station_message_template', {
      p_company_id: customer.companyId,
      p_key: 'REFUSAL',
      p_body: 'Beleza! Fica pra próxima.',
    });
    if (overrideError) throw new Error(`fixture override failed: ${overrideError.message}`);

    const { data: firstId, error: firstError } = await owner.rpc('register_message_template', {
      p_company_id: customer.companyId,
      p_purpose: 'PICKUP_REMINDER',
      p_name: 'lembrete_retirada',
      p_language: 'pt_BR',
      p_body: 'Oi {{1}}, seu prêmio te espera!',
      // Block 29b-1: p_variables is now a closed vocabulary (0223) rather
      // than prose an operator typed -- LISTENER_FIRST_NAME is a valid
      // public.template_variable member matching the single {{1}} above.
      p_variables: ['LISTENER_FIRST_NAME'],
    });
    if (firstError) throw new Error(`fixture registration failed: ${firstError.message}`);
    firstStationTemplateId = firstId as string;

    const { data: secondId, error: secondError } = await owner.rpc('register_message_template', {
      p_company_id: secondCompanyId,
      p_purpose: 'PICKUP_REMINDER',
      p_name: 'lembrete_da_outra_estacao',
      p_language: 'pt_BR',
      p_body: 'Oi {{1}}, seu prêmio te espera!',
      // Block 29b-1: p_variables is now a closed vocabulary (0223) rather
      // than prose an operator typed -- LISTENER_FIRST_NAME is a valid
      // public.template_variable member matching the single {{1}} above.
      p_variables: ['LISTENER_FIRST_NAME'],
    });
    if (secondError) throw new Error(`second-station registration failed: ${secondError.message}`);
    secondStationTemplateId = secondId as string;
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  // -------------------------------------------------------------------------
  // templates.view is not templates.manage — one door at a time, because each
  // carries its own gate and a fix applied to three of four would pass a
  // bundled assertion.
  // -------------------------------------------------------------------------

  it('refuses to set an override to a caller holding templates.view alone', async () => {
    const viewer = await grantRoleWith(customer, `tpl-viewer-set-${STAMP}`, ['templates.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('set_station_message_template', {
      p_company_id: customer.companyId,
      p_key: 'ABANDON',
      p_body: 'Não deveria entrar',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses to clear an override to a caller holding templates.view alone', async () => {
    const viewer = await grantRoleWith(customer, `tpl-viewer-clear-${STAMP}`, ['templates.view']);
    const client = await signInAs(viewer.email, viewer.password);

    // The override REFUSAL genuinely exists and this caller can read it — so
    // the refusal is the permission and nothing else. A caller who could not
    // see the row would be refused either way and prove less.
    const { error } = await client.rpc('clear_station_message_template', {
      p_company_id: customer.companyId,
      p_key: 'REFUSAL',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses to register a template to a caller holding templates.view alone', async () => {
    const viewer = await grantRoleWith(customer, `tpl-viewer-reg-${STAMP}`, ['templates.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('register_message_template', {
      p_company_id: customer.companyId,
      p_purpose: 'PICKUP_REMINDER',
      p_name: 'nao_deveria',
      p_language: 'pt_BR',
      p_body: 'Oi {{1}}!',
      p_variables: ['LISTENER_FIRST_NAME'],
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses to archive a template to a caller holding templates.view alone', async () => {
    const viewer = await grantRoleWith(customer, `tpl-viewer-arch-${STAMP}`, ['templates.view']);
    const client = await signInAs(viewer.email, viewer.password);

    // Again a row this caller can read: archive_message_template resolves the
    // Station from the row itself, so pointing it at a VISIBLE template is the
    // only way to prove the refusal came from templates.manage rather than
    // from the row being unreachable.
    const { error } = await client.rpc('archive_message_template', {
      p_id: firstStationTemplateId,
    });

    expect(error?.code).toBe('42501');
  });

  // -------------------------------------------------------------------------
  // The Station boundary. templates.manage in one Station is not
  // templates.manage anywhere, and the refusal never says which.
  // -------------------------------------------------------------------------

  it('refuses an override at a Station the caller holds nothing in', async () => {
    const manager = await grantRoleWith(
      customer,
      `tpl-manager-a-${STAMP}`,
      ['templates.view', 'templates.manage'],
      [customer.companyId],
    );
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('set_station_message_template', {
      p_company_id: secondCompanyId,
      p_key: 'REFUSAL',
      p_body: 'Estação errada',
    });

    // 42501 and never P0002: the door checks the permission BEFORE resolving
    // the Station (0093), so the answer cannot be read as "that Station does
    // not exist" either.
    expect(error?.code).toBe('42501');
  });

  it('refuses a registration at a Station the caller holds nothing in', async () => {
    const manager = await grantRoleWith(
      customer,
      `tpl-manager-b-${STAMP}`,
      ['templates.view', 'templates.manage'],
      [customer.companyId],
    );
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('register_message_template', {
      p_company_id: secondCompanyId,
      p_purpose: 'PICKUP_REMINDER',
      p_name: 'estacao_errada',
      p_language: 'pt_BR',
      p_body: 'Oi {{1}}!',
      p_variables: ['LISTENER_FIRST_NAME'],
    });

    expect(error?.code).toBe('42501');
  });

  it('never answers P0002 for a template id the caller may not see', async () => {
    const manager = await grantRoleWith(
      customer,
      `tpl-manager-c-${STAMP}`,
      ['templates.view', 'templates.manage'],
      [customer.companyId],
    );
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('archive_message_template', {
      p_id: secondStationTemplateId,
    });

    // The id names a real, live template — in a Station this caller cannot
    // reach. It answers exactly what a uuid naming nothing at all answers, so
    // the door is not an oracle for what exists elsewhere in the group.
    expect(error?.code).toBe('42501');
  });

  // -------------------------------------------------------------------------
  // The read boundary, both directions. The negative half first.
  // -------------------------------------------------------------------------

  it('shows no override at all to a caller holding neither code', async () => {
    const stranger = await grantRoleWith(customer, `tpl-stranger-msg-${STAMP}`, ['members.view']);
    const client = await signInAs(stranger.email, stranger.password);

    const { data, error } = await client.from('station_message_templates').select('key, body');

    // The grant lets the statement run; the policy is what empties it. So this
    // is a silent zero rather than a 42501, and asserting the row exists for
    // somebody else is what stops the case passing against a table that is
    // simply empty.
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const owner = await signInAs(customer.email, customer.password);
    const { data: ownerRows } = await owner.from('station_message_templates').select('key');
    expect((ownerRows ?? []).map((r) => r.key)).toContain('REFUSAL');
  });

  it('shows no registered template at all to a caller holding neither code', async () => {
    const stranger = await grantRoleWith(customer, `tpl-stranger-reg-${STAMP}`, ['members.view']);
    const client = await signInAs(stranger.email, stranger.password);

    const { data, error } = await client.from('message_templates').select('name');

    expect(error).toBeNull();
    expect(data).toEqual([]);

    const owner = await signInAs(customer.email, customer.password);
    const { data: ownerRows } = await owner.from('message_templates').select('name');
    expect((ownerRows ?? []).map((r) => r.name)).toContain('lembrete_retirada');
  });

  // -------------------------------------------------------------------------
  // …and the positive half, which is what makes the two screens reachable and
  // which nothing else in the repository proves. Both tables, in one case, on
  // purpose: they are granted separately and could break separately.
  // -------------------------------------------------------------------------

  it('lets templates.view alone read both tables', async () => {
    const viewer = await grantRoleWith(customer, `tpl-reader-${STAMP}`, ['templates.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { data: overrides, error: overrideError } = await client
      .from('station_message_templates')
      .select('key, body');
    expect(overrideError).toBeNull();
    expect((overrides ?? []).map((o) => o.key)).toContain('REFUSAL');

    const { data: registrations, error: registrationError } = await client
      .from('message_templates')
      .select('name, variables');
    expect(registrationError).toBeNull();
    expect((registrations ?? []).map((r) => r.name)).toContain('lembrete_retirada');
  });

  it('shows a caller only the Stations they can reach, not the whole group', async () => {
    // The owner registered a template in BOTH Stations; this delegate holds
    // templates.view in one. 0110's policy gates on has_permission per row's
    // company_id, so the second Station's registration must be absent — the
    // property a policy written `using (true)` would silently lose.
    const viewer = await grantRoleWith(customer, `tpl-one-station-${STAMP}`, ['templates.view'], [
      customer.companyId,
    ]);
    const client = await signInAs(viewer.email, viewer.password);

    const { data, error } = await client.from('message_templates').select('name');
    expect(error).toBeNull();

    const names = (data ?? []).map((r) => r.name);
    expect(names).toContain('lembrete_retirada');
    expect(names).not.toContain('lembrete_da_outra_estacao');
  });

  // -------------------------------------------------------------------------
  // The back door. Both tables revoke every write from `authenticated`, so the
  // doors above are the only way in — including for a caller who holds
  // templates.manage and would be allowed through them.
  // -------------------------------------------------------------------------

  it('refuses a direct insert into the overrides even to a caller with templates.manage', async () => {
    const manager = await grantRoleWith(customer, `tpl-direct-msg-${STAMP}`, [
      'templates.view',
      'templates.manage',
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.from('station_message_templates').insert({
      organization_id: customer.organizationId,
      company_id: customer.companyId,
      key: 'ABANDON',
      body: 'Pela porta dos fundos',
    });

    // Refused by the missing grant, before RLS is consulted at all.
    expect(error?.code).toBe('42501');
  });

  it('refuses a direct insert into the registry even to a caller with templates.manage', async () => {
    const manager = await grantRoleWith(customer, `tpl-direct-reg-${STAMP}`, [
      'templates.view',
      'templates.manage',
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.from('message_templates').insert({
      organization_id: customer.organizationId,
      company_id: customer.companyId,
      purpose: 'PICKUP_REMINDER',
      name: 'pela_porta_dos_fundos',
      language: 'pt_BR',
      body: 'Oi {{1}}!',
    });

    expect(error?.code).toBe('42501');
  });
});
