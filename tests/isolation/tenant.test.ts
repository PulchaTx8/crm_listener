import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { provisionCustomer, signInAs, cleanupUsers, admin } from './harness';

afterAll(async () => {
  await cleanupUsers();
});

describe('tenant isolation', () => {
  it('a user reads only their own company', async () => {
    const a = await provisionCustomer(`a-${Date.now()}`);
    const b = await provisionCustomer(`b-${Date.now()}`);

    const clientA = await signInAs(a.email, a.password);
    const { data } = await clientA.from('companies').select('id');

    const ids = (data ?? []).map((r) => r.id);
    expect(ids).toContain(a.companyId);
    expect(ids).not.toContain(b.companyId);
  });

  it('a user cannot write into another company', async () => {
    const a = await provisionCustomer(`wa-${Date.now()}`);
    const b = await provisionCustomer(`wb-${Date.now()}`);

    const clientA = await signInAs(a.email, a.password);
    // company_memberships takes no INSERT grant at all (Block 1c: every write
    // goes through assign_company_role), so this is denied before role_id or
    // organization_id are ever validated — their values only need to satisfy
    // the Insert type, not point at a real role.
    const { error } = await clientA.from('company_memberships').insert({
      user_id: a.userId,
      company_id: b.companyId,
      organization_id: b.organizationId,
      role_id: crypto.randomUUID(),
    });

    expect(error).not.toBeNull();
  });

  it('an ordinary user cannot provision', async () => {
    const a = await provisionCustomer(`p-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    const { error } = await clientA.rpc('provision_customer', {
      p_user_id: a.userId,
      p_organization_name: 'Pirate Org',
      p_company_name: 'Pirate Company',
      p_timezone: 'America/Sao_Paulo',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('an ordinary user cannot suspend a company', async () => {
    const a = await provisionCustomer(`s-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    const { error } = await clientA.rpc('suspend_company', {
      p_company_id: a.companyId,
      p_reason: 'nope',
    });

    expect(error).not.toBeNull();
  });

  it('a suspended company yields no business data, even to its owner', async () => {
    const a = await provisionCustomer(`sus-${Date.now()}`);

    // Suspend through the real subscription lever rather than writing the
    // column directly, so the test covers the path production actually uses.
    const { error: suspendError } = await a.adminClient.rpc('suspend_company', {
      p_company_id: a.companyId,
      p_reason: 'non-payment',
    });
    expect(suspendError).toBeNull();

    const clientA = await signInAs(a.email, a.password);

    // Metadata stays visible so the UI can explain the suspension...
    const { data: meta } = await clientA.from('companies').select('id, status');
    expect((meta ?? []).map((r) => r.id)).toContain(a.companyId);

    // ...but has_company_access is false, which is what business tables use.
    const { data: access } = await clientA.rpc('has_company_access', {
      p_company_id: a.companyId,
    });
    expect(access).toBe(false);
  });

  it('anon cannot read companies at all', async () => {
    const a = await provisionCustomer(`anon-${Date.now()}`);
    const anonClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    const { data, error } = await anonClient.from('companies').select('id');
    expect(error ?? data?.length === 0).toBeTruthy();
    expect(a.companyId).toBeTruthy();
  });

  it('a user cannot clear their own password gate', async () => {
    const a = await provisionCustomer(`gate-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    // provision_customer sets the gate; only complete_password_change may clear
    // it. A table-level UPDATE grant on profiles would make this PATCH succeed
    // and let the user walk straight past the forced password change.
    const { error } = await clientA
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', a.userId);

    expect(error).not.toBeNull();

    const { data: after } = await admin
      .from('profiles')
      .select('must_change_password')
      .eq('id', a.userId)
      .single();
    expect(after?.must_change_password).toBe(true);
  });

  it('a user may still edit their own display name', async () => {
    const a = await provisionCustomer(`name-${Date.now()}`);
    const clientA = await signInAs(a.email, a.password);

    // The counterpart to the test above: locking the gate columns must not
    // lock the whole row.
    const { error } = await clientA
      .from('profiles')
      .update({ full_name: 'Renamed Owner' })
      .eq('id', a.userId);

    expect(error).toBeNull();
  });
});
