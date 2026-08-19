import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/supabase/database.types';
import {
  MAX_CONSECUTIVE_SEND_FAILURES,
  OUTBOX_BATCH,
  STALE_CLAIM,
  nextAttemptDelay,
} from '@/services/whatsapp';
import { parseTemplate } from '@/lib/integrations/whatsapp/template';
import { GraphTransport } from '@/lib/integrations/whatsapp/graph';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import { WhatsAppMessagingProvider } from '@/lib/messaging/whatsapp-provider';
import { EmailMessagingProvider } from '@/lib/messaging/email-provider';
import type {
  EmailSenderIdentity,
  EmailSendJob,
  MessagingProvider,
  SendOutcome,
  WhatsAppSendJob,
} from '@/lib/messaging/provider';
import { DevMailer, SmtpMailer, type Mailer } from '@/lib/mailer';
import { newUnsubscribeToken } from '@/services/consent';
import { env } from '@/lib/env';
import ptMessages from '../../messages/pt.json';

type ServiceClient = SupabaseClient<Database>;

export interface CampaignDrainResult {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
}

/**
 * Test-only seam: OMITTED means "resolve the real provider from the
 * environment", the same convention `drainGeocodeQueue`'s own `options.transport`
 * uses (`src/services/places.ts`) -- the common case (the tick route) calls
 * `drainCampaigns(supabase)` with nothing here, and a test hands in a provider
 * that records what it was called with instead of touching a network.
 */
export interface CampaignDrainDeps {
  emailProvider?: MessagingProvider;
  whatsappProvider?: MessagingProvider;
}

/**
 * The Portuguese label for a campaign e-mail's unsubscribe link.
 *
 * Read directly out of the catalogue JSON rather than through next-intl's
 * `getTranslations`: this file has no request behind it (it runs from the
 * worker tick), and `tests/unit/i18n/usage.test.ts` exists specifically
 * because a translator call outside a request throws the moment the module
 * loads. Portuguese, unconditionally: the listener has no locale to read --
 * `renderCampaignEmail`'s own comment says the label belongs to the caller
 * for exactly that reason, and `message_templates.body`'s column comment
 * (0110) states that everything a listener reads in this product is
 * Portuguese.
 */
const UNSUBSCRIBE_LABEL: string = ptMessages.unsubscribe.emailLinkLabel;

/**
 * `STALE_CLAIM` (src/services/whatsapp.ts) is a Postgres interval literal,
 * handed to `reclaim_stale_whatsapp_claims` for Postgres itself to parse.
 * This drain's own reclaim is a DIRECT WRITE rather than an RPC -- no reclaim
 * function exists for this table (0245 built only the index it scans), and
 * the brief for this task says the write belongs here, not in a new
 * migration -- so the identical string has to become a JS cutoff instead of
 * being handed to Postgres.
 *
 * NARROW ON PURPOSE. This reads exactly the "<n> <unit>" shape STALE_CLAIM
 * holds today, not the whole of Postgres' interval grammar: a second,
 * general-purpose parser would be a bigger thing to keep correct than the one
 * constant it exists to read, and `nextAttemptDelay`'s own file changing this
 * constant's shape would fail this function loudly (a thrown error) rather
 * than silently mis-scheduling every reclaim.
 */
function staleClaimMs(interval: string): number {
  const match = /^(\d+)\s+(second|minute|hour|day)s?$/.exec(interval.trim());
  if (!match) {
    throw new Error(`campaigns drain: cannot parse STALE_CLAIM interval "${interval}"`);
  }
  const unitMs: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
  };
  return Number(match[1]) * unitMs[match[2]!]!;
}

function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

function resolveWhatsAppTransport() {
  return env.WHATSAPP_ACCESS_TOKEN ? new GraphTransport(env.WHATSAPP_ACCESS_TOKEN) : new FakeTransport();
}

/** The shape `claim_campaign_batch` (0244) returns, with the nullability the LEFT JOIN actually admits. */
interface ClaimedRow {
  id: string;
  campaign_id: string;
  channel: 'WHATSAPP' | 'EMAIL';
  address: string | null;
  variables: Json;
  attempts: number;
  company_id: string | null;
  template_name: string | null;
  template_language: string | null;
  body: string | null;
  subject: string | null;
}

interface CompanyIdentity {
  name: string;
  logoUrl: string | null;
  emailFromName: string | null;
  emailFromAddress: string | null;
  emailReplyTo: string | null;
}

interface CampaignInfo {
  status: string;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  otpButton: boolean;
}

interface CampaignDeltas {
  sentDelta: number;
  failedDelta: number;
  suppressedDelta: number;
}

