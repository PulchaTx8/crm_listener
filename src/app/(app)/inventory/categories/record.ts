'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { getPrizeCategoryById } from '@/services/inventory';
import type { PrizeCategorySummary } from '@/services/inventory';

/**
 * Block 26. One category's record, read when the dialog opens.
 *
 * The dialog reads rather than being handed the row it was opened from, for the
 * reason every other record dialog here does: `?record=<id>` is an address an
 * operator can paste, and the row it names may be on a page this browser never
 * loaded. Reading makes both openings the same path instead of one that works and
 * one that renders an empty form.
 *
 * `not-found` covers three facts deliberately: no such category, a category at a
 * Station this caller cannot reach, and a category that has been archived —
 * `prize_categories_select_inventory_view` (0029) filters `deleted_at` too, so
 * all three are one answer through RLS. The screen must not be able to tell them
 * apart, the same contract vendors/record.ts and inventory/record.ts carry.
 */
export type PrizeCategoryRecordResult =
  | { status: 'ok'; record: PrizeCategorySummary }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function getPrizeCategoryRecordAction(
  categoryId: string,
): Promise<PrizeCategoryRecordResult> {
  try {
    const found = await getPrizeCategoryById(categoryId);
    return found ? { status: 'ok', record: found } : { status: 'not-found' };
  } catch (cause) {
    logger.error({ err: cause, categoryId }, 'could not load this prize category record');
    const t = await getTranslations('prizeCategories');
    return { status: 'error', message: t('couldNotReadTheCategory') };
  }
}
