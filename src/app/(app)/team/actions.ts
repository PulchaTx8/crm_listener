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
  const parsed = createInvitationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    email: formData.get('email'),
    role: formData.get('role'),
  });

  if (!parsed.success) {
    return { status: 'error', message: 'Check the address and the role.' };
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

export async function changeRoleAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('change_member_role', {
    p_membership_id: String(formData.get('membershipId')),
    p_new_role: String(formData.get('role')) as 'owner' | 'operator' | 'viewer',
  });
  if (error) logger.error({ err: error }, 'change_member_role failed');
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
