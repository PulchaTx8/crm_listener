'use server';

import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createUserClient } from '@/lib/supabase/user-client';
import { logger } from '@/lib/logger';
import { UnauthorizedError } from '@/lib/errors';
import { InMemoryRateLimiter } from '@/lib/rate-limit';
import type { Json } from '@/lib/supabase/database.types';
import { sendListReachRequestSchema } from '@/schemas/send-lists';
import { createCampaignSchema, cancelCampaignSchema, testSendCampaignSchema } from '@/schemas/campaigns';
import {
  eligibleMemberIds,
  listReach,
  readSendListStation,
  resolveSendListAudience,
  searchSendLists,
  SendListResolutionCappedError,
} from '@/services/send-lists';
import type { ListReach } from '@/services/send-lists';
import { listCompanyAccess } from '../../inventory/station-access';
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
  recordCampaignTestSend,
  testSendCampaign,
  UnresolvableEmailPlaceholderError,
} from '@/services/campaigns';
import type { CampaignTemplateOption } from '@/services/campaigns';
import { describeCampaignWriteError, describeCancelCampaignError } from '../errors';
import { describeResolutionCap } from '../lists/actions';

/**
 * Fix round 1, F2. A test send spends real provider traffic -- exactly the
 * concern deezer-actions.ts' own InMemoryRateLimiter exists for, and the
 * only rate limiter this codebase has that a Server Action under (app) can
 * reach directly: PostgresRateLimiter (@/lib/rate-limit) requires a
 * service_role client, which src/lib/supabase/service-client.ts's own
 * header says must never be built inside a user request -- the identical
 * boundary campaign_whatsapp_sender's own header (0248) already states for
 * this same screen. Module scope, so it survives between requests within
 * one instance -- with `output: 'standalone'` there may be several, each
 * with its own counter, the same disclosed-rather-than-pretended-away gap
 * deezer-actions.ts' own comment names for itself.
 */
const testSendLimiter = new InMemoryRateLimiter();
const TEST_SENDS_PER_MINUTE = 10;

async function requireAccessToken(): Promise<string> {
  return (await requireSession()).token;
}

/**
 * Fix round 1, F2. The pair requireAccessToken alone never carried: a
 * caller id, for the test send's own rate-limit key (below) -- the same
 * shape deezer-actions.ts' own requireSession returns for the identical
 * reason, keyed by Station AND person so one operator cannot spend a whole
 * Station's budget alone.
 */
async function requireSession(): Promise<{ userId: string; token: string }> {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session) redirect('/login');
  return { userId: session.user.id, token: session.access_token };
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
// Fix round 1, F3. The list picker's own <select> is built from page.tsx's
// first SEND_LIST_PAGE_SIZE (50) lists, newest first -- an Organization with
// more can never reach an OLDER list through it. This is the way back: a
// name search over every list messaging.view admits, unbounded by recency.
// ---------------------------------------------------------------------------

export interface CampaignListSearchOption {
  id: string;
  name: string;
  companyId: string;
  companyName: string;
}

export type SearchCampaignListsState =
  | { status: 'ok'; lists: CampaignListSearchOption[] }
  | { status: 'error'; message: string };

/**
 * searchSendLists (services/send-lists.ts) returns id/companyId/name only --
 * it has no Station NAME to give back, since resolving one for every match
 * would mean a second read this function does instead, once, the same shape
 * page.tsx's own listCompanyAccess call already establishes for the initial
 * list. A result whose Station this caller cannot find in that access list
 * (should not happen -- both reads are bounded by the identical messaging.view
 * RLS -- but is not asserted by either read alone) is dropped rather than
 * shown with a fabricated name, the same discipline page.tsx's own listOptions
 * filter already applies to the first page.
 */
