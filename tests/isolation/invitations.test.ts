import { describe, it, expect, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  provisionCustomer,
  signInAs,
  createUser,
  createRoleAs,
  addMemberByInvitation,
  cleanupUsers,
  admin,
} from './harness';
import { hashInvitationToken } from '@/services/invitations';

afterAll(async () => {
  await cleanupUsers();
});

function freshToken(): string {
  return randomBytes(32).toString('base64url');
}

describe('invitations', () => {
  it('an owner can create one and a member without users.invite cannot', async () => {
    const a = await provisionCustomer(`inv-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    // Block 1b seeded users.invite to the owner alone — operator and viewer
    // held nothing. The role-based equivalent is a role with no permissions.
    const roleId = await createRoleAs(a, `NoPerms-${Date.now()}`, []);

    const { data: id, error } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `guest-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });
    expect(error).toBeNull();
    expect(id).toBeTruthy();

    // Seeded directly through the invitation flow, which is the only path that
    // can add a member: service_role cannot write the tenant tables.
    const member = await addMemberByInvitation(a, `mem-${Date.now()}`, roleId, [a.companyId]);
    const memberClient = await signInAs(member.email, member.password);
    const { error: denied } = await memberClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `nope-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });
    expect(denied).not.toBeNull();
    expect(denied?.message).toMatch(/permission denied/i);
  });

  it('refuses an e-mail that already has an account', async () => {
    const a = await provisionCustomer(`dup-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);

    const { error } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: a.email,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/already has an account/i);
  });

  it('one organization cannot read another organization invitations', async () => {
    const a = await provisionCustomer(`ra-${Date.now()}`);
    const b = await provisionCustomer(`rb-${Date.now()}`);

    const ownerA = await signInAs(a.email, a.password);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);
    await ownerA.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `secret-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(freshToken()),
      p_ttl_days: 7,
    });

    const ownerB = await signInAs(b.email, b.password);
    const { data } = await ownerB.from('invitations').select('id, email');
    expect(data ?? []).toEqual([]);
  });

  it('a revoked invitation cannot be accepted', async () => {
    const a = await provisionCustomer(`rev-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);
    const token = freshToken();

    const { data: id } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `revoked-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });
    await ownerClient.rpc('revoke_invitation', { p_invitation_id: String(id) });

    const invitee = await createUser(`ri-${Date.now()}@example.test`);
    const { error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: invitee.userId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invalid or expired/i);
  });

  it('an expired invitation cannot be accepted', async () => {
    const a = await provisionCustomer(`exp-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);
    const token = freshToken();

    // Born already expired, via the real RPC. Ageing the row afterwards is not
    // possible and should not be: service_role holds no write grant on
    // invitations, so the only way in is create_invitation itself.
    const { error: createError } = await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `expired-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: -1,
    });
    expect(createError).toBeNull();

    const invitee = await createUser(`ei-${Date.now()}@example.test`);
    const { error } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: invitee.userId,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/invalid or expired/i);
  });

  it('cannot be accepted twice', async () => {
    const a = await provisionCustomer(`twice-${Date.now()}`);
    const ownerClient = await signInAs(a.email, a.password);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);
    const token = freshToken();

    await ownerClient.rpc('create_invitation', {
      p_organization_id: a.organizationId,
      p_email: `once-${Date.now()}@example.test`,
      p_is_owner: false,
      p_role_id: roleId,
      p_company_ids: [a.companyId],
      p_token_hash: hashInvitationToken(token),
      p_ttl_days: 7,
    });

    const first = await createUser(`f1-${Date.now()}@example.test`);
    const { error: firstError } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: first.userId,
    });
    expect(firstError).toBeNull();

    const second = await createUser(`f2-${Date.now()}@example.test`);
    const { error: secondError } = await admin.rpc('accept_invitation', {
      p_token_hash: hashInvitationToken(token),
      p_user_id: second.userId,
    });
    expect(secondError).not.toBeNull();
  });

  it('acceptance grants membership at the invited role', async () => {
    const a = await provisionCustomer(`grant-${Date.now()}`);
    const roleId = await createRoleAs(a, `Role-${Date.now()}`, []);
    const invitee = await addMemberByInvitation(a, `grant-${Date.now()}`, roleId, [a.companyId]);

    const inviteeClient = await signInAs(invitee.email, invitee.password);
    const { data: companies } = await inviteeClient.from('companies').select('id');
    expect((companies ?? []).map((r) => r.id)).toContain(a.companyId);

    const { data: canInvite } = await inviteeClient.rpc('has_org_permission', {
      p_permission: 'users.invite',
      p_organization_id: a.organizationId,
    });
    expect(canInvite).toBe(false);
  });
});
