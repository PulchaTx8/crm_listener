import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/supabase/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Resolved from this file's own location, not process.cwd() — vitest happens
// to run from the repo root today, but a helper that only works from one
// particular working directory is a trap for whoever runs it differently
// tomorrow (a workspace script, an IDE test runner, a future CI step).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const admin = createClient<Database>(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const createdUserIds: string[] = [];

export interface ProvisionedCustomer {
  userId: string;
  email: string;
  password: string;
  organizationId: string;
  companyId: string;
  /** Signed-in client for the platform admin that provisioned this customer. */
  adminClient: SupabaseClient<Database>;
}

/**
 * Creates a real auth user, marks it a platform admin only if asked, then
 * calls the real provision_customer RPC as that admin. Mirrors what the
 * application does, so the tests exercise the production path.
 */
export async function provisionCustomer(label: string): Promise<ProvisionedCustomer> {
  const adminUser = await createUser(`admin-${label}@example.test`);
  const { error: adminError } = await admin
    .from('platform_admins')
    .insert({ user_id: adminUser.userId });
  if (adminError) throw new Error(`could not seed platform admin: ${adminError.message}`);

  const owner = await createUser(`owner-${label}@example.test`);

  const adminClient = await signInAs(adminUser.email, adminUser.password);
  const { data, error } = await adminClient.rpc('provision_customer', {
    p_user_id: owner.userId,
    p_organization_name: `Org ${label}`,
    p_company_name: `Company ${label}`,
    p_timezone: 'America/Sao_Paulo',
  });
  if (error) throw new Error(`provision_customer failed: ${error.message}`);

  const result = data as { organization_id: string; company_id: string };
  return {
    ...owner,
    organizationId: result.organization_id,
    companyId: result.company_id,
    adminClient,
  };
}

export async function createUser(
  email: string,
): Promise<{ userId: string; email: string; password: string }> {
  const password = `Test-${crypto.randomUUID()}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, email });
  if (profileError) throw new Error(`could not create profile: ${profileError.message}`);
  createdUserIds.push(data.user.id);
  return { userId: data.user.id, email, password };
}

export async function signInAs(email: string, password: string): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signInAs(${email}) failed: ${error.message}`);
  return client;
}

export async function cleanupUsers(): Promise<void> {
  const ids = createdUserIds.splice(0);
  const failures: string[] = [];

  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) failures.push(id);
  }

  // A cleanup that lies is worse than one that fails: this reports what it
  // could not do rather than swallowing the error. Confirmed causes, any of
  // which can block a given user:
  //   - audit_logs.actor_id, companies.provisioned_by, invitations.invited_by /
  //     accepted_by, and roles.created_by all reference auth.users(id) with NO
  //     `on delete cascade` (0003_identity_tenant.sql, 0004_audit_and_contact.sql,
  //     0012_invitations.sql, 0015_roles.sql) — so any user who ever acted
  //     through an audited RPC (which is most of them: accept_invitation alone
  //     records the invitee as actor_id) leaves a row Postgres refuses to orphan.
  //   - An Organization's sole owner additionally cascades into
  //     organization_memberships (`on delete cascade`), which trips the deferred
  //     "at least one owner" constraint trigger (0011_member_management.sql).
  // The second is load-bearing product behaviour; the first is just how the
  // schema was built. Neither is something test cleanup should work around by
  // itself, so the row is left behind in auth.users instead of being silently
  // (and falsely) reported as gone.
  if (failures.length > 0) {
    console.warn(
      `cleanupUsers: could not delete ${failures.length} user(s), left behind in auth.users ` +
        `(non-cascading FKs from audit_logs/companies/invitations/roles, or an Organization's ` +
        `sole owner tripping the "at least one owner" trigger): ${failures.join(', ')}`,
    );
  }
}

/**
 * Creates a role in the customer's Organization through the real RPC, as the
 * owner. Tests cannot insert one directly: roles are written only by the
 * SECURITY DEFINER functions, and going the long way round means the seeding
 * path is the production path.
 */
export async function createRoleAs(
  customer: ProvisionedCustomer,
  name: string,
  permissionCodes: string[],
): Promise<string> {
  const ownerClient = await signInAs(customer.email, customer.password);
  const { data, error } = await ownerClient.rpc('create_role', {
    p_organization_id: customer.organizationId,
    p_name: name,
    p_permission_codes: permissionCodes,
  });
  if (error) throw new Error(`create_role failed: ${error.message}`);
  return data as string;
}

/**
 * Adds a second person to an existing Organization holding the given role in
 * the given Companies, through the real invitation flow.
 *
 * It cannot simply insert the membership rows: Block 1a deliberately leaves the
 * tenant tables read-only for `service_role`, so that a mistake in server code
 * cannot create or move a tenant behind the audited RPCs' back. That decision
 * applies to tests too — which is the point. Going the long way round means the
 * seeding path is the production path.
 *
 * Order matters: the invitation is created BEFORE the auth user exists, because
 * create_invitation refuses an address that already has an account.
 */
