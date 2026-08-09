import { createHash, randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import type { Database } from '../../src/lib/supabase/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const admin = createClient<Database>(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * An anon-key client holding no session at all — the shape of a caller who
 * found a URL and has never signed in. Distinct from `signInAs`, which always
 * returns a client for a real, authenticated user; some doors (the WhatsApp
 * ingestion RPC, Block 5a) must be checked against BOTH `authenticated` and
 * `anon`, because a grant given to one and withheld from the other would leave
 * exactly one of the two checks meaningful.
 */
export const anonClient = createClient<Database>(url, anonKey, {
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
 * Creates a real auth user, marks it a platform admin, then provisions a
 * customer as that admin. Mirrors what the application does, so the tests
 * exercise the production path.
 *
 * TWO CALLS SINCE BLOCK 16, WHERE THERE USED TO BE ONE. provision_customer
 * created an Organization and a Company together and was dropped in 0157,
 * precisely because a customer's Station count is not known when the customer is
 * taken on. The console now provisions the group and adds each radio afterwards,
 * and this does the same — so what the two hundred call sites below get back is
 * unchanged, and the sequence they exercise is the one the console performs.
 *
 * The name stays `provisionCustomer` deliberately: a customer with one Station
 * is what these tests need, and renaming it would touch every file in this
 * directory to say nothing new.
 */
export async function provisionCustomer(label: string): Promise<ProvisionedCustomer> {
  const adminUser = await createUser(`admin-${label}@example.test`);
  const { error: adminError } = await admin
    .from('platform_admins')
    .insert({ user_id: adminUser.userId });
  if (adminError) throw new Error(`could not seed platform admin: ${adminError.message}`);

  const owner = await createUser(`owner-${label}@example.test`);

  const adminClient = await signInAs(adminUser.email, adminUser.password);
  const { data: organizationId, error } = await adminClient.rpc('provision_organization', {
    p_user_id: owner.userId,
    p_organization_name: `Org ${label}`,
  });
  if (error) throw new Error(`provision_organization failed: ${error.message}`);
  if (typeof organizationId !== 'string') {
    throw new Error('provision_organization returned no organization id');
  }

  const { data: companyId, error: companyError } = await adminClient.rpc('add_company', {
    p_organization_id: organizationId,
    p_name: `Company ${label}`,
    p_timezone: 'America/Sao_Paulo',
  });
  if (companyError) throw new Error(`add_company failed: ${companyError.message}`);
  if (typeof companyId !== 'string') throw new Error('add_company returned no company id');

  return { ...owner, organizationId, companyId, adminClient };
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
 * One statement on a superuser connection to Postgres, outside the API
 * entirely. The two helpers below are its only callers and they are the only
 * writes in this suite that no client can make; see corruptBalanceDirectly for
 * why that state has to be reachable at all.
 *
 * This replaces `execFileSync(node, [supabase.js, 'db', 'query', …])`, which is
 * what both helpers used until the Block 4b branch review. That call spawned the
 * Supabase CLI's JS entrypoint, which spawns the CLI binary, from inside a
 * vitest worker — three processes deep, ~6 s of the worker's event loop blocked
 * solid per call, and a raw SQL string built by interpolation because the CLI
 * takes no parameters. A `pg` client is one socket to a port the test config
 * already pins, it takes real parameters, and it does not block the loop the
 * worker answers its parent on.
 *
 * It was ALSO the suspected trigger for the `Worker exited unexpectedly` crash,
 * being the one thing the two files that had ever hit it had in common. **That
 * was wrong** and the record is kept here so nobody re-derives it: the crash
 * survived this rewrite and later dropped `invitations.test.ts`, which has never
 * called either helper. Keep this change for the reasons in the paragraph above;
 * do not credit it with the flake. docs/block-4b-report.md §1.3 has the runs.
 *
 * Refuses outright when the suite has been pointed somewhere other than the
 * local stack: vitest.isolation.config.ts allows a remote target behind
 * ALLOW_REMOTE_ISOLATION_TESTS, and these two helpers cannot follow it there —
 * they would corrupt the developer's own database while every assertion around
 * them read the remote one, which is worse than either failing or working.
 */
function assertLocalSuperuserTarget(label: string): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(url)) {
    throw new Error(
      `${label}: this helper writes Postgres directly on ${LOCAL_SUPABASE_DB_URL} and the suite ` +
        `is pointed at ${url}. It cannot follow a remote target, and writing the local ` +
        'database while the assertions read a remote one would be silently wrong.',
    );
  }
}

async function superuserStatement(
  label: string,
  sql: string,
  params: readonly unknown[],
): Promise<number> {
  assertLocalSuperuserTarget(label);

  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params as unknown[]);
    return result.rowCount ?? 0;
  } finally {
    await client.end();
  }
}

