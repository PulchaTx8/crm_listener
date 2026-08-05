import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  PromptContextError,
  advance,
  firstPrompt,
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
import type { Database, Json } from '@/lib/supabase/database.types';
import { hashCpf } from '@/services/members';

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
  | { kind: 'ignored' };

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

export type InboundTurn = z.infer<typeof inboundTurnSchema>;

/** Throws when the door's answer is not one this file can act on. */
export class InboundTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboundTurnError';
  }
}

export function parseInboundTurn(raw: unknown): InboundTurn {
  const parsed = inboundTurnSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    // No phone, no text: this message may end up in a log.
    throw new InboundTurnError(`ingest_whatsapp_event returned an unusable turn: ${problems}`);
  }
  return parsed.data;
}

export async function runConversationTurn(
  deps: ConversationDeps,
  turn: InboundTurn,
): Promise<TurnOutcome> {
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
    if (turn.start) return await open(deps, turn, key);

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
  }
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