export async function addMemberByInvitation(
  customer: ProvisionedCustomer,
  label: string,
  roleId: string,
  companyIds: string[],
): Promise<{ userId: string; email: string; password: string }> {
  const email = `member-${label}@example.test`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const ownerClient = await signInAs(customer.email, customer.password);
  const { error: inviteError } = await ownerClient.rpc('create_invitation', {
    p_organization_id: customer.organizationId,
    p_email: email,
    p_is_owner: false,
    p_role_id: roleId,
    p_company_ids: companyIds,
    p_token_hash: tokenHash,
    p_ttl_days: 7,
  });
  if (inviteError) throw new Error(`create_invitation failed: ${inviteError.message}`);

  const user = await createUser(email);

  const { error: acceptError } = await admin.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: user.userId,
  });
  if (acceptError) throw new Error(`accept_invitation failed: ${acceptError.message}`);

  return user;
}

/**
 * Adds a second owner to an existing Organization, through the real invitation
 * flow. Not in the brief's mandated harness surface — added because Block 1c
 * removed the only other way a test had to produce one: addMemberByInvitation
 * always invites p_is_owner: false, and an owner takes no role or Company at
 * all, so it cannot be reused with a null role. permissions.test.ts needs a
 * second owner to prove the last-owner guard only blocks going to zero owners,
 * not demoting an owner outright.
 */
export async function addOwnerByInvitation(
  customer: ProvisionedCustomer,
  label: string,
): Promise<{ userId: string; email: string; password: string }> {
  const email = `owner-${label}@example.test`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const ownerClient = await signInAs(customer.email, customer.password);
  const { error: inviteError } = await ownerClient.rpc('create_invitation', {
    p_organization_id: customer.organizationId,
    p_email: email,
    p_is_owner: true,
    // p_role_id is a nullable uuid with no SQL default, so `supabase gen types`
    // types the generated Args as a bare string (same gap noted in
    // src/services/invitations.ts). The RPC body requires exactly this: null
    // when p_is_owner is true. `as unknown as string` because a literal `null`
    // and `string` do not overlap enough for a direct assertion.
    p_role_id: null as unknown as string,
    p_company_ids: [],
    p_token_hash: tokenHash,
    p_ttl_days: 7,
  });
  if (inviteError) throw new Error(`create_invitation failed: ${inviteError.message}`);

  const user = await createUser(email);

  const { error: acceptError } = await admin.rpc('accept_invitation', {
    p_token_hash: tokenHash,
    p_user_id: user.userId,
  });
  if (acceptError) throw new Error(`accept_invitation failed: ${acceptError.message}`);

  return user;
}

/**
 * Adds a second Station through the real RPC, as the platform admin that
 * provisioned the customer. Per-Company roles cannot be tested against an
 * Organization holding one Company.
 */
export async function addCompany(customer: ProvisionedCustomer, name: string): Promise<string> {
  const { data, error } = await customer.adminClient.rpc('add_company', {
    p_organization_id: customer.organizationId,
    p_name: name,
    p_timezone: 'America/Sao_Paulo',
  });
  if (error) throw new Error(`add_company failed: ${error.message}`);
  return data as string;
}

/**
 * Registers a prize through the real create_prize RPC, as the owner. Pure
 * fixture setup for inventory.test.ts: catalogue creation is not itself under
 * test in most of that suite's cases, so the owner's bypass is fine here —
 * every case still performs the operation it actually names through its own
 * delegate client.
 */
export async function createPrizeAs(
  customer: ProvisionedCustomer,
  name: string,
  companyId: string = customer.companyId,
): Promise<string> {
  const ownerClient = await signInAs(customer.email, customer.password);
  const { data, error } = await ownerClient.rpc('create_prize', {
    p_company_id: companyId,
    p_name: name,
  });
  if (error) throw new Error(`create_prize failed: ${error.message}`);
  return data as string;
}

/**
 * Registers a listener through the real create_member RPC, as the owner —
 * the createPrizeAs precedent immediately above, applied to members.test.ts:
 * pure fixture setup for cases where registering the Member is not itself the
 * operation under test. Every case that names create_member, update_member,
 * link_member_to_company, record_member_consent, add_member_note,
 * block_member, lift_member_block, archive_member or anonymize_member as the
 * RPC it is actually proving still performs THAT call through its own
 * non-owner delegate client, the same way createPrizeAs's own comment
 * describes for inventory.test.ts.
 */
