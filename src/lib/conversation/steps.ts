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
 * How a field is ANSWERED, as opposed to what it is called.
 *
 * Every requested field until the gender block was free text, and the two
 * places that ask for one said so structurally: `promptFor`'s `case 'field'`
 * returned `{ kind: 'text' }` unconditionally, and the widget rendered an
 * `<input type="text">` per step. A tenth field that is a closed set of three
 * needs both of them to do something else.
 *
 * A SHAPE, NOT `if (field === 'gender')`. The special case would have been two
 * lines shorter and would have to be written a second time for the next closed
 * set — and this product has obvious candidates for one (a favourite show, a
 * preferred contact channel). Total over `RequestedField`, like `FIELD_PROMPTS`
 * and `FIELD_MESSAGE_KEYS` in engine.ts, so an eleventh field does not compile
 * until somebody says which shape it is rather than defaulting to text and
 * being discovered by a listener.
 *
 * IT LIVES HERE RATHER THAN IN engine.ts because it has two consumers and they
 * may not import each other: `engine.ts` is worker code with a deliberate
 * import rule (its own header), and the widget is a browser bundle. This module
 * is the vocabulary both already share, and it is types plus two frozen
 * constants — nothing here reaches a database, a network or a clock.
 */
export type FieldShape = 'text' | 'choice';

export const FIELD_SHAPE: Record<RequestedField, FieldShape> = {
  full_name: 'text',
  address: 'text',
  city: 'text',
  neighbourhood: 'text',
  age: 'text',
  gender: 'choice',
  cpf: 'text',
  passport: 'text',
  discovery_source: 'text',
  // Free text on purpose, and the near miss is worth naming: a country IS a
  // closed set, and Block 28 still asked for it as prose resolved by
  // `country_alpha2` (0213). The reason holds here too — a list of every
  // country is not a WhatsApp message anybody reads — and it is exactly why
  // this is a per-field shape rather than "closed sets are choices".
  country: 'text',
};

/**
 * What `members.gender` may hold (0220's CHECK), and what a choice-shaped
 * `gender` step accepts back.
 *
 * FOUR STATES, THREE OF THEM STORABLE. `N` is "asked, and declined"; the fourth
 * is the column being null, which is "nobody asked". A campaign filter that
 * folded those two together would report a refusal as an unfilled form, and
 * telling them apart is free — one is a value and the other is its absence.
 */
export const GENDER_VALUES = ['M', 'F', 'N'] as const;
export type GenderValue = (typeof GENDER_VALUES)[number];

/**
 * The id each of the three reply buttons carries, and by which the answer is
 * recognised when it comes back — the same mechanism `CONSENT_YES_ID` uses at
 * the consent step (engine.ts), for the same reason: an id this list does not
 * hold is not an answer to this question, and gets a re-prompt rather than a
 * guess.
 *
 * PREFIXED, so the three cannot collide with a promotion question's option ids
 * (uuids) or with the two consent ids. The value is recovered by
 * `genderFromButtonId` below rather than by slicing the string at a call site.
 */
export const GENDER_BUTTON_IDS: Record<GenderValue, string> = {
  M: 'gender_M',
  F: 'gender_F',
  N: 'gender_N',
};

/** The value a gender button id stands for, or null if it stands for none. */
export function genderFromButtonId(buttonId: string): GenderValue | null {
  const match = GENDER_VALUES.find((value) => GENDER_BUTTON_IDS[value] === buttonId);
  return match ?? null;
}

/**
 * `FIELD_SHAPE` for a caller that holds a plain string rather than a
 * `RequestedField`, which is the widget's situation: `readSteps`
 * (lib/widget/promotion-mapping.ts) parses steps out of a jsonb column and keeps
 * `field` as `string` on purpose, so a promotion configured with a value this
 * build has never heard of renders as an unknown field instead of crashing the
 * form.
 *
 * An unknown field is TEXT, and that is the safe direction rather than an
 * arbitrary one: a text input accepts whatever a choice would have offered,
 * where a choice with no options is a field nobody can fill in. The value still
 * has to survive `apply_member_field_values` at the far end, which resolves what
 * it knows and leaves the rest alone.
 */
export function fieldShapeOf(field: string): FieldShape {
  return FIELD_SHAPE[field as RequestedField] ?? 'text';
}

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
  | { kind: 'question'; questionId: string; questionKind: QuestionKind }
  // NOT a RequestedField, and that is the structural decision of Block 29c.
  // Requested fields are what a PROMOTION asks and an operator picks from; as
  // one of those, whether the product asks for marketing consent at all would
  // depend on each operator remembering to tick a box, and compliance would be
  // a per-promotion accident. It is a step of the engine instead.
  | { kind: 'marketing_consent' };

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
  /**
   * Block 29c, D2's "once". Whether the SERVICE has checked `member_consents`
   * and found no `whatsapp_marketing` row for this listener at this Station
   * yet -- a lookup the engine may not do itself (this file's own header: no
   * database, no clock). False on every context built for an ordinary turn,
   * because that lookup is only useful the moment a participation has just
   * been recorded (`marketingConsentSteps`, engine.ts) and running it on
   * every turn would be a query twenty-nine turns out of thirty never need.
   * True is therefore never the DEFAULT for a context -- it is something the
   * service sets deliberately, once, right before deciding whether to ask.
   */
  needsMarketingConsent: boolean;
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
  | { kind: 'ignore' }
  /**
   * Block 29c. The marketing_consent step was answered by a recognised tap.
   * Carries neither `conversation` nor `outbound`, the same reasoning
   * `refused`/`abandon` give for carrying no conversation: this step is
   * always the only one in its own follow-up conversation (`engine.ts`,
   * `marketingConsentSteps`), so there is nothing left to save, and the
   * answer is silence rather than a reply -- the tap is its own confirmation,
   * the same way a WhatsApp button stays visibly pressed. `granted` is the
   * one value the caller could not otherwise recover: it is what
   * `record_member_consent` (0034) needs and the engine is the only place
   * that reads `MARKETING_YES_ID`/`MARKETING_NO_ID` off the wire.
   */
  | { kind: 'marketing_answered'; granted: boolean };
