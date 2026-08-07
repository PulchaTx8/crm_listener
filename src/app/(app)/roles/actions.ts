'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { roleFormSchema } from '@/schemas/roles';
import { createRole, deleteRole, updateRole } from '@/services/roles';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately (Block 3c) — the same rule
// members/actions.ts and inventory/actions.ts carry, for the same reason.
//
// Both writes below are invoked from the role record dialog, and revalidatePath
// returns a fresh render of /roles alongside the action's result, rebuilding the
// list under an operator who is in the middle of it. The grid patches its own
// row instead (src/lib/row-patch.ts), which is why saveRoleAction returns what
// was stored.
// ---------------------------------------------------------------------------

/**
 * What the grid needs to redraw a saved role's row, and nothing more.
 *
 * `holders` is absent on purpose: update_role (0017) touches `roles` and
 * `role_permissions` only — it never writes company_memberships — so the count
 * the grid already has is still correct after a save, and the row keeps it
 * rather than taking a number back from a form the caller controls.
 */
export interface SavedRole {
  id: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
}

export interface RoleFormState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** Present exactly when status is 'saved'. */
  role?: SavedRole;
  /** True when this save created the role rather than updating one. */
  created?: boolean;
}

export interface DeleteRoleState {
  status: 'idle' | 'deleted' | 'error';
  message?: string;
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * The service throws the typed errors from lib/errors.ts; this is where each
 * one turns into a sentence the person filling in the form can act on. Shared
 * by both saveRoleAction and deleteRoleAction — deleteRole (services/roles.ts)
 * throws the same taxonomy (BusinessRuleError for "role is assigned to N
 * user(s)", NotFoundError for a stale id, UnauthorizedError for a missing
 * roles.manage), so one mapping serves both actions.
 * ConflictError and BusinessRuleError already carry a friendly message from
 * services/roles.ts (mapRoleError) — the duplicate-name text and the holder
 * count respectively — so those pass through unchanged. NotFoundError and
 * UnauthorizedError carry the raw Postgres message ("role not found: <uuid>",
 * "permission denied: roles.manage required"), which names the row or the
 * permission code instead of speaking to the person reading it, so those are
 * rewritten here. ValidationError's messages ("role name is required",
 * "unknown permission code: x") are already plain English and pass through.
 * Anything else — InternalError — is our fault, not theirs: there is nothing
 * for them to fix beyond trying again, so it gets the generic fallback rather
 * than a raw database message.
 */
function describeRoleError(cause: unknown, t: (key: string) => string): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return t('thatRoleNoLongerExists');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionToManageRoles');
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose, and worded to fit both callers: InternalError means
  // the fault is ours, not the caller's, whether they were saving or deleting.
  return t('somethingWentWrong');
}

export async function saveRoleAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const parsed = roleFormSchema.safeParse({
    organizationId: formData.get('organizationId'),
    name: formData.get('name'),
    description: formData.get('description') || null,
    permissionCodes: formData.getAll('permissionCodes').map(String),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const token = await requireAccessToken();
  const roleId = String(formData.get('roleId') ?? '');

  try {
    let savedId: string;
    if (roleId) {
      await updateRole(roleId, parsed.data, token);
      savedId = roleId;
    } else {
      savedId = await createRole(parsed.data, token);
    }

    // Assembled from the input rather than read back, which is sound here and
    // would not be for a record the database rewrites. roleFormSchema already
    // trims the name and folds '' and null into undefined for the description,
    // and update_role/create_role apply exactly the same normalisation
    // (nullif(trim(coalesce(p_description,'')),'')) to what they are handed;
    // the permission set is replaced wholesale with the codes given, having
    // been checked against the catalogue first. So these three values are what
    // is now stored, not an optimistic guess at it.
    return {
      status: 'saved',
      created: !roleId,
      role: {
        id: savedId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        permissionCodes: parsed.data.permissionCodes,
      },
    };
  } catch (cause) {
    logger.error({ err: cause }, 'save role failed');
    return { status: 'error', message: describeRoleError(cause, await getTranslations('roles')) };
  }
}

/**
 * The database's refusal has somewhere to be said now. This used to be a plain
 * `<form action={deleteRoleAction}>` with no state container of its own, so a
 * failure — BusinessRuleError when the holder count changed between render and
 * click, or was wrong to begin with (I2) — had to travel back as a
 * ?deleteError= query parameter for the page to read into a banner, and the
 * success path had to redirect to the bare path just to clear it again.
 *
 * Called from the grid's confirmation dialog now, through useActionState, so
 * the message comes back in the result and is rendered where the operator is
 * looking. That also retires the redirect pair: both of them re-rendered
 * /roles, which is exactly what this block's rule forbids — the grid removes
 * the row itself on success.
 */
export async function deleteRoleAction(
  _prev: DeleteRoleState,
  formData: FormData,
): Promise<DeleteRoleState> {
  const token = await requireAccessToken();
  try {
    await deleteRole(String(formData.get('roleId')), token);
    return { status: 'deleted' };
  } catch (cause) {
    logger.error({ err: cause }, 'delete role failed');
    return { status: 'error', message: describeRoleError(cause, await getTranslations('roles')) };
  }
}
