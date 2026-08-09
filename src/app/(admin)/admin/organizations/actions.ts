'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { ValidationError } from '@/lib/errors';
import {
  blockOrganizationSchema,
  provisionOrganizationSchema,
  updateOrganizationSchema,
} from '@/schemas/organizations';
import {
  blockOrganization,
  listOrganizations,
  provisionOrganization,
  unblockOrganization,
  updateOrganization,
} from '@/services/organizations';
import { regenerateProvisionalPassword } from '@/services/provisioning';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately -- the rule members/actions.ts,
// inventory/actions.ts and the retiring customers/actions.ts all carry. Every
// write below is invoked from a record dialog, and revalidatePath would return a
// fresh render of the whole screen alongside the action's result. The grid
// patches its own row instead (src/lib/row-patch.ts).
// ---------------------------------------------------------------------------

/** A Station under a group, as the record's third tab lists them. */
export interface StationBrief {
  id: string;
  name: string;
  status: string;
}

/**
 * One customer group, with everything its record shows.
 *
 * The whole record, not a summary: the dialog opens from what page.tsx already
 * read, never from a fetch of its own, so anything the dialog can display has to
 * be on this row before it opens.
 */
export interface OrganizationRow {
  id: string;
  name: string;
  legalName: string | null;
  taxId: string | null;
  municipalRegistration: string | null;
  fiscalEmail: string | null;
  billingEntity: 'ORGANIZATION' | 'STATIONS';
  addressLine: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  neighbourhood: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  suspendedAt: string | null;
  suspensionReason: string | null;
  createdAt: string;
  stationCount: number;
  owner: { userId: string; email: string } | null;
  stations: StationBrief[];
}

export interface OrganizationActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** The row as it now stands, so the grid can redraw one line. */
  organization?: OrganizationRow;
  /** addStationAction only: the Station that was created, for the caller to append. */
  station?: StationBrief;
}

/**
 * The provisional password travels through the action result, never through a
 * redirect URL: a query string reaches browser history and every proxy access
 * log in front of the app. It is shown once, on screen, and stored nowhere.
 */
export interface CredentialState {
  status: 'idle' | 'revealed' | 'error';
  email?: string;
  password?: string;
  message?: string;
  /** Present when a provisioning created a group, so the grid can show its row. */
  organization?: OrganizationRow;
}

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/**
 * Reads the group back rather than assembling it from what was submitted:
 * `created_at` is the database's own now(), the name is stored trimmed, and the
 * Station count is a fact about the database. Reading the whole list to find one
 * row is affordable for the same reason this screen has no paging — the platform
 * has tens of groups.
 */
async function readOrganizationRow(organizationId: string): Promise<OrganizationRow | undefined> {
  try {
    const token = await requireAccessToken();
    const found = (await listOrganizations(token)).find((row) => row.id === organizationId);
    if (!found) return undefined;
    // A group that was just created has no Stations, and one that was just
    // edited has whatever it had — which the caller already holds and merges.
    return { ...found, stations: [] };
  } catch (cause) {
    logger.error({ err: cause, organizationId }, 'could not read back the organization');
    return undefined;
  }
}

/**
 * Creates the group and its owner, and NO Station.
 *
 * A failure here is deliberately not fatal to the password: if the read-back
 * fails the group still exists and the password is still shown, and the list
 * simply does not gain its line until the next navigation — a far smaller loss
 * than a provisional password the operator never got to read.
 */
export async function provisionOrganizationAction(
  _prev: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const t = await getTranslations('admin');
  const parsed = provisionOrganizationSchema.safeParse({
    organizationName: formData.get('organizationName'),
    ownerEmail: formData.get('ownerEmail'),
    ownerName: formData.get('ownerName') || undefined,
  });

  if (!parsed.success) return { status: 'error', message: t('checkTheForm') };

  const token = await requireAccessToken();

  try {
    const result = await provisionOrganization(parsed.data, token);
    return {
      status: 'revealed',
      email: parsed.data.ownerEmail,
      password: result.provisionalPassword,
      organization: await readOrganizationRow(result.organizationId),
    };
  } catch (cause) {
    logger.error({ err: cause }, 'provisioning failed');
    return { status: 'error', message: t('provisioningFailedAndWasRolledBack') };
  }
}

