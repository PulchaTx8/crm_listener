/**
 * Where the conversation lives between two messages.
 *
 * The shape Block 0 gave `RateLimiter` (spec D6): an interface with a Postgres
 * implementation as the default and a Redis one switched on by an environment
 * variable. The application boots without Redis, so CI and every developer need
 * no new service, and the Station can turn it on when volume justifies it.
 *
 * **No compare-and-set here.** The advisory lock on `(integration, phone)`
 * (spec §4.3) is what serialises writers, and it lives in Postgres precisely so
 * that it works whichever driver holds the state. A second concurrency
 * mechanism in this interface would be two answers to one question, and the two
 * would eventually disagree.
 */
import { z } from 'zod';
import { Constants } from '@/lib/supabase/database.types';
import type { Conversation } from './steps';

/**
 * D5: thirty minutes of silence and the conversation is gone. Exported, and the
 * only place the number is written -- the Postgres driver puts it in
 * `expires_at`, the Redis driver in the key's TTL, and the runbook quotes it.
 */
export const CONVERSATION_WINDOW_SECONDS = 30 * 60;

/**
 * Keyed on the integration and the phone as WhatsApp delivered it, and NOT on
 * the listener: the key has to work before anybody has been resolved, which is
 * the whole first message of a stranger.
 */
export interface ConversationKey {
  integrationId: string;
  phone: string;
}

export interface ConversationStore {
  /** The live conversation, or null when there is none or the window has passed. */
  load(key: ConversationKey): Promise<Conversation | null>;
  /**
   * Writes the state and RESTARTS the window: thirty minutes of silence is
   * measured from the last message, not from the first. The `expiresAt` on the
   * value handed in is ignored and replaced -- that field is the store's, and
   * `Conversation` says so.
   */
  save(key: ConversationKey, value: Conversation): Promise<void>;
  /** Removes it. Called when the conversation completes, is refused, or is abandoned. */
  clear(key: ConversationKey): Promise<void>;
}

/**
 * A stored state that is not a conversation. Always a bug -- either this
 * module and `start_whatsapp_conversation` (0066) disagree about the shape, or
 * a deploy changed it under a live conversation.
 *
 * It THROWS rather than returning null on purpose. Null would silently restart
 * the listener from the beginning and look, from the outside, exactly like the
 * window having passed; the worker parking the message is a thing somebody can
 * see. The message carries no phone and no answer: this is an error object that
 * may end up in a log.
 */
export class ConversationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationStateError';
  }
}

const requestedField = z.enum(Constants.public.Enums.promotion_requested_field);
const questionKind = z.enum(Constants.public.Enums.promotion_question_kind);

const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('consent') }),
  z.object({ kind: z.literal('field'), field: requestedField }),
  z.object({ kind: z.literal('question'), questionId: z.string(), questionKind }),
  // Block 29c. Never built by whatsapp_conversation_steps (0066) -- that step
  // list ends the moment a participation is recorded, on purpose (spec §6:
  // "runs after the participation is recorded, never before"), so this
  // literal is written by the SERVICE alone, the one time it saves the
  // follow-up conversation `marketingConsentSteps` (engine.ts) produces. It
  // still belongs in this schema: the store validates whatever it reads back
  // on the next turn, and a step this union does not know would fail exactly
  // the way a mismatch between this file and the SQL side always has.
  z.object({ kind: z.literal('marketing_consent') }),
]);

/**
 * The state, validated at the boundary where it comes back as `unknown`.
 *
 * This is where the two languages meet: the object is BUILT in plpgsql by
 * `whatsapp_conversation_steps` and `start_whatsapp_conversation`, and READ
 * here. Nothing else checks that the two agree, and a mismatch would surface as
 * a listener being asked for a field that does not exist, or a turn crashing on
 * an undefined cursor several steps later. Unknown keys are stripped rather
 * than refused, so that adding a field on the SQL side is not an outage; a
 * missing or misnamed required one is still an error, which is the mistake that
 * actually happens.
 */
const conversationSchema = z.object({
  integrationId: z.string().min(1),
  phone: z.string().min(1),
  promotionId: z.string().min(1),
  memberId: z.string().min(1),
  steps: z.array(stepSchema),
  cursor: z.number().int().min(0),
  answers: z.object({
    fields: z.record(requestedField, z.string()),
    questions: z.array(
      z.object({
        questionId: z.string().min(1),
        optionId: z.string().nullable(),
        answerText: z.string().nullable(),
      }),
    ),
  }),
  reprompts: z.number().int().min(0),
  expiresAt: z.string().min(1),
});

/**
 * `where` names the driver and the integration, never the phone or an answer.
 * A parse failure is reported by shape, not by content.
 */
export function parseConversation(raw: unknown, where: string): Conversation {
  const parsed = conversationSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConversationStateError(`stored conversation is not usable (${where}): ${problems}`);
  }
  return parsed.data;
}
