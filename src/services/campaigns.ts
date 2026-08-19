import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { encodeCursor, keysetFilter } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import type { Database, Json } from '@/lib/supabase/database.types';
import {
  MAX_CONSECUTIVE_SEND_FAILURES,
  OUTBOX_BATCH,
  STALE_CLAIM,
  nextAttemptDelay,
} from '@/services/whatsapp';
import { parseTemplate, TemplateLimitError, type Template } from '@/lib/integrations/whatsapp/template';
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
import {
  CAMPAIGN_RESOLVABLE,
  namedPlaceholder,
  variableFromPlaceholder,
  type TemplateVariable,
} from '@/lib/templates/variables';
import { newUnsubscribeToken } from '@/services/consent';
import type { CampaignRecipientDetail } from '@/services/members';
import { env } from '@/lib/env';
import { InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import ptMessages from '../../messages/pt.json';

type ServiceClient = SupabaseClient<Database>;

export interface CampaignDrainResult {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
  /**
   * Settle writes that failed at the database, not send outcomes -- the same
   * distinction `TickResult.dbErrors` draws in src/services/whatsapp.ts.
   * Zero is what "nothing to do" looks like; anything else means a row's
   * true outcome could not be recorded and the row was left exactly as it
   * was (still `claimed`), for the stale-claim reclaim to return later.
   */
  dbErrors: number;
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

/** Exported for Task 7's test send (actions.ts), which needs the identical env-resolved mailer the drain uses -- a second copy of this resolution would be a second place for the two to disagree about which mailer a Station's messages actually go through. */
export function resolveMailer(): Mailer {
  if (env.SMTP_URL && env.MAIL_FROM) return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM);
  return new DevMailer();
}

/** Exported for the identical reason resolveMailer above is. */
export function resolveWhatsAppTransport() {
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
  /**
   * The Station's live WhatsApp integration (0057), joined INSIDE
   * claim_campaign_batch itself (0252) -- service_role holds no SELECT on
   * `integrations` through PostgREST (0057's own design: "nothing reaches
   * this table through a user-scoped client"), confirmed live, which is why
   * this column cannot be resolved by a second query from here the way a
   * Station's name or its WhatsApp-eligible member ids are. Null for an
   * EMAIL row or a WHATSAPP Station with no live integration.
   */
  phone_number_id: string | null;
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
 * the row in place, and `anonymized_at is null` is one of the eligibility
 * door's own bars (0246) -- asking first is what turns an erased listener
 * into a `suppressed` row instead of a send to an empty address. (The door's
 * actual FIRST bar is `member_linked_to_company`, "the widest bar of the
 * lot" by its own comment, 0246/0034 -- `anonymized_at` is checked second,
 * but is still checked before this drain ever reads an address.)
 */
export async function drainCampaigns(
  supabase: ServiceClient,
  deps: CampaignDrainDeps = {},
): Promise<CampaignDrainResult> {
  const result: CampaignDrainResult = { claimed: 0, sent: 0, failed: 0, suppressed: 0, dbErrors: 0 };

  // 1. Reclaim first, before anything is claimed: a row abandoned mid-claim
  // is in no other query's answer, so if this does not look for it nothing
  // will (src/services/whatsapp.ts:209-213, same reasoning, same order). NOT
  // an exact mirror of reclaim_stale_whatsapp_claims' own outbound arm: that
  // one takes the stale rows `for update skip locked` before updating them
  // (0063), a lock a plain PostgREST UPDATE cannot ask for at all -- this
  // reclaim is a single UPDATE ... WHERE, and accepts the gap.
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
  if (rows.length === 0) {
    // Item 1(b), Task 8 fix round 1. A tick that claims nothing is exactly
    // the case this exists for: a campaign stranded `running` by something
    // OTHER than this drain never appears in any claimed batch again, so a
    // tick with nothing to claim must still be the one that finds it. See
    // finalizeEmptyRunningCampaigns' own comment for the full reasoning.
    await finalizeEmptyRunningCampaigns(supabase);
    return result;
  }

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
      //
      // CONSENT IS NOT RE-CHECKED HERE, and that is a real cost rather than a
      // free simplification: a listener who withdrew consent on a row that
      // lands in this branch is recorded `campaign_data_missing` (our
      // failure) rather than `suppressed` (their choice). Nothing is sent to
      // them either way -- eligibility gates a SEND this branch never
      // attempts -- so the cost is a bookkeeping label, not an unwanted
      // message. Asking eligibility here would need company_id to be known,
      // which is exactly the one thing this branch cannot always assume (the
      // other trigger, an EMAIL row missing body/subject, does still carry a
      // company_id and could be asked -- but splitting the branch on which
      // field is missing to save a mislabelled outcome in a case 0244's own
      // comment already calls smaller than the outbox equivalent it mirrors,
      // and not zero, was judged not worth the extra branch).
      for (const row of campaignRows) {
        const settled = await settleRow(supabase, result, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'campaign_data_missing',
          error_description: 'the campaign or its template could not be resolved',
        });
        if (settled) {
          deltas.failedDelta += 1;
          result.failed += 1;
        }
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
        const settled = await settleRow(supabase, result, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'campaign_data_missing',
          error_description: 'this recipient row has no resolvable listener',
        });
        if (settled) {
          deltas.failedDelta += 1;
          result.failed += 1;
        }
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
        const settled = await settleRow(supabase, result, row.id, { status: 'suppressed' });
        if (settled) {
          deltas.suppressedDelta += 1;
          result.suppressed += 1;
        }
        continue;
      }

      if (row.address === null) {
        const settled = await settleRow(supabase, result, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'no_address',
          error_description: 'this recipient has no resolved address',
        });
        if (settled) {
          deltas.failedDelta += 1;
          result.failed += 1;
        }
        continue;
      }

      if (row.channel === 'WHATSAPP' && row.phone_number_id === null) {
        // The same reasoning drainOutbox uses for a row with no
        // phone_number_id (src/services/whatsapp.ts): parked with a reason
        // rather than sent to nowhere, and never handed to the transport.
        const settled = await settleRow(supabase, result, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: 'no_whatsapp_integration',
          error_description: 'this station has no active WhatsApp integration',
        });
        if (settled) {
          deltas.failedDelta += 1;
          result.failed += 1;
        }
        continue;
      }

      const outcome = await sendOne(supabase, row, {
        campaignId,
        company,
        info,
        phoneNumberId: row.channel === 'WHATSAPP' ? row.phone_number_id! : undefined,
        memberId,
        provider: row.channel === 'EMAIL' ? emailProvider : whatsappProvider,
      });

      if (outcome.ok) {
        const settled = await settleRow(supabase, result, row.id, {
          status: 'sent',
          attempts: row.attempts + 1,
          provider_message_id: outcome.providerMessageId,
        });
        if (settled) {
          deltas.sentDelta += 1;
          result.sent += 1;
        }
        consecutiveFailures = 0;
        continue;
      }

      // Fix round 1, ITEM 1 (Critical). ONLY a row that ends `failed` -- the
      // ladder exhausted, or a permanent outcome -- may increment
      // failedDelta/result.failed. A row going back to `pending` is still
      // working: counting it here as well is how a single recipient retried
      // six times across six ticks added six to a counter total_recipients
      // was supposed to bound, and `sent + failed + suppressed` could exceed
      // it on a campaign that finished cleanly.
      const delay = outcome.retryable ? nextAttemptDelay(row.attempts) : null;
      if (delay === null) {
        const settled = await settleRow(supabase, result, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          error_code: outcome.code,
          error_description: outcome.description,
        });
        if (settled) {
          deltas.failedDelta += 1;
          result.failed += 1;
        }
      } else {
        await settleRow(supabase, result, row.id, {
          status: 'pending',
          attempts: row.attempts + 1,
          next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
          error_code: outcome.code,
          error_description: outcome.description,
        });
      }

      // A whole batch stops after MAX_CONSECUTIVE_SEND_FAILURES retryable
      // failures in a row -- the same defence drainOutbox applies and for the
      // same reason its own comment gives (src/services/whatsapp.ts): a
      // credential failure is system-wide, and burning one rung of every
      // row's ladder on the same outage can park an entire queue over an
      // incident that fixed itself in ninety seconds. Tied to the SEND
      // outcome alone, never to whether the settle write itself succeeded.
      consecutiveFailures = outcome.retryable ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
        aborted = true;
      }
    }

    await finalizeCampaign(supabase, campaignId, info, deltas);
  }

  // Item 1(b), Task 8 fix round 1. Runs every tick, AFTER this tick's own
  // batch loop above -- a campaign the loop just finished (the ordinary
  // case) already reads back as no longer `running` by the time this runs,
  // so it only ever does real work for a campaign THIS tick's own claim
  // never touched at all. See finalizeEmptyRunningCampaigns' own comment for
  // why that case matters and cannot simply wait for a later tick that
  // claims something.
  await finalizeEmptyRunningCampaigns(supabase);

  return result;
}

