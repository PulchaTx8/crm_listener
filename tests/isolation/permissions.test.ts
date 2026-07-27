import { describe, it, expect, afterAll } from 'vitest';
import { provisionCustomer, signInAs, addMemberByInvitation, cleanupUsers, admin } from './harness';

afterAll(async () => {
  await cleanupUsers();
});

describe('permission helpers', () => {
  it('grants the owner what the seed says and denies the operator', async () => {
    const a = await provisionCustomer(`perm-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: ownerCan } = await ownerClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(ownerCan).toBe(true);

    const operator = await addMemberByInvitation(a, `op-${Date.now()}`, 'operator');
    const operatorClient = await signInAs(operator.email, operator.password);

    const { data: operatorCan } = await operatorClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(operatorCan).toBe(false);
  });

  it('returns false for an unknown permission code, even for a platform admin', async () => {
    const a = await provisionCustomer(`closed-${Date.now()}`);

    // a.adminClient is the platform admin that provisioned this customer, so
    // is_platform_admin() is true — which is exactly the path where a naive
    // `is_platform_admin() or exists(...)` would short-circuit and return true
    // before the permission code was ever compared.
    const { data } = await a.adminClient.rpc('has_permission', {
      p_permission: 'totally.bogus.code',
      p_company_id: a.companyId,
    });
    expect(data).toBe(false);
  });

  it('grants a real permission to a platform admin on an active company', async () => {
    // The counterpart to the test above: the bypass must still work for a code
    // that exists, or the fail-closed fix would have broken admin access.
    const a = await provisionCustomer(`bypass-${Date.now()}`);
    const { data } = await a.adminClient.rpc('has_permission', {
      p_permission: 'users.manage',
      p_company_id: a.companyId,
    });
    expect(data).toBe(true);
  });

  it('yields no permissions on a suspended company, even to its owner', async () => {
    const a = await provisionCustomer(`susp-${Date.now()}`);
    const { error } = await a.adminClient.rpc('suspend_company', {
      p_company_id: a.companyId,
      p_reason: 'non-payment',
    });
    expect(error).toBeNull();

    const ownerClient = await signInAs(a.email, a.password);
    const { data } = await ownerClient.rpc('has_permission', {
      p_permission: 'users.manage',
      p_company_id: a.companyId,
    });
    expect(data).toBe(false);
  });
});

describe('member management', () => {
  it('refuses to remove the last owner', async () => {
    const a = await provisionCustomer(`last-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', a.organizationId)
      .eq('user_id', a.userId)
      .single();
    if (!membership) throw new Error('provisioning left no owner membership');

    const { error } = await ownerClient.rpc('remove_member', {
      p_membership_id: membership.id,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/at least one owner/i);
  });

  it('refuses to demote the last owner', async () => {
    const a = await provisionCustomer(`demote-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', a.organizationId)
      .eq('user_id', a.userId)
      .single();
    if (!membership) throw new Error('provisioning left no owner membership');

    const { error } = await ownerClient.rpc('change_member_role', {
      p_membership_id: membership.id,
      p_new_role: 'viewer',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/at least one owner/i);
  });

  it('allows demoting an owner once a second owner exists', async () => {
    // The rule is "at least one", not "never demote an owner". Without this the
    // trigger could be over-tight and no test would notice.
    const a = await provisionCustomer(`second-${Date.now()}`);
    await addMemberByInvitation(a, `co-${Date.now()}`, 'owner');
    const ownerClient = await signInAs(a.email, a.password);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('organization_id', a.organizationId)
      .eq('user_id', a.userId)
      .single();
    if (!membership) throw new Error('provisioning left no owner membership');

    const { error } = await ownerClient.rpc('change_member_role', {
      p_membership_id: membership.id,
      p_new_role: 'viewer',
    });
    expect(error).toBeNull();
  });

  it('an operator cannot change roles', async () => {
    const a = await provisionCustomer(`opmanage-${Date.now()}`);
    const operator = await addMemberByInvitation(a, `mg-${Date.now()}`, 'operator');
    const operatorClient = await signInAs(operator.email, operator.password);

    const { data: victim } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('user_id', a.userId)
      .single();
    if (!victim) throw new Error('no owner membership to target');

    const { error } = await operatorClient.rpc('change_member_role', {
      p_membership_id: victim.id,
      p_new_role: 'viewer',
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied/i);
  });

  it('an owner reads their own audit trail and no one else', async () => {
    const a = await provisionCustomer(`audit-${Date.now()}`);
    const b = await provisionCustomer(`auditb-${Date.now()}`);

    const ownerA = await signInAs(a.email, a.password);
    const { data: rows } = await ownerA
      .from('audit_logs')
      .select('action, organization_id');

    // Provisioning wrote one, so there is something to see.
    expect((rows ?? []).length).toBeGreaterThan(0);
    expect((rows ?? []).every((r) => r.organization_id === a.organizationId)).toBe(true);
    expect((rows ?? []).some((r) => r.organization_id === b.organizationId)).toBe(false);
  });

  it('an operator cannot read the audit trail at all', async () => {
    // audit.view is the third permission this block seeds, and the only one
    // enforced through an RLS policy rather than an RPC body.
    const a = await provisionCustomer(`auditop-${Date.now()}`);
    const operator = await addMemberByInvitation(a, `ao-${Date.now()}`, 'operator');
    const operatorClient = await signInAs(operator.email, operator.password);

    const { data } = await operatorClient.from('audit_logs').select('action');
    expect(data ?? []).toEqual([]);
  });

  it('a removed member loses access on the next request', async () => {
    const a = await provisionCustomer(`revoke-${Date.now()}`);
    const viewer = await addMemberByInvitation(a, `rv-${Date.now()}`, 'viewer');
    const viewerClient = await signInAs(viewer.email, viewer.password);

    const { data: before } = await viewerClient.from('companies').select('id');
    expect((before ?? []).map((r) => r.id)).toContain(a.companyId);

    const { data: membership } = await admin
      .from('organization_memberships')
      .select('id')
      .eq('user_id', viewer.userId)
      .single();
    if (!membership) throw new Error('no membership to remove');

    const ownerClient = await signInAs(a.email, a.password);
    const { error } = await ownerClient.rpc('remove_member', {
      p_membership_id: membership.id,
    });
    expect(error).toBeNull();

    // Same client, same JWT, no re-authentication: the helpers query the tables
    // on every check, so revocation is immediate.
    const { data: after } = await viewerClient.from('companies').select('id');
    expect(after ?? []).toEqual([]);
  });
});
