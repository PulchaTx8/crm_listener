'use server';

import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '@/lib/errors';
import { vendorFormSchema } from '@/schemas/vendors';
import { archiveVendor, getVendorById, saveVendor, type VendorSummary } from '@/services/vendors';

/**
 * Block 24, item 7. The two writes a vendor has.
 *
 * NOT ONE `revalidatePath` IN THIS FILE, the same rule shows, songs, inventory
 * and members all carry: every write here is invoked from the record dialog or
 * the row menu, and a fresh render of the route would re-run the list's keyset
 * query, rebuild the grid from page one and throw away whatever the operator had
 * open. The grid patches its own row instead (src/lib/row-patch.ts), which is why
 * both actions hand the saved record back.
 */

export interface VendorFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** The saved vendor, so the grid can patch its row without re-reading the list. */
  record?: VendorSummary;
}

// The idle constant lives in the dialog, NOT here. A module carrying
// 'use server' may export nothing but async functions — an exported const object
// is a runtime error Next raises only when the route is served, which is why no
// typecheck, lint or unit run catches it and the e2e does. shows/actions.ts
// carries the same note for the same reason.

async function accessToken(): Promise<string | null> {
  const supabase = await createUserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/**
 * A write refusal, as an operator should read it.
 *
 * `23505` gets a sentence of its own rather than the constraint's message: what
 * Postgres says is "duplicate key value violates unique constraint
 * vendors_name_unique", which names an index at somebody trying to register a
 * supplier.
 */
function describe(cause: unknown, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (cause instanceof ConflictError) return t('aVendorWithThisNameAlreadyExists');
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof UnauthorizedError) return t('youDoNotHoldInventoryCatalogue');
  if (cause instanceof NotFoundError) return t('thatVendorNoLongerExists');
  return t('couldNotSaveTheVendor');
}

export async function saveVendorAction(
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const t = await getTranslations('vendors');

  const parsed = vendorFormSchema.safeParse({
    companyId: formData.get('companyId'),
    vendorId: formData.get('vendorId') || undefined,
    name: formData.get('name'),
    legalName: formData.get('legalName') || null,
    document: formData.get('document') || null,
    contactName: formData.get('contactName') || null,
    phone: formData.get('phone') || null,
    email: formData.get('email') || null,
    addressLine: formData.get('addressLine') || null,
    city: formData.get('city') || null,
    state: formData.get('state') || null,
    postalCode: formData.get('postalCode') || null,
    website: formData.get('website') || null,
    notes: formData.get('notes') || null,
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheVendor') };

  try {
    const id = await saveVendor(parsed.data, token);
    // Read back rather than assembling a summary from what was posted: the row
    // carries created_at, which a new vendor's grid row needs and this action
    // never saw.
    const record = await getVendorById(id);
    return record
      ? { status: 'saved', record }
      : { status: 'error', message: t('couldNotSaveTheVendor') };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'save vendor failed');
    return { status: 'error', message: describe(cause, t) };
  }
}

/**
 * The only way a supplier leaves circulation. There is no delete action in this
 * file, and its absence is the decision: an entry points at a vendor, so a delete
 * would be refused with 23503 the moment one purchase named them — the operator
 * would read "could not save" about a row they were removing.
 */
export async function archiveVendorAction(
  _previous: VendorFormState,
  formData: FormData,
): Promise<VendorFormState> {
  const t = await getTranslations('vendors');

  const vendorId = String(formData.get('vendorId') ?? '');
  if (!vendorId) return { status: 'error', message: t('checkTheForm') };

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheVendor') };

  try {
    await archiveVendor(vendorId, token);
    // NOTHING IS READ BACK, unlike saveVendorAction, and it cannot be: 0198's
    // select policy filters `deleted_at`, so the row this action just archived is
    // unreadable through RLS the instant it lands. The grid removes the row on
    // this success rather than patching it — which is also what the list should
    // show, since an archived vendor is not on it.
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, vendorId }, 'archive vendor failed');
    return { status: 'error', message: describe(cause, t) };
  }
}