/**
 * Block 29d-2, Task 6b. The fifth drain: turns a campaign's claimed recipient
 * rows into sends, one batch per call.
 *
 * THE ORDER IS NOT NEGOTIABLE (task brief): reclaim, then claim, then GROUP
 * the batch by campaign before anything is resolved per row -- a batch can
 * span campaigns of more than one Station, and a per-row lookup here is the
 * N+1 this block already had to undo one layer up (Block 3b, 102 queries down
 * to 5). Eligibility is asked BEFORE the address is ever read, because
 * erasure nulls a listener's address on their recipient rows while leaving
 * the row in place, and the eligibility door's first bar is
 * `anonymized_at is null` -- asking first is what turns an erased listener
 * into a `suppressed` row instead of a send to an empty address.
 */
export async function drainCampaigns(
  supabase: ServiceClient,
  deps: CampaignDrainDeps = {},
): Promise<CampaignDrainResult> {
  const result: CampaignDrainResult = { claimed: 0, sent: 0, failed: 0, suppressed: 0 };

  // 1. Reclaim first, before anything is claimed: a row abandoned mid-claim
  // is in no other query's answer, so if this does not look for it nothing
  // will (src/services/whatsapp.ts:209-213, same reasoning, same order).
  const cutoff = new Date(Date.now() - staleClaimMs(STALE_CLAIM)).toISOString();
  const reclaim = await supabase
    .from('message_campaign_recipients')
    .update({ status: 'pending' })
    .eq('status', 'claimed')
    .lt('claimed_at', cutoff);
  if (reclaim.error) {
    throw new Error(`campaigns drain: could not reclaim stale claims: ${reclaim.error.message}`);
  }

  // 2. Claim a batch.
  const claim = await supabase.rpc('claim_campaign_batch', { p_limit: OUTBOX_BATCH });
  if (claim.error) {
    throw new Error(`campaigns drain: could not claim a batch: ${claim.error.message}`);
  }
  const rows = (claim.data ?? []) as unknown as ClaimedRow[];
  result.claimed = rows.length;
  if (rows.length === 0) return result;

  // 3. Group the batch before doing anything per row.
  const byCampaign = new Map<string, ClaimedRow[]>();
  for (const row of rows) {
    const group = byCampaign.get(row.campaign_id);
    if (group) group.push(row);
    else byCampaign.set(row.campaign_id, [row]);
  }

  const memberByRow = await loadMemberIds(
    supabase,
    rows.map((r) => r.id),
  );

  const companyIds = distinct(rows.map((r) => r.company_id).filter(isNotNull));
  const companies = await loadCompanies(supabase, companyIds);

  const whatsappCompanyIds = distinct(
    rows.filter((r) => r.channel === 'WHATSAPP' && r.company_id !== null).map((r) => r.company_id as string),
  );
  const phoneNumberIds = await loadPhoneNumberIds(supabase, whatsappCompanyIds);

  const campaignInfo = await loadCampaignInfo(supabase, [...byCampaign.keys()]);

  const emailProvider = deps.emailProvider ?? new EmailMessagingProvider(resolveMailer());
  const whatsappProvider = deps.whatsappProvider ?? new WhatsAppMessagingProvider(resolveWhatsAppTransport());

  let consecutiveFailures = 0;
  let aborted = false;

  for (const [campaignId, campaignRows] of byCampaign) {
    if (aborted) break;

    const info = campaignInfo.get(campaignId);
    const head = campaignRows[0]!;
    const deltas: CampaignDeltas = { sentDelta: 0, failedDelta: 0, suppressedDelta: 0 };

    const dataMissing =
      !info || head.company_id === null || (head.channel === 'EMAIL' && (head.body === null || head.subject === null));

    if (dataMissing) {
      // The claim's own LEFT JOIN (0244) exists for exactly this: a claimed
      // row whose campaign or template vanished comes back with the joined
      // columns null rather than silently dropped from the batch while still
      // claimed. Settled here so it cannot sit `claimed` past the stale
      // window and be reclaimed and re-attempted for ever, since nothing
      // about it can ever resolve. These fields are uniform across a group --
      // they are joined from the SAME message_campaigns/message_templates
      // row for every recipient of one campaign -- so checking the head row
      // once answers for the whole group.
      for (const row of campaignRows) {
        await settleRow(supabase, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'campaign_data_missing',
          error_description: 'the campaign or its template could not be resolved',
        });
        deltas.failedDelta += 1;
        result.failed += 1;
      }
      await finalizeCampaign(supabase, campaignId, info, deltas);
      continue;
    }

    if (info.status === 'queued') {
      await supabase
        .from('message_campaigns')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('status', 'queued');
    }

    const company = companies.get(head.company_id!);

    // 4. Ask eligibility BEFORE reading the address, once for the whole
    // group's member ids.
    const memberIds = campaignRows.map((row) => memberByRow.get(row.id)).filter(isNotNull);
    const eligibility = await supabase.rpc('members_marketing_eligible_bulk_for_worker', {
      p_member_ids: memberIds,
      p_company_id: head.company_id!,
      p_channel: head.channel,
    });
    if (eligibility.error) {
      throw new Error(
        `campaigns drain: could not check eligibility for campaign ${campaignId}: ${eligibility.error.message}`,
      );
    }
    const eligibleByMember = new Map((eligibility.data ?? []).map((row) => [row.member_id, row.eligible]));

    for (const row of campaignRows) {
      if (aborted) break;

      const memberId = memberByRow.get(row.id);
      if (!memberId) {
        await settleRow(supabase, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'campaign_data_missing',
          error_description: 'this recipient row has no resolvable listener',
        });
        deltas.failedDelta += 1;
        result.failed += 1;
        continue;
      }

      /**
       * CONSENT IS ASKED AGAIN HERE, not only at snapshot (spec D1). A large campaign
       * takes hours to drain, and a listener who clicks "descadastrar" while it does
       * has, from their side, done the thing the button promised. Sending anyway is
       * the complaint that costs a WhatsApp number its quality rating -- and it is
       * indistinguishable, to them, from the button not working.
       *
       * A refusal here is `suppressed`, never `failed`: it is their choice, not our
       * error, and it must never be retried.
       */
      if (!(eligibleByMember.get(memberId) ?? false)) {
        await settleRow(supabase, row.id, { status: 'suppressed' });
        deltas.suppressedDelta += 1;
        result.suppressed += 1;
        continue;
      }

      if (row.address === null) {
        await settleRow(supabase, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'no_address',
          error_description: 'this recipient has no resolved address',
        });
        deltas.failedDelta += 1;
        result.failed += 1;
        continue;
      }

      if (row.channel === 'WHATSAPP' && !phoneNumberIds.has(row.company_id!)) {
        // The same reasoning drainOutbox uses for a row with no
        // phone_number_id (src/services/whatsapp.ts): parked with a reason
        // rather than sent to nowhere, and never handed to the transport.
        await settleRow(supabase, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'no_whatsapp_integration',
          error_description: 'this station has no active WhatsApp integration',
        });
        deltas.failedDelta += 1;
        result.failed += 1;
        continue;
      }

      const outcome = await sendOne(supabase, row, {
        company,
        info,
        phoneNumberId: row.channel === 'WHATSAPP' ? phoneNumberIds.get(row.company_id!)! : undefined,
        memberId,
        provider: row.channel === 'EMAIL' ? emailProvider : whatsappProvider,
      });

      if (outcome.ok) {
        await settleRow(supabase, row.id, {
          status: 'sent',
          attempts: row.attempts + 1,
          provider_message_id: outcome.providerMessageId,
        });
        deltas.sentDelta += 1;
        result.sent += 1;
        consecutiveFailures = 0;
        continue;
      }

      const delay = outcome.retryable ? nextAttemptDelay(row.attempts) : null;
      if (delay === null) {
        await settleRow(supabase, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: outcome.code,
          error_description: outcome.description,
        });
      } else {
        await settleRow(supabase, row.id, {
          status: 'pending',
          attempts: row.attempts + 1,
          next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
          error_code: outcome.code,
          error_description: outcome.description,
        });
      }
      deltas.failedDelta += 1;
      result.failed += 1;

      // A whole batch stops after MAX_CONSECUTIVE_SEND_FAILURES retryable
      // failures in a row -- the same defence drainOutbox applies and for the
      // same reason its own comment gives (src/services/whatsapp.ts): a
      // credential failure is system-wide, and burning one rung of every
      // row's ladder on the same outage can park an entire queue over an
      // incident that fixed itself in ninety seconds.
      consecutiveFailures = outcome.retryable ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        aborted = true;
      }
    }

    await finalizeCampaign(supabase, campaignId, info, deltas);
  }

  return result;
}

