'use server';

import { getTranslations } from 'next-intl/server';

import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { provisionCustomerSchema } from '@/schemas/provisioning';
import { provisionCustomer, regenerateProvisionalPassword } from '@/services/provisioning';
import { logger } from '@/lib/logger';
import { ValidationError } from '@/lib/errors';
import { khzFromInput } from '@/lib/frequency';
import {
  clearCompanyThumb,
  setCompanyThumb,
  updateCompanyProfile,
} from '@/services/company-profile';
import {
  issueApiCredential,
  listApiCredentials,
  revokeApiCredential,
  type ApiCredentialRow,
} from '@/services/api-credentials';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately (Block 3c) — the same rule
// members/actions.ts, inventory/actions.ts, roles/actions.ts and
// team/actions.ts carry.
//
// Every write below is invoked from the customer record dialog, and
// revalidatePath returns a fresh render of /admin/customers alongside the
// action's result, re-running that screen's keyset query and losing the
// admin's place in it. The grid patches its own row instead
// (src/lib/row-patch.ts).
//
// The redirects went with them, and they were load-bearing: suspend,
// reactivate and addCompany each had to redirect to the bare path to clear a
// stale ?stationError=1 from the address bar, because that query parameter was
// the only place a failure could be reported from a plain <form action={...}>
// with no state of its own. All three return their outcome now, so there is no
// parameter to clear and nothing to redirect for.
// ---------------------------------------------------------------------------

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
  /** Present when a provisioning created a Station, so the grid can show its row. */
  company?: CustomerRow;
}

/** One line of the customers list, as both the page and the actions build it. */
export interface CustomerRow {
  id: string;
  name: string;
  status: string;
  suspensionReason: string | null;
  createdAt: string;
  organizationId: string;
  owner: { userId: string; email: string } | null;
}

export interface CustomerActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** The Station this call created, for addCompanyAction only. */
  company?: CustomerRow;
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
    return {
      status: 'revealed',
      email: parsed.data.ownerEmail,
      password: result.provisionalPassword,
      company: await readCompanyRow(result.companyId, {
        userId: result.userId,
        email: parsed.data.ownerEmail,
      }),
    };
  } catch (cause) {
    logger.error({ err: cause }, 'provisioning failed');
    return { status: 'error', message: 'Provisioning failed and was rolled back.' };
  }
}

/**
 * Reads back the row the grid is about to show, rather than assembling it from
 * what was submitted: `created_at` is the database's own now(), `status` its
 * default, and the name is stored trimmed. A failure here is deliberately not
 * an error for the caller — the Station exists, and the worst case is that the
 * list does not gain its line until the next navigation, which is a far smaller
 * loss than a provisional password the operator never got to read.
 */
async function readCompanyRow(
  companyId: string,
  owner: { userId: string; email: string } | null,
): Promise<CustomerRow | undefined> {
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, status, suspension_reason, created_at, organization_id')
    .eq('id', companyId)
    .single();
  if (error || !data) {
    logger.error({ err: error, companyId }, 'could not read back the Station that was just created');
    return undefined;
  }
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    suspensionReason: data.suspension_reason,
    createdAt: data.created_at,
    organizationId: data.organization_id,
    owner,
  };
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
    return { status: 'revealed', email, password };
  } catch (cause) {
    logger.error({ err: cause }, 'provisional password regeneration failed');
    return { status: 'error', message: 'Could not regenerate the password.' };
  }
}

/**
 * Both status writes are platform-admin only (0007), and everyone who reaches
 * this console already is one, so a refusal here means the row moved under the
 * admin — archived, or suspended by somebody else in another tab — rather than
 * something adversarial. Reported rather than logged and dropped: a suspension
 * that silently did not happen is the one failure this screen cannot afford,
 * since the whole point of the button is that the customer loses access.
 */
export async function suspendAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('suspend_company', {
    p_company_id: String(formData.get('companyId')),
    p_reason: String(formData.get('reason') || 'non-payment'),
  });
  if (error) {
    logger.error({ err: error }, 'suspend_company failed');
    return { status: 'error', message: 'Could not suspend this Station. Try again.' };
  }
  return { status: 'done' };
}

export async function reactivateAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('reactivate_company', {
    p_company_id: String(formData.get('companyId')),
  });
  if (error) {
    logger.error({ err: error }, 'reactivate_company failed');
    return { status: 'error', message: 'Could not reactivate this Station. Try again.' };
  }
  return { status: 'done' };
}

/**
 * Adds a second (or third...) Station to an existing Organization. add_company
 * (0017) is platform-admin only — everyone who reaches this console already is
 * one, so a denial here usually means ordinary bad input (a whitespace-only
 * name passes the form's `required` but still trips the RPC's own "company
 * name is required") rather than something adversarial. The message is shown in
 * the record dialog the form now lives in, which is where the ?stationError=1
 * round trip went.
 *
 * The row comes back without an owner: the new Station belongs to the
 * Organization whose record this was added from, so the caller already holds
 * the owner it should carry and attaches it there rather than this action
 * reading a profile it has no other use for.
 */
