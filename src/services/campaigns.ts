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
import { namedPlaceholder, variableFromPlaceholder, type TemplateVariable } from '@/lib/templates/variables';
import { newUnsubscribeToken } from '@/services/consent';
import { env } from '@/lib/env';
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

      if (row.channel === 'WHATSAPP' && !phoneNumberIds.has(row.company_id!)) {
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
        phoneNumberId: row.channel === 'WHATSAPP' ? phoneNumberIds.get(row.company_id!)! : undefined,
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

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isNotNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