/** One recipient's outcome: the unsubscribe mint (e-mail only), the job, and the send. */
async function sendOne(
  supabase: ServiceClient,
  row: ClaimedRow,
  ctx: {
    company: CompanyIdentity | undefined;
    info: CampaignInfo;
    phoneNumberId: string | undefined;
    memberId: string;
    provider: MessagingProvider;
  },
): Promise<SendOutcome> {
  if (row.channel === 'WHATSAPP') {
    const job: WhatsAppSendJob = {
      channel: 'WHATSAPP',
      address: row.address!,
      phoneNumberId: ctx.phoneNumberId!,
      // `variables` travels exactly as the snapshot stored it -- positional,
      // never re-consulted against the template's current order (0242's own
      // warning) -- and `parseTemplate` is the one place that shape is
      // validated, the same door drainOutbox reads a stored template through.
      template: parseTemplate({
        name: row.template_name,
        language: row.template_language,
        variables: row.variables,
        otpButton: ctx.info.otpButton,
      }),
    };
    return ctx.provider.send(job);
  }

  const unsubscribe = await mintUnsubscribe(supabase, row.company_id!, ctx.memberId);
  if (!unsubscribe.ok) {
    // Never reaches the provider: the drain owns this outcome and it flows
    // through the same retry ladder as any other failed attempt, rather than
    // a special path a reviewer would have to remember exists.
    return { ok: false, retryable: true, code: 'unsubscribe_token_error', description: unsubscribe.message };
  }

  const fromName = ctx.info.fromName ?? ctx.company?.emailFromName ?? null;
  const fromAddress = ctx.info.fromEmail ?? ctx.company?.emailFromAddress ?? null;
  const replyTo = ctx.info.replyTo ?? ctx.company?.emailReplyTo ?? null;
  const sender: EmailSenderIdentity | null = fromAddress ? { fromAddress, fromName, replyTo } : null;

  const job: EmailSendJob = {
    channel: 'EMAIL',
    address: row.address!,
    subject: row.subject!,
    stationName: ctx.company?.name ?? '',
    logoUrl: ctx.company?.logoUrl ?? null,
    body: row.body!,
    unsubscribe: unsubscribe.value,
    sender,
  };
  return ctx.provider.send(job);
}