export async function searchCampaignListsAction(query: string): Promise<SearchCampaignListsState> {
  const supabase = await createUserClient();
  const token = await requireAccessToken();

  try {
    const [access, results] = await Promise.all([
      listCompanyAccess(supabase, 'messaging.view'),
      searchSendLists(query, token),
    ]);
    const stationNameById = new Map(access.viewable.map((c) => [c.id, c.name]));
    const lists: CampaignListSearchOption[] = results
      .filter((row) => stationNameById.has(row.companyId))
      .map((row) => ({
        id: row.id,
        name: row.name,
        companyId: row.companyId,
        companyName: stationNameById.get(row.companyId)!,
      }));
    return { status: 'ok', lists };
  } catch (cause) {
    logger.error({ err: cause }, 'could not search send lists for a campaign');
    return { status: 'error', message: (await getTranslations('templates'))('campaignListSearchFailed') };
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
    // Fix round 1, F7. extractEmailVariables throws this for an EMAIL
    // template naming an unresolvable placeholder -- genuinely reachable
    // through the ordinary screen when the placeholder sits in the
    // SUBJECT (that function's own header explains why save time never
    // catches it there), so it earns its own translated sentence rather
    // than describeCampaignWriteError's generic ValidationError pass-through.
    if (cause instanceof UnresolvableEmailPlaceholderError) {
      return {
        status: 'error',
        message: t('campaignEmailPlaceholderNotResolvable', { placeholder: cause.placeholder }),
      };
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
    // describeCancelCampaignError, not the shared write describer: the one
    // 22023 cancel_campaign raises is reachable by an ordinary race (the
    // campaign finishes between this row being rendered and this button being
    // pressed), and the shared describer would show that door's own English
    // sentence to a Portuguese operator. See its own header.
    return {
      status: 'error',
      message: describeCancelCampaignError(cause, await getTranslations('templates')),
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

  const { userId, token } = await requireSession();
  const t = await getTranslations('templates');

  try {
    // The Station, and NOTHING ELSE, before the limiter (whole-branch review,
    // Minor 5). This used to be the full `resolveSendListAudience` call now
    // below, which for a LIVING list re-resolves the whole audience -- up to
    // RESOLVE_CAP (10,000) ids -- so a throttled caller still paid for the
    // most expensive step in this action before being refused, and the
    // comment below claiming the limiter runs before the work it protects was
    // false. `readSendListStation` reads one `send_lists` row, which is the
    // one fact the limiter's key needs.
    const companyId = await readSendListStation(parsed.data.listId, token);

    // Fix round 1, F2. Rate-limited before the permission check and the
    // audit write below -- a throttled caller should not spend either on a
    // request this function is about to refuse anyway. Keyed by Station AND
    // person, the identical shape deezer-actions.ts uses for its own
    // outside-service call, so one operator holding the button down cannot
    // spend a whole Station's budget, and one Station's own volume of
    // legitimate testing cannot exhaust another's.
    const gate = await testSendLimiter.check(
      `campaign-test-send:${companyId}:${userId}`,
      TEST_SENDS_PER_MINUTE,
      60,
    );
    if (!gate.allowed) {
      return { status: 'error', message: t('testSendRateLimited') };
    }

    // Fix round 1, F2. A test send is a send: the one permission check and
    // the one audit_logs row this action produces, both from ONE call
    // (record_campaign_test_send, 0249), before anything else -- including
    // before checking whether this list even has a sample member to draw
    // from, so a caller lacking messaging.send learns that first rather than
    // last. Its own header explains why the gate lives there rather than a
    // separate has_permission round trip here.
    await recordCampaignTestSend(
      {
        companyId,
        channel: parsed.data.channel,
        listId: parsed.data.listId,
        templateId: parsed.data.templateId,
        // The RAW, operator-typed destination, before WHATSAPP's own
        // digit-only normalisation below -- the audit trail is about what
        // the operator told this system to send to, not the shape the
        // transport layer happened to need it in. The door itself masks it
        // before it reaches audit_logs (0249, ruling R35); what travels here
        // is what the operator typed, because the mask is the door's job and
        // a caller that pre-masked would leave the door still able to store a
        // clear address for anybody who called it differently.
        destination: parsed.data.destination,
      },
      token,
    );

    // The audience itself, AFTER the limiter and the permission check above:
    // this is the expensive step, and it is only needed for the one sample
    // listener whose own field values the test message is built from.
    const audience = await resolveSendListAudience(parsed.data.listId, token);
    const sampleMemberId = audience.memberIds[0];
    if (!sampleMemberId) {
      return { status: 'error', message: t('testSendListHasNobody') };
    }

    const template = await loadCampaignTemplate(
      parsed.data.templateId,
      companyId,
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
      { companyId, channel: parsed.data.channel, template, sampleMember, destination },
      token,
    );

    if (outcome.ok) return { status: 'sent' };
    return { status: 'error', message: t('testSendFailed', { code: outcome.code }) };
  } catch (cause) {
    if (cause instanceof SendListResolutionCappedError) {
      return { status: 'error', message: await describeResolutionCap(cause) };
    }
    // Fix round 1, F7. testSendCampaign calls extractEmailVariables too, so
    // the identical genuinely-reachable subject-placeholder case can surface
    // here -- see createCampaignAction's own comment on the same branch.
    if (cause instanceof UnresolvableEmailPlaceholderError) {
      return {
        status: 'error',
        message: t('campaignEmailPlaceholderNotResolvable', { placeholder: cause.placeholder }),
      };
    }
    logger.error({ err: cause, listId: parsed.data.listId, channel: parsed.data.channel }, 'a campaign test send failed');
    return { status: 'error', message: describeCampaignWriteError(cause, t, 'actionSendATestMessage') };
  }
}
