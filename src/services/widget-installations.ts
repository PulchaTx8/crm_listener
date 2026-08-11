import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { generatePublicKey } from '@/lib/widget/code';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import type { Database } from '@/lib/supabase/database.types';

/**
 * Block 17a, spec §11. The one question the widget's page asks before it
 * renders anything: does this public key name an installation that is live?
 *
 * A DOOR, NOT A TABLE READ, and that is not a preference — it is the only thing
 * that works. `widget_installations` has RLS on and its ACL revoked (0159),
 * and its own table comment states the consequence in writing: "this schema
 * revokes the default ACL, so createServiceClient().from('widget_installations')
 * fails with 42501 and every reader is inside a SECURITY DEFINER body". That
 * was measured while writing this file, not assumed:
 *
 *     companies              readable
 *     integrations           42501 permission denied for table integrations
 *     widget_installations   42501 permission denied for table widget_installations
 *
 * THE ANON KEY, not the service key, and deliberately. `widget_frame_context`
 * is granted to `anon` precisely because its other caller — the Edge middleware
 * — has nothing else (0161's comment says so), and this page is served to an
 * anonymous visitor on somebody else's website. Handing that request a
 * service-role client to ask a question the anon role can already answer would
 * be privilege it has no use for. The two server actions beside the page do
 * hold one, because the doors they call are granted to `service_role` only and
 * there is no alternative there.
 *
 * WHY NOT REUSE `frameOrigins` (src/lib/widget/frame-cache.ts), which calls the
 * same function: that module is compiled for the EDGE runtime and caches its
 * answers for sixty seconds. A cache is right for a header on every widget
 * load; it is wrong for the decision to render or to 404, where a minute of
 * staleness means an installation an operator just enabled still answers "no
 * such widget".
 */

/**
 * True only for a key that names an enabled, unarchived installation.
 *
 * `false` covers an unknown key, a disabled installation and an archived one
 * alike — 0161 answers identically for all three on purpose, so probing keys
 * learns nothing the iframe `src` did not already say.
 *
 * A DATABASE THAT CANNOT ANSWER THROWS rather than returning false. An outage
 * is not an installation that does not exist, and collapsing the two would
 * answer 404 to a Station whose configuration is perfectly correct — telling
 * an operator their key is wrong on the one day nothing is wrong with it.
 */
export async function installationExists(publicKey: string): Promise<boolean> {
  // An empty segment cannot be an installation, and asking would spend a round
  // trip to be told so — `frameOrigins` short-circuits the same case for the
  // same reason.
  if (!publicKey) return false;

  const { url, anonKey } = getUserSupabaseConfig();
  const supabase = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.rpc('widget_frame_context', {
    p_public_key: publicKey,
  });
  if (error) throw error;

  // The door answers `{"found": bool, "origins": [...]}`, which arrives typed
  // as `Json`. Anything else — a shape a future migration changed, an envelope
  // this code does not know — is NOT a found installation: the shape is checked
  // rather than asserted, the same rule frame-cache.ts states for the same
  // payload, and the unknown case falls to the refusal.
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  return (data as { found?: unknown }).found === true;
}

// ---------------------------------------------------------------------------
// Block 17a, Task 11. The console's read and write path, entirely separate
// from the anon door above: `installationExists` answers an anonymous visitor
// with the one bit an <iframe> may learn, and everything below answers a
// signed-in platform admin with the row itself.
// ---------------------------------------------------------------------------

