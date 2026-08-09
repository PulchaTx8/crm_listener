import 'server-only';
import { randomInt } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, UnauthorizedError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Database } from '@/lib/supabase/database.types';

/**
 * The provisional password, and the one operation that reissues it.
 *
 * PROVISIONING ITSELF LEFT THIS FILE IN BLOCK 16. provisionCustomer created an
 * Organization and a Station in one breath, and its RPC was dropped in 0157;
 * services/organizations.ts holds the replacement, which creates the group and
 * no Station. What stayed here is what is about a PERSON rather than about a
 * customer: the password generator both paths use, and the reissue an owner
 * needs when their seven days run out.
 */

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
 * A client bound to the caller's JWT. reset_provisional_password is SECURITY
 * DEFINER and re-checks is_platform_admin() against auth.uid(), so calling it
 * with the service key would defeat the check it exists to make.
 */
function createUserScopedClient(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
