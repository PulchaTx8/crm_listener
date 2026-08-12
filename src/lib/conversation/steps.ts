/**
 * The conversation's vocabulary: the step list, the state that walks it, what
 * the listener sent, and what goes back.
 *
 * Types only. Every value in here is data the engine is HANDED -- that is the
 * whole design (spec §4.4, D7): the step list is computed once when the hashtag
 * arrives and stored, so each turn is a pure function of (steps, answers,
 * message) with no database, no network and no clock behind it.
 *
 * The one import is `import type` from the generated database types, and it is
 * deliberate: `RequestedField` is the TypeScript form of the
 * `promotion_requested_field` enum, and re-declaring the eight strings here
 * would create a second place a ninth field has to be added -- the defect
 * `member_field_value` (0065) exists to prevent on the SQL side. Being a type
 * import it is erased at compile time, so `engine.ts` -- which imports from
 * this file and nothing else of the sort -- reaches no runtime module in
 * `@/lib/supabase`, `@/services` or the transport.
 */
import type { Interactive } from '@/lib/integrations/whatsapp/interactive';
import type { Enums } from '@/lib/supabase/database.types';

/** One of the eight fields a promotion may ask for. `promotion_requested_field`. */
export type RequestedField = Enums<'promotion_requested_field'>;

/** `promotion_question_kind`: the two list-rendered kinds, and free text. */
export type QuestionKind = Enums<'promotion_question_kind'>;

/**
 * One of the ten texts a Station may give its own wording to.
 * `system_message_key` (0109), derived rather than re-declared for exactly the
 * reason the file header gives for `RequestedField`: a hand-written union here
 * would be a second place an eleventh key has to be added, and the two would
 * disagree silently. Derived, `SYSTEM_MESSAGE_DEFAULTS` fails to compile until
 * somebody writes the text that goes with the new key.
 */
export type SystemMessageKey = Enums<'system_message_key'>;

/**
 * Which door a matched hashtag opens: `widget_link_purpose` (Block 19a,
 * 0178). Derived for the same reason `RequestedField` and `SystemMessageKey`
 * are: `LINK_MESSAGE_KEYS` (engine.ts) is `Record<LinkPurpose, ...>`, and a
 * hand-written `'MUSIC' | 'MENU' | 'PROMOTION'` union here would be a second
 * place a fourth purpose has to be added, with nothing to notice if it
 * were not.
 */
export type LinkPurpose = Enums<'widget_link_purpose'>;

/**
 * One Station's own wording. PARTIAL on purpose (D2): a row exists per
 * OVERRIDDEN text, never one per Station, so a missing key is the ordinary
 * case and `resolveSystemMessage` answers it with the code's own default.
 */
export type SystemMessageOverrides = Partial<Record<SystemMessageKey, string>>;

/**
 * One thing the bot asks. Produced by `whatsapp_conversation_steps` (0066) in
 * exactly this order: consent, then the stale fields in the enum's own order,
 * then the promotion's questions in `position` order.
 */
export type Step =
  | { kind: 'consent' }
  | { kind: 'field'; field: RequestedField }
  | { kind: 'question'; questionId: string; questionKind: QuestionKind };

/** One answered question. `optionId` for a list, `answerText` for an essay -- never both. */
export interface QuestionAnswer {
  questionId: string;
  optionId: string | null;
  answerText: string | null;
}

/** Everything the listener has said so far, and nothing they said badly. */
export interface ConversationAnswers {
  fields: Partial<Record<RequestedField, string>>;
  questions: QuestionAnswer[];
}

/**
 * The whole state, deliberately small (spec §4.4). Keyed on
 * `(integrationId, phone)` by the store, never on the listener: the key has to
 * work before anybody has been resolved.
 */
export interface Conversation {
  integrationId: string;
  phone: string;
  promotionId: string;
  memberId: string;
  steps: Step[];
  cursor: number;
  answers: ConversationAnswers;
  reprompts: number;
  /** When the window closes. Owned by the store and the sweep; the engine only carries it. */
  expiresAt: string;
}

