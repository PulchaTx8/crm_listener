'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { AppError, ValidationError } from '@/lib/errors';
import { khzFromInput } from '@/lib/frequency';
import {
  clearCompanyThumb,
  readCompanyProfile,
  setCompanyThumb,
  updateCompanyProfile,
  type CompanyProfileRecord,
} from '@/services/company-profile';
import {
  issueApiCredential,
  listApiCredentials,
  revokeApiCredential,
  type ApiCredentialRow,
} from '@/services/api-credentials';
import { disableIntegration, getIntegration, upsertIntegration } from '@/services/integrations';
import type { IntegrationRow } from '@/services/integrations';
import { getWidgetInstallation, upsertWidgetInstallation } from '@/services/widget-installations';
import type { WidgetInstallationRow } from '@/services/widget-installations';
import { parseOrigins } from '@/lib/widget/origins';

// ---------------------------------------------------------------------------
// Not one revalidatePath in this file, deliberately -- the rule every record
// screen in this project carries. A fresh render of /admin/stations re-reads the
// selected group's Stations, their profiles, their keys and their integrations,
// and hands the operator back a redrawn screen with the record they were editing
// closed. The grid patches its own rows instead (src/lib/row-patch.ts).
//
// WHICH IS WHY EVERY ACTION HERE RETURNS WHAT IT WROTE, and why that is not a
// convenience. page.tsx reads each Station's profile, keys, integration and
// widget installation ONCE, before any record is opened, and the dialog renders
// from that snapshot; nothing re-reads it. So an action that returned only
// `status: 'saved'` would leave the screen showing the values from before the
// write -- and because the dialog mounts each tab only while it is selected
// (`{tab === 'data' && ...}`) and the Dialog renders its children only while
// open, merely switching tabs or reopening the record was enough to remount a
// form from that stale snapshot and make a save that HAD landed look lost. That
// was reported from the hosted console on 2026-08-10, with the database's own
// audit_logs showing the write present and the screen denying it. The returned
// record goes to stations-grid.tsx, which holds these four snapshots in state
// and patches them; see its `patch` helpers.
//
// THAT IS A CHANGE FROM THE SCREEN THIS REPLACES. admin/integrations/actions.ts
// called revalidatePath and then router.refresh(), which was right there: that
// screen was a list of cards with no record over it, so a re-render lost
// nothing. Here it would close the dialog the form lives in.
//
// Everything below is gated in the DATABASE on is_platform_admin() -- 0130,
// 0149, 0153 and 0155 each check it before doing any work -- so these actions
// carry no gate of their own.
// ---------------------------------------------------------------------------

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

/** One line of the Stations list, as both the page and these actions build it. */
export interface StationRow {
  id: string;
  name: string;
  status: string;
  suspensionReason: string | null;
  createdAt: string;
  organizationId: string;
}

export interface StationActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

export interface StationProfileState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * The record as the database now holds it, so the screen above this form can
   * replace the snapshot it was rendered from. `undefined` means the write
   * landed and only the read-back failed -- the contract `IntegrationState.row`
   * already carries, and `readStationProfile`'s comment gives the reason.
   */
  profile?: CompanyProfileRecord;
}

/**
 * A failed read-back is not a failed save, the rule `readIntegration` states
 * for this same file. The write already succeeded, so this reports what it
 * could not refresh rather than telling the operator their change did not land.
 */
async function readStationProfile(
  companyId: string,
  token: string,
): Promise<CompanyProfileRecord | undefined> {
  try {
    return await readCompanyProfile(companyId, token);
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not read back the station profile');
    return undefined;
  }
}

