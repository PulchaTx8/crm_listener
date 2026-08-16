'use server';

import { getTranslations } from 'next-intl/server';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { prizeCategoryFormSchema } from '@/schemas/inventory';
import {
  archivePrizeCategory,
  getPrizeCategoryById,
  savePrizeCategory,
  type PrizeCategorySummary,
} from '@/services/inventory';

/**
 * Block 26. The two writes a prize category has.
 *
 * NOT ONE `revalidatePath` IN THIS FILE, the same rule vendors, shows, songs,
 * inventory and members all carry: every write here is invoked from the record
 * dialog or the row menu, and a fresh render of the route would re-run the list's
 * keyset query, rebuild the grid from page one and throw away whatever the
 * operator had open. The grid patches its own row instead (src/lib/row-patch.ts),
 * which is why the save action hands the saved record back.
 */

export interface PrizeCategoryFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** The saved category, so the grid can patch its row without re-reading the list. */
  record?: PrizeCategorySummary;
}

export interface PrizeCategoryArchiveState {
  status: 'idle' | 'archived' | 'error';
  message?: string;
  /**
   * How many prizes actually lost the label. NOT the same number the
   * confirmation quoted: that one came off the row, which was read when the page
   * was, and somebody may have moved a prize into this category since. The door
   * returns what it did, so the line the grid shows afterwards is the truth
   * rather than the estimate.
   */
  detached?: number;
}

// The idle constants live in the components, NOT here. A module carrying
// 'use server' may export nothing but async functions — an exported const object
// is a runtime error Next raises only when the route is served, which is why no
// typecheck, lint or unit run catches it and the e2e does. vendors/actions.ts
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
 * prize_categories_name_unique", which names an index at somebody typing a name.
 * 0202's door already rewrites it, and this is the fallback for the day it
 * stops.
 */
function describe(cause: unknown, t: Awaited<ReturnType<typeof getTranslations>>): string {
  if (cause instanceof ConflictError) return t('aCategoryWithThisNameAlreadyExists');
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof UnauthorizedError) return t('youDoNotHoldInventoryCatalogue');
  if (cause instanceof NotFoundError) return t('thatCategoryNoLongerExists');
  return t('couldNotSaveTheCategory');
}

export async function savePrizeCategoryAction(
  _previous: PrizeCategoryFormState,
  formData: FormData,
): Promise<PrizeCategoryFormState> {
  const t = await getTranslations('prizeCategories');

  const parsed = prizeCategoryFormSchema.safeParse({
    companyId: formData.get('companyId'),
    categoryId: formData.get('categoryId') || undefined,
    name: formData.get('name'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? t('checkTheForm') };
  }

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheCategory') };

  try {
    const id = await savePrizeCategory(
      parsed.data.companyId,
      parsed.data.name,
      token,
      parsed.data.categoryId,
    );
    // Read back rather than assembling a summary from what was posted: the row
    // carries created_at and the prize count, neither of which this action saw.
    const record = await getPrizeCategoryById(id);
    return record
      ? { status: 'saved', record }
      : { status: 'error', message: t('couldNotSaveTheCategory') };
  } catch (cause) {
    logger.error({ err: cause, companyId: parsed.data.companyId }, 'save prize category failed');
    return { status: 'error', message: describe(cause, t) };
  }
}

/**
 * The only way a category leaves circulation. There is no delete action in this
 * file, and its absence is the decision: prizes point at a category, so a delete
 * would be refused with 23503 the moment one prize wore it — the operator would
 * read "could not save" about a row they were removing.
 */
export async function archivePrizeCategoryAction(
  _previous: PrizeCategoryArchiveState,
  formData: FormData,
): Promise<PrizeCategoryArchiveState> {
  const t = await getTranslations('prizeCategories');

  const categoryId = String(formData.get('categoryId') ?? '');
  if (!categoryId) return { status: 'error', message: t('checkTheForm') };

  const token = await accessToken();
  if (!token) return { status: 'error', message: t('couldNotSaveTheCategory') };

  try {
    const detached = await archivePrizeCategory(categoryId, token);
    // NOTHING IS READ BACK, unlike savePrizeCategoryAction, and it cannot be:
    // 0029's select policy filters `deleted_at`, so the row this action just
    // archived is unreadable through RLS the instant it lands. The grid removes
    // the row on this success rather than patching it — which is also what the
    // list should show, since an archived category is not on it.
    return { status: 'archived', detached };
  } catch (cause) {
    logger.error({ err: cause, categoryId }, 'archive prize category failed');
    return { status: 'error', message: describe(cause, t) };
  }
}