/**
 * One message to send. The engine decides *which* message; the shapes
 * themselves live in `interactive.ts`, which is also where the consent
 * message's composition is pinned -- there is exactly one composer for it, and
 * it is not here.
 */
export type Outbound =
  { kind: 'text'; body: string } | { kind: 'interactive'; interactive: Interactive };

/**
 * What arrived, already flattened out of Meta's envelope by the caller.
 * `button` is an `interactive.button_reply`, `list` an `interactive.list_reply`
 * -- kept apart rather than merged into one "reply" so that a list answer at
 * the consent step is refused as the mistake it is instead of being matched by
 * id against a button that happens to share it.
 *
 * `receivedAt` is an ISO 8601 instant: the moment the LISTENER wrote, which is
 * the same timestamp everything else in Block 5a is judged by. It is here
 * because the engine may not read a clock and one validation genuinely needs a
 * reference point -- a birth date has to be in the past, and "the past" is
 * relative to something. It arrives with the message rather than in
 * `PromptContext` because it is a property of the message, not of the
 * promotion. If it does not parse, `age` falls back to a fixed floor rather
 * than rejecting a valid answer over a caller's bad argument (see
 * `parseBirthDate`).
 */
export type InboundAnswer = { receivedAt: string } & (
  | { kind: 'text'; text: string }
  | { kind: 'button'; buttonId: string }
  | { kind: 'list'; optionId: string }
);

/** One question as the listener will see it. `menuTitle`/`buttonLabel` are null only for ESSAY. */
export interface QuestionPrompt {
  prompt: string;
  menuTitle: string | null;
  buttonLabel: string | null;
  options: { id: string; label: string }[];
}

/**
 * Everything the prompts need and the engine must not fetch.
 *
 * `systemMessages` REPLACED a total `fieldPrompts: Record<RequestedField,
 * string>`, and the reason that record was total has not been abandoned — it
 * has moved. It was total so the compiler would refuse a caller that forgot one
 * of the eight, "the failure mode a Partial/lookup-table would turn into a
 * listener receiving an empty message". A partial map is now CORRECT (D2: one
 * row per overridden text, never one per Station), and the guarantee it used to
 * carry is held in two stronger places instead: `SYSTEM_MESSAGE_DEFAULTS` and
 * `FIELD_MESSAGE_KEYS` in engine.ts are both total over their key types, so a
 * ninth requested field still fails to compile, and a missing override resolves
 * to a non-empty constant rather than to nothing. The empty message is
 * unreachable now by construction rather than by the caller remembering.
 *
 * `questions` is keyed by question id and is NOT total -- a promotion's
 * questions are data -- so a step naming a question the context does not carry
 * is a caller bug, and `PromptContextError` says so loudly rather than sending
 * something broken.
 */
export interface PromptContext {
  promotion: {
    name: string;
    callToAction: string | null;
    useArt: boolean;
    artUrl: string | null;
    yesButtonLabel: string | null;
    noButtonLabel: string | null;
  };
  /** This Station's own wording, per text. Absent keys are the ordinary case. */
  systemMessages: SystemMessageOverrides;
  questions: Record<string, QuestionPrompt>;
}

/**
 * What one inbound message did.
 *
 * `complete` carries no outbound: what the listener is told depends on what the
 * final write actually decides (D8 -- the pre-check and the write may disagree,
 * and the reply says what really happened), which is the caller's business, not
 * this module's. `refused` and `abandon` carry no conversation because there is
 * nothing left to save; the caller clears the state.
 */
export type Turn =
  | { kind: 'prompt'; conversation: Conversation; outbound: Outbound }
  | { kind: 'refused'; outbound: Outbound }
  | { kind: 'complete'; conversation: Conversation }
  | { kind: 'abandon'; outbound: Outbound }
  | { kind: 'ignore' };
