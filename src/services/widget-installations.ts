import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
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