/** One recipient's outcome: e-mail placeholder substitution, the unsubscribe mint, the job, and the send. */
async function sendOne(
  supabase: ServiceClient,
  row: ClaimedRow,
  ctx: {
    campaignId: string;
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

  // EMAIL. Fix round 1, ITEM 6. The two channels do not share a notation: a
  // WhatsApp template carries positional {{1}}..{{n}} (0222), refused for
  // EMAIL by message_templates_email_variables_empty (0223); an EMAIL
  // template's body and subject name their own placeholders from the
  // template_variable vocabulary instead ({{listener_first_name}} and so on,
  // validated at save time by save_marketing_template, 0225). This
  // recipient's own snapshot carries the values by name -- an array of
  // {name, value} objects (Task 6b fix round 1 ruling; 0242's column comment,
  // which still describes the positional shape, is Task 7's to correct).
  // Substituted here, per recipient, because the values are per recipient.
  const values = parseEmailVariables(row.variables);

  const bodyResult = substitutePlaceholders(row.body!, values);
  if (!bodyResult.ok) {
    return { ok: false, retryable: false, code: bodyResult.code, description: bodyResult.description };
  }

  const subjectResult = substitutePlaceholders(row.subject!, values);
  if (!subjectResult.ok) {
    return { ok: false, retryable: false, code: subjectResult.code, description: subjectResult.description };
  }

  const unsubscribe = await mintUnsubscribe(supabase, ctx.campaignId, row.company_id!, ctx.memberId);
  if (!unsubscribe.ok) {
    return { ok: false, retryable: unsubscribe.retryable, code: unsubscribe.code, description: unsubscribe.message };
  }

  const fromName = ctx.info.fromName ?? ctx.company?.emailFromName ?? null;
  const fromAddress = ctx.info.fromEmail ?? ctx.company?.emailFromAddress ?? null;
  const replyTo = ctx.info.replyTo ?? ctx.company?.emailReplyTo ?? null;
  const sender: EmailSenderIdentity | null = fromAddress ? { fromAddress, fromName, replyTo } : null;

  const job: EmailSendJob = {
    channel: 'EMAIL',
    address: row.address!,
    subject: subjectResult.text,
    stationName: ctx.company?.name ?? '',
    logoUrl: ctx.company?.logoUrl ?? null,
    body: bodyResult.text,
    unsubscribe: unsubscribe.value,
    sender,
  };
  return ctx.provider.send(job);
}

/**
 * Parses `message_campaign_recipients.variables` for an EMAIL row: an array
 * of `{name, value}` pairs (Task 6b fix round 1 ruling -- an ARRAY, so
 * 0242's committed `message_campaign_recipients_variables_is_positional`
 * CHECK still holds; only WHATSAPP's own elements stay plain strings).
 * Malformed or unrecognised entries are dropped rather than thrown on: an
 * entry this map cannot use behaves exactly like an entry the snapshot never
 * had, which `substitutePlaceholders` below already turns into an honest
 * failure rather than a blank.
 */
function parseEmailVariables(json: Json): Map<TemplateVariable, string> {
  const map = new Map<TemplateVariable, string>();
  if (!Array.isArray(json)) return map;
  for (const entry of json) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.value !== 'string') continue;
    const variable = variableFromPlaceholder(record.name);
    if (variable) map.set(variable, record.value);
  }
  return map;
}

/**
 * Substitutes every `{{...}}` in an e-mail's body or subject, by name, from
 * this recipient's own resolved values.
 *
 * A PLACEHOLDER THE SNAPSHOT HAS NO VALUE FOR FAILS THE CALLER, NEVER BLANKS.
 * Not this file's own rule: `variableFromPlaceholder`'s own comment
 * (src/lib/templates/variables.ts) states it -- substituting an empty string
 * "is how a listener reads 'Oi !' and nobody finds out." The capture is WIDE,
 * the same shape `save_marketing_template`'s own validation uses (0225) --
 * anything between the braces, so a name this vocabulary does not recognise
 * is caught here too rather than shipped to a listener as literal text.
 */
