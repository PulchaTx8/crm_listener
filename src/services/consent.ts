import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, NotFoundError } from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';

/**
 * SHA-256, hex, lower case -- the exact shape unsubscribe_tokens.token_hash
 * constrains (`^[0-9a-f]{64}$`). The constraint is not decoration: it is what
 * makes a mistake here fail on the first insert rather than on the first click.
 */
export function unsubscribeTokenHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * The raw token goes in the URL; the hash goes in the table. They are returned
 * together exactly once, at mint time, because the raw value is never
 * recoverable afterwards -- which is the whole point of storing the hash.
 */
export function newUnsubscribeToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: unsubscribeTokenHash(raw) };
}

/**
 * `consume_unsubscribe_token` (0232) raises `P0002` for an unknown, an
 * already-spent and an expired token alike -- deliberately, so a caller
 * probing tokens learns nothing about which of the three it hit. Mapped here
 * to a single `NotFoundError` rather than split back apart by message
 * sniffing, which would undo that on the TypeScript side of the same door.
 */
function mapConsentError(code: string | undefined, message: string): Error {
  if (code === 'P0002') return new NotFoundError(message);
  return new InternalError(message);
}

/**
 * Spends an unsubscribe token. `allStations = false` withdraws
 * `email_marketing` at the one Station the token was minted for;
 * `true` withdraws both marketing channels at every Station this listener is
 * linked to. Which Stations and channels that means is entirely
 * `consume_unsubscribe_token`'s own decision (0232) -- this function repeats
 * none of it.
 *
 * THE ANON CLIENT, not a service-role client and not one bound to a user's
 * JWT: the visitor clicking "descadastrar" in an e-mail has no session and
 * never will, the same reasoning `installationContext`
 * (services/widget-installations.ts) gives for its own anon door. 0232 grants
 * `consume_unsubscribe_token` to `anon` and `authenticated` alike for exactly
 * that reason -- a service-role client here would be privilege this call has
 * no use for.
 *
 * `consentsWritten`, not `stationsLeft`: the door's own return column is
 * `consents_written`, renamed from `stations_left` in 0232's own second fix
 * round because it counts rows written (Stations x channels), not Stations.
 * Keeping the old name here would put the false claim that rename fixed in
 * SQL back into TypeScript.
 */
export async function consumeUnsubscribeToken(
  rawToken: string,
  allStations: boolean,
): Promise<{ memberId: string; companyId: string; consentsWritten: number }> {
  const { url, anonKey } = getUserSupabaseConfig();
  const supabase = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc('consume_unsubscribe_token', {
    p_token_hash: unsubscribeTokenHash(rawToken),
    p_all_stations: allStations,
  });
  if (error) throw mapConsentError(error.code, error.message);

  // `returns table (...)`, so supabase-js types this as a row array -- one row
  // on success, because the door itself raises P0002 (mapped above) rather
  // than returning zero rows for a token it could not spend.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new InternalError('consume_unsubscribe_token returned no row');

  return {
    memberId: row.member_id,
    companyId: row.company_id,
    consentsWritten: row.consents_written,
  };
}
