import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  PromptContextError,
  advance,
  firstPrompt,
  marketingConsentSteps,
  resolveSystemMessage,
  toSystemMessageOverrides,
} from '@/lib/conversation/engine';
import type {
  Conversation,
  InboundAnswer,
  Outbound,
  PromptContext,
} from '@/lib/conversation/steps';
import {
  parseConversation,
  type ConversationKey,
  type ConversationStore,
} from '@/lib/conversation/store';
import { isStopWord } from '@/lib/consent/stop-words';
import type { Database, Json } from '@/lib/supabase/database.types';
import { hashCpf } from '@/services/members';
import { sendServiceLink } from '@/services/whatsapp-link';

/**
 * One inbound message, taken from where it stopped to wherever it gets to.
 *
 * The shape of this file follows from one decision (spec §4.3, amended): the
 * engine is a pure function in TypeScript, so a turn is `load -> advance ->
 * write` with the middle step outside the database. That is what makes every
 * branch of the conversation testable with nothing running, and it is why the
 * lease exists -- an advisory lock would be released before the load and after
 * the write, covering neither.
 *
 * The order of writes is fixed and each one is load-bearing:
 *
 *   1. claim the lease, or leave the message for the next tick
 *   2. the turn's DATABASE work first, then the state (spec §4.3)
 *   3. release the lease, whatever happened
 *
 * A prompt is the one case where the state is written before the message goes
 * out, and deliberately: a consent message with no state behind it leaves the
 * listener pressing a button nobody is listening for, while a state with no
 * message sent is answered by the re-prompt the engine already has.
 */

/** How long a lease may be held before another worker may take it over. */
export const TURN_LEASE_STALE_AFTER = '5 minutes';

export interface ConversationDeps {
  supabase: SupabaseClient<Database>;
  store: ConversationStore;
}

export type TurnOutcome =
  /** Another worker holds the lease. The message is left for the next tick. */
  | { kind: 'busy' }
  | { kind: 'started' }
  | { kind: 'prompted' }
  | { kind: 'refused' }
  | { kind: 'completed'; status: string | null }
  | { kind: 'abandoned' }
  /** Nobody is mid-conversation and this message opens none: the silence D4 asks for. */
  | { kind: 'ignored' }
  /** Block 19a. A code was minted and the one message carrying it was enqueued. */
  | { kind: 'link_sent' }
  /**
   * Block 19a, D2's window. `mint_widget_link` answered null: this listener
   * was already answered for this exact purpose inside the last two minutes,
   * and null means say nothing -- the whole protection against five hashtags
   * in a row producing five messages.
   */
  | { kind: 'already_answered' }
  /**
   * Block 29c. The follow-up marketing_consent step was settled -- by a
   * recognised tap (`granted` is what was tapped) or by a stop word typed
   * instead of tapping (`granted` is always false there). Distinct from
   * `completed`: that outcome is a PARTICIPATION being decided, and this one
   * is a CHANNEL PREFERENCE being decided, sometimes several messages later
   * and always after the participation already stands.
   */
  | { kind: 'marketing_consent_recorded'; granted: boolean };

const replySchema = z.object({
  kind: z.enum(['button', 'list']),
  id: z.string().min(1),
  title: z.string(),
});

const startSchema = z.object({
  conversation: z.unknown(),
  promotion: z.object({
    name: z.string(),
    callToAction: z.string().nullable(),
    useArt: z.boolean(),
    artUrl: z.string().nullable(),
    yesButtonLabel: z.string().nullable(),
    noButtonLabel: z.string().nullable(),
  }),
  questions: z.record(z.string(), z.unknown()),
  /**
   * This Station's own wording for the ten system texts (0114). `.default({})`
   * rather than required, and that is not laxity: a Station that has
   * overridden nothing is the ordinary case, and an older deploy's stored
   * document has no such key at all. Absent and empty both mean "use the
   * constants", which is exactly what resolveSystemMessage does with them.
   */
  systemMessages: z.record(z.string(), z.string()).default({}),
});

/**
 * What `ingest_whatsapp_event` hands back on the two outcomes it does not
 * decide itself. Validated here for the same reason the stored state is: it is
 * built in plpgsql and read in TypeScript, and nothing else checks that the two
 * agree.
 */