function substitutePlaceholders(
  text: string,
  values: Map<TemplateVariable, string>,
): { ok: true; text: string } | { ok: false; code: string; description: string } {
  // Pass 1: validate every placeholder resolves AND has a value, before
  // rewriting anything. A single mutable `let` reassigned inside `.replace`'s
  // own callback is how the first draft of this function read; two plain
  // passes, neither closing over the other's state, is simpler to prove
  // correct than either regexp callback trying to also carry a verdict out.
  for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const captured = match[1] ?? '';
    const variable = variableFromPlaceholder(captured);
    if (!variable) {
      return {
        ok: false,
        code: 'unresolved_email_variable',
        description: `this campaign's text names {{${captured}}}, which is not a value this system substitutes`,
      };
    }
    if (!values.has(variable)) {
      // Never blanked -- see this function's own header comment for why.
      return {
        ok: false,
        code: 'unresolved_email_variable',
        description: `this campaign's text names ${namedPlaceholder(variable)}, which this recipient's snapshot has no value for`,
      };
    }
  }

  // Pass 2: every placeholder validated above, so every lookup here is safe.
  const substituted = text.replace(/\{\{([^{}]*)\}\}/g, (_whole, captured: string) => {
    const variable = variableFromPlaceholder(captured)!;
    return values.get(variable)!;
  });
  return { ok: true, text: substituted };
}

type UnsubscribeResult =
  | { ok: true; value: { url: string; label: string } }
  | { ok: false; retryable: boolean; code: string; message: string };

async function mintUnsubscribe(
  supabase: ServiceClient,
  campaignId: string,
  companyId: string,
  memberId: string,
): Promise<UnsubscribeResult> {
  if (!env.NEXT_PUBLIC_SITE_URL) {
    // Fix round 1, ITEM 5. NOT a degraded send: `src/lib/env.ts:28` makes
    // this variable required in every correctly configured installation, so
    // this branch firing at all means the deployment itself is broken -- and
    // marketing e-mail with no way to leave it is worse than marketing
    // e-mail that never went out. The asymmetry is IRREVERSIBILITY, not
    // speed: a row marked `failed` here is visible on the history screen for
    // an operator to notice and act on (an unsatisfying but recoverable
    // state, the same shape EAUTH's own comment in email-provider.ts accepts
    // for the identical reason below); an e-mail actually sent with no way
    // to unsubscribe is in the listener's inbox forever, and nothing this
    // system does afterwards can put the missing link back into it.
    // NOT RETRYABLE: nothing about waiting six minutes makes an unset
    // environment variable set itself, and burning the ladder on every
    // recipient of a campaign that cannot succeed until the same config fix
    // happens either way is the identical cost EAUTH's own comment accepts.
    return {
      ok: false,
      retryable: false,
      code: 'no_unsubscribe_base_url',
      message:
        'NEXT_PUBLIC_SITE_URL is not configured; a campaign e-mail must not be sent with no working way to unsubscribe from it',
    };
  }

  const { raw, hash } = newUnsubscribeToken();
  const { error } = await supabase.rpc('issue_unsubscribe_token', {
    p_member_id: memberId,
    p_company_id: companyId,
    p_token_hash: hash,
    // Fix round 1, ITEM 4. Without this, member_consents.origin (0232,
    // consume_unsubscribe_token) records the bare string "unsubscribe:" --
    // 'unsubscribe:' || coalesce(p_campaign_label, '') -- with nothing after
    // it, naming no campaign at all. The campaign's own id is the one value
    // guaranteed to identify it: message_campaigns carries no name column,
    // and the id is what an operator or support reader can look up.
    p_campaign_label: campaignId,
  });
  if (error) {
    return { ok: false, retryable: true, code: 'unsubscribe_token_error', message: error.message };
  }

  const base = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, '');
  return { ok: true, value: { url: `${base}/unsubscribe/${raw}`, label: UNSUBSCRIBE_LABEL } };
}

type RecipientPatch = Database['public']['Tables']['message_campaign_recipients']['Update'];

/**
 * Fix round 1, ITEM 3. Records the error and returns `false` rather than
 * throwing -- `drainOutbox`'s own shape (`failed()`, src/services/whatsapp.ts)
 * -- because a throw here used to propagate out of the per-row loop and skip
 * the `finalizeCampaign` call below it, discarding every OTHER row's already-
 * tallied delta for that group along with it. The row this call itself failed
 * to settle is left exactly as claim_campaign_batch (0244) left it -- still
 * `claimed` -- for the stale-claim reclaim to return later; its outcome is
 * not counted now precisely because it was not durably recorded now.
 */
async function settleRow(
  supabase: ServiceClient,
  result: CampaignDrainResult,
  rowId: string,
  patch: RecipientPatch,
): Promise<boolean> {
  const { error } = await supabase.from('message_campaign_recipients').update(patch).eq('id', rowId);
  if (error) {
    result.dbErrors += 1;
    console.error(`campaigns drain: could not settle recipient ${rowId}: ${error.message}`);
    return false;
  }
  return true;
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


async function loadCampaignInfo(supabase: ServiceClient, campaignIds: string[]): Promise<Map<string, CampaignInfo>> {
  const { data: campaigns, error: campaignsError } = await supabase
    .from('message_campaigns')
    .select('id, status, template_id')
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
      fromName: t?.from_name ?? null,
      fromEmail: t?.from_email ?? null,
      replyTo: t?.reply_to ?? null,
      otpButton: t?.otp_button ?? false,
    });
  }
  return info;
}

