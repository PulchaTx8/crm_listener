import 'server-only';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { hashToken } from '@/lib/api/credentials';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';

/**
 * A client bound to the caller's JWT. The three console RPCs re-check
 * is_platform_admin() against auth.uid(), so calling one of them with the
 * service key would defeat the very check they exist to make -- the reasoning
 * services/roles.ts gives for its own asCaller.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Mints a secret and derives the only two things the database is allowed to
 * keep.
 *
 * 32 bytes of base64url: 256 bits, and no character that needs escaping in an
 * Authorization header, a shell, or a YAML file somebody will paste it into.
 *
 * THE SECRET IS RETURNED ONCE AND NEVER STORED. The caller shows it to the
 * operator and forgets it; everything the row keeps is derived here, so there is
 * no code path along which the plaintext could be written by accident.
 */
export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `ptx_${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, 12), hash: hashToken(secret) };
}

export interface ApiCredentialRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function mapCredentialError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '22023') return new ValidationError(message);
  // A scope that names no permission reaches here as a foreign key violation.
  if (code === '23503') return new ValidationError('That scope does not name a known permission.');
  return new InternalError(message);
}

/**
 * Records a key and hands back the secret, once.
 *
 * The secret is generated HERE and only its prefix and hash travel to the RPC --
 * the rule the WhatsApp webhook follows for the wamid, whose comment gives the
 * reason: an argument passed to an RPC lands in query logs and in backups.
 */
export async function issueApiCredential(
  input: { companyId: string; name: string; scopes: string[]; expiresAt: string | null },
  accessToken: string,
): Promise<{ id: string; secret: string }> {
  const key = generateApiKey();

  const { data, error } = await asCaller(accessToken).rpc('issue_api_credential', {
    p_company_id: input.companyId,
    p_name: input.name,
    p_token_prefix: key.prefix,
    p_token_hash: key.hash,
    p_scopes: input.scopes,
    p_expires_at: input.expiresAt ?? undefined,
  });

  if (error) throw mapCredentialError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('issue_api_credential returned no id');

  return { id: data, secret: key.secret };
}

export async function listApiCredentials(
  companyId: string,
  accessToken: string,
): Promise<ApiCredentialRow[]> {
  const { data, error } = await asCaller(accessToken).rpc('list_api_credentials', {
    p_company_id: companyId,
  });

  if (error) throw mapCredentialError(error.code, error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: row.scopes ?? [],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeApiCredential(
  credentialId: string,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('revoke_api_credential', {
    p_credential_id: credentialId,
  });
  if (error) throw mapCredentialError(error.code, error.message);
}
