'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { getPrizeById, getPrizeMovements } from '@/services/inventory';
import type { MovementEntry, PrizeSummary } from '@/services/inventory';
import { describeInventoryReadError } from './errors';

export interface PrizeRecord {
  companyId: string;
  prize: PrizeSummary;
  movements: MovementEntry[];
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
 * One round trip for the whole record: the prize with its balances, and its
 * movement history. Both tabs render from what arrives, so switching between
 * them cannot reach the server and therefore cannot re-run the list behind the
 * dialog.
 */
export async function getPrizeRecordAction(prizeId: string): Promise<PrizeRecordResult> {
  try {
    const found = await getPrizeById(prizeId);
    if (!found) return { status: 'not-found' };

    const movements = await getPrizeMovements(found.companyId, prizeId);
    return {
      status: 'ok',
      record: { companyId: found.companyId, prize: found.prize, movements },
    };
  } catch (cause) {
    logger.error({ err: cause, prizeId }, 'could not load this prize record');
    return { status: 'error', message: describeInventoryReadError(cause, await getTranslations('inventory')) };
  }
}