/**
 * The campaign's own counters, incremented by this drain's tally through
 * `bump_campaign_counters` (0247, Task 6b fix round 1 Item 2) -- an atomic
 * SQL update, never a read-then-write from here: two overlapping ticks
 * settling different rows of the same campaign (the ordinary case for this
 * worker, not an edge one) would otherwise lose one tick's own delta. Never
 * recomputed from message_campaign_recipients either (0242's own comment: a
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

  // UNCONDITIONAL: a row this drain settled is a row this drain settled,
  // whatever the campaign's own status says by the time this write lands.
  // cancel_campaign (0243) leaves an already-claimed row exactly as it is --
  // "already in flight at a provider, cannot be recalled" -- and THIS drain
  // is what settles it; a status guard here would silently drop that row's
  // outcome from the counters of a campaign cancelled mid-drain, and the
  // recipient table and the campaign's own summary would disagree about what
  // happened to it.
  const bump = await supabase.rpc('bump_campaign_counters', {
    p_campaign_id: campaignId,
    p_sent: deltas.sentDelta,
    p_failed: deltas.failedDelta,
    p_suppressed: deltas.suppressedDelta,
  });
  if (bump.error) {
    throw new Error(`campaigns drain: could not bump campaign ${campaignId}'s counters: ${bump.error.message}`);
  }
  const totals = (Array.isArray(bump.data) ? bump.data[0] : bump.data) as
    | { sent_count: number; failed_count: number; suppressed_count: number }
    | undefined;
  if (!totals) {
    throw new Error(`campaigns drain: bump_campaign_counters returned no row for campaign ${campaignId}`);
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
  // happened to be settled after that. The totals used for the decision are
  // the POST-BUMP row `bump_campaign_counters` just returned, not a value
  // read earlier in this function that a concurrent tick's own bump could
  // since have moved past.
  const finish = await supabase
    .from('message_campaigns')
    .update({
      finished_at: new Date().toISOString(),
      // A campaign that ends with every row suppressed is `sent` with
      // sent_count zero: it ran to completion and the counters say what
      // happened. `failed` only when nothing was sent and something was --
      // OUR problem, not the listener's choice.
      status: totals.sent_count === 0 && totals.failed_count > 0 ? 'failed' : 'sent',
    })
    .eq('id', campaignId)
    .in('status', ['queued', 'running']);
  if (finish.error) {
    throw new Error(`campaigns drain: could not finish campaign ${campaignId}: ${finish.error.message}`);
  }
}

/**
 * Item 1(b), Task 8 fix round 1. `finalizeCampaign` above used to run ONLY
 * for a campaign this tick's own batch loop drew a claimed row from. A
 * campaign whose queue empties some OTHER way -- Task 8's `anonymize_member`
 * (0251) moving a listener's last `pending` row straight to `suppressed` is
 * the concrete case that surfaced this, but any future writer that empties a
 * queue without going through this drain has the identical shape -- was left
 * `running` for ever. That is worse than a stuck status flag: the retention
 * sweep's own DELETE (0250) is gated on
 * `c.status in ('sent', 'failed', 'cancelled')`, so a campaign stranded in
 * `running` is invisible to retention for ever too -- not just the one
 * listener's row, EVERY recipient row of that campaign, phone numbers and
 * e-mail addresses included. Exactly the obligation this task exists to
 * discharge, defeated by a side effect of the task itself.
 *
 * Runs every tick, unconditionally, BEFORE the "claimed nothing" early
 * return above -- a tick that claims zero rows is precisely the case a
 * campaign stranded by an outside writer needs, since such a campaign will
 * never again appear in a claimed batch (nothing is left in it to claim).
 *
 * ONE BOUNDED QUERY PAIR, not one per campaign: every `running` campaign id,
 * then which of those ids still has a `pending` or `claimed` row, in a
 * single `.in(...)` read apiece. The remainder -- `running` with nothing
 * left in its queue -- is what gets finalized, reusing `loadCampaignInfo`
 * and `finalizeCampaign` exactly as the batch loop above already does, with
 * an all-zero delta, rather than a second version of either.
 */
