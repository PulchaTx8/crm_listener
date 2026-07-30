'use server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { getPromotionRecord } from '@/services/promotions';
import type { PromotionDetail } from '@/services/promotions';
import { describePromotionsReadError } from './errors';

/**
 * Three outcomes, and `not-found` covers two facts on purpose: the promotion
 * does not exist, and the promotion is at a Station this caller cannot reach.
 * RLS decides which rows exist (0044) and this must not let the screen tell
 * them apart, or `?record=<id>` becomes an oracle for ids — the same reasoning
 * the audience and inventory records carry.
 */
export type PromotionRecordResult =
  | { status: 'ok'; record: PromotionDetail }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * The whole record for one opening — the promotion, its questions and their
 * options. All three tabs render from what arrives, so moving between them
 * cannot reach the server and therefore cannot re-run the list query behind
 * the dialog.
 *
 * Never throws to the client: the dialog renders a failure in its own body
 * while the list behind it stays usable, which is the whole advantage of the
 * record being a dialog rather than a page.
 */
export async function getPromotionRecordAction(
  promotionId: string,
): Promise<PromotionRecordResult> {
  const accessToken = await requireAccessToken();

  try {
    const record = await getPromotionRecord(promotionId, accessToken);
    if (!record) return { status: 'not-found' };
    return { status: 'ok', record };
  } catch (cause) {
    logger.error({ err: cause, promotionId }, 'could not load this promotion record');
    return { status: 'error', message: describePromotionsReadError(cause) };
  }
}