/**
 * A client bound to the caller's JWT. `upsert_widget_installation` and
 * `widget_installation_for` (0162) re-check is_platform_admin() against
 * auth.uid(), so calling either with the service key would defeat the very
 * check they exist to make -- the reasoning services/api-credentials.ts gives
 * for its own asCaller, copied here rather than shared: a third copy of a
 * four-line function is cheaper than a shared module two services would have
 * to agree to depend on for one indirection.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface WidgetInstallationRow {
  id: string;
  organizationId: string;
  companyId: string;
  publicKey: string;
  enabled: boolean;
  allowedOrigins: string[];
  /**
   * Whether this Station has an approved WEB_VERIFICATION template. Computed
   * by 0162's `widget_installation_for` in the SAME query as the row, so the
   * console's warning line (spec §5) cannot read this a moment apart from
   * `enabled` and disagree with it.
   */
  hasTemplate: boolean;
  /**
   * Block 17b. How long a listener waits between music requests at this
   * Station, as the three integers the form has rather than as an interval.
   *
   * ALL THREE ZERO IS NO CEILING, which is the column's own default and its
   * meaning (0167). They arrive already decomposed from
   * `widget_installation_for`, because `extract` is the authority on what a
   * component of an interval is and the alternative was parsing Postgres's
   * `01:30:00` output format in TypeScript.
   */
  cooldownDays: number;
  cooldownHours: number;
  cooldownMinutes: number;
  createdAt: string;
  updatedAt: string;
}

function mapWidgetError(code: string | undefined, message: string): Error {
  if (code === '42501') return new UnauthorizedError(message);
  if (code === 'P0002') return new NotFoundError(message);
  // 0159's CHECK constraints on the origin grammar and the key shape. The tab
  // runs parseOrigins itself before this is ever reached, and Node mints the
  // key, so this is a backstop for a bug rather than a path an operator can
  // reach honestly -- 0162's own comment says the RPC does not re-validate
  // what the CHECK already refuses, so a 23514 still has to leave here as a
  // message a human can read rather than "internal error".
  if (code === '23514') {
    return new ValidationError('That could not be saved: the origins or the key were malformed.');
  }
  return new InternalError(message);
}

/**
 * `widget_installation_for` returns jsonb, which supabase-js types as `Json`
 * -- an untyped RPC return, unlike `list_api_credentials`'s typed table rows
 * -- so the shape is checked here rather than trusted, the same discipline
 * `find_member_by_identifier`'s parser (services/members.ts) applies to its
 * own jsonb door.
 *
 * `null` IS A VALID ANSWER, not a parse failure: 0162's own comment states
 * that bare SQL NULL is what the function returns for a Station with no
 * installation yet, deliberately unlike widget_frame_context's found/not-found
 * envelope. Anything else that is not the expected object shape throws,
 * because collapsing "no installation" and "the shape changed under us" into
 * the same `null` would hide a real defect behind the ordinary case the tab
 * already expects to see constantly.
 */