async function finalizeEmptyRunningCampaigns(supabase: ServiceClient): Promise<void> {
  const running = await supabase.from('message_campaigns').select('id').eq('status', 'running');
  if (running.error) {
    throw new Error(`campaigns drain: could not list running campaigns: ${running.error.message}`);
  }
  const runningIds = (running.data ?? []).map((c) => c.id);
  if (runningIds.length === 0) return;

  const active = await supabase
    .from('message_campaign_recipients')
    .select('campaign_id')
    .in('campaign_id', runningIds)
    .in('status', ['pending', 'claimed']);
  if (active.error) {
    throw new Error(`campaigns drain: could not check for outstanding recipients: ${active.error.message}`);
  }
  const stillActive = new Set((active.data ?? []).map((r) => r.campaign_id));
  const emptyIds = runningIds.filter((id) => !stillActive.has(id));
  if (emptyIds.length === 0) return;

  const info = await loadCampaignInfo(supabase, emptyIds);
  const zeroDeltas: CampaignDeltas = { sentDelta: 0, failedDelta: 0, suppressedDelta: 0 };
  for (const id of emptyIds) {
    await finalizeCampaign(supabase, id, info.get(id), zeroDeltas);
  }
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isNotNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

// ---------------------------------------------------------------------------
// Task 7: the screen -- listing, creating and cancelling a campaign, and the
// four-step resolution create_campaign (0243) deliberately leaves to the
// application layer (0243's own header: a LIVING list is re-resolved by the
// src/services/ listing resolvers, which SQL cannot call, and the addresses
// and variable values need members and the template's own mapping -- work
// this screen already does to show the operator what will be sent).
// ---------------------------------------------------------------------------

/** A client bound to the caller's JWT, the same shape every other service file in this codebase declares for itself (send-lists.ts's own asCaller has the fullest comment on why). */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * The code taxonomy create_campaign and cancel_campaign (0243) raise, the
 * same shape mapSendListError (services/send-lists.ts) and mapTemplateError
 * (services/templates.ts) document for their own doors.
 *
 * - `42501` is a permission refusal, and -- 0093's rule, which both doors
 *   follow -- ALSO an id that names nothing this caller may reach: an unknown
 *   Station, list or template resolve to `P0002` instead (below), but a
 *   caller who lacks `messaging.send` outright is refused before either door
 *   even looks at the ids it was given.
 * - `P0002` is create_campaign's unknown-or-wrong-Station list/template, a
 *   listener not linked to the Station, or cancel_campaign's unknown
 *   campaign.
 * - `22023` is every validation raise: an empty recipient set, a WhatsApp
 *   campaign whose template is not Meta-registered, a template of the wrong
 *   channel, the new variables-shape guard this task adds to create_campaign,
 *   or cancel_campaign's refusal of an already-finished campaign.
 * - Anything else is ours, not the caller's.
 */
function mapCampaignError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

/** One row of the history grid -- see listCampaigns' own header for why list/template/creator names are batched reads rather than a PostgREST embed. */
export interface CampaignRecord {
  id: string;
  companyId: string;
  status: Database['public']['Enums']['campaign_status'];
  listId: string;
  /** Null when the list has been archived (soft-deleted, 0238) since this campaign was created, or this caller cannot read it -- see listCampaigns' own header. Never a fabricated name. */
  listName: string | null;
  channel: Database['public']['Enums']['message_channel'];
  templateId: string;
  /** Null when this caller holds messaging.view but not templates.view (0110's own select policy) -- a real, documented gap this screen inherits rather than papers over, the same shape idFragment (messages/lists/lists-grid.tsx) accepts for a promotion/song/show id this caller may not have the matching permission to name. */
  templateName: string | null;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  suppressedCount: number;
  createdByName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CampaignsPage {
  rows: CampaignRecord[];
  nextCursor: string | null;
}

/** One page of rows, the same bound listSendLists (services/send-lists.ts) uses for its own grid. */
export const CAMPAIGN_PAGE_SIZE = 50;

/**
 * Every campaign this caller's `messaging.view` reaches, across every
 * Station -- `message_campaigns_select_messaging_view` (0242) is what
 * actually bounds which rows come back, the same division listSendLists
 * draws for its own read against 0238's policy.
 *
 * ORDERED `created_at desc, id desc`, A TOTAL ORDER, for the reason this
 * project has already paid for once: `created_at` defaults to `now()` and
 * `id` is the primary key, so neither is ever null, unlike the `purpose`
 * column `listTemplates` (services/templates.ts) once ordered its own
 * marketing half by alone -- see listSendLists' own comment for the full
 * story of that defect. A history grid ordered by a nullable column (say,
 * `finished_at`, null for every row still queued or running) would render
 * every unfinished campaign in an undefined order across two loads of the
 * same unchanged data.
 *
 * list/template names and the creator's name are NOT read through a
 * PostgREST embed: nothing else in this codebase's services layer embeds a
 * foreign-key join (listTemplates, services/templates.ts, reads its own
 * `updated_by` name through a second batched query for the identical
 * reason -- `profiles` sits behind `auth.users`, which PostgREST cannot
 * embed across -- and every other cross-table name in this project's grids
 * follows that same shape), so this keeps to it rather than being the first
 * departure.
 */
export async function listCampaigns(
  accessToken: string,
  cursor: Cursor | null = null,
): Promise<CampaignsPage> {
  const client = asCaller(accessToken);

  let query = client
    .from('message_campaigns')
    .select(
      'id, company_id, list_id, channel, template_id, status, total_recipients, sent_count, failed_count, suppressed_count, created_by, created_at, started_at, finished_at',
    )
    .order('created_at', { ascending: false });

  if (cursor) {
    query = query.or(keysetFilter('created_at', 'desc', cursor, false));
  }

  const { data, error } = await query.order('id', { ascending: false }).limit(CAMPAIGN_PAGE_SIZE + 1);
  if (error) throw new InternalError(`Could not list campaigns: ${error.message}`);

  const fetched = data ?? [];
  const more = fetched.length > CAMPAIGN_PAGE_SIZE;
  const page = more ? fetched.slice(0, CAMPAIGN_PAGE_SIZE) : fetched;
  const last = page[page.length - 1];

  const listIds = distinct(page.map((row) => row.list_id));
  const templateIds = distinct(page.map((row) => row.template_id));
  const actorIds = distinct(page.map((row) => row.created_by).filter(isNotNull));

  // Three batched reads, sequential rather than Promise.all -- the same
  // shape listTemplates (services/templates.ts) uses for its own actor-name
  // batch, kept here rather than parallelised so each supabase-js query
  // builder's return type is inferred on its own rather than unified across
  // three different shapes inside one Promise.all array.
  const { data: listRows, error: listsError } =
    listIds.length === 0
      ? { data: [] as { id: string; name: string }[], error: null }
      : await client.from('send_lists').select('id, name').in('id', listIds);
  if (listsError) throw new InternalError(`Could not read the lists behind these campaigns: ${listsError.message}`);

  const { data: templateRows, error: templatesError } =
    templateIds.length === 0
      ? { data: [] as { id: string; internal_name: string }[], error: null }
      : await client.from('message_templates').select('id, internal_name').in('id', templateIds);
  if (templatesError) {
    throw new InternalError(`Could not read the templates behind these campaigns: ${templatesError.message}`);
  }

  const { data: profileRows, error: profilesError } =
    actorIds.length === 0
      ? { data: [] as { id: string; full_name: string | null }[], error: null }
      : await client.from('profiles').select('id, full_name').in('id', actorIds);
  if (profilesError) {
    throw new InternalError(`Could not read who created these campaigns: ${profilesError.message}`);
  }

  const listNameById = new Map((listRows ?? []).map((row) => [row.id, row.name]));
  const templateNameById = new Map((templateRows ?? []).map((row) => [row.id, row.internal_name]));
  const actorNameById = new Map((profileRows ?? []).map((row) => [row.id, row.full_name]));

  return {
    rows: page.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      status: row.status,
      listId: row.list_id,
      listName: listNameById.get(row.list_id) ?? null,
      channel: row.channel,
      templateId: row.template_id,
      templateName: templateNameById.get(row.template_id) ?? null,
      totalRecipients: row.total_recipients,
      sentCount: row.sent_count,
      failedCount: row.failed_count,
      suppressedCount: row.suppressed_count,
      createdByName: row.created_by ? (actorNameById.get(row.created_by) ?? null) : null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    })),
    nextCursor: more && last ? encodeCursor({ value: last.created_at, id: last.id }) : null,
  };
}

export interface CreateCampaignInput {
  companyId: string;
  listId: string;
  channel: Database['public']['Enums']['message_channel'];
  templateId: string;
  memberIds: string[];
  /** Keyed by member id, the exact object shape create_campaign's own p_addresses expects (0243's own comment). */
  addresses: Record<string, string>;
  /** Keyed by member id; each value is a positional string[] for WHATSAPP or a {name, value}[] for EMAIL -- see this file's buildWhatsAppVariableValues/buildEmailVariableValues. */
  variables: Record<string, Json>;
}

/**
 * create_campaign (0243) itself. Every id and value here was resolved by
 * this same file's own audience-and-template functions below, called from
 * the campaigns screen's Server Action (messages/campaigns/actions.ts) --
 * this wrapper trusts none of it further than the RPC call does; the door
 * re-derives the Station from p_company_id and re-checks messaging.send
 * regardless (0243's own body).
 */
export async function createCampaign(input: CreateCampaignInput, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken).rpc('create_campaign', {
    p_company_id: input.companyId,
    p_list_id: input.listId,
    p_channel: input.channel,
    p_template_id: input.templateId,
    p_member_ids: input.memberIds,
    // jsonb on the database side; the generated Json type has no open-object
    // variant, the identical cast services/send-lists.ts's own createSendList
    // uses for its own p_filters, and for the identical reason -- nothing is
    // actually smuggled past the RPC, every value here is plain
    // JSON-serialisable data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_addresses: input.addresses as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_variables: input.variables as any,
  });
  if (error) throw mapCampaignError(error.code, error.message);
  if (typeof data !== 'string') throw new InternalError('create_campaign returned no id');
  return data;
}

export interface CancelCampaignInput {
  campaignId: string;
  reason?: string;
}

