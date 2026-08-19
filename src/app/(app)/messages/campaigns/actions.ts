'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { UnauthorizedError } from '@/lib/errors';
import type { Json } from '@/lib/supabase/database.types';
import { sendListReachRequestSchema } from '@/schemas/send-lists';
import { createCampaignSchema, cancelCampaignSchema, testSendCampaignSchema } from '@/schemas/campaigns';
import {
  eligibleMemberIds,
  listReach,
  resolveSendListAudience,
  SendListResolutionCappedError,
} from '@/services/send-lists';
import type { ListReach } from '@/services/send-lists';
import { getMembersForCampaign } from '@/services/members';
import {
  buildEmailVariableValues,
  buildWhatsAppVariableValues,
  cancelCampaign,
  createCampaign,
  extractEmailVariables,
  listCampaignTemplateOptions,
  loadCampaignTemplate,
  readStationName,
  testSendCampaign,
} from '@/services/campaigns';
import type { CampaignTemplateOption } from '@/services/campaigns';
import { describeCampaignWriteError } from '../errors';
import { describeResolutionCap } from '../lists/actions';

async function requireAccessToken(): Promise<string> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) redirect('/login');
  return token;
}

// ---------------------------------------------------------------------------
// The reach number the dialog shows before Send is ever enabled -- the SAME
// listReach (services/send-lists.ts) the Lists screen itself calls, so the
// number here and the one on /messages/lists for the same list can never
// disagree (Task 7 addendum §2's own warning against a second resolver).
// ---------------------------------------------------------------------------

export type GetCampaignReachState =
  | { status: 'ok'; reach: ListReach }
  | { status: 'error'; message: string };

export async function getCampaignReachAction(listId: string): Promise<GetCampaignReachState> {
  const parsed = sendListReachRequestSchema.safeParse({ listId });
  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatSendListCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    const reach = await listReach(parsed.data.listId, token);
    return { status: 'ok', reach };
  } catch (cause) {
    if (cause instanceof SendListResolutionCappedError) {
      return { status: 'error', message: await describeResolutionCap(cause) };
    }
    logger.error({ err: cause, listId: parsed.data.listId }, 'could not compute reach for a campaign candidate list');
    return { status: 'error', message: (await getTranslations('templates'))('reachCouldNotLoad') };
  }
}

// ---------------------------------------------------------------------------
// The template dropdown, re-fetched whenever the dialog's list (its Station)
// or channel changes -- never a call to listTemplates (services/templates.ts),
// which also reads the ten system texts and every purpose this screen has no
// use for; listCampaignTemplateOptions (services/campaigns.ts) is the
// narrower read this dialog actually needs.
// ---------------------------------------------------------------------------

export type ListCampaignTemplatesState =
  | { status: 'ok'; templates: CampaignTemplateOption[] }
  | { status: 'error'; message: string };

export async function listCampaignTemplatesAction(
  companyId: string,
  channel: 'WHATSAPP' | 'EMAIL',
): Promise<ListCampaignTemplatesState> {
  const token = await requireAccessToken();

  try {
    const templates = await listCampaignTemplateOptions(companyId, channel, token);
    return { status: 'ok', templates };
  } catch (cause) {
    logger.error({ err: cause, companyId, channel }, 'could not list marketing templates for a campaign');
    return { status: 'error', message: (await getTranslations('templates'))('campaignTemplatesCouldNotLoad') };
  }
}

// ---------------------------------------------------------------------------
// create_campaign's own four-step resolution (Task 7 addendum §1): resolve
// the list's people, keep only who is eligible on this channel, read each
// kept listener's address and build their variable values, then call the
// door. Every step below reuses a function this file's own imports name --
// nothing here re-implements a filter, a permission check, or a resolver.
// ---------------------------------------------------------------------------

export type CreateCampaignState =
  | { status: 'idle' }
  | { status: 'created'; campaignId: string }
  | { status: 'error'; message: string };

