import { createHash, randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  addMemberByInvitation,
  admin,
  cleanupUsers,
  createRoleAs,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

describe('roles', () => {
  it('grants a permission in one Station and withholds it in another', async () => {
    const label = `roles-scope-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const second = await addCompany(customer, 'Station Two');
    const manager = await createRoleAs(customer, 'Manager', ['users.invite']);
    const bystander = await createRoleAs(customer, 'Bystander', []);
    const member = await addMemberByInvitation(customer, label, manager, [customer.companyId]);

    // The member must hold a membership in the second Station too, under a role
    // that grants nothing. Without it, has_company_access already returns false
    // there and has_permission short-circuits before the role branch runs — so
    // the test would pass at the access gate and leave the line that actually
    // implements "the role assigned in THAT Company" unproven.
    const owner = await signInAs(customer.email, customer.password);
    const { error: assignError } = await owner.rpc('assign_company_role', {
      p_company_id: second,
      p_user_id: member.userId,
      p_role_id: bystander,
    });
    expect(assignError).toBeNull();

    const client = await signInAs(member.email, member.password);

    const { data: here } = await client.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    const { data: there } = await client.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: second,
    });
    const { data: reachesSecond } = await client.rpc('has_company_access', {
      p_company_id: second,
    });

    expect(reachesSecond).toBe(true);
    expect(here).toBe(true);
    expect(there).toBe(false);
  });

  it('cuts access on the next request when the permission is unchecked', async () => {
    const label = `roles-live-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const role = await createRoleAs(customer, 'Manager', ['users.invite']);
    const member = await addMemberByInvitation(customer, label, role, [customer.companyId]);

    // The SAME client throughout: no sign-out, no token refresh.
    const client = await signInAs(member.email, member.password);
    const before = await client.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: customer.organizationId,
    });
    expect(before.data).toBe(true);

    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner.rpc('update_role', {
      p_role_id: role,
      p_name: 'Manager',
      // p_description is optional in the generated Args; omitting it compiles
      // clean and produces identical SQL (the RPC default is null).
      p_permission_codes: [],
    });
    expect(error).toBeNull();

    const after = await client.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: customer.organizationId,
    });
    expect(after.data).toBe(false);
  });

  it('refuses to delete a role somebody holds', async () => {
    const label = `roles-inuse-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const role = await createRoleAs(customer, 'Manager', []);
    await addMemberByInvitation(customer, label, role, [customer.companyId]);

    const owner = await signInAs(customer.email, customer.password);
    const { error } = await owner.rpc('delete_role', { p_role_id: role });

    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/assigned to 1 user/i);
  });

  it('refuses to assign a role that was archived', async () => {
    const label = `roles-archived-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const role = await createRoleAs(customer, 'Retired', ['users.invite']);
    const target = await addMemberByInvitation(customer, label, role, [customer.companyId]);

    const owner = await signInAs(customer.email, customer.password);
    await owner.rpc('remove_company_access', {
      p_company_id: customer.companyId,
      p_user_id: target.userId,
    });
    const archived = await owner.rpc('delete_role', { p_role_id: role });
    expect(archived.error).toBeNull();

    // The composite foreign key cannot see deleted_at — it references a
    // non-partial constraint, because a foreign key cannot reference a partial
    // index. Without an explicit liveness check the assignment would succeed and
    // hand back permissions the owner had retired.
    const { error } = await owner.rpc('assign_company_role', {
      p_company_id: customer.companyId,
      p_user_id: target.userId,
      p_role_id: role,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/role not found/i);
  });

  it('accepts the same Station named twice without dying on the primary key', async () => {
    const label = `roles-dupe-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const role = await createRoleAs(customer, 'Local', []);
    const owner = await signInAs(customer.email, customer.password);

    // A fixed, low-entropy hash would collide with whatever this DB already
    // holds under the global unique index on token_hash — unrelated to this
    // test's own claim, and the resulting 23505 would look identical to the
    // one this test is trying to provoke. Same construction the harness uses.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // `unnest` does not deduplicate, so a count-based validation lets the same
    // Station through twice and the insert then fails on the primary key with a
    // raw duplicate-key error. This is the only place that path is reachable —
    // create_invitation needs a real session, which pgTAP cannot provide.
    const { data: invitationId, error } = await owner.rpc('create_invitation', {
      p_organization_id: customer.organizationId,
      p_email: `dupe-station-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: role,
      p_company_ids: [customer.companyId, customer.companyId],
      p_token_hash: tokenHash,
      p_ttl_days: 7,
    });
    expect(error).toBeNull();

    // A mutation that skipped the insert into invitation_companies entirely
    // would still leave `error` null; only counting the row proves the
    // dedup actually ran rather than just not crashing.
    const { data: rows } = await admin
      .from('invitation_companies')
      .select('company_id')
      .eq('invitation_id', invitationId as string);
    expect(rows).toHaveLength(1);
  });

  it('refuses to remove access that is not there', async () => {
    const label = `roles-noop-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const role = await createRoleAs(customer, 'Local', []);
    const member = await addMemberByInvitation(customer, label, role, [customer.companyId]);

    const owner = await signInAs(customer.email, customer.password);
    const first = await owner.rpc('remove_company_access', {
      p_company_id: customer.companyId,
      p_user_id: member.userId,
    });
    expect(first.error).toBeNull();

    // A second call must fail rather than write an audit row for a removal that
    // did not happen.
    const second = await owner.rpc('remove_company_access', {
      p_company_id: customer.companyId,
      p_user_id: member.userId,
    });
    expect(second.error).not.toBeNull();
    expect(second.error!.message).toMatch(/no access to this company/i);
  });

  it('refuses a role from another Organization even with a valid id', async () => {
    const a = await provisionCustomer(`roles-org-a-${Date.now()}`);
    const b = await provisionCustomer(`roles-org-b-${Date.now()}`);
    const foreign = await createRoleAs(b, 'Foreign', []);

    const memberOfA = await createUserInOrgA(a);
    const owner = await signInAs(a.email, a.password);
    const { error } = await owner.rpc('assign_company_role', {
      p_company_id: a.companyId,
      p_user_id: memberOfA,
      p_role_id: foreign,
    });

    expect(error).not.toBeNull();
    // Task 3 relied solely on the composite foreign key here, which would have
    // surfaced as a raw constraint-violation error. Task 4 (22703bd) added the
    // `for share ... deleted_at is null` liveness check to close the
    // archived-role hole, and that check's WHERE clause filters on
    // `organization_id = v_org` too — so a foreign Organization's role is now
    // refused by that same explicit, friendly check before the insert (and the
    // FK) is ever reached. The FK still backs it up if this body were wrong.
    expect(error!.message).toMatch(/role not found in this organization/i);
  });

  it('lets an Organization member read a colleague\'s profile, never one from another Organization', async () => {
    // profiles_select_org_member (0020_profiles_visibility.sql): the Team
    // screen renders a row per member per Station and needs the colleague's
    // name/e-mail to do it, but the policy must stop at the Organization
    // boundary — it joins organization_memberships to itself, so proving it
    // requires a SECOND Organization whose owner must stay unreadable.
    const label = `profiles-visibility-${Date.now()}`;
    const a = await provisionCustomer(label);
    const b = await provisionCustomer(`${label}-b`);

    const role = await createRoleAs(a, 'Local', []);
    const colleague = await addMemberByInvitation(a, label, role, [a.companyId]);

    const client = await signInAs(colleague.email, colleague.password);

    // Within A: the colleague can read the owner's profile row (not just
    // their own — profiles_select_self alone would already cover "your own
    // row", so this pins the new, wider grant).
    const { data: withinOrg, error: withinError } = await client
      .from('profiles')
      .select('id')
      .eq('id', a.userId)
      .maybeSingle();
    expect(withinError).toBeNull();
    expect(withinOrg?.id).toBe(a.userId);

    // Across Organizations: the same colleague reading B's owner comes back
    // with no row and no error — RLS silently excludes it, exactly like every
    // other cross-tenant select in this suite. A `.single()` would turn "zero
    // rows" into a thrown error and mask the distinction between "excluded by
    // RLS" and "a real query fault"; `.maybeSingle()` keeps that visible.
    const { data: acrossOrg, error: acrossError } = await client
      .from('profiles')
      .select('id')
      .eq('id', b.userId)
      .maybeSingle();
    expect(acrossError).toBeNull();
    expect(acrossOrg).toBeNull();
  });

  it('lets roles.manage administer roles, and refuses without it', async () => {
    const label = `roles-delegate-${Date.now()}`;
    const customer = await provisionCustomer(label);
    const admin_role = await createRoleAs(customer, 'Director', ['roles.manage']);
    const plain = await createRoleAs(customer, 'Trainee', []);

    const director = await addMemberByInvitation(customer, `${label}-director`, admin_role, [
      customer.companyId,
    ]);
    const trainee = await addMemberByInvitation(customer, `${label}-trainee`, plain, [
      customer.companyId,
    ]);

    const asDirector = await signInAs(director.email, director.password);
    const created = await asDirector.rpc('create_role', {
      p_organization_id: customer.organizationId,
      p_name: 'Producer',
      p_permission_codes: [],
    });
    expect(created.error).toBeNull();

    const asTrainee = await signInAs(trainee.email, trainee.password);
    const refused = await asTrainee.rpc('create_role', {
      p_organization_id: customer.organizationId,
      p_name: 'Sneaky',
      p_permission_codes: [],
    });
    expect(refused.error).not.toBeNull();
    expect(refused.error!.message).toMatch(/roles\.manage/);
  });

  it('grants the owner everything without any membership row', async () => {
    const customer = await provisionCustomer(`roles-owner-${Date.now()}`);
    const owner = await signInAs(customer.email, customer.password);

    const { data: rows } = await admin
      .from('company_memberships')
      .select('id')
      .eq('user_id', customer.userId);
    expect(rows).toHaveLength(0);

    const { data } = await owner.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    expect(data).toBe(true);
  });

  it('grants nothing once the Station is suspended, not even to the owner', async () => {
    const customer = await provisionCustomer(`roles-suspended-${Date.now()}`);
    await customer.adminClient.rpc('suspend_company', {
      p_company_id: customer.companyId,
      p_reason: 'non-payment',
    });

    const owner = await signInAs(customer.email, customer.password);
    const { data } = await owner.rpc('has_permission', {
      p_permission: 'users.invite',
      p_company_id: customer.companyId,
    });
    expect(data).toBe(false);

    // The Organization-scoped helper must agree. The owner's bypass carries its
    // own subscription gate for exactly this case, and nothing else in the suite
    // pins it — a later block could drop the gate and every other test would
    // still pass. A lapsed customer is frozen; reactivation is the platform
    // admin's job, not theirs.
    const { data: orgScoped } = await owner.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: customer.organizationId,
    });
    expect(orgScoped).toBe(false);
  });
});

/** A second person in Organization A, needed as the target of a bad assignment. */
async function createUserInOrgA(a: Awaited<ReturnType<typeof provisionCustomer>>) {
  const role = await createRoleAs(a, 'Local', []);
  const member = await addMemberByInvitation(a, `roles-target-${Date.now()}`, role, [a.companyId]);
  return member.userId;
}
