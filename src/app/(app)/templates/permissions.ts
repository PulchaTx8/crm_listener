import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

/**
 * Whether this caller may change wording in this one Station.
 *
 * A single boolean rather than the `{ manage, request, merge }` record
 * getMusicPermissions returns, because this block ships exactly two permission
 * codes and one of them is the read that got the caller onto the page at all
 * (0109's own comment: nothing here destroys the way a merge does, so there is
 * no third code to separate out).
 *
 * It sits at `templates/` rather than under either screen because both use it —
 * the Messages screen gates the ten edit forms on it and the WhatsApp screen
 * gates the registry form, and two copies could silently disagree the next time
 * either is fixed.
 *
 * A courtesy gate, never the boundary: all four doors in 0113 re-check
 * `templates.manage` in their own bodies before writing anything, so a stale
 * render — the permission revoked after this page loaded but before a form
 * still sitting in an open tab is submitted — is still refused where it
 * matters.
 *
 * A failed `has_permission` call throws rather than being folded into "not
 * granted": collapsing a transient RPC failure into "no access" would silently
 * hide every form from somebody who does hold the permission.
 */
export async function canManageTemplates(
  supabase: UserClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission: 'templates.manage',
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check templates.manage access for this station: ${error.message}`,
    );
  }
  return data === true;
}

/**
 * Whether this caller owns the Organization this Station belongs to.
 *
 * A SECOND predicate rather than a third permission code, and the distinction
 * matters: `templates.manage` is a grant an owner hands out, and pairing the
 * Station's WhatsApp Business account at Meta is not that kind of act — it
 * binds a telephone number the Organization pays for to this product, and it
 * cannot be undone from this screen. So it is gated on being the owner rather
 * than on holding a code somebody could have been given for transcribing
 * template bodies.
 *
 * `is_owner_of_company` (0044) is ALSO true for the platform admin, which is
 * the house convention every other caller of it accepts (promotions/access.ts
 * uses it for the archived-row rule). Support reaching this button on a
 * customer's behalf is the intended reading, not a leak.
 *
 * A failed call throws rather than being folded into "not the owner", for the
 * reason canManageTemplates above gives for its own: a transient RPC failure
 * that renders as "you are not the owner" is indistinguishable, to the owner,
 * from having lost the Organization.
 */
export async function isStationOwner(
  supabase: UserClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_owner_of_company', {
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check ownership of this station: ${error.message}`,
    );
  }
  return data === true;
}
