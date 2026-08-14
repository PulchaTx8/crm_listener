'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { getPrizeById, getPrizeMovements } from '@/services/inventory';
import type { PrizeMovementsPage, PrizeSummary } from '@/services/inventory';
import { ENTRY_MOVEMENT_TYPES, EXIT_MOVEMENT_TYPES, RESERVATION_MOVEMENT_TYPES } from './format';
import { describeInventoryReadError } from './errors';

export interface PrizeRecord {
  companyId: string;
  prize: PrizeSummary;
  /**
   * One page per tab (Block 23, Task 5), each `getPrizeMovements` call
   * narrowed to its own group of kinds (format.ts's three arrays) except
   * `movements`, called with `types` omitted — the Movimentação tab is the
   * one unified view (design D10) and passing an empty array there would
   * ask `list_movements` for the empty set instead (0196's own comment: an
   * empty `p_types` array matches nothing, `null` means no filter).
   */
  entries: PrizeMovementsPage;
  exits: PrizeMovementsPage;
  reservations: PrizeMovementsPage;
  movements: PrizeMovementsPage;
}

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the prize does
 * not exist, and the prize is at a Station this caller cannot reach. RLS
 * decides which rows exist (prizes_select_inventory_view, 0029) and this must
 * not let the screen tell them apart — the same reasoning the audience record
 * carries, and the same reason the retired prize page collapsed them too.
 */
export type PrizeRecordResult =
  | { status: 'ok'; record: PrizeRecord }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

/**
 * `getPrizeMovements` (Task 4) is SECURITY DEFINER and re-checks
 * `has_permission` against `auth.uid()` in its own body, so it needs the
 * caller's own JWT rather than the cookie session `getPrizeById` reads
 * through — the same plumbing `members/record.ts` and `promotions/record.ts`
 * already carry for their own RPC-backed reads.
 */
async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * One round trip for the whole record — the prize with its balances, and all
 * four of the movement histories the tabs need — rather than one read per
 * tab switch. This is the same shape `members/record.ts` already established
 * for its own five tabs (its own header states the reasoning at length): the
 * tabs render from what arrives, so switching between them costs nothing and
 * cannot re-run the list query behind the dialog.
 *
 * It also keeps the four histories mutually consistent for free. A stock
 * entry recorded through the Entradas tab lands a row in Entradas AND in
 * Movimentação (the unfiltered view) and changes the balance `data` shows —
 * three places one write touches. Tasks 6/7's own reload after a write is
 * this whole action run again (prize-record-dialog.tsx's `reloadToken`, the
 * same mechanism the old two-tab dialog used), never a re-fetch of only the
 * tab that was open — so none of the other three can be left showing what
 * was true before the write.
 *
 * The four movement reads run in `Promise.all` rather than in sequence:
 * independent RPC calls with nothing for one to learn from another, the same
 * reasoning `members/record.ts` gives for its own four parallel reads.
 */
export async function getPrizeRecordAction(prizeId: string): Promise<PrizeRecordResult> {
  const accessToken = await requireAccessToken();

  try {
    const found = await getPrizeById(prizeId);
    if (!found) return { status: 'not-found' };

    const [entries, exits, reservations, movements] = await Promise.all([
      getPrizeMovements(found.companyId, prizeId, accessToken, ENTRY_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken, EXIT_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken, RESERVATION_MOVEMENT_TYPES),
      getPrizeMovements(found.companyId, prizeId, accessToken),
    ]);

    return {
      status: 'ok',
      record: { companyId: found.companyId, prize: found.prize, entries, exits, reservations, movements },
    };
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'could not load this prize record');
    return { status: 'error', message: describeInventoryReadError(cause, await getTranslations('inventory')) };
  }
}
