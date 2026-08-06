'use server';

import { revalidatePath } from 'next/cache';
import { logger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { disableIntegration, upsertIntegration } from '@/services/integrations';

export interface IntegrationActionResult {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

/**
 * Block 10a. Connect a Station, or edit the one it has.
 *
 * One action for both, because `upsert_integration` is one RPC for both — a
 * Station has at most one WhatsApp integration, so "create" and "edit" are the
 * same submission with different prior state.
 */
export async function saveIntegrationAction(
  formData: FormData,
): Promise<IntegrationActionResult> {
  const companyId = String(formData.get('companyId') ?? '');
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (!companyId || !phoneNumberId) {
    return { status: 'error', message: 'A Station and a phone number id are required.' };
  }

  try {
    await upsertIntegration({
      companyId,
      phoneNumberId,
      wabaId: String(formData.get('wabaId') ?? '').trim() || null,
      displayPhoneNumber: String(formData.get('displayPhoneNumber') ?? '').trim() || null,
      enabled: formData.get('enabled') === 'on',
    });
  } catch (cause) {
    // AppError carries the message the service already made specific -- for a
    // 23505 that is which of the two unique indexes refused, which is the
    // difference between "another Station has this number" and "this Station
    // already has one". Flattening it here would undo 0130's whole reason for
    // not catching them.
    if (cause instanceof AppError) return { status: 'error', message: cause.message };
    logger.error({ err: cause, companyId }, 'could not save the WhatsApp integration');
    return { status: 'error', message: 'The integration could not be saved.' };
  }

  revalidatePath('/admin/integrations');
  return { status: 'done' };
}

export async function disableIntegrationAction(
  companyId: string,
): Promise<IntegrationActionResult> {
  try {
    await disableIntegration(companyId);
  } catch (cause) {
    if (cause instanceof AppError) return { status: 'error', message: cause.message };
    logger.error({ err: cause, companyId }, 'could not disable the WhatsApp integration');
    return { status: 'error', message: 'The integration could not be disabled.' };
  }

  revalidatePath('/admin/integrations');
  return { status: 'done' };
}