/** cancel_campaign (0243) itself. Returns how many still-pending recipient rows it marked cancelled. */
export async function cancelCampaign(input: CancelCampaignInput, accessToken: string): Promise<number> {
  const { data, error } = await asCaller(accessToken).rpc('cancel_campaign', {
    p_campaign_id: input.campaignId,
    // '', not null: cancel_campaign's own body already folds the two
    // together (`nullif(btrim(coalesce(p_reason, '')), '')`, 0243), and the
    // generated Args type for a `text` parameter with no SQL default is
    // `string`, not `string | null` -- p_reason carries no default here.
    p_reason: input.reason ?? '',
  });
  if (error) throw mapCampaignError(error.code, error.message);
  return data ?? 0;
}

export interface RecordCampaignTestSendInput {
  companyId: string;
  channel: Database['public']['Enums']['message_channel'];
  listId: string;
  templateId: string;
  destination: string;
}

/**
 * Task 7 fix round 1 (F2, Important). The ONE write and the ONE permission
 * check a test send goes through -- record_campaign_test_send (0249),
 * called BEFORE any provider is asked to send anything. Its own 42501 means
 * exactly one thing (messaging.send is missing at this Station), so the
 * caller does not check that permission a second time first; it just calls
 * this and reacts to what comes back.
 */
export async function recordCampaignTestSend(
  input: RecordCampaignTestSendInput,
  accessToken: string,
): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('record_campaign_test_send', {
    p_company_id: input.companyId,
    p_channel: input.channel,
    p_list_id: input.listId,
    p_template_id: input.templateId,
    p_destination: input.destination,
  });
  if (error) throw mapCampaignError(error.code, error.message);
}

/** A marketing template's full content, as the new-campaign dialog and the create/test-send actions need it. */
export interface CampaignTemplate {
  id: string;
  channel: Database['public']['Enums']['message_channel'];
  name: string | null;
  language: string | null;
  body: string;
  subject: string | null;
  /** Positional, WHATSAPP only -- empty for EMAIL, whose placeholders are named IN the body/subject instead (see this file's extractEmailVariables). */
  variables: TemplateVariable[];
  otpButton: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
}

/**
 * Reads ONE marketing template (`purpose is null`, 0225) belonging to
 * `companyId`, re-verifying its channel matches `channel` -- the same pair of
 * checks create_campaign's own body makes (0243), so a stale dialog selection
 * (a template archived or recreated on a different channel between load and
 * submit) is caught here with a clear error before the door is ever called,
 * rather than surfacing as the door's own 22023/P0002 with less context.
 *
 * Under `message_templates_select_view` (0110): `templates.view` at
 * `companyId`, a DIFFERENT permission from `messaging.view`/`messaging.send`
 * -- an operator who can reach this screen but holds no `templates.view`
 * here reads zero rows, which this function turns into NotFoundError the
 * same as a genuinely unknown id, rather than a false claim that the
 * template does not exist.
 */
export async function loadCampaignTemplate(
  templateId: string,
  companyId: string,
  channel: Database['public']['Enums']['message_channel'],
  accessToken: string,
): Promise<CampaignTemplate> {
  const { data, error } = await asCaller(accessToken)
    .from('message_templates')
    .select(
      'id, channel, name, language, body, subject, variables, otp_button, from_name, from_email, reply_to',
    )
    .eq('id', templateId)
    .eq('company_id', companyId)
    .is('purpose', null)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new InternalError(`Could not read this campaign's template: ${error.message}`);
  if (!data) throw new NotFoundError(`marketing template not found: ${templateId}`);
  if (data.channel !== channel) {
    throw new ValidationError('this template does not send on the channel requested');
  }

  return {
    id: data.id,
    channel: data.channel,
    name: data.name,
    language: data.language,
    body: data.body,
    subject: data.subject,
    variables: data.variables,
    otpButton: data.otp_button,
    fromName: data.from_name,
    fromEmail: data.from_email,
    replyTo: data.reply_to,
  };
}

export interface CampaignTemplateOption {
  id: string;
  internalName: string;
}

/**
 * The dialog's template dropdown, narrowed to marketing templates
 * (`purpose is null`) of the chosen Station and channel -- ordered by
 * `internal_name, id`, a total order for the reason listCampaigns' own
 * header gives, though this list is short enough that the ordering is a
 * courtesy rather than a defence against a defect this project has already
 * paid for once.
 */
