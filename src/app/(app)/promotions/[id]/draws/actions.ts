'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { cancelDraw, runDraw, type DrawUnitRequest } from '@/services/draws';
import type { WinnerAction } from '@/components/draws/winner-actions';
import {
  attachDeliveryReceipt,
  cancelDelivery,
  deliverPrize,
  returnPrize,
  writeOffPrize,
} from '@/services/winners';
import { describeReceiptRejection } from '@/lib/security/uploads';
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
 * The four transitions this route can actually finish, and the receipt.
 *
 * Each returns a message or null, the shape the draws screen already uses, and
 * each revalidates this route for the reason runDrawAction gives: the whole
 * content of this page is what the operator just changed.
 *
 * `action` is the full `WinnerAction` (Block 6d Task 8 added `'reopen'`) rather
 * than a narrower type, because that is what `WinnerActions`' `onAct` actually
 * hands up through `DrawDetailView`/`DrawsScreen` — narrowing the parameter
 * here would only move the type error one file up. `winnerPowers.reopenDeadline`
 * is hard-set to `false` on this route (page.tsx), so the branch below is
 * unreachable through this screen's own UI; it exists so a value the compiler
 * still considers possible can never fall through to the `write_off` branch by
 * accident.
 */
export async function winnerActionAction(
  promotionId: string,
  winnerId: string,
  action: WinnerAction,
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
    } else if (action === 'write_off') {
      await writeOffPrize(token, { winnerId, reason });
    } else {
      // 'reopen': this route offers no field for the new deadline
      // reopen_pickup_deadline (0093) requires. Block 6d Task 9 builds the
      // Pickups screen, the one place with a date beside the reason, and
      // reopens through its own action there instead.
      return 'Reopening a deadline is not available from this screen.';
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
  // Block 11b, D7. The bucket refuses these too (0134), and THAT is the real
  // boundary -- no client can go around it. This exists so the operator reads
  // "that file is 40 MB" instead of a raw Storage error, and so a refused file
  // is never uploaded in the first place.
  const rejection = describeReceiptRejection(file);
  if (rejection) return rejection;

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
