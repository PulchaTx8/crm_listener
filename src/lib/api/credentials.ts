import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Pulls the token out of `Authorization: Bearer <token>`.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is, and an
 * integrator sending `bearer` is not wrong. Another scheme is refused outright
 * rather than having its value tried as a token: a caller sending Basic
 * credentials has misread the documentation, and answering 401 is clearer than
 * hashing a base64 blob and answering 401 anyway.
 */
export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * SHA-256, lowercase hex.
 *
 * THE RAW TOKEN NEVER REACHES THE DATABASE, not even as an RPC argument. This is
 * the rule the WhatsApp webhook already follows for the wamid, and its comment
 * gives the reason: an argument passed to an RPC lands in query logs and in
 * backups. `api_credentials_hash_shape` (0148) refuses anything that is not this
 * shape, which is a backstop rather than a reason to relax here.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AuthOutcome =
  | { ok: true; credentialId: string; companyId: string; organizationId: string }
  | { ok: false; code: 'unauthorized' | 'forbidden_scope' };

/**
 * The whole of this API's authentication.
 *
 * NO CONSTANT-TIME COMPARISON HERE, and that is correct rather than an
 * oversight. There is no secret-to-secret comparison on this path: what arrives
 * is hashed before anything happens, and what is stored is a hash, so the lookup
 * is an indexed equality over the SHA-256 of a 256-bit secret. An attacker would
 * need a preimage, and the timing of a b-tree probe says nothing about the
 * secret. The `timingSafeEqual` in /api/worker/tick exists because THAT secret
 * lives in the environment and is compared directly, byte for byte.
 *
 * Please do not "fix" this into a scan and a comparison.
 *
 * The two failure codes are distinguished on purpose, and 0149's own comment
 * argues it: zero rows means unknown, revoked, expired, or a Station that is
 * deleted or suspended -- four causes, one answer, so probing learns nothing. A
 * row with `scope_ok = false` means the caller already proved it holds a valid
 * key, so naming the missing scope gives away nothing it did not know and is the
 * only way an integrator can tell "wrong key" from "key lacks this".
 */
export async function authenticate(
  client: SupabaseClient<Database>,
  header: string | null,
  scope: string,
): Promise<AuthOutcome> {
  const token = parseBearer(header);
  if (!token) return { ok: false, code: 'unauthorized' };

  const { data, error } = await client.rpc('authenticate_api_credential', {
    p_token_hash: hashToken(token),
    p_scope: scope,
  });

  // A failed CALL is not folded into "not authorised". Collapsing a transient
  // database failure into a 401 would tell a correct integrator that their key
  // is wrong, and they would go and rotate it -- the same choice
  // searchDeezerAction makes for its own permission check, for the same reason.
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { ok: false, code: 'unauthorized' };
  if (!row.scope_ok) return { ok: false, code: 'forbidden_scope' };

  return {
    ok: true,
    credentialId: row.credential_id,
    companyId: row.company_id,
    organizationId: row.organization_id,
  };
}