export async function createMemberAs(
  customer: ProvisionedCustomer,
  companyId: string,
  fields: {
    fullName: string;
    phone?: string;
    email?: string;
    cpfHash?: string;
    cpfLastDigits?: string;
    passport?: string;
  },
): Promise<string> {
  const ownerClient = await signInAs(customer.email, customer.password);
  const { data, error } = await ownerClient.rpc('create_member', {
    p_company_id: companyId,
    p_full_name: fields.fullName,
    p_phone: fields.phone,
    p_email: fields.email,
    p_cpf_hash: fields.cpfHash,
    p_cpf_last_digits: fields.cpfLastDigits,
    p_passport: fields.passport,
  });
  if (error) throw new Error(`create_member failed: ${error.message}`);
  return data as string;
}

/**
 * Composes a role holding exactly `permissionCodes` and attaches a member to
 * it in the given Companies (the customer's one Station by default) — the
 * create_role + addMemberByInvitation pair that inventory.test.ts's non-owner
 * delegates need everywhere. `label` must be unique per call within a test
 * (it names both the role and the invited email), the same way every other
 * harness helper is used.
 */
export async function grantRoleWith(
  customer: ProvisionedCustomer,
  label: string,
  permissionCodes: string[],
  companyIds: string[] = [customer.companyId],
): Promise<{ userId: string; email: string; password: string; roleId: string }> {
  const roleId = await createRoleAs(customer, `Role-${label}`, permissionCodes);
  const member = await addMemberByInvitation(customer, label, roleId, companyIds);
  return { ...member, roleId };
}

const BALANCE_COLUMNS = [
  'available',
  'reserved',
  'linked',
  'awaiting_pickup',
  'pending_return',
  'delivered',
  'written_off',
] as const;
type BalanceColumn = (typeof BALANCE_COLUMNS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Adds `delta` directly to one bucket of one inventory_balances row, entirely
 * outside apply_inventory_movement — which is the one write no client can
 * make through the API, by design. 0029 revokes insert/update/delete from
 * every role on this table, including service_role (its own comment: "No
 * table takes an insert, update or delete grant from any role, including
 * service_role"), and Task 5's pgTAP suite pins
 * `has_table_privilege('service_role', 'public.inventory_balances',
 * 'UPDATE')` as false. Confirmed live against this stack too: a PATCH through
 * PostgREST with the service-role key returns 42501, "permission denied for
 * table inventory_balances" — there is no supabase-js client, service-role or
 * otherwise, that can write this table.
 *
 * Reconciliation (0028) exists precisely to catch this failure mode — its own
 * comment names it: "a balance row with no movements behind it (for instance
 * one written to directly, bypassing the ledger)". Proving that requires
 * actually producing that state, and the only route left is the one a human
 * operator would have to use too: a direct connection to Postgres, as its
 * superuser, outside the API entirely. `supabase db query --local` is that
 * connection.
 *
 * Invoked via the CLI's own JS entrypoint through node.exe, rather than the
 * `.bin/supabase.cmd` shim: on Windows, `.cmd` files can only be exec'd with
 * `shell: true`, and `shell: true` re-tokenizes a repository path that
 * contains a space (this one) into garbage before the CLI ever sees it.
 * company_id/prize_id are validated as UUIDs before they are interpolated,
 * since this builds a raw SQL string rather than a parameterised query.
 *
 * The CLI's own stdout is captured and checked for the `UPDATE 1` command tag
 * rather than discarded: a WHERE clause that matches nothing still exits 0
 * with `UPDATE 0`, and a caller who passed the wrong company_id/prize_id
 * would otherwise see reconcile_inventory report nothing changed and read
 * that as "reconciliation missed the divergence" — exactly the wrong
 * diagnosis under this suite's own rule that a failure here names a real
 * defect in the migrations. Failing loudly here, in the harness, keeps that
 * misdiagnosis from ever reaching a test assertion.
 */
export function corruptBalanceDirectly(
  companyId: string,
  prizeId: string,
  column: BalanceColumn,
  delta: number,
): void {
  if (!UUID_RE.test(companyId) || !UUID_RE.test(prizeId)) {
    throw new Error('corruptBalanceDirectly: company_id and prize_id must be UUIDs');
  }
  if (!BALANCE_COLUMNS.includes(column)) {
    throw new Error(`corruptBalanceDirectly: unknown balance column ${column}`);
  }
  if (!Number.isInteger(delta)) {
    throw new Error('corruptBalanceDirectly: delta must be an integer');
  }

  const script = path.join(REPO_ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');
  const sql =
    `update inventory_balances set ${column} = ${column} + (${delta}) ` +
    `where company_id = '${companyId}' and prize_id = '${prizeId}';`;

  const output = execFileSync(process.execPath, [script, 'db', 'query', '--local', sql], {
    encoding: 'utf8',
  });

  if (!/\bUPDATE 1\b/.test(output)) {
    throw new Error(
      `corruptBalanceDirectly: expected to update exactly one inventory_balances row ` +
        `(company_id=${companyId}, prize_id=${prizeId}, column=${column}); the CLI reported: ${output.trim()}`,
    );
  }
}