const inboundTurnSchema = z.object({
  event_id: z.string().min(1),
  external_id: z.string().min(1),
  integration_id: z.string().min(1),
  phone: z.string().min(1),
  received_at: z.string().min(1),
  text: z.string().default(''),
  reply: replySchema.nullable().default(null),
  /** Present only when the message named a promotion this listener may enter. */
  start: startSchema.nullish(),
});

/**
 * Block 19a. What `ingest_whatsapp_event` (0179) hands back for a matched
 * hashtag -- D3's promotion, music or service door -- instead of the
 * `no_hashtag` shape `inboundTurnSchema` above validates. A DIFFERENT shape,
 * not an extension of it: 0179 never populates `external_id`, `received_at`,
 * `text` or `reply` on this outcome (confirmed against the migration, and
 * true of 0070's own `conversation` outcome before it), because nothing on
 * this path needs them -- `dedupe_prefix` carries the same hash `external_id`
 * would, and `mint_widget_link`'s own `now()` is authoritative for the
 * window and the expiry both. `dedupe_prefix` is checked as a sha256 hex
 * digest for the same reason `widget_link_tokens.token_hash` (0178) is.
 *
 * `phone` IS THE DELIVERED FORM, exactly as `inboundTurnSchema`'s own `phone`
 * above is, and it is the ONLY phone this shape carries. Fix round 1's
 * Critical finding: the first cut of 0179 returned the LOCAL form (country
 * code stripped) under `phone` and the delivered form under a second field,
 * `to_phone` -- the store's own contract (`src/lib/conversation/store.ts`)
 * is keyed on the delivered form, so a caller that read `phone` for the
 * store key (as `runConversationTurn` does, for every turn, before it even
 * knows which shape arrived) missed the live conversation for essentially
 * every Brazilian listener, and D7's guarantee -- a listener mid-conversation
 * is never handed a link -- silently did not hold. 0179 now returns exactly
 * one phone field, under the one name and the one meaning both shapes
 * already agreed on; `to_phone` does not exist any more, on this shape or
 * anywhere else in this file, rather than being kept alongside a corrected
 * `phone` as a second name for a value a future caller could still reach for
 * by mistake.
 */
const linkIntentSchema = z.object({
  outcome: z.literal('link'),
  event_id: z.string().min(1),
  integration_id: z.string().min(1),
  company_id: z.string().min(1),
  phone: z.string().min(1),
  member_id: z.string().min(1),
  purpose: z.enum(['MUSIC', 'MENU', 'PROMOTION']),
  promotion_id: z.string().nullable(),
  promotion_name: z.string().nullable(),
  dedupe_prefix: z.string().regex(/^[0-9a-f]{64}$/, 'dedupe_prefix must be a sha256 hex digest'),
});

/** The shape `sendServiceLink` (src/services/whatsapp-link.ts) acts on. */
export type LinkIntent = z.infer<typeof linkIntentSchema>;

export type InboundTurn = z.infer<typeof inboundTurnSchema> & {
  /**
   * Present only when this event is a matched hashtag (D3) rather than a
   * possible answer to a live conversation. Checked in `runConversationTurn`
   * AFTER the live-conversation load (D7) and never before: a live
   * conversation wins over a link intent exactly as it already won over
   * `start`, for the same reason -- a listener halfway through answering
   * questions must never be handed a link.
   */
  link: LinkIntent | null;
};

/** Throws when the door's answer is not one this file can act on. */
export class InboundTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundTurnError';
  }
}

function zodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function parseInboundTurn(raw: unknown): InboundTurn {
  // The discriminator, checked on the raw value before either schema runs:
  // the two shapes share no set of required fields to branch on otherwise
  // (a link intent has no `text`; a no_hashtag turn has no `purpose`), so
  // this is the one field both carry that says which one arrived.
  const outcome =
    typeof raw === 'object' && raw !== null ? (raw as { outcome?: unknown }).outcome : undefined;

  if (outcome === 'link') {
    const parsed = linkIntentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new InboundTurnError(
        `ingest_whatsapp_event returned an unusable link intent: ${zodIssues(parsed.error)}`,
      );
    }
    return {
      event_id: parsed.data.event_id,
      // The same hash the no_hashtag shape calls external_id -- 0179 assigns
      // v_event.external_id to dedupe_prefix too. Carried through rather than
      // left blank so a link turn's external_id agrees with the value a
      // no_hashtag turn for the same event would have carried.
      external_id: parsed.data.dedupe_prefix,
      integration_id: parsed.data.integration_id,
      phone: parsed.data.phone,
      // Unused on this path -- see linkIntentSchema's comment.
      received_at: '',
      text: '',
      reply: null,
      start: null,
      link: parsed.data,
    };
  }

  const parsed = inboundTurnSchema.safeParse(raw);
  if (!parsed.success) {
    // No phone, no text: this message may end up in a log.
    throw new InboundTurnError(`ingest_whatsapp_event returned an unusable turn: ${zodIssues(parsed.error)}`);
  }
  return { ...parsed.data, link: null };
}