function parseWidgetInstallation(data: unknown): WidgetInstallationRow | null {
  if (data === null) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new InternalError('widget_installation_for returned an unexpected shape');
  }

  const row = data as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.organization_id !== 'string' ||
    typeof row.company_id !== 'string' ||
    typeof row.public_key !== 'string' ||
    typeof row.enabled !== 'boolean' ||
    !Array.isArray(row.allowed_origins) ||
    typeof row.has_template !== 'boolean' ||
    // Block 17b. Checked rather than defaulted to zero: zero MEANS something
    // here -- no ceiling -- so a missing field silently becoming zero would
    // turn a shape that changed under us into a Station with its limit
    // switched off, which is the one direction this must not fail in.
    typeof row.cooldown_days !== 'number' ||
    typeof row.cooldown_hours !== 'number' ||
    typeof row.cooldown_minutes !== 'number' ||
    typeof row.created_at !== 'string' ||
    typeof row.updated_at !== 'string'
  ) {
    throw new InternalError('widget_installation_for returned an unexpected shape');
  }

  return {
    id: row.id,
    organizationId: row.organization_id,
    companyId: row.company_id,
    publicKey: row.public_key,
    enabled: row.enabled,
    allowedOrigins: row.allowed_origins as string[],
    hasTemplate: row.has_template,
    cooldownDays: row.cooldown_days,
    cooldownHours: row.cooldown_hours,
    cooldownMinutes: row.cooldown_minutes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One Station's widget installation, or `null` if nobody has configured one.
 *
 * Read by `page.tsx` for every listed Station before any record opens (spec
 * §9's rule for this whole dialog), and again by the save action to read back
 * what it just wrote -- `station-record-dialog.tsx`'s header comment is
 * explicit that a fetch when the record OPENS is the Block 15 defect; a fetch
 * after a write that already happened is a different thing, the same
 * read-back `actions.ts`'s `readIntegration` already does.
 */
export async function getWidgetInstallation(
  companyId: string,
  accessToken: string,
): Promise<WidgetInstallationRow | null> {
  const { data, error } = await asCaller(accessToken).rpc('widget_installation_for', {
    p_company_id: companyId,
  });
  if (error) throw mapWidgetError(error.code, error.message);
  return parseWidgetInstallation(data);
}

/**
 * Creates or edits a Station's installation. Every field is written on every
 * call, never merged -- 0162's own convention, the one `update_prize`,
 * `update_role`, `update_song` and `update_company_profile` all follow.
 * `public_key` is the one exception, and as of 0163 the database enforces
 * that itself: `upsert_widget_installation`'s DO UPDATE now sets it to
 * `coalesce(widget_installations.public_key, excluded.public_key)`, so a key
 * is pinned on first insert and cannot be replaced by any later call,
 * whatever this function sends.
 *
 * THE READ BEFORE THE DECISION IS NOW BELT-AND-BRACES, NOT THE GUARANTEE --
 * it used to be the only thing standing between a live key and silent
 * rotation (one `??`, no schema backing it), until 0163 moved that invariant
 * into the door itself. It stays for two reasons neither of which is "in case
 * the database is wrong":
 *
 *   1. It saves generating and discarding a key on every ordinary edit. Every
 *      ENABLE toggle or origin-list save on a Station that already has an
 *      installation would otherwise mint a fresh `pw_...` that the door's
 *      coalesce immediately throws away -- correct, but pointless CPU and
 *      entropy for a value nobody will ever see.
 *   2. It keeps `upsert_widget_installation`'s audit row honest. That
 *      function logs `p_public_key` -- THE ARGUMENT SENT, not the value that
 *      was actually stored, deliberately, so a genuine attempt to change a
 *      Station's key is visible in the trail rather than silently absorbed.
 *      If this function always sent a freshly minted key instead of reusing
 *      the one already on the row, every ordinary save would log an
 *      "attempted" key change that never happened, and the one signal the
 *      audit design depends on -- a mismatch meaning somebody actually tried
 *      to rotate this Station's key -- would drown in routine noise.
 */
export async function upsertWidgetInstallation(
  input: {
    companyId: string;
    enabled: boolean;
    allowedOrigins: string[];
    cooldown: { days: number; hours: number; minutes: number };
  },
  accessToken: string,
): Promise<{ id: string; publicKey: string }> {
  const existing = await getWidgetInstallation(input.companyId, accessToken);
  const publicKey = existing?.publicKey ?? generatePublicKey();

  const { data, error } = await asCaller(accessToken).rpc('upsert_widget_installation', {
    p_company_id: input.companyId,
    p_public_key: publicKey,
    p_enabled: input.enabled,
    p_allowed_origins: input.allowedOrigins,
    // Postgres's own interval literal, built here rather than in SQL so the
    // three numbers travel as one value the door writes without arithmetic.
    // '0 days 0 hours 0 mins' is a valid interval of zero, which is this
    // column's meaning for "no ceiling" -- there is no special case to write.
    p_music_request_cooldown:
      `${input.cooldown.days} days ${input.cooldown.hours} hours ${input.cooldown.minutes} mins`,
  });

  if (error) throw mapWidgetError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('upsert_widget_installation returned no id');

  return { id: data, publicKey };
}
