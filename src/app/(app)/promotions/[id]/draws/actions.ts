'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { cancelDraw, runDraw, type DrawUnitRequest } from '@/services/draws';
import {
  attachDeliveryReceipt,
  cancelDelivery,
  deliverPrize,
  returnPrize,
  writeOffPrize,
} from '@/services/winners';
import { describePromotionsWriteError } from '../../errors';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * revalidatePath IS called here, unlike everywhere in ../../actions.ts.
 *
 * That rule exists to protect the promotions LIST's keyset place from being
 * re-run underneath an open record dialog. This is its own route, reached by
 * navigating away from that list, and its whole content is the draws of one
 * promotion — after a draw runs or is cancelled, a page that did not re-read
 * would be showing the state before the thing the operator just did.
 */
export async function runDrawAction(
  promotionId: string,
  units: DrawUnitRequest[] | null,
): Promise<string | null> {
  try {
    const token = await requireAccessToken();
    await runDraw(token, { promotionId, units });
    revalidatePath(`/promotions/${promotionId}/draws`);
    return null;
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'run_draw failed');
    return describePromotionsWriteError(cause, 'run a draw');
  }
}

export async function cancelDrawAction(
  promotionId: string,
  drawId: string,
  reason: string,
): Promise<string | null> {
  try {
    const token = await requireAccessToken();
    await cancelDraw(token, { drawId, reason });
    revalidatePath(`/promotions/${promotionId}/draws`);
    return null;
  } catch (cause) {
    logger.error({ err: cause, drawId }, 'cancel_draw failed');
    return describePromotionsWriteError(cause, 'cancel a draw');
  }
}

/**
 * The four transitions, and the receipt.
 *
 * Each returns a message or null, the shape the draws screen already uses, and
 * each revalidates this route for the reason runDrawAction gives: the whole
 * content of this page is what the operator just changed.
 */
export async function winnerActionAction(
  promotionId: string,
  winnerId: string,
  action: 'deliver' | 'cancel_delivery' | 'return' | 'write_off',
  reason: string,
): Promise<string | null> {
  try {
    const token = await requireAccessToken();
    if (action === 'deliver') {
      await deliverPrize(token, { winnerId, note: reason.trim() || null });
    } else if (action === 'cancel_delivery') {
      await cancelDelivery(token, { winnerId, reason });
    } else if (action === 'return') {
      await returnPrize(token, { winnerId, reason });
    } else {
      await writeOffPrize(token, { winnerId, reason });
    }
    revalidatePath(`/promotions/${promotionId}/draws`);
    return null;
  } catch (cause) {
    logger.error({ err: cause, winnerId, action }, 'winner transition failed');
    return describePromotionsWriteError(cause, 'change this prize');
  }
}

export async function attachReceiptAction(
  promotionId: string,
  winnerId: string,
  companyId: string,
  formData: FormData,
): Promise<string | null> {
  const file = formData.get('receipt');
  if (!(file instanceof File) || file.size === 0) return 'Choose a file.';

  try {
    const token = await requireAccessToken();
    await attachDeliveryReceipt(token, { winnerId, companyId, file });
    revalidatePath(`/promotions/${promotionId}/draws`);
    return null;
  } catch (cause) {
    logger.error({ err: cause, winnerId }, 'attach_delivery_receipt failed');
    return describePromotionsWriteError(cause, 'attach a receipt');
  }
}