/**
 * The read-and-return sibling of superuserStatement, for a caller that needs
 * a generated value back (an id an INSERT ... RETURNING produced) rather than
 * only a row count. Same connection, same guard, same reasoning.
 */
async function superuserQuery<T extends Record<string, unknown>>(
  label: string,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  assertLocalSuperuserTarget(label);

  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params as unknown[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * Inserts a live WhatsApp integration row directly against Postgres, as its
 * superuser — the same escape hatch corruptBalanceDirectly uses just above,
 * and for the identical reason 0057_integrations.sql states on the table
 * itself: "service_role reads it" is the sentence that comment exists to
 * refuse. `integrations` carries NO PostgREST grant for ANY role, service_role
 * included — confirmed live against this stack:
 * has_table_privilege('service_role', 'public.integrations', 'INSERT') is
 * false, alongside SELECT, UPDATE and DELETE. Every reader of this table in
 * production is INSIDE a SECURITY DEFINER body (ingest_whatsapp_event,
 * claim_outbox_batch), and nothing under Block 10 — the future configuration
 * screen — exists yet to create one through the API. A test that needs a live
 * integration for a Station therefore has no route left but the one a human
 * operator would have to use too: a direct connection to Postgres, outside
 * the API entirely.
 *
 * Returns the generated id, which every caller needs to build a fixture on
 * top of: a promotion's hashtag alone does not say which number receives it,
 * the integration row is what maps one to the other.
 */
export async function seedIntegration(
  customer: ProvisionedCustomer,
  phoneNumberId: string,
  // Defaults to the customer's own Station; a caller exercising a
  // cross-Station scenario (a second Station added via addCompany) passes
  // that Station's id explicitly.
  companyId: string = customer.companyId,
): Promise<string> {
  const rows = await superuserQuery<{ id: string }>(
    'seedIntegration',
    `insert into public.integrations
       (organization_id, company_id, provider, phone_number_id, enabled)
     values ($1, $2, 'WHATSAPP', $3, true)
     returning id`,
    [customer.organizationId, companyId, phoneNumberId],
  );
  if (rows.length !== 1) {
    throw new Error(`seedIntegration: expected to insert exactly one row, got ${rows.length}`);
  }
  return rows[0]!.id;
}

/**
 * Block 15. Puts an API credential and its scopes in place, for the same reason
 * seedIntegration exists and by the same route.
 *
 * THROUGH THE SUPERUSER CONNECTION, because there is no other. api_credentials
 * has RLS enabled and no policy (0148), and this schema revokes the default ACL,
 * so `admin.from('api_credentials')` -- service role and all -- answers 42501 by
 * design. The only door is issue_api_credential, and that is gated on
 * is_platform_admin(), which reads auth.uid(); this harness holds no platform
 * admin session, and giving it one to seed a fixture would be a wider change
 * than the fixture is worth.
 *
 * The hash is passed in rather than generated here so a test can hold the
 * matching secret when it wants one; the tests below only ever need the
 * credential id.
 */
export async function seedApiCredential(
  customer: ProvisionedCustomer,
  tokenHash: string,
  scopes: string[],
  companyId: string = customer.companyId,
): Promise<string> {
  const rows = await superuserQuery<{ id: string }>(
    'seedApiCredential',
    `insert into public.api_credentials
       (organization_id, company_id, name, token_prefix, token_hash)
     values ($1, $2, 'isolation fixture', 'ptx_aaaabbbb', $3)
     returning id`,
    [customer.organizationId, companyId, tokenHash],
  );
  if (rows.length !== 1) {
    throw new Error(`seedApiCredential: expected to insert exactly one row, got ${rows.length}`);
  }
  const credentialId = rows[0]!.id;

  for (const scope of scopes) {
    await superuserQuery(
      'seedApiCredential:scope',
      `insert into public.api_credential_scopes (credential_id, permission_code)
       values ($1, $2)`,
      [credentialId, scope],
    );
  }

  return credentialId;
}

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
 * superuser, outside the API entirely. superuserStatement above is that
 * connection.
 *
 * The column name is checked against BALANCE_COLUMNS and the delta against
 * Number.isInteger before either reaches the statement, because an identifier
 * and an arithmetic operand cannot be bound as parameters; the two UUIDs are
 * bound. The UUID check is kept even so — it names the mistake in the harness
 * rather than letting Postgres report `22P02` from inside a test.
 *
 * The affected row count is checked rather than discarded: a WHERE clause that
 * matches nothing succeeds, and a caller who passed the wrong
 * company_id/prize_id would otherwise see reconcile_inventory report nothing
 * changed and read that as "reconciliation missed the divergence" — exactly the
 * wrong diagnosis under this suite's own rule that a failure here names a real
 * defect in the migrations. Failing loudly here, in the harness, keeps that
 * misdiagnosis from ever reaching a test assertion.
 */
export async function corruptBalanceDirectly(
  companyId: string,
  prizeId: string,
  column: BalanceColumn,
  delta: number,
): Promise<void> {
  if (!UUID_RE.test(companyId) || !UUID_RE.test(prizeId)) {
    throw new Error('corruptBalanceDirectly: company_id and prize_id must be UUIDs');
  }
  if (!BALANCE_COLUMNS.includes(column)) {
    throw new Error(`corruptBalanceDirectly: unknown balance column ${column}`);
  }
  if (!Number.isInteger(delta)) {
    throw new Error('corruptBalanceDirectly: delta must be an integer');
  }

  const updated = await superuserStatement(
    'corruptBalanceDirectly',
    `update public.inventory_balances set ${column} = ${column} + (${delta}) ` +
      `where company_id = $1 and prize_id = $2`,
    [companyId, prizeId],
  );

  if (updated !== 1) {
    throw new Error(
      `corruptBalanceDirectly: expected to update exactly one inventory_balances row ` +
        `(company_id=${companyId}, prize_id=${prizeId}, column=${column}); ${updated} were updated`,
    );
  }
}

/**
 * Sets `drawn` on one promotion_prize_balances row directly, outside
 * apply_inventory_movement — the same escape hatch corruptBalanceDirectly uses
 * and for a narrower reason: nothing writes `drawn` until Block 6 brings the
 * draw, so D4's floor ("do not unlink below what has been drawn") has no
 * reachable fixture through any RPC. 0046 revokes every write grant on this
 * table from every role, service_role included, so a direct connection to
 * Postgres as its superuser is the only route left, exactly as it is there.
 *
 * A row set this way is a real divergence and reconcile_inventory (0048) will
 * report it as stored=N against computed=0 — which is the truth, because the
 * ledger has no record of it. Do not use this helper inside a test that also
 * asserts reconciliation is clean.
 *
 * Runs on the same superuser connection, and checks the affected row count
 * rather than discarding it, both for the reasons corruptBalanceDirectly's
 * comment sets out at length.
 */
export async function setPromotionPrizeDrawnDirectly(
  promotionPrizeId: string,
  drawn: number,
): Promise<void> {
  if (!UUID_RE.test(promotionPrizeId)) {
    throw new Error('setPromotionPrizeDrawnDirectly: promotion_prize_id must be a UUID');
  }
  if (!Number.isInteger(drawn) || drawn < 0) {
    throw new Error('setPromotionPrizeDrawnDirectly: drawn must be a non-negative integer');
  }

  const updated = await superuserStatement(
    'setPromotionPrizeDrawnDirectly',
    'update public.promotion_prize_balances set drawn = $1 where promotion_prize_id = $2',
    [drawn, promotionPrizeId],
  );

  if (updated !== 1) {
    throw new Error(
      `setPromotionPrizeDrawnDirectly: expected to update exactly one row ` +
        `(promotion_prize_id=${promotionPrizeId}); ${updated} were updated`,
    );
  }
}