/**
 * Saves the Station's record and settles its picture, in that order.
 *
 * TWO CALLS, NOT ONE, and the database is what makes it two:
 * update_company_profile writes every field it takes on every call, so a picture
 * on that list would be cleared by the next ordinary save. 0144 and 0145 each
 * document the defect; 0153's set_company_thumb is the answer to it.
 *
 * The picture is settled AFTER the fields, so a validation failure on the record
 * does not leave an upload behind that no column points at.
 *
 * Then the record is READ BACK and returned, for the reason this file's header
 * gives: nothing else re-reads it, so this is what stops the screen showing the
 * values from before the save.
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
        contactEmail: text('contactEmail'),
        contactPhone: text('contactPhone'),
        websiteUrl: text('websiteUrl'),
        instagramUrl: text('instagramUrl'),
        facebookUrl: text('facebookUrl'),
        youtubeUrl: text('youtubeUrl'),
        tagline: text('tagline'),
        description: text('description'),
        legalName: text('legalName'),
        taxId: text('taxId'),
        municipalRegistration: text('municipalRegistration'),
        fiscalEmail: text('fiscalEmail'),
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
    } else if (file instanceof File && file.size > 0) {
      await setCompanyThumb({ companyId, file }, token);
    }

    // AFTER the picture is settled, not before: this is the one read that tells
    // the screen what it now holds, and a thumb_url read a moment too early
    // would send back the address the save had just replaced.
    return { status: 'saved', profile: await readStationProfile(companyId, token) };
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'save station profile failed');
    return {
      status: 'error',
      message: cause instanceof ValidationError ? cause.message : t('couldNotSaveTheStation'),
    };
  }
}

/**
 * Suspend and reactivate, which is what a Station's own lock has always been.
 *
 * DISTINCT FROM BLOCKING A GROUP, and the difference is the point of D5.1: this
 * stops ONE radio, and blocking stops the customer. Reported rather than logged
 * and dropped — a suspension that silently did not happen is the one failure
 * this screen cannot afford.
 */
export async function suspendAction(
  _prev: StationActionState,
  formData: FormData,
): Promise<StationActionState> {
  const t = await getTranslations('admin');
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('suspend_company', {
    p_company_id: String(formData.get('companyId')),
    p_reason: String(formData.get('reason') || 'non-payment'),
  });
  if (error) {
    logger.error({ err: error }, 'suspend_company failed');
    return { status: 'error', message: t('couldNotSuspendThisStation') };
  }
  return { status: 'done' };
}

export async function reactivateAction(
  _prev: StationActionState,
  formData: FormData,
): Promise<StationActionState> {
  const t = await getTranslations('admin');
  const supabase = await createUserClient();
  const { error } = await supabase.rpc('reactivate_company', {
    p_company_id: String(formData.get('companyId')),
  });
  if (error) {
    logger.error({ err: error }, 'reactivate_company failed');
    return { status: 'error', message: t('couldNotReactivateThisStation') };
  }
  return { status: 'done' };
}

export interface IntegrationState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** The integration as it now stands, so the tab redraws without a page render. */
  row?: IntegrationRow | null;
}

/**
 * Connect a Station, or edit the connection it has.
 *
 * One action for both, because `upsert_integration` is one RPC for both: a
 * Station has at most one WhatsApp integration, so "create" and "edit" are the
 * same submission with different prior state.
 *
 * The saved row is READ BACK AND RETURNED where the retiring screen called
 * revalidatePath: this form lives inside a record dialog, and a re-render would
 * close it.
 */
export async function saveIntegrationAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim();

  if (!companyId || !phoneNumberId) {
    return { status: 'error', message: t('aStationAndAPhoneNumberIdAreRequired') };
  }

  try {
    await upsertIntegration({
      companyId,
      phoneNumberId,
      wabaId: String(formData.get('wabaId') ?? '').trim() || null,
      displayPhoneNumber: String(formData.get('displayPhoneNumber') ?? '').trim() || null,
      enabled: formData.get('enabled') === 'on',
    });
  } catch (cause) {
    // AppError carries the message the service already made specific -- for a
    // 23505 that is WHICH of the two unique indexes refused, which is the
    // difference between "another Station has this number" and "this Station
    // already has one". Flattening it here would undo 0130's whole reason for
    // not catching them.
    if (cause instanceof AppError) return { status: 'error', message: cause.message };
    logger.error({ err: cause, companyId }, 'could not save the WhatsApp integration');
    return { status: 'error', message: t('theIntegrationCouldNotBeSaved') };
  }

  return { status: 'done', row: await readIntegration(companyId) };
}

