import 'server-only';
import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/supabase/database.types';
import type { ProvisionCustomerInput } from '@/schemas/provisioning';

// Ambiguous glyphs removed: this password is read over the phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const LENGTH = 20;

export function generateProvisionalPassword(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

export interface ProvisionResult {
  userId: string;
  organizationId: string;
  companyId: string;
  provisionalPassword: string;
}

/**
 * Creating the auth user and creating the tenant are two systems with no
 * shared transaction. If the RPC fails after the user exists we would leave
 * someone who can authenticate and belongs to no tenant — worse than failing
 * outright, because it only surfaces when they try to sign in. Hence the
 * compensating delete.
 *
 * `accessToken` is the calling platform admin's JWT: the RPC re-checks
 * is_platform_admin() in its own body, so it must run as that user, not as
 * service_role.
 */
export async function provisionCustomer(
  input: ProvisionCustomerInput,
  accessToken: string,
): Promise<ProvisionResult> {
  const admin = createServiceClient();
  const provisionalPassword = generateProvisionalPassword();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: input.ownerEmail,
    password: provisionalPassword,
    email_confirm: true,
    user_metadata: input.ownerName ? { full_name: input.ownerName } : undefined,
  });

  if (createError || !created.user) {
    throw new ValidationError(`Could not create the user: ${createError?.message ?? 'unknown'}`);
  }

  const userId = created.user.id;

  try {
    const { error: profileError } = await admin
      .from('profiles')
      .insert({ id: userId, email: input.ownerEmail, full_name: input.ownerName ?? null });
    if (profileError) throw new Error(profileError.message);

    const asAdmin = createUserScopedClient(accessToken);
    const { data, error } = await asAdmin.rpc('provision_customer', {
      p_user_id: userId,
      p_organization_name: input.organizationName,
      p_company_name: input.companyName,
      p_timezone: input.timezone,
    });
    if (error) {
      await recordDeniedProvisioning(admin, accessToken, input, error.message);
      throw new Error(error.message);
    }

    const result = data as { organization_id: string; company_id: string };
    return {
      userId,
      organizationId: result.organization_id,
      companyId: result.company_id,
      provisionalPassword,
    };
  } catch (cause) {
    // Compensating action: remove the orphan before surfacing the failure.
    await admin.auth.admin.deleteUser(userId).catch(() => {
      logger.error({ userId }, 'orphaned auth user could not be deleted after failed provisioning');
    });
    throw new InternalError('Provisioning failed and was rolled back', { cause });
  }
}

/**
 * Issues a fresh provisional password for an existing owner and restarts the
 * seven-day clock. Without this, expiry would simply strand the customer.
 *
 * The permission-checked RPC runs FIRST, so a caller who is not a platform
 * admin never reaches the Admin API and no password is changed. If the second
 * step then fails, the gate has merely been reset — the operation is safe to
 * retry.
 */
export async function regenerateProvisionalPassword(
  userId: string,
  accessToken: string,
): Promise<string> {
  const asAdmin = createUserScopedClient(accessToken);
  const { error: rpcError } = await asAdmin.rpc('reset_provisional_password', {
    p_user_id: userId,
  });
  if (rpcError) {
    throw new UnauthorizedError(`Could not reset the provisional password: ${rpcError.message}`);
  }

  const password = generateProvisionalPassword();
  const admin = createServiceClient();
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    throw new InternalError(`Could not set the new provisional password: ${error.message}`);
  }

  logger.info({ userId }, 'provisional password regenerated');
  return password;
}

/**
 * The RPC cannot audit its own refusals: it raises, and the raise rolls back
 * anything it just inserted. It writes the refusal to the server log instead,
 * and this records the row from out here, where the failed transaction cannot
 * take it with it. Only covers calls that came through the app — a refusal on
 * a direct PostgREST call lives in the Postgres log alone.
 */
async function recordDeniedProvisioning(
  admin: ReturnType<typeof createServiceClient>,
  accessToken: string,
  input: ProvisionCustomerInput,
  reason: string,
): Promise<void> {
  try {
    const { data } = await admin.auth.getUser(accessToken);
    await admin.from('audit_logs').insert({
      actor_id: data.user?.id ?? null,
      action: 'provision_customer.denied',
      succeeded: false,
      detail: { reason, organization_name: input.organizationName },
    });
  } catch (cause) {
    // Never let the audit write mask the original failure.
    logger.error({ err: cause }, 'could not record a denied provisioning attempt');
  }
}

/**
 * A client bound to the caller's JWT. provision_customer is SECURITY DEFINER
 * and re-checks is_platform_admin() against auth.uid(), so calling it with the
 * service key would defeat the check it exists to make.
 */
function createUserScopedClient(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