export async function addCompanyAction(
  _prev: CustomerActionState,
  formData: FormData,
): Promise<CustomerActionState> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('add_company', {
    p_organization_id: String(formData.get('organizationId')),
    p_name: String(formData.get('name')),
    p_timezone: String(formData.get('timezone') || 'America/Sao_Paulo'),
  });
  if (error) {
    logger.error({ err: error }, 'add_company failed');
    return {
      status: 'error',
      message: (await getTranslations('admin'))('couldNotAddTheStation'),
    };
  }
  return {
    status: 'done',
    company: typeof data === 'string' ? await readCompanyRow(data, null) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Block 15. The Station's own record, and its machine keys.
//
// Everything below is gated in the DATABASE on is_platform_admin() -- 0153 and
// 0149 each check it before doing any work -- so these actions carry no gate of
// their own. That is the same division every other action in this file follows.
// ---------------------------------------------------------------------------

export interface StationProfileState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /** What was stored, so the form can show the picture it now has. */
  thumbUrl?: string | null;
}

/**
 * Saves the Station's record and settles its picture, in that order.
 *
 * TWO CALLS, NOT ONE, and the database is what makes it two:
 * update_company_profile writes every field it takes on every call, so a picture
 * on that list would be cleared by the next ordinary save. 0144 and 0145 each
 * document the defect; 0153's set_company_thumb is this block's answer to it.
 *
 * The picture is settled AFTER the fields, so a validation failure on the record
 * does not leave an upload behind that no column points at.
 */
export async function saveStationProfileAction(
  _prev: StationProfileState,
  formData: FormData,
): Promise<StationProfileState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: t('checkTheForm') };

  const band = String(formData.get('broadcastBand') ?? '');
  const parsedBand = band === 'FM' || band === 'AM' || band === 'WEB' ? band : null;

  const coordinate = (name: string): number | null => {
    const raw = String(formData.get(name) ?? '').trim().replace(',', '.');
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const text = (name: string): string | null => String(formData.get(name) ?? '').trim() || null;

  const token = await requireAccessToken();

  try {
    await updateCompanyProfile(
      {
        companyId,
        addressLine: text('addressLine'),
        addressNumber: text('addressNumber'),
        addressComplement: text('addressComplement'),
        neighbourhood: text('neighbourhood'),
        city: text('city'),
        state: text('state'),
        postalCode: text('postalCode'),
        broadcastBand: parsedBand,
        frequencyKhz: khzFromInput(parsedBand, String(formData.get('frequency') ?? '')),
        latitude: coordinate('latitude'),
        longitude: coordinate('longitude'),
      },
      token,
    );

    // The control posts `thumbCleared` so that "left alone" and "taken away" are
    // distinguishable; without it an empty file input and a deliberate removal
    // look identical, and every save would clear the picture or none ever would.
    const cleared = formData.get('thumbCleared') === 'on';
    const file = formData.get('thumb');

    if (cleared) {
      await clearCompanyThumb(companyId, token);
      return { status: 'saved', thumbUrl: null };
    }

    if (file instanceof File && file.size > 0) {
      const url = await setCompanyThumb({ companyId, file }, token);
      return { status: 'saved', thumbUrl: url };
    }

    return { status: 'saved' };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'save station profile failed');
    return {
      status: 'error',
      message: cause instanceof ValidationError ? cause.message : t('couldNotSaveTheStation'),
    };
  }
}

export interface ApiKeyState {
  status: 'idle' | 'issued' | 'revoked' | 'error';
  message?: string;
  /** Shown ONCE, and never again: the database holds only its SHA-256. */
  secret?: string;
  rows?: ApiCredentialRow[];
}

export async function issueApiKeyAction(
  _prev: ApiKeyState,
  formData: FormData,
): Promise<ApiKeyState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const scopes = formData.getAll('scopes').map(String);
  const expiresAt = String(formData.get('expiresAt') ?? '').trim() || null;

  if (!companyId || !name || scopes.length === 0) {
    return { status: 'error', message: t('aKeyNeedsANameAndAtLeastOneScope') };
  }

  const token = await requireAccessToken();

  try {
    const issued = await issueApiCredential({ companyId, name, scopes, expiresAt }, token);
    return {
      status: 'issued',
      secret: issued.secret,
      rows: await listApiCredentials(companyId, token),
    };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'issue api key failed');
    return {
      status: 'error',
      message: cause instanceof ValidationError ? cause.message : t('couldNotIssueTheKey'),
    };
  }
}

export async function revokeApiKeyAction(
  _prev: ApiKeyState,
  formData: FormData,
): Promise<ApiKeyState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  const credentialId = String(formData.get('credentialId') ?? '');
  if (!companyId || !credentialId) return { status: 'error', message: t('checkTheForm') };

  const token = await requireAccessToken();

  try {
    await revokeApiCredential(credentialId, token);
    return { status: 'revoked', rows: await listApiCredentials(companyId, token) };
  } catch (cause) {
    logger.error({ err: cause, credentialId }, 'revoke api key failed');
    return { status: 'error', message: t('couldNotRevokeTheKey') };
  }
}
