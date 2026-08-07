'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { createInvitationSchema } from '@/schemas/invitations';
import { createInvitation, revokeInvitation } from '@/services/invitations';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately (Block 3c) — the same rule
// members/actions.ts, inventory/actions.ts and roles/actions.ts carry.
//
// Every write below is invoked from the team record dialog, and revalidatePath
// returns a fresh render of /team alongside the action's result, rebuilding the
// roster under somebody who is halfway through granting Stations. The grid
// patches its own row instead (src/lib/row-patch.ts).
//
// These five actions also stopped swallowing their failures. Each was a plain
// `<form action={...}>` with nowhere to put a message, so a refusal — an
// expired permission, a role archived between render and click, the owner who
// takes no role — was logged and then rendered as nothing happening at all.
// Through useActionState the sentence comes back with the result and is shown
// where the operator is looking.
// ---------------------------------------------------------------------------

/**
 * The accept URL is returned through the action result and shown once, never put
 * in a redirect query string: a URL reaches browser history and every proxy
 * access log in front of the app. Same rule as the provisional password in 1a.
 */
export interface InviteState {
  status: 'idle' | 'revealed' | 'error';
  email?: string;
  acceptUrl?: string;
  message?: string;
  /** What the grid needs to show the pending invitation it just created. */
  invitation?: PendingInvitation;
}

export interface PendingInvitation {
  id: string;
  email: string;
  isOwner: boolean;
  roleId: string | null;
  expiresAt: string;
}

export interface TeamActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

const IDLE: TeamActionState = { status: 'idle' };

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * The four membership RPCs (0011, 0017) raise with SQLSTATEs chosen to be told
 * apart, so this maps by code rather than by matching on message text.
 *
 * 23503 and 22023 carry sentences written to be read by the person who pressed
 * the button — "that user does not belong to this organization", "the owner
 * already has full access and takes no role" — and pass through unchanged.
 * 42501 and P0002 name a permission code or a bare uuid instead, which tells
 * the reader nothing they can act on, so those are rewritten. Anything else is
 * our fault rather than theirs and gets the generic line.
 */
function describeTeamError(
  error: { code?: string; message: string },
  t: (key: string) => string,
): string {
  switch (error.code) {
    case '42501':
      return t('youDoNotHavePermissionInThisOrganization');
    case 'P0002':
      return t('thatRecordNoLongerExists');
    case '23503':
    case '22023':
      return error.message;
    default:
      return t('somethingWentWrong');
  }
}

export async function inviteAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const isOwner = formData.get('isOwner') === 'on';
  const parsed = createInvitationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    email: formData.get('email'),
    isOwner,
    // Forced to the shape the schema requires regardless of what the disabled
    // fields happen to carry: a checked owner box means no role and no
    // Stations, full stop, whether or not the browser actually stripped them.
    roleId: isOwner ? null : (formData.get('roleId') as string) || null,
    companyIds: isOwner ? [] : formData.getAll('companyIds').map(String),
  });

  if (!parsed.success) {
    // createInvitationSchema's two .refine messages ("Choose a role for this
    // person." / "Choose at least one Station.") are written to be shown
    // verbatim here, not collapsed into one generic sentence.
    return {
      status: 'error',
      message: parsed.error.issues[0]?.message ?? (await getTranslations('team'))('checkTheAddressRoleAndStations'),
    };
  }

  const token = await requireAccessToken();

  try {
    const result = await createInvitation(parsed.data, token);

    // Read back rather than assembled from the input: expires_at is the
    // database's own now() + p_ttl_days, and the row the grid shows should be
    // the row that exists. A failure here costs the operator nothing but the
    // new line in the list — the invitation itself was created, and the accept
    // URL below is the part that cannot be recovered later.
    const supabase = await createUserClient();
    const { data: stored, error: readError } = await supabase
      .from('invitations')
      .select('id, email, is_owner, role_id, expires_at')
      .eq('id', result.invitationId)
      .single();
    if (readError) {
      logger.error({ err: readError, invitationId: result.invitationId }, 'could not read back the invitation');
    }

    return {
      status: 'revealed',
      email: parsed.data.email,
      acceptUrl: result.acceptUrl,
      invitation: stored
        ? {
            id: stored.id,
            email: stored.email,
            isOwner: stored.is_owner,
            roleId: stored.role_id,
            expiresAt: stored.expires_at,
          }
        : undefined,
    };
  } catch (cause) {
    logger.error({ err: cause }, 'invitation failed');
    const message =
      cause instanceof Error && /already has an account|already/i.test(cause.message)
        ? (await getTranslations('team'))('thatAddressAlreadyHasAnAccount')
        : (await getTranslations('team'))('couldNotSendTheInvitation');
    return { status: 'error', message };
  }
}

export async function revokeAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const token = await requireAccessToken();
  try {
    await revokeInvitation(String(formData.get('invitationId')), token);
    return { status: 'done' };
  } catch (cause) {
    logger.error({ err: cause }, 'revoke failed');
    // revokeInvitation throws UnauthorizedError for every failure the RPC can
    // raise, message included, so there is no code to switch on here.
    return { status: 'error', message: 'Could not revoke the invitation.' };
  }
}

export async function changeOrgRoleAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('change_org_role', {
    p_membership_id: String(formData.get('membershipId')),
    p_new_role: String(formData.get('role')) as 'owner' | 'member',
  });
  if (error) {
    logger.error({ err: error }, 'change_org_role failed');
    return { status: 'error', message: describeTeamError(error, await getTranslations('team')) };
  }
  return { status: 'done' };
}

export async function assignCompanyRoleAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const roleId = String(formData.get('roleId') ?? '');
  // The Select's "No access" option is a placeholder for a member with no
  // company_membership row yet, not a role to assign — it exists so the row
  // has something to display, and is disabled precisely so nobody can pick
  // it deliberately. But it can still be the value Apply submits if someone
  // never changed a fresh "No access" row, and there is nothing to assign in
  // that case. Skip the RPC rather than send it an empty uuid and let
  // assign_company_role fail on a request nobody actually made; removing an
  // existing assignment already has its own explicit Remove button.
  if (!roleId) return IDLE;

  const supabase = await createUserClient();
  const { error } = await supabase.rpc('assign_company_role', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
    p_role_id: roleId,
  });
  if (error) {
    logger.error({ err: error }, 'assign_company_role failed');
    return { status: 'error', message: describeTeamError(error, await getTranslations('team')) };
  }
  return { status: 'done' };
}

export async function removeCompanyAccessAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_company_access', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
  });
  if (error) {
    logger.error({ err: error }, 'remove_company_access failed');
    return { status: 'error', message: describeTeamError(error, await getTranslations('team')) };
  }
  return { status: 'done' };
}

export async function removeMemberAction(
  _prev: TeamActionState,
  formData: FormData,
): Promise<TeamActionState> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_member', {
    p_membership_id: String(formData.get('membershipId')),
  });
  if (error) {
    logger.error({ err: error }, 'remove_member failed');
    return { status: 'error', message: describeTeamError(error, await getTranslations('team')) };
  }
  return { status: 'done' };
}
