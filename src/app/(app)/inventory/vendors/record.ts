'use server';

import { getTranslations } from 'next-intl/server';
import { logger } from '@/lib/logger';
import { getVendorById } from '@/services/vendors';
import type { VendorSummary } from '@/services/vendors';

/**
 * Block 24, item 7. One vendor's record, read when the dialog opens.
 *
 * The dialog reads rather than being handed the row it was opened from, for the
 * reason every other record dialog here does: `?record=<id>` is an address an
 * operator can paste, and the row it names may be on a page this browser never
 * loaded. Reading makes both openings the same path instead of one that works
 * and one that renders an empty form.
 *
 * `not-found` covers three facts deliberately: no such vendor, a vendor at a
 * Station this caller cannot reach, and a vendor that has been archived —
 * `vendors_select_inventory_view` (0198) filters `deleted_at` too, so all three
 * are one answer through RLS. The screen must not be able to tell them apart,
 * the same contract shows/record.ts and inventory/record.ts carry.
 */
export type VendorRecordResult =
  | { status: 'ok'; record: VendorSummary }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export async function getVendorRecordAction(vendorId: string): Promise<VendorRecordResult> {
  try {
    const found = await getVendorById(vendorId);
    return found ? { status: 'ok', record: found } : { status: 'not-found' };
  } catch (cause) {
    logger.error({ err: cause, vendorId }, 'could not load this vendor record');
    const t = await getTranslations('vendors');
    return { status: 'error', message: t('couldNotReadTheVendor') };
  }
}
