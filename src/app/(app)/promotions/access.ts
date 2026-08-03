import 'server-only';
import { InternalError } from '@/lib/errors';
import type { createUserClient } from '@/lib/supabase/user-client';

type UserClient = Awaited<ReturnType<typeof createUserClient>>;

export interface PromotionPowers {
  create: boolean;
  edit: boolean;
  cancel: boolean;
  archive: boolean;
  /** Linking moves stock, so it is its own code rather than part of promotions.edit. */
  prizes: boolean;
  /**
   * participations.view, and it is asked for one narrow reason: the fifth tab's
   * two counts are read under 0053's select policy, so a caller without it is
   * answered with zero rather than with an error. Rendered unqualified, "0 in
   * the draw" would then be a screen stating as fact something it is not allowed
   * to know.
   */
  participationsView: boolean;
  /** record_participation, on the record's fifth tab. */
  participationsCreate: boolean;
  /** import_participations, which also needs membersCreate below (design spec D10). */
  participationsImport: boolean;
  /**
   * members.view. Not decoration on either writing surface: both reach a
   * listener through resolve_or_create_member, whose find_member_by_identifier
   * (0033) raises 42501 without it. Somebody holding participations.create alone
   * can record nothing at all, because there is no way from the screen to name a
   * listener that does not go through that lookup.
   */
  membersView: boolean;
  /**
   * members.create. D10 for the import, checked by the RPC before its first row;
   * narrower for the manual form, where only registering somebody new needs it.
   */
  membersCreate: boolean;
  /** draws.execute. Running a draw moves stock and starts a deadline, so it is its own code. */
  drawsExecute: boolean;
  /**
   * draws.cancel, and deliberately NOT implied by drawsExecute (spec 4.3):
   * cancelling un-awards prizes somebody has already been told they won, and
   * whoever may run a draw is not thereby somebody who may undo one.
   */
  drawsCancel: boolean;
  /** Block 6b's four, each its own code for the reasons 0081 records. */
  winnersDeliver: boolean;
  winnersDeliverCancel: boolean;
  winnersReturn: boolean;
  winnersWriteOff: boolean;
  /** True for the platform admin and the Organization owner — the only callers whose reads return archived rows (0044). */
  seesArchived: boolean;
}

/**
 * The last five are not promotions codes, and they are here rather than in a
 * second per-Station lookup of their own because the record's fifth tab needs
 * them at exactly the moment this answer already exists.
 *
 * Block 4c tried the alternative first — the tab asking for them itself when it
 * opened — and it produced a tab that could hang for ever: a server action
 * dispatched from an effect that runs immediately after the tab strip's
 * navigation is silently dropped when that navigation aborts an action already
 * in flight. Resolved here, the tab renders from props like Quiz and Prizes do,
 * and reaches the server only to write.
 *
 * The cost, stated: five more has_permission calls on every render of the
 * promotions list, for a tab most of those renders will never open. They go out
 * with the five above them in one Promise.all and each is a single predicate, so
 * this is five more round trips and not five more queries anybody will feel —
 * measured against a control that sometimes never loaded at all.
 */
const WRITE_CODES = [
  'promotions.create',
  'promotions.edit',
  'promotions.cancel',
  'promotions.archive',
  'promotions.prizes',
  'participations.view',
  'participations.create',
  'participations.import',
  'members.view',
  'members.create',
  'draws.execute',
  'draws.cancel',
  'winners.deliver',
  'winners.deliver_cancel',
  'winners.return',
  'winners.write_off',
] as const;

/**
 * Which of the five write permissions the caller holds in this one Station,
 * plus whether they are the caller 0044 admits to archived rows.
 *
 * A courtesy gate for which controls get rendered at all, never the boundary:
 * create_promotion, update_promotion, cancel_promotion, archive_promotion and
 * both quiz RPCs re-check has_permission themselves before writing anything
 * (0042/0043), and so do link_prize_to_promotion and unlink_prize_from_promotion
 * (0049), so a permission revoked after this page rendered — with a form still
 * sitting in an open tab — is still refused where it matters.
 *
 * A failed has_permission call throws rather than being folded into "not
 * granted", the same reasoning getInventoryPermissions gives: collapsing a
 * transient RPC failure into "no access" would silently hide every control
 * from somebody who does hold the permission, and they would have no way to
 * tell that from having lost it.
 */
export async function getPromotionPowers(
  supabase: UserClient,
  companyId: string,
): Promise<PromotionPowers> {
  const [writes, archived] = await Promise.all([
    Promise.all(
      WRITE_CODES.map((code) =>
        supabase.rpc('has_permission', { p_permission: code, p_company_id: companyId }),
      ),
    ),
    supabase.rpc('is_owner_of_company', { p_company_id: companyId }),
  ]);

  writes.forEach((result, i) => {
    if (result.error) {
      throw new InternalError(
        `Could not check ${WRITE_CODES[i]} access for this station: ${result.error.message}`,
      );
    }
  });
  if (archived.error) {
    throw new InternalError(
      `Could not check whether this caller sees archived promotions: ${archived.error.message}`,
    );
  }

  return {
    create: writes[0]?.data === true,
    edit: writes[1]?.data === true,
    cancel: writes[2]?.data === true,
    archive: writes[3]?.data === true,
    prizes: writes[4]?.data === true,
    participationsView: writes[5]?.data === true,
    participationsCreate: writes[6]?.data === true,
    participationsImport: writes[7]?.data === true,
    membersView: writes[8]?.data === true,
    membersCreate: writes[9]?.data === true,
    drawsExecute: writes[10]?.data === true,
    drawsCancel: writes[11]?.data === true,
    winnersDeliver: writes[12]?.data === true,
    winnersDeliverCancel: writes[13]?.data === true,
    winnersReturn: writes[14]?.data === true,
    winnersWriteOff: writes[15]?.data === true,
    seesArchived: archived.data === true,
  };
}