export async function disableIntegrationAction(
  _prev: IntegrationState,
  formData: FormData,
): Promise<IntegrationState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: t('checkTheForm') };

  try {
    await disableIntegration(companyId);
  } catch (cause) {
    if (cause instanceof AppError) return { status: 'error', message: cause.message };
    logger.error({ err: cause, companyId }, 'could not disable the WhatsApp integration');
    return { status: 'error', message: t('theIntegrationCouldNotBeDisabled') };
  }

  return { status: 'done', row: await readIntegration(companyId) };
}

/**
 * A failed read-back is not a failed save. The write already succeeded, so this
 * reports what it could not refresh rather than telling the operator their
 * change did not land — the worst case is a tab that shows the old values until
 * the next navigation.
 */
async function readIntegration(companyId: string): Promise<IntegrationRow | null | undefined> {
  try {
    return await getIntegration(companyId);
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not read back the integration');
    return undefined;
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

export interface WidgetInstallationState {
  status: 'idle' | 'saved' | 'error';
  message?: string;
  /**
   * `undefined` means the write landed and only the read-back failed -- the
   * same distinction `IntegrationState.row` carries, for the same reason
   * (`readIntegration`'s comment below `readWidgetInstallation`'s twin).
   * `null` never appears here: a successful save always leaves a row behind.
   */
  installation?: WidgetInstallationRow | null;
}

/**
 * A failed read-back is not a failed save, the rule `readIntegration` already
 * states for this same file: the write already succeeded, so this reports
 * what it could not refresh rather than telling the operator their change did
 * not land.
 */
async function readWidgetInstallation(
  companyId: string,
  token: string,
): Promise<WidgetInstallationRow | null | undefined> {
  try {
    return await getWidgetInstallation(companyId, token);
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'could not read back the widget installation');
    return undefined;
  }
}

/**
 * Enable, disable, or edit a Station's widget installation. One action for
 * all three, because `upsert_widget_installation` is one RPC for all three --
 * the same reasoning `saveIntegrationAction` gives for its own single action.
 *
 * ORIGINS ARE PARSED HERE, SERVER-SIDE, even though `parseOrigins` carries no
 * `server-only` guard and could run in the tab directly. The write boundary is
 * this action, not the browser, and the CHECK at 0159 is already the backstop
 * of record for the same grammar -- adding a client-only check here would
 * mean trusting JavaScript an operator's browser might not run, for the one
 * value that decides which sites may frame this Station's widget.
 */
export async function saveWidgetInstallationAction(
  _prev: WidgetInstallationState,
  formData: FormData,
): Promise<WidgetInstallationState> {
  const t = await getTranslations('admin');
  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) return { status: 'error', message: t('checkTheForm') };

  const enabled = formData.get('enabled') === 'on';
  const parsed = parseOrigins(String(formData.get('allowedOrigins') ?? ''));
  if (!parsed.ok) {
    return { status: 'error', message: t('thatOriginIsNotValid', { origin: parsed.bad }) };
  }

  const token = await requireAccessToken();

  try {
    await upsertWidgetInstallation({ companyId, enabled, allowedOrigins: parsed.origins }, token);
  } catch (cause) {
    logger.error({ err: cause, companyId }, 'save widget installation failed');
    return {
      status: 'error',
      message: cause instanceof ValidationError ? cause.message : t('couldNotSaveTheWidget'),
    };
  }

  return { status: 'saved', installation: await readWidgetInstallation(companyId, token) };
}