export async function createCampaignAction(
  _prev: CreateCampaignState,
  formData: FormData,
): Promise<CreateCampaignState> {
  const parsed = createCampaignSchema.safeParse({
    listId: formData.get('listId'),
    channel: formData.get('channel'),
    templateId: formData.get('templateId'),
  });
  if (!parsed.success) {
    return { status: 'error', message: (await getTranslations('templates'))('couldNotSave') };
  }

  const token = await requireAccessToken();
  const t = await getTranslations('templates');

  try {
    // 1. The list's people, through the exact resolver listReach itself uses
    // (peopleForList, wrapped as resolveSendListAudience) -- see that
    // function's own header for why this is not a second resolution path.
    const audience = await resolveSendListAudience(parsed.data.listId, token);
    if (audience.memberIds.length === 0) {
      return { status: 'error', message: t('campaignListHasNoPeople') };
    }

    // 2. Kept only who is eligible on this channel (members_marketing_eligible_bulk,
    // 0235) -- a 42501 here means this caller lacks members.view (or the
    // owner, or the platform admin) at this Station, which is a REFUSAL, not
    // an audience of zero; eligibleMemberIds' own header explains why it
    // throws rather than silently narrowing.
    let eligible: string[];
    try {
      eligible = await eligibleMemberIds(audience.memberIds, audience.companyId, parsed.data.channel, token);
    } catch (cause) {
      if (cause instanceof UnauthorizedError) {
        return { status: 'error', message: t('campaignEligibilityNotPermitted') };
      }
      throw cause;
    }

    if (eligible.length === 0) {
      // NAMES THE REASON, not the symptom (Task 7 brief's own words): the
      // audience is not "zero", it is "nobody has consented yet" (WHATSAPP,
      // 29c's D1 opt-in) or "nobody left who may still be written to"
      // (EMAIL -- everybody blocked or unsubscribed).
      return {
        status: 'error',
        message: parsed.data.channel === 'WHATSAPP' ? t('campaignZeroReachWhatsapp') : t('campaignZeroReachEmail'),
      };
    }

    // 3-4. The template's own shape, each kept listener's address and their
    // variable values -- resolved here, at creation, per Task 7 addendum §3,
    // rather than left for the drain to discover a gap in later.
    const template = await loadCampaignTemplate(
      parsed.data.templateId,
      audience.companyId,
      parsed.data.channel,
      token,
    );
    const [members, stationName] = await Promise.all([
      getMembersForCampaign(eligible, token),
      readStationName(audience.companyId, token),
    ]);

    const addresses: Record<string, string> = {};
    const variables: Record<string, Json> = {};

    if (parsed.data.channel === 'WHATSAPP') {
      for (const memberId of eligible) {
        const detail = members.get(memberId);
        if (detail?.phoneNormalized) addresses[memberId] = detail.phoneNormalized;
        variables[memberId] = buildWhatsAppVariableValues(
          template.variables,
          detail ?? { fullName: null, city: null },
          stationName,
        );
      }
    } else {
      const usedVariables = extractEmailVariables(template.body, template.subject ?? '');
      for (const memberId of eligible) {
        const detail = members.get(memberId);
        if (detail?.emailNormalized) addresses[memberId] = detail.emailNormalized;
        variables[memberId] = buildEmailVariableValues(
          usedVariables,
          detail ?? { fullName: null, city: null },
          stationName,
        );
      }
    }

    const campaignId = await createCampaign(
      {
        companyId: audience.companyId,
        listId: parsed.data.listId,
        channel: parsed.data.channel,
        templateId: parsed.data.templateId,
        memberIds: eligible,
        addresses,
        variables,
      },
      token,
    );

    revalidatePath('/messages/campaigns');
    return { status: 'created', campaignId };
  } catch (cause) {
    // resolveSendListAudience (step 1) can throw this for a LIVING list that
    // has grown past RESOLVE_CAP/RESOLVE_PAGE_CAP since the dialog's own
    // reach check ran a moment earlier -- the identical race
    // getCampaignReachAction above already answers with the same two
    // sentences, so a create hitting it gets the specific reason too, not
    // describeCampaignWriteError's generic fallback.
    if (cause instanceof SendListResolutionCappedError) {
      return { status: 'error', message: await describeResolutionCap(cause) };
    }
    logger.error({ err: cause, listId: parsed.data.listId, channel: parsed.data.channel }, 'create a campaign failed');
    return { status: 'error', message: describeCampaignWriteError(cause, t, 'actionCreateACampaign') };
  }
}

