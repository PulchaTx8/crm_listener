'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { createInvitationSchema } from '@/schemas/invitations';
import { createInvitation, revokeInvitation } from '@/services/invitations';
import { logger } from '@/lib/logger';

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
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
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
      message: parsed.error.issues[0]?.message ?? 'Check the address, role and Stations.',
    };
  }

  const token = await requireAccessToken();

  try {
    const result = await createInvitation(parsed.data, token);
    revalidatePath('/team');
    return { status: 'revealed', email: parsed.data.email, acceptUrl: result.acceptUrl };
  } catch (cause) {
    logger.error({ err: cause }, 'invitation failed');
    const message =
      cause instanceof Error && /already has an account|already/i.test(cause.message)
        ? 'That address already has an account or a pending invitation.'
        : 'Could not send the invitation.';
    return { status: 'error', message };
  }
}

export async function revokeAction(formData: FormData): Promise<void> {
  const token = await requireAccessToken();
  try {
    await revokeInvitation(String(formData.get('invitationId')), token);
  } catch (cause) {
    logger.error({ err: cause }, 'revoke failed');
  }
  revalidatePath('/team');
}

export async function changeOrgRoleAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('change_org_role', {
    p_membership_id: String(formData.get('membershipId')),
    p_new_role: String(formData.get('role')) as 'owner' | 'member',
  });
  if (error) logger.error({ err: error }, 'change_org_role failed');
  revalidatePath('/team');
}

export async function assignCompanyRoleAction(formData: FormData): Promise<void> {
  const roleId = String(formData.get('roleId') ?? '');
  // The Select's "No access" option is a placeholder for a member with no
  // company_membership row yet, not a role to assign — it exists so the row
  // has something to display, and is disabled precisely so nobody can pick
  // it deliberately. But it can still be the value Apply submits if someone
  // never changed a fresh "No access" row, and there is nothing to assign in
  // that case. Skip the RPC rather than send it an empty uuid and let
  // assign_company_role fail on a request nobody actually made; removing an
  // existing assignment already has its own explicit Remove button.
  if (!roleId) {
    revalidatePath('/team');
    return;
  }
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('assign_company_role', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
    p_role_id: roleId,
  });
  if (error) logger.error({ err: error }, 'assign_company_role failed');
  revalidatePath('/team');
}

export async function removeCompanyAccessAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_company_access', {
    p_company_id: String(formData.get('companyId')),
    p_user_id: String(formData.get('userId')),
  });
  if (error) logger.error({ err: error }, 'remove_company_access failed');
  revalidatePath('/team');
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('remove_member', {
    p_membership_id: String(formData.get('membershipId')),
  });
  if (error) logger.error({ err: error }, 'remove_member failed');
  revalidatePath('/team');
}