async function mintUnsubscribe(
  supabase: ServiceClient,
  companyId: string,
  memberId: string,
): Promise<{ ok: true; value: { url: string; label: string } | null } | { ok: false; message: string }> {
  if (!env.NEXT_PUBLIC_SITE_URL) {
    // Degraded rather than refused: this deployment cannot address its own
    // links (the same absence sendServiceLink, src/services/whatsapp-link.ts,
    // treats as fatal for a single message), but a whole campaign batch
    // spanning both channels must not stop over a link the recipient can live
    // without for one send. The e-mail simply carries no unsubscribe link.
    return { ok: true, value: null };
  }

  const { raw, hash } = newUnsubscribeToken();
  const { error } = await supabase.rpc('issue_unsubscribe_token', {
    p_member_id: memberId,
    p_company_id: companyId,
    p_token_hash: hash,
  });
  if (error) return { ok: false, message: error.message };

  const base = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  return { ok: true, value: { url: `${base}/unsubscribe/${raw}`, label: UNSUBSCRIBE_LABEL } };
}

type RecipientPatch = Database['public']['Tables']['message_campaign_recipients']['Update'];

async function settleRow(supabase: ServiceClient, rowId: string, patch: RecipientPatch): Promise<void> {
  const { error } = await supabase.from('message_campaign_recipients').update(patch).eq('id', rowId);
  if (error) {
    throw new Error(`campaigns drain: could not settle recipient ${rowId}: ${error.message}`);
  }
}

async function loadMemberIds(supabase: ServiceClient, rowIds: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('message_campaign_recipients').select('id, member_id').in('id', rowIds);
  if (error) {
    throw new Error(`campaigns drain: could not resolve member ids: ${error.message}`);
  }
  return new Map((data ?? []).map((row) => [row.id, row.member_id]));
}

async function loadCompanies(supabase: ServiceClient, companyIds: string[]): Promise<Map<string, CompanyIdentity>> {
  if (companyIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, thumb_url, email_from_name, email_from_address, email_reply_to')
    .in('id', companyIds);
  if (error) {
    throw new Error(`campaigns drain: could not resolve Station identity: ${error.message}`);
  }
  return new Map(
    (data ?? []).map((c) => [
      c.id,
      {
        name: c.name,
        logoUrl: c.thumb_url,
        emailFromName: c.email_from_name,
        emailFromAddress: c.email_from_address,
        emailReplyTo: c.email_reply_to,
      },
    ]),
  );
}

async function loadPhoneNumberIds(supabase: ServiceClient, companyIds: string[]): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('integrations')
    .select('company_id, phone_number_id')
    .eq('provider', 'WHATSAPP')
    .is('deleted_at', null)
    .in('company_id', companyIds);
  if (error) {
    throw new Error(`campaigns drain: could not resolve WhatsApp sender numbers: ${error.message}`);
  }
  return new Map((data ?? []).map((row) => [row.company_id, row.phone_number_id]));
}