export async function runConversationTurn(
  deps: ConversationDeps,
  turn: InboundTurn,
): Promise<TurnOutcome> {
  // D7 is this key, as much as it is the branch order below. The store is
  // keyed on the phone AS WHATSAPP DELIVERED IT (src/lib/conversation/store.ts),
  // and every live conversation row was written under that form -- so
  // `turn.phone` has to BE that form for every shape `parseInboundTurn` can
  // produce, link intents included, or this lookup silently misses the row
  // for whichever shape disagrees (fix round 1's Critical: 0179 briefly
  // returned the LOCAL form here for a link intent, and the branch ordering
  // two lines below this comment could not have caught it -- the ordering
  // was right and the value the ordering keyed on was wrong).
  const key: ConversationKey = { integrationId: turn.integration_id, phone: turn.phone };

  const { data: token, error } = await deps.supabase.rpc('claim_conversation_turn', {
    p_integration_id: key.integrationId,
    p_phone: key.phone,
    p_stale_after: TURN_LEASE_STALE_AFTER,
  });
  if (error) throw error;
  // Not an error and never waited on: another worker is mid-turn for this
  // phone, and waiting would hold this one open for the length of somebody
  // else's HTTPS call to Meta. The event stays PROCESSING and the next tick
  // takes it.
  if (!token) return { kind: 'busy' };

  try {
    const live = await deps.store.load(key);
    if (live) return await advanceLive(deps, turn, live, key);
    // D7. A listener halfway through answering questions is NOT handed a
    // link: the branch above already returned. Nothing starts a new
    // conversation any more (0179 never returns a `start` outcome), so
    // `open` below is reachable only by a conversation the ingest can no
    // longer produce -- kept until the last one still open closes itself,
    // then deleted with the branch.
    if (turn.link) return await sendServiceLink(deps, turn.link);
    if (turn.start) return await open(deps, turn, key);

    // Block 29c, fix round 1, F7. The stop word's OWN case, told apart from
    // the ordinary silence below: no live conversation to answer, which is
    // the ORDINARY shape D4 exists for -- a listener replying to a CAMPAIGN,
    // which never opens a conversation at all. Task 4's own report named
    // this the gap in its cold-path resolution; withdraw_marketing_by_phone
    // (0231) is that door, and it is the only place in this file that
    // resolves a phone to a member without one already in hand -- done IN
    // SQL, through the same shared core (apply_member_lookup, 0061) every
    // other door in this block resolves a listener through, because
    // duplicating phone_normalized's own normalisation here is exactly the
    // drift 0061's header warns against.
    if (turn.reply === null && isStopWord(turn.text)) {
      // F8. The door hands back the STATION, not a boolean, precisely so
      // this reply is not stuck on the code default -- see
      // `marketingStoppedReply` below.
      const { data: companyId, error } = await deps.supabase.rpc('withdraw_marketing_by_phone', {
        p_integration_id: turn.integration_id,
        p_phone: turn.phone,
      });
      if (error) throw error;
      // A stranger, or a listener this STATION never linked, gets the same
      // silence anybody else not mid-conversation gets -- the door itself
      // answers null for exactly that pair of cases (its own comment), so
      // that this file is never tempted to tell either one "removed" for
      // something that never happened here.
      if (companyId) {
        await enqueue(
          deps,
          turn,
          { kind: 'text', body: await marketingStoppedReply(deps, companyId) },
          'marketing_stopped',
        );
      }
      await finish(deps, turn.event_id, 'no_conversation');
      return companyId ? { kind: 'marketing_consent_recorded', granted: false } : { kind: 'ignored' };
    }

    // A message from somebody who is not mid-conversation and whose message
    // opens none. Silence, and the event is closed so it is not retried.
    await finish(deps, turn.event_id, 'no_conversation');
    return { kind: 'ignored' };
  } finally {
    // In a finally, so a turn that throws does not hold a phone for five
    // minutes. The token is checked by the function: if this worker was
    // declared stale and taken over while it worked, this frees nothing, which
    // is correct.
    const { error: releaseError } = await deps.supabase.rpc('release_conversation_turn', {
      p_integration_id: key.integrationId,
      p_phone: key.phone,
      p_token: token,
    });
    if (releaseError) {
      console.error(`conversation turn: could not release the lease: ${releaseError.message}`);
    }
  }
}

