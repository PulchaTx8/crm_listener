import { createHash, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/supabase/database.types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
  for (const id of createdUserIds.splice(0)) {
    await admin.auth.admin.deleteUser(id);
  }
}

/**
 * Adds a second person to an existing Organization at the given role, through
 * the real invitation flow.
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
  role: 'owner' | 'operator' | 'viewer',
): Promise<{ userId: string; email: string; password: string }> {
  const email = `${role}-${label}@example.test`;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const ownerClient = await signInAs(customer.email, customer.password);
  const { error: inviteError } = await ownerClient.rpc('create_invitation', {
    p_organization_id: customer.organizationId,
    p_email: email,
    p_role: role,
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