export async function listCampaignTemplateOptions(
  companyId: string,
  channel: Database['public']['Enums']['message_channel'],
  accessToken: string,
): Promise<CampaignTemplateOption[]> {
  const { data, error } = await asCaller(accessToken)
    .from('message_templates')
    .select('id, internal_name')
    .eq('company_id', companyId)
    .eq('channel', channel)
    .is('purpose', null)
    .is('deleted_at', null)
    .order('internal_name', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new InternalError(`Could not list marketing templates: ${error.message}`);
  return (data ?? []).map((row) => ({ id: row.id, internalName: row.internal_name }));
}

/** The one company fact both the create-campaign and test-send paths need for STATION_NAME -- name only; `companies_select_org_member` (0006/0021) admits any member of this Station's Organization, which every caller reaching this screen already is. */
export async function readStationName(companyId: string, accessToken: string): Promise<string> {
  const { data, error } = await asCaller(accessToken)
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new InternalError(`Could not read this Station's name: ${error.message}`);
  if (!data) throw new NotFoundError(`station not found: ${companyId}`);
  return data.name;
}

/** The e-mail sender identity fields the test send needs -- the same four columns loadCompanies (this file's own drain code, above) reads for the real send, for one company rather than a batch. */
export interface StationEmailIdentity {
  name: string;
  logoUrl: string | null;
  emailFromName: string | null;
  emailFromAddress: string | null;
  emailReplyTo: string | null;
}

export async function readStationEmailIdentity(
  companyId: string,
  accessToken: string,
): Promise<StationEmailIdentity> {
  const { data, error } = await asCaller(accessToken)
    .from('companies')
    .select('name, thumb_url, email_from_name, email_from_address, email_reply_to')
    .eq('id', companyId)
    .maybeSingle();
  if (error) throw new InternalError(`Could not read this Station's sender identity: ${error.message}`);
  if (!data) throw new NotFoundError(`station not found: ${companyId}`);
  return {
    name: data.name,
    logoUrl: data.thumb_url,
    emailFromName: data.email_from_name,
    emailFromAddress: data.email_from_address,
    emailReplyTo: data.email_reply_to,
  };
}

// ---------------------------------------------------------------------------
// The variable resolver. PURE FUNCTIONS, no I/O -- everything they need
// (the member's own fields, the Station's name) is read by the caller
// above, so these can be proven directly rather than through a fake
// database (tests/unit/campaigns-variables.test.ts).
// ---------------------------------------------------------------------------

/**
 * One CAMPAIGN_RESOLVABLE value, resolved from the recipient and the
 * Station. The first-name split (below) resolves the same real name
 * enqueue_pickup_reminder's own `split_part(btrim(v_full_name), ' ', 1)`
 * (0112) does for every ordinarily-typed name -- the same idea, in
 * TypeScript rather than a second SQL copy, so a campaign's greeting and a
 * pickup reminder's agree in the cases that matter. NOT BYTE-IDENTICAL
 * (fix round 1, F11): `split(/\s+/)` and Postgres' `' '` split_part
 * diverge on a tab or a non-breaking space inside a name, where
 * JavaScript's \s matches both and Postgres' literal single-space
 * delimiter matches neither -- an edge case neither implementation was
 * written to agree on, not a claim this comment makes any more.
 *
 * A MISSING FIELD RESOLVES TO AN EMPTY STRING, never a placeholder throw --
 * `member.fullName`/`member.city` are both nullable columns (0031), and a
 * listener who never gave a name or a city is a real, if incomplete, row.
 * For EMAIL this is a legitimate value: substitutePlaceholders (this file's
 * drain code, above) only refuses a placeholder NAME it cannot resolve, not
 * a resolved value that happens to be blank. For WHATSAPP, an empty
 * parameter is refused downstream by validateParameters
 * (lib/integrations/whatsapp/template.ts) -- a guaranteed, visible
 * `no_template` outcome on that ONE recipient's row (see this file's own
 * WhatsAppMessagingProvider.send), not a silent success with a blank
 * greeting. Excluding such a listener at snapshot time was considered and
 * rejected: it would make total_recipients disagree with the reach number
 * `listReach` showed the operator before they sent (Task 7 addendum §1's own
 * warning against a second resolution path), for a case -- a listener with
 * no name on file -- that is itself visible data, not a defect in this
 * resolution.
 *
 * Only ever called with one of the four CAMPAIGN_RESOLVABLE-true values:
 * a WhatsApp marketing template's own `variables` is restricted to
 * CAMPAIGN_VARIABLES at save time (marketingTemplateSchema,
 * schemas/templates.ts), and extractEmailVariables below refuses any other
 * name before this function is ever called for EMAIL. The `default` branch
 * is defence against a row written by something that bypassed both, not a
 * reachable path today.
 */
function resolveCampaignVariable(
  variable: TemplateVariable,
  member: Pick<CampaignRecipientDetail, 'fullName' | 'city'>,
  stationName: string,
): string {
  switch (variable) {
    case 'LISTENER_FIRST_NAME': {
      const trimmed = member.fullName?.trim();
      return trimmed ? trimmed.split(/\s+/)[0]! : '';
    }
    case 'LISTENER_FULL_NAME':
      return member.fullName?.trim() ?? '';
    case 'LISTENER_CITY':
      return member.city?.trim() ?? '';
    case 'STATION_NAME':
      return stationName;
    default:
      throw new ValidationError(`${variable} is not a value a campaign can resolve`);
  }
}

/** One recipient's positional WHATSAPP array, in `template.variables`' own order -- see message_campaign_recipients.variables' column comment (0242) for why this order is fixed at snapshot and never re-read against the template's current one afterwards. */
export function buildWhatsAppVariableValues(
  templateVariables: TemplateVariable[],
  member: Pick<CampaignRecipientDetail, 'fullName' | 'city'>,
  stationName: string,
): string[] {
  return templateVariables.map((variable) => resolveCampaignVariable(variable, member, stationName));
}

/**
 * Thrown by extractEmailVariables for a placeholder neither save time gate
 * would have let through -- EXCEPT ONE CASE THAT IS GENUINELY REACHABLE,
 * not merely defensive (fix round 1, F7): save_marketing_template (0225)
 * validates {{...}} names against the vocabulary in v_body ONLY, never in
 * v_subject, and marketingTemplateSchema's own superRefine (schemas/
 * templates.ts) scans only value.body for the identical reason -- neither
 * gate this file's own header used to claim covers "both validations" was
 * ever written to look at an e-mail template's SUBJECT at all. A template
 * saved through the ordinary screen with {{prize_name}} in its subject
 * line -- a typo, not a bypass -- saves cleanly and only surfaces here,
 * the first time a campaign is built from it. A named class, not a bare
 * ValidationError, so the Server Action that calls this can give the
 * operator a translated sentence instead of this constructor's own English.
 */
export class UnresolvableEmailPlaceholderError extends Error {
  readonly placeholder: string;
  constructor(placeholder: string) {
    super(`this template names {{${placeholder}}}, which is not a value a campaign can resolve`);
    this.name = 'UnresolvableEmailPlaceholderError';
    this.placeholder = placeholder;
  }
}

/**
 * Every CAMPAIGN_RESOLVABLE value an e-mail template's body and subject
 * name, deduplicated -- the wide capture matches save_marketing_template's
 * own (0225) and marketingTemplateSchema's own (schemas/templates.ts)
 * captures, BOTH OVER THE BODY ONLY. Reachable through the ordinary screen
 * for the SUBJECT specifically -- see UnresolvableEmailPlaceholderError's
 * own header for why -- and reachable for the BODY only through a row that
 * bypassed both save-time gates.
 */
export function extractEmailVariables(body: string, subject: string): TemplateVariable[] {
  const found = new Set<TemplateVariable>();
  for (const text of [body, subject]) {
    for (const match of text.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const captured = match[1] ?? '';
      const variable = variableFromPlaceholder(captured);
      if (!variable || !CAMPAIGN_RESOLVABLE[variable]) {
        throw new UnresolvableEmailPlaceholderError(captured);
      }
      found.add(variable);
    }
  }
  return [...found];
}

/** One recipient's EMAIL variables -- a named array of {name, value} pairs (Task 7 addendum §3), `name` lower-cased to match the exact notation the body/subject itself uses (namedPlaceholder's own transform) and variableFromPlaceholder's own case-insensitive read on the way back out (drain code, above). */
export function buildEmailVariableValues(
  usedVariables: TemplateVariable[],
  member: Pick<CampaignRecipientDetail, 'fullName' | 'city'>,
  stationName: string,
): { name: string; value: string }[] {
  return usedVariables.map((variable) => ({
    name: variable.toLowerCase(),
    value: resolveCampaignVariable(variable, member, stationName),
  }));
}

/**
 * The Station's active WhatsApp `phone_number_id`, for the test send only.
 *
 * `public.integrations` carries RLS with NO POLICY at all (0057's own
 * comment: "nothing reaches this table through a user-scoped client, by
 * design"), and the one existing authenticated door onto it,
 * `list_integrations` (0130), is gated on `is_platform_admin()` alone -- an
 * installation-wide console, the wrong shape for "may THIS caller test-send
 * from THEIR OWN Station". `campaign_whatsapp_sender` (0248) is the narrow
 * door this screen needed instead: gated on `messaging.view`, the same
 * permission that gates the whole screen and, per the addendum, the test
 * send along with it, and it returns nothing but the `phone_number_id`
 * itself -- "no secret", by 0057's own words.
 */
export async function resolveWhatsAppSenderId(
  companyId: string,
  accessToken: string,
): Promise<string | null> {
  const { data, error } = await asCaller(accessToken).rpc('campaign_whatsapp_sender', {
    p_company_id: companyId,
  });
  if (error) throw mapCampaignError(error.code, error.message);
  return data ?? null;
}

export interface TestSendCampaignInput {
  companyId: string;
  channel: Database['public']['Enums']['message_channel'];
  template: CampaignTemplate;
  /** The one sample listener's own fields, already resolved by the caller (Task 7's action). */
  sampleMember: Pick<CampaignRecipientDetail, 'fullName' | 'city'>;
  /** The phone number or e-mail address the OPERATOR typed -- never a listener's own, see this function's own header. */
  destination: string;
}

/**
 * Sends ONE message through the same provider a real campaign uses
 * (WhatsAppMessagingProvider / EmailMessagingProvider), to an address the
 * operator typed rather than to any listener. THIS FUNCTION ITSELF WRITES
 * NOTHING -- no `message_campaign_recipients` row, no `message_campaigns`
 * row, and no unsubscribe token (`issue_unsubscribe_token`, 0232, is
 * granted to `service_role` alone in any case -- a test send could not
 * mint one even if this function tried). Leaving either of those a trace
 * would corrupt the count an operator reads before deciding whether to
 * send for real (Task 7 brief's own words).
 *
 * ONE audit_logs ROW IS WRITTEN, DELIBERATELY, BUT NOT HERE (fix round 1,
 * F2): record_campaign_test_send (0249) is called by
 * testSendCampaignAction (messages/campaigns/actions.ts) BEFORE this
 * function ever runs, not by this function -- a test send is a send, and
 * spending real provider traffic to a real address with no trace at all
 * was the gap that fix closed. This function's own silence on writes is
 * still real; it just is not the whole of the test send's own contract
 * any more.
 *
 * `unsubscribe: null` on the EMAIL job -- `EmailSendJob.unsubscribe` is
 * required but nullable (provider.ts), and `renderCampaignEmail`
 * (`FrameInput.unsubscribe`) treats it as optional either way: the seam is
 * simply left empty. A real unsubscribe link promises the reader a working
 * way out of a mailing list they are actually on; this recipient consented
 * to nothing and is not on any list, so a link that could never be honoured
 * would be a worse trace than none.
 */
export async function testSendCampaign(
  input: TestSendCampaignInput,
  accessToken: string,
): Promise<SendOutcome> {
  if (input.channel === 'WHATSAPP') {
    if (!input.template.name || !input.template.language) {
      return {
        ok: false,
        retryable: false,
        code: 'no_template',
        description: 'this template is not a registered WhatsApp template',
      };
    }

    const [phoneNumberId, stationName] = await Promise.all([
      resolveWhatsAppSenderId(input.companyId, accessToken),
      readStationName(input.companyId, accessToken),
    ]);
    if (!phoneNumberId) {
      return {
        ok: false,
        retryable: false,
        code: 'no_whatsapp_integration',
        description: 'this station has no active WhatsApp integration',
      };
    }

    const template: Template = {
      name: input.template.name,
      language: input.template.language,
      variables: buildWhatsAppVariableValues(input.template.variables, input.sampleMember, stationName),
      otpButton: input.template.otpButton,
    };

    const provider = new WhatsAppMessagingProvider(resolveWhatsAppTransport());
    const job: WhatsAppSendJob = { channel: 'WHATSAPP', address: input.destination, phoneNumberId, template };
    try {
      return await provider.send(job);
    } catch (cause) {
      // buildTemplatePayload (called from GraphTransport.sendTemplate) throws
      // TemplateLimitError for a shape the Cloud API would reject -- most
      // realistically here, an empty parameter from a sample listener with no
      // name or city on file (resolveCampaignVariable's own comment). The
      // drain (this file's own sendOne) never sees this throw because
      // parseTemplate swallows it to null for a batch that must keep moving;
      // a test send has exactly one recipient and one operator waiting on the
      // result, so it is surfaced as an honest outcome instead.
      if (cause instanceof TemplateLimitError) {
        return { ok: false, retryable: false, code: 'template_limit', description: cause.message };
      }
      throw cause;
    }
  }

  // EMAIL.
  const usedVariables = extractEmailVariables(input.template.body, input.template.subject ?? '');
  const stationIdentity = await readStationEmailIdentity(input.companyId, accessToken);

  // The IDENTICAL substitution the drain itself runs (substitutePlaceholders,
  // this file's own Task 6b code, above) -- not a second, simplified copy: a
  // template that would fail to resolve for a real recipient must fail the
  // same way here, with the same taxonomy code, rather than silently
  // blanking under a hand-rolled replace.
  const values = new Map(
    usedVariables.map((variable) => [
      variable,
      resolveCampaignVariable(variable, input.sampleMember, stationIdentity.name),
    ]),
  );

  const bodyResult = substitutePlaceholders(input.template.body, values);
  if (!bodyResult.ok) {
    return { ok: false, retryable: false, code: bodyResult.code, description: bodyResult.description };
  }
  const subjectResult = substitutePlaceholders(input.template.subject ?? '', values);
  if (!subjectResult.ok) {
    return { ok: false, retryable: false, code: subjectResult.code, description: subjectResult.description };
  }

  const fromName = input.template.fromName ?? stationIdentity.emailFromName ?? null;
  const fromAddress = input.template.fromEmail ?? stationIdentity.emailFromAddress ?? null;
  const replyTo = input.template.replyTo ?? stationIdentity.emailReplyTo ?? null;
  const sender: EmailSenderIdentity | null = fromAddress ? { fromAddress, fromName, replyTo } : null;

  const job: EmailSendJob = {
    channel: 'EMAIL',
    address: input.destination,
    subject: subjectResult.text,
    stationName: stationIdentity.name,
    logoUrl: stationIdentity.logoUrl,
    body: bodyResult.text,
    unsubscribe: null,
    sender,
  };

  const provider = new EmailMessagingProvider(resolveMailer());
  return provider.send(job);
}
