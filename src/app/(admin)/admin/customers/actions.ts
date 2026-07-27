'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { provisionCustomerSchema } from '@/schemas/provisioning';
import { provisionCustomer, regenerateProvisionalPassword } from '@/services/provisioning';
import { logger } from '@/lib/logger';

/**
 * The provisional password is returned through the action result, never
 * through a redirect URL. A query string reaches browser history and every
 * proxy access log in front of the app, which is precisely what spec §6 rules
 * out — the password is shown once, on screen, and stored nowhere.
 */
export interface CredentialState {
  status: 'idle' | 'revealed' | 'error';
  email?: string;
  password?: string;
  message?: string;
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

export async function provisionAction(
  _prev: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const parsed = provisionCustomerSchema.safeParse({
    organizationName: formData.get('organizationName'),
    companyName: formData.get('companyName'),
    ownerEmail: formData.get('ownerEmail'),
    ownerName: formData.get('ownerName') || undefined,
    timezone: formData.get('timezone') || undefined,
  });

  if (!parsed.success) {
    return { status: 'error', message: 'Check the fields and try again.' };
  }

  const token = await requireAccessToken();

  try {
    const result = await provisionCustomer(parsed.data, token);
    revalidatePath('/admin/customers');
    return {
      status: 'revealed',
      email: parsed.data.ownerEmail,
      password: result.provisionalPassword,
    };
  } catch (cause) {
    logger.error({ err: cause }, 'provisioning failed');
    return { status: 'error', message: 'Provisioning failed and was rolled back.' };
  }
}

export async function regenerateAction(
  _prev: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const userId = String(formData.get('userId') ?? '');
  const email = String(formData.get('email') ?? '');
  if (!userId) return { status: 'error', message: 'Missing user.' };

  const token = await requireAccessToken();

  try {
    const password = await regenerateProvisionalPassword(userId, token);
    revalidatePath('/admin/customers');
    return { status: 'revealed', email, password };
  } catch (cause) {
    logger.error({ err: cause }, 'provisional password regeneration failed');
    return { status: 'error', message: 'Could not regenerate the password.' };
  }
}

export async function suspendAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('suspend_company', {
    p_company_id: String(formData.get('companyId')),
    p_reason: String(formData.get('reason') || 'non-payment'),
  });
  if (error) logger.error({ err: error }, 'suspend_company failed');
  revalidatePath('/admin/customers');
}

export async function reactivateAction(formData: FormData): Promise<void> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('reactivate_company', {
    p_company_id: String(formData.get('companyId')),
  });
  if (error) logger.error({ err: error }, 'reactivate_company failed');
  revalidatePath('/admin/customers');
}
