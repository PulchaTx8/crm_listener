'use server';

import { revalidatePath } from 'next/cache';
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

export interface RoleFormState {
  status: 'idle' | 'saved' | 'error';
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
function describeRoleError(cause: unknown): string {
  if (cause instanceof ConflictError) return cause.message;
  if (cause instanceof BusinessRuleError) return cause.message;
  if (cause instanceof NotFoundError) {
    return 'That role no longer exists. Refresh the page and try again.';
  }
  if (cause instanceof UnauthorizedError) {
    return 'You do not have permission to manage roles.';
  }
  if (cause instanceof ValidationError) return cause.message;
  // Generic on purpose, and worded to fit both callers: InternalError means
  // the fault is ours, not the caller's, whether they were saving or deleting.
  return 'Something went wrong. Try again.';
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
    if (roleId) await updateRole(roleId, parsed.data, token);
    else await createRole(parsed.data, token);
    revalidatePath('/roles');
    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause }, 'save role failed');
    return { status: 'error', message: describeRoleError(cause) };
  }
}

/**
 * Bound directly to a plain `<form action={deleteRoleAction}>` (no
 * useActionState), so there is no component state to hold an error message
 * the way saveRoleAction's does. Previously this swallowed the error into a
 * log line and let the page re-render unchanged — the database's refusal
 * (BusinessRuleError, when holders changed between render and click; or the
 * count was wrong in the first place, I2) looked exactly like nothing had
 * happened. Surfaced the same way addCompanyAction (admin/customers/actions.ts)
 * already surfaces a failure with no state container of its own: redirect
 * into a query param the page reads back into a banner. The success path also
 * redirects to the bare path — revalidatePath alone re-renders in place
 * without touching the address bar, so a stale ?deleteError= from an earlier
 * failed attempt would otherwise still be sitting in the URL after a
 * successful retry.
 */
export async function deleteRoleAction(formData: FormData): Promise<void> {
  const token = await requireAccessToken();
  let message: string | null = null;
  try {
    await deleteRole(String(formData.get('roleId')), token);
  } catch (cause) {
    logger.error({ err: cause }, 'delete role failed');
    message = describeRoleError(cause);
  }
  revalidatePath('/roles');
  if (message) redirect(`/roles?deleteError=${encodeURIComponent(message)}`);
  redirect('/roles');
}