// ---------------------------------------------------------------------------
// cancel_campaign. A form (campaignId hidden, reason optional), the same
// useActionState shape renameSendListAction/deleteSendListAction already
// establish for this section's own single-field writes.
// ---------------------------------------------------------------------------

export type CancelCampaignState =
  | { status: 'idle' }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export async function cancelCampaignAction(
  _prev: CancelCampaignState,
  formData: FormData,
): Promise<CancelCampaignState> {
  const parsed = cancelCampaignSchema.safeParse({
    campaignId: formData.get('campaignId'),
    reason: formData.get('reason') ?? undefined,
  });
  if (!parsed.success) {
    return {
      status: 'error',
      message: (await getTranslations('templates'))('thatCampaignCouldNotBeIdentified'),
    };
  }

  const token = await requireAccessToken();

  try {
    await cancelCampaign(parsed.data, token);
    revalidatePath('/messages/campaigns');
    return { status: 'cancelled' };
  } catch (cause) {
    logger.error({ err: cause, campaignId: parsed.data.campaignId }, 'cancel a campaign failed');
    return {
      status: 'error',
      message: describeCampaignWriteError(cause, await getTranslations('templates'), 'actionCancelACampaign'),
    };
  }
}

// ---------------------------------------------------------------------------
// The test send (Task 7 brief, Step 3; addendum §4). Assembles ONE message
// with a sample listener's own variables and sends it through the same
// provider a real campaign uses, to an address the OPERATOR typed --
// creating no recipient row, no campaign, no history entry, and minting no
// unsubscribe token (testSendCampaign's own header, services/campaigns.ts,
// says why for each).
// ---------------------------------------------------------------------------

export type TestSendCampaignState =
  | { status: 'idle' }
  | { status: 'sent' }
  | { status: 'error'; message: string };

export async function testSendCampaignAction(
  _prev: TestSendCampaignState,
  formData: FormData,
): Promise<TestSendCampaignState> {
  const rawChannel = formData.get('channel');
  const parsed = testSendCampaignSchema.safeParse({
    listId: formData.get('listId'),
    channel: rawChannel,
    templateId: formData.get('templateId'),
    destination: formData.get('destination'),
  });
  if (!parsed.success) {
    const t = await getTranslations('templates');
    return {
      status: 'error',
      message:
        rawChannel === 'EMAIL' ? t('testSendInvalidEmailDestination') : t('testSendInvalidWhatsappDestination'),
    };
  }

  const token = await requireAccessToken();
  const t = await getTranslations('templates');

  try {
    const audience = await resolveSendListAudience(parsed.data.listId, token);
    const sampleMemberId = audience.memberIds[0];
    if (!sampleMemberId) {
      return { status: 'error', message: t('testSendListHasNobody') };
    }

    const template = await loadCampaignTemplate(
      parsed.data.templateId,
      audience.companyId,
      parsed.data.channel,
      token,
    );
    const members = await getMembersForCampaign([sampleMemberId], token);
    const sampleMember = members.get(sampleMemberId) ?? { fullName: null, city: null };

    // WHATSAPP's own address shape (phone_normalized, digits only) -- the
    // operator may have typed spaces, a plus sign or punctuation, and this
    // is the same normalisation members.phone_normalized itself applies
    // (normalize_phone, 0031), so the destination a test send actually
    // dials agrees with what a real campaign would have stored.
    const destination =
      parsed.data.channel === 'WHATSAPP'
        ? parsed.data.destination.replace(/[^0-9]/g, '')
        : parsed.data.destination;

    const outcome = await testSendCampaign(
      { companyId: audience.companyId, channel: parsed.data.channel, template, sampleMember, destination },
      token,
    );

    if (outcome.ok) return { status: 'sent' };
    return { status: 'error', message: t('testSendFailed', { code: outcome.code }) };
  } catch (cause) {
    if (cause instanceof SendListResolutionCappedError) {
      return { status: 'error', message: await describeResolutionCap(cause) };
    }
    logger.error({ err: cause, listId: parsed.data.listId, channel: parsed.data.channel }, 'a campaign test send failed');
    return { status: 'error', message: describeCampaignWriteError(cause, t, 'actionSendATestMessage') };
  }
}