/**
 * The first message: the conversation the door assembled is stored, and its
 * opening question goes out.
 *
 * A live conversation WINS over a new hashtag, which is why this runs only when
 * `load` found nothing. Somebody halfway through being asked for their address
 * who types a hashtag is answering the address question badly, not starting
 * again -- and the engine's re-prompt tells them so.
 */
async function open(
  deps: ConversationDeps,
  turn: InboundTurn,
  key: ConversationKey,
): Promise<TurnOutcome> {
  if (!turn.start) throw new InboundTurnError('open() called for a turn that opens nothing');

  const conversation = parseConversation(turn.start.conversation, 'ingest_whatsapp_event');
  const context = promptContext(turn.start);

  const outbound = firstPrompt(conversation, context);
  await deps.store.save(key, conversation);
  await enqueue(deps, turn, outbound, 'consent');
  await finish(deps, turn.event_id, 'conversation');
  return { kind: 'started' };
}

async function advanceLive(
  deps: ConversationDeps,
  turn: InboundTurn,
  conversation: Conversation,
  key: ConversationKey,
): Promise<TurnOutcome> {
  const context = await loadPromptContext(deps, conversation.promotionId);
  const message = inboundAnswer(turn);

  // Block 29c, D4's placement. Checked HERE -- ahead of `advance()`, and only
  // when the live step is the marketing question itself -- never inside it.
  // A listener mid the PROMOTION's own consent/field/question steps who
  // types PARAR is refusing to answer, which the engine already treats as an
  // ordinary bad answer (a re-prompt, then an abandon); routing it here
  // instead would turn an abandoned FIELD into a withdrawal nobody asked
  // for, exactly the miscount D4 warns against. The marketing_consent step
  // is the one place this file can make that promise safely: it is the
  // engine's own follow-up conversation (`marketingConsentSteps`), never a
  // promotion's, so nothing about entering the promotion is at stake here.
  //
  // `isStopWord` is read here, not in engine.ts, so that file's own import
  // rule (its header: "`./steps` and `interactive.ts`, and nothing else")
  // stays exactly what it says -- this is a text-classification decision a
  // CALLER makes, the same class of decision that rule exists to keep out.
  if (
    conversation.steps[conversation.cursor]?.kind === 'marketing_consent' &&
    message.kind === 'text' &&
    isStopWord(message.text)
  ) {
    return await stopMarketingConsent(deps, turn, conversation, context, key);
  }

  let result;
  try {
    result = advance(conversation, message, context);
  } catch (cause) {
    // The context cannot produce a prompt the step list names -- a question
    // deleted from the promotion while somebody was answering it. The
    // conversation cannot go on and cannot be repaired from here, so it ends
    // the way any unusable conversation ends rather than failing this message
    // for ever on every retry.
    if (!(cause instanceof PromptContextError)) throw cause;
    console.error(`conversation turn: the promotion changed under a live conversation: ${cause.message}`);
    await deps.store.clear(key);
    await finish(deps, turn.event_id, 'abandoned');
    return { kind: 'abandoned' };
  }

  switch (result.kind) {
    case 'prompt':
      await deps.store.save(key, result.conversation);
      await enqueue(deps, turn, result.outbound, 'prompt');
      await finish(deps, turn.event_id, 'conversation_turn');
      return { kind: 'prompted' };

    case 'refused': {
      // The engine's refusal is copy, and copy is text. Asserted rather than
      // coerced: an interactive goodbye would mean the engine changed under
      // this file, and a silent null here would enqueue nothing at all.
      if (result.outbound.kind !== 'text') {
        throw new InboundTurnError('the engine produced a refusal that is not a text message');
      }
      const body = result.outbound.body;
      const { error } = await deps.supabase.rpc('record_whatsapp_refusal', {
        p_event_id: turn.event_id,
        p_integration_id: turn.integration_id,
        p_promotion_id: conversation.promotionId,
        p_member_id: conversation.memberId,
        p_to_phone: turn.phone,
        p_body: body,
        p_refused_at: turn.received_at,
        p_dedupe_key: dedupeKey(turn, 'goodbye'),
      });
      if (error) throw error;
      // After the write, never before (spec §4.3): a state cleared first and a
      // write that then failed would lose the refusal AND the conversation.
      await deps.store.clear(key);
      return { kind: 'refused' };
    }

    case 'complete': {
      const { data, error } = await deps.supabase.rpc('complete_whatsapp_conversation', {
        p_event_id: turn.event_id,
        p_integration_id: turn.integration_id,
        p_promotion_id: conversation.promotionId,
        p_member_id: conversation.memberId,
        p_to_phone: turn.phone,
        p_fields: fieldsForWriting(result.conversation) as Json,
        p_questions: result.conversation.answers.questions as unknown as Json,
        p_completed_at: turn.received_at,
        p_dedupe_key: dedupeKey(turn, 'confirmation'),
      });
      if (error) throw error;
      await deps.store.clear(key);
      const status = (data as { status?: string } | null)?.status ?? null;
      // Block 29c. AFTER the clear, never before: `maybeAskMarketingConsent`
      // starts a SEPARATE follow-up conversation under the same key, and
      // starting it ahead of the clear above would have this write undo the
      // one it just made. The participation itself is unconditional on
      // `status` -- complete_whatsapp_conversation already wrote SOMETHING
      // for every status a listener can reach here, VALID or not, and D2's
      // "once per Station" is about the QUESTION having been asked, not
      // about the entry having been VALID.
      //
      // Caught rather than let propagate, the same reasoning the worker route
      // gives its own secondary drains: the entry is ALREADY COMMITTED by the
      // time this runs, and a listener who just got their promotion must not
      // have that turn fail -- and be retried, and re-logged as a failure --
      // over a channel-consent question that failed to send.
      try {
        await maybeAskMarketingConsent(deps, turn, conversation, context, key);
      } catch (cause) {
        console.error(
          `conversation turn: could not offer the marketing consent question: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
      return { kind: 'completed', status };
    }

    case 'abandon':
      await deps.store.clear(key);
      await enqueue(deps, turn, result.outbound, 'goodbye');
      await finish(deps, turn.event_id, 'abandoned');
      return { kind: 'abandoned' };

    case 'ignore':
      await finish(deps, turn.event_id, 'conversation_turn');
      return { kind: 'ignored' };

    case 'marketing_answered':
      await recordMarketingAnswer(deps, conversation, result.granted);
      await deps.store.clear(key);
      await finish(deps, turn.event_id, 'conversation_turn');
      return { kind: 'marketing_consent_recorded', granted: result.granted };
  }
}

/**
 * Block 29c. The question a completed participation may still owe -- never
 * before the entry is safely recorded (§4.3's ordering, restated for this
 * block: an abandoned answer here must not cost anybody their promotion,
 * which is exactly why this runs from `advanceLive`'s `complete` case and
 * nowhere earlier).
 *
 * A SEPARATE, one-step conversation under the SAME key, not a longer step
 * list on the original: `whatsapp_conversation_steps` (0066, SQL) decides
 * the promotion's own steps, and appending a channel-consent question to
 * that list from here would make participation wait on it being answered --
 * the ordering this whole function exists to avoid. `marketingConsentSteps`
 * (engine.ts) is the step list; an empty one means the check below already
 * found a row, and nothing is stored or sent.
 */
async function maybeAskMarketingConsent(
  deps: ConversationDeps,
  turn: InboundTurn,
  conversation: Conversation,
  context: PromptContext,
  key: ConversationKey,
): Promise<void> {
  const companyId = await companyIdForPromotion(deps, conversation.promotionId);
  const asked = await hasWhatsappMarketingConsentRecord(deps, conversation.memberId, companyId);
  const steps = marketingConsentSteps({ ...context, needsMarketingConsent: !asked });
  if (steps.length === 0) return;

  const follow: Conversation = {
    ...conversation,
    steps,
    cursor: 0,
    answers: { fields: {}, questions: [] },
    reprompts: 0,
  };
  const outbound = firstPrompt(follow, { ...context, needsMarketingConsent: true });
  // The state before the message, same as `open()` and the same reason (this
  // file's header): a listener pressing Sim/Não with no state behind it
  // presses a button nobody is listening for.
  await deps.store.save(key, follow);
  await enqueue(deps, turn, outbound, 'marketing_consent');
  // No `finish()` call: complete_whatsapp_conversation already finished THIS
  // event, inside the same transaction that recorded the entry (0071) --
  // finishing it a second time is not this function's to do, and the
  // whitelist finish_whatsapp_turn enforces would refuse a made-up outcome
  // for it besides.
}

/**
 * Block 29c, F8. The Station's own MARKETING_STOPPED wording, resolved the
 * SAME WAY the in-conversation path resolves every one of the ten texts:
 * `resolveSystemMessage` (engine.ts) against whatever override exists, the
 * code default when there is none. `whatsapp_prompt_context` assembles all
 * ten keyed by a promotion; there is no promotion on this path, only the
 * Station `withdraw_marketing_by_phone` (0231) handed back, so this reads
 * the one key this reply actually needs directly off
 * `station_message_templates` -- the same table, the same partial-unique
 * `(company_id, key) where deleted_at is null`, just a narrower read.
 */
async function marketingStoppedReply(deps: ConversationDeps, companyId: string): Promise<string> {
  const { data, error } = await deps.supabase
    .from('station_message_templates')
    .select('body')
    .eq('company_id', companyId)
    .eq('key', 'MARKETING_STOPPED')
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  return resolveSystemMessage(data ? { MARKETING_STOPPED: data.body } : {}, 'MARKETING_STOPPED');
}

/** Block 29c. Whether a `whatsapp_marketing` row already exists for this pair, granted true or false (D2). */
async function hasWhatsappMarketingConsentRecord(
  deps: ConversationDeps,
  memberId: string,
  companyId: string,
): Promise<boolean> {
  const { data, error } = await deps.supabase
    .from('member_consents')
    .select('id')
    .eq('member_id', memberId)
    .eq('company_id', companyId)
    .eq('consent_type', 'whatsapp_marketing')
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/**
 * Block 29c. The Station `record_member_consent` (0034) must be told about --
 * read from the promotion rather than passed down from the integration,
 * because the promotion is what the listener actually just finished
 * answering, and record_member_consent itself refuses a member/company pair
 * that member_linked_to_company does not already hold.
 */
async function companyIdForPromotion(deps: ConversationDeps, promotionId: string): Promise<string> {
  const { data, error } = await deps.supabase
    .from('promotions')
    .select('company_id')
    .eq('id', promotionId)
    .single();
  if (error) throw error;
  return data.company_id;
}

/** Block 29c. The one write both a tap and a stop word settle into. */
async function recordMarketingAnswer(
  deps: ConversationDeps,
  conversation: Conversation,
  granted: boolean,
): Promise<void> {
  const companyId = await companyIdForPromotion(deps, conversation.promotionId);
  const { error } = await deps.supabase.rpc('record_member_consent', {
    p_member_id: conversation.memberId,
    p_company_id: companyId,
    p_consent_type: 'whatsapp_marketing',
    p_granted: granted,
    p_origin: 'conversation',
    p_promotion_id: conversation.promotionId,
  });
  if (error) throw error;
}

/**
 * Block 29c, D4. A stop word typed AT the marketing_consent step, told apart
 * from an ordinary bad answer by the caller (`advanceLive`, above) before
 * `advance()` ever runs. Ends the follow-up conversation exactly as a tap
 * would, plus the one thing a tap does not need: a reply, because a listener
 * who typed a command to stop something is owed the words that say it
 * stopped, where a listener who pressed a button already has WhatsApp's own
 * confirmation that the tap landed.
 */
async function stopMarketingConsent(
  deps: ConversationDeps,
  turn: InboundTurn,
  conversation: Conversation,
  context: PromptContext,
  key: ConversationKey,
): Promise<TurnOutcome> {
  await recordMarketingAnswer(deps, conversation, false);
  await deps.store.clear(key);
  await enqueue(
    deps,
    turn,
    { kind: 'text', body: resolveSystemMessage(context.systemMessages, 'MARKETING_STOPPED') },
    'marketing_stopped',
  );
  await finish(deps, turn.event_id, 'conversation_turn');
  return { kind: 'marketing_consent_recorded', granted: false };
}

/**
 * The answers as the record wants them.
 *
 * The CPF is hashed HERE, in Node, before it is ever an argument -- 0031's rule,
 * because an argument lands in query logs and in backups, and the raw number is
 * stored nowhere. The engine has already normalised it to eleven digits, and
 * `hashCpf` normalises again so the value equals the one the operator's door
 * writes for the same person.
 */
function fieldsForWriting(conversation: Conversation): Record<string, string> {
  const fields: Record<string, string> = { ...conversation.answers.fields };
  if (fields.cpf !== undefined) fields.cpf = hashCpf(fields.cpf);
  return fields;
}

function inboundAnswer(turn: InboundTurn): InboundAnswer {
  if (turn.reply?.kind === 'button') {
    return { kind: 'button', buttonId: turn.reply.id, receivedAt: turn.received_at };
  }
  if (turn.reply?.kind === 'list') {
    return { kind: 'list', optionId: turn.reply.id, receivedAt: turn.received_at };
  }
  return { kind: 'text', text: turn.text, receivedAt: turn.received_at };
}

async function loadPromptContext(
  deps: ConversationDeps,
  promotionId: string,
): Promise<PromptContext> {
  const { data, error } = await deps.supabase.rpc('whatsapp_prompt_context', {
    p_promotion_id: promotionId,
  });
  if (error) throw error;
  const parsed = startSchema
    .omit({ conversation: true })
    .safeParse(data as Record<string, unknown> | null);
  if (!parsed.success) {
    throw new InboundTurnError(`whatsapp_prompt_context returned nothing usable for a promotion`);
  }
  return promptContext(parsed.data);
}

function promptContext(source: {
  promotion: PromptContext['promotion'];
  questions: Record<string, unknown>;
  systemMessages: Record<string, string>;
}): PromptContext {
  return {
    promotion: source.promotion,
    // The Station's own words where it has given any, and the constants in
    // engine.ts everywhere else — per text, never per Station (D2). Narrowed
    // rather than cast: the map crossed a jsonb boundary and its keys are only
    // as trustworthy as the enum that produced them.
    systemMessages: toSystemMessageOverrides(source.systemMessages),
    questions: source.questions as PromptContext['questions'],
    // Block 29c. Always false here: this context is built once per ORDINARY
    // turn (`open`, `loadPromptContext`), before a participation exists to
    // ask the marketing question about. `maybeAskMarketingConsent` builds its
    // own copy with the real answer, the one time it is worth a query.
    needsMarketingConsent: false,
  };
}

/**
 * Every dedupe key in this block is '<sha256 of the wamid>:<what it is>' (0059),
 * keyed on the MESSAGE that provoked the send. A turn re-run after a crash
 * enqueues nothing new, and no raw provider id is written down.
 */
function dedupeKey(turn: InboundTurn, what: string): string {
  return `${turn.external_id}:${what}`;
}

async function enqueue(
  deps: ConversationDeps,
  turn: InboundTurn,
  outbound: Outbound,
  what: string,
): Promise<void> {
  const { error } = await deps.supabase.rpc('enqueue_whatsapp_outbound', {
    p_integration_id: turn.integration_id,
    p_to_phone: turn.phone,
    // An interactive message still carries its words in `body`: an operator
    // asked what somebody was told can answer without rendering anything.
    p_body: outbound.kind === 'text' ? outbound.body : outbound.interactive.body,
    p_interactive: outbound.kind === 'text' ? null : (outbound.interactive as unknown as Json),
    p_dedupe_key: dedupeKey(turn, what),
  });
  if (error) throw error;
}

async function finish(deps: ConversationDeps, eventId: string, outcome: string): Promise<void> {
  const { error } = await deps.supabase.rpc('finish_whatsapp_turn', {
    p_event_id: eventId,
    p_outcome: outcome,
  });
  if (error) throw error;
}