export async function regenerateAction(
  _prev: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const t = await getTranslations('admin');
  const userId = String(formData.get('userId') ?? '');
  const email = String(formData.get('email') ?? '');
  if (!userId) return { status: 'error', message: t('checkTheForm') };

  const token = await requireAccessToken();

  try {
    const password = await regenerateProvisionalPassword(userId, token);
    return { status: 'revealed', email, password };
  } catch (cause) {
    logger.error({ err: cause }, 'provisional password regeneration failed');
    return { status: 'error', message: t('couldNotRegenerateThePassword') };
  }
}

/**
 * Saves the group's record wholesale.
 *
 * Every field is sent on every call, because update_organization blanks what it
 * is not given — the convention update_prize, update_song and
 * update_company_profile all follow, so a partial submission has one meaning
 * rather than a per-field guess.
 */
export async function saveOrganizationAction(
  _prev: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const t = await getTranslations('admin');
  const text = (name: string): string | undefined =>
    String(formData.get(name) ?? '').trim() || undefined;

  const entity = String(formData.get('billingEntity') ?? '');
  const parsed = updateOrganizationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    name: formData.get('name'),
    legalName: text('legalName'),
    taxId: text('taxId'),
    municipalRegistration: text('municipalRegistration'),
    fiscalEmail: text('fiscalEmail'),
    billingEntity: entity === 'ORGANIZATION' ? 'ORGANIZATION' : 'STATIONS',
    addressLine: text('addressLine'),
    addressNumber: text('addressNumber'),
    addressComplement: text('addressComplement'),
    neighbourhood: text('neighbourhood'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postalCode'),
  });

  if (!parsed.success) return { status: 'error', message: t('checkTheForm') };

  const token = await requireAccessToken();

  try {
    await updateOrganization(parsed.data, token);
    return { status: 'done', organization: await readOrganizationRow(parsed.data.organizationId) };
  } catch (cause) {
    logger.error({ err: cause }, 'update_organization failed');
    return {
      status: 'error',
      message: cause instanceof ValidationError ? cause.message : t('couldNotSaveTheOrganization'),
    };
  }
}

/**
 * Shuts a whole customer down, and reports it rather than logging and dropping
 * it: a block that silently did not happen is the one failure this screen cannot
 * afford, because the whole point of the button is that the customer loses
 * access.
 */
export async function blockAction(
  _prev: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const t = await getTranslations('admin');
  const parsed = blockOrganizationSchema.safeParse({
    organizationId: formData.get('organizationId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { status: 'error', message: t('aBlockNeedsAReason') };

  const token = await requireAccessToken();

  try {
    await blockOrganization(parsed.data.organizationId, parsed.data.reason, token);
    return { status: 'done' };
  } catch (cause) {
    logger.error({ err: cause }, 'block_organization failed');
    return { status: 'error', message: t('couldNotBlockThisCustomer') };
  }
}

export async function unblockAction(
  _prev: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const t = await getTranslations('admin');
  const organizationId = String(formData.get('organizationId') ?? '');
  if (!organizationId) return { status: 'error', message: t('checkTheForm') };

  const token = await requireAccessToken();

  try {
    await unblockOrganization(organizationId, token);
    return { status: 'done' };
  } catch (cause) {
    logger.error({ err: cause }, 'unblock_organization failed');
    return { status: 'error', message: t('couldNotReleaseThisCustomer') };
  }
}

/**
 * Adds a Station to an existing group. add_company (0017) is platform-admin
 * only, and everyone who reaches this console already is one — so a denial here
 * is ordinary bad input (a whitespace-only name passes the form's `required` and
 * still trips the RPC's own check) rather than something adversarial.
 */
export async function addStationAction(
  _prev: OrganizationActionState,
  formData: FormData,
): Promise<OrganizationActionState> {
  const t = await getTranslations('admin');
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc('add_company', {
    p_organization_id: String(formData.get('organizationId')),
    p_name: String(formData.get('name')),
    p_timezone: String(formData.get('timezone') || 'America/Sao_Paulo'),
  });
  if (error) {
    logger.error({ err: error }, 'add_company failed');
    return { status: 'error', message: t('couldNotAddTheStation') };
  }

  const { data: created, error: readError } = await supabase
    .from('companies')
    .select('id, name, status')
    .eq('id', String(data))
    .single();

  if (readError || !created) {
    logger.error({ err: readError }, 'could not read back the Station that was just created');
    return { status: 'done' };
  }

  // Only the new Station travels back, because it is the only thing that
  // changed; the caller appends it to the group it already holds. A partial
  // OrganizationRow here would be a shape that claims to be a whole record and
  // is not.
  return {
    status: 'done',
    station: { id: created.id, name: created.name, status: created.status },
  };
}
