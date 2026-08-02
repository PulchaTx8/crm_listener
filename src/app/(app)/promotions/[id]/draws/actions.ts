'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { cancelDraw, runDraw, type DrawUnitRequest } from '@/services/draws';
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
  runnerUpCount: number,
): Promise<string | null> {
  try {
    const token = await requireAccessToken();
    await runDraw(token, { promotionId, units, runnerUpCount });
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
