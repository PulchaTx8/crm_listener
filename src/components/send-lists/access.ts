import 'server-only';
import { InternalError } from '@/lib/errors';
import type { UserClient } from '@/lib/supabase/user-client';

/**
 * Block 29d-1, Task 7. Whether this caller may create a send list at one
 * Station -- the exact permission create_send_list (0239) itself re-checks
 * before writing anything, asked here only so the button that opens
 * CreateSendListDialog can be hidden rather than offered and then refused.
 *
 * Shared by all three source screens (Members, Participations, Requests)
 * rather than copied three times, the same cross-screen reuse
 * canSearchByListener (../../app/(app)/participations/access.ts) already
 * establishes for a permission none of the three screens individually owns --
 * messaging.manage belongs to none of members.*, participations.* or
 * music.*, so it has no natural home in any one of their own access.ts
 * files, and lives beside the shared dialog instead.
 *
 * A courtesy gate, never the boundary: the door re-checks messaging.manage in
 * its own SECURITY DEFINER body regardless (0239's own comment on why --
 * "the boundary is the database's, and hiding a button is a courtesy"), so a
 * permission revoked between this read and a submission already in flight is
 * still refused where it actually matters.
 *
 * A failed check throws rather than being folded into "not granted", the
 * same reasoning canSearchByListener/canRunDraw both give for their own:
 * collapsing a transient RPC failure into "no access" would silently take
 * the button away from someone who does hold the permission.
 */
export async function canManageMessagingAt(
  supabase: UserClient,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_permission: 'messaging.manage',
    p_company_id: companyId,
  });
  if (error) {
    throw new InternalError(
      `Could not check whether this caller may create a send list here: ${error.message}`,
    );
  }
  return data === true;
}