async function loadCampaignInfo(supabase: ServiceClient, campaignIds: string[]): Promise<Map<string, CampaignInfo>> {
  const { data: campaigns, error: campaignsError } = await supabase
    .from('message_campaigns')
    .select('id, status, sent_count, failed_count, suppressed_count, template_id')
    .in('id', campaignIds);
  if (campaignsError) {
    throw new Error(`campaigns drain: could not resolve campaigns: ${campaignsError.message}`);
  }

  const templateIds = distinct((campaigns ?? []).map((c) => c.template_id));
  const { data: templates, error: templatesError } =
    templateIds.length === 0
      ? { data: [] as { id: string; from_name: string | null; from_email: string | null; reply_to: string | null; otp_button: boolean }[], error: null }
      : await supabase
          .from('message_templates')
          .select('id, from_name, from_email, reply_to, otp_button')
          .in('id', templateIds);
  if (templatesError) {
    throw new Error(`campaigns drain: could not resolve templates: ${templatesError.message}`);
  }
  const templateById = new Map((templates ?? []).map((t) => [t.id, t]));

  const info = new Map<string, CampaignInfo>();
  for (const c of campaigns ?? []) {
    const t = templateById.get(c.template_id);
    info.set(c.id, {
      status: c.status,
      sentCount: c.sent_count,
      failedCount: c.failed_count,
      suppressedCount: c.suppressed_count,
      fromName: t?.from_name ?? null,
      fromEmail: t?.from_email ?? null,
      replyTo: t?.reply_to ?? null,
      otpButton: t?.otp_button ?? false,
    });
  }
  return info;
}

/**
 * The campaign's own counters, incremented by this drain's tally -- never
 * recomputed from message_campaign_recipients (0242's own comment: a
 * campaign's history must still answer once its recipient rows have aged out
 * under retention). "The queue is empty" is judged here, once per campaign in
 * the batch, never once per row.
 */
async function finalizeCampaign(
  supabase: ServiceClient,
  campaignId: string,
  info: CampaignInfo | undefined,
  deltas: CampaignDeltas,
): Promise<void> {
  if (!info) return;

  const sentCount = info.sentCount + deltas.sentDelta;
  const failedCount = info.failedCount + deltas.failedDelta;
  const suppressedCount = info.suppressedCount + deltas.suppressedDelta;

  // UNCONDITIONAL: a row this drain settled is a row this drain settled,
  // whatever the campaign's own status says by the time this write lands.
  // cancel_campaign (0243) leaves an already-claimed row exactly as it is --
  // "already in flight at a provider, cannot be recalled" -- and THIS drain
  // is what settles it; a status guard here would silently drop that row's
  // outcome from the counters of a campaign cancelled mid-drain, and the
  // recipient table and the campaign's own summary would disagree about what
  // happened to it.
  const counters = await supabase
    .from('message_campaigns')
    .update({ sent_count: sentCount, failed_count: failedCount, suppressed_count: suppressedCount })
    .eq('id', campaignId);
  if (counters.error) {
    throw new Error(`campaigns drain: could not settle campaign ${campaignId}'s counters: ${counters.error.message}`);
  }

  // "The queue is empty" is judged here, once per campaign in the batch,
  // never once per row.
  const remaining = await supabase
    .from('message_campaign_recipients')
    .select('id')
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'claimed'])
    .limit(1);
  if (remaining.error) {
    throw new Error(
      `campaigns drain: could not check remaining rows for campaign ${campaignId}: ${remaining.error.message}`,
    );
  }
  if ((remaining.data ?? []).length > 0) return;

  // GUARDED, unlike the counters above: a campaign already `cancelled` (by an
  // operator, mid-drain) or already finished must never have its status
  // overwritten back to `sent`/`failed` just because its last claimed rows
  // happened to be settled after that.
  const finish = await supabase
    .from('message_campaigns')
    .update({
      finished_at: new Date().toISOString(),
      // A campaign that ends with every row suppressed is `sent` with
      // sent_count zero: it ran to completion and the counters say what
      // happened. `failed` only when nothing was sent and something was --
      // OUR problem, not the listener's choice.
      status: sentCount === 0 && failedCount > 0 ? 'failed' : 'sent',
    })
    .eq('id', campaignId)
    .in('status', ['queued', 'running']);
  if (finish.error) {
    throw new Error(`campaigns drain: could not finish campaign ${campaignId}: ${finish.error.message}`);
  }
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isNotNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
