/**
 * The conversation, as a pure function.
 *
 * `(steps, answers, message) -> (outbound, next state)`. No database, no
 * WhatsApp, no clock: every value this needs arrives in the `Conversation`, the
 * `InboundAnswer` or the `PromptContext`. That is what computing the step list
 * once (spec D7) buys, and it is why every branch below is unit-testable with
 * nothing running.
 *
 * The rule that keeps it true: **this file imports from `./steps` and from
 * `interactive.ts`, and from nothing else.** Not `@/services`, not
 * `@/lib/supabase`, not the transport. A single import from those paths would
 * mean a decision that belongs to a caller had been taken here.
 *
 * What it does NOT own: message shape. The consent message is composed by
 * `buildConsentInteractive`, beside the other message-shape code and pinned by
 * its own tests. Two places composing one message is a defect this project has
 * been returned for before; this module decides WHICH message, never how it
 * reads.
 */
import { buildConsentInteractive } from '@/lib/integrations/whatsapp/interactive';
// The gender block. VALUES, not types, and the only ones this module imports
// from `./steps` — which the file header allows and the header's reasoning
// still holds: `./steps` is the shared vocabulary, it reaches no database, no
// network and no clock, and putting the field's SHAPE here instead would put it
// out of the widget's reach (see FIELD_SHAPE's own comment).
import {
  FIELD_SHAPE,
  GENDER_BUTTON_IDS,
  GENDER_VALUES,
  genderFromButtonId,
} from './steps';
import type {
  Conversation,
  ConversationAnswers,
  GenderValue,
  InboundAnswer,
  LinkPurpose,
  Outbound,
  PromptContext,
  QuestionPrompt,
  RequestedField,
  Step,
  SystemMessageKey,
  SystemMessageOverrides,
  Turn,
} from './steps';

/**
 * The ids the two consent buttons carry, and by which their replies are
 * recognised when they come back. Any other id at the consent step is not an
 * answer to this question -- an old message re-pressed, or something else
 * entirely -- and gets a re-prompt rather than a guess.
 */
export const CONSENT_YES_ID = 'consent_yes';
export const CONSENT_NO_ID = 'consent_no';

/**
 * The marketing step's own button ids.
 *
 * SEPARATE FROM CONSENT_YES_ID/CONSENT_NO_ID above, which are the promotion's
 * rules acceptance. Sharing them would make one tap mean two consents, which is
 * exactly the bundling the LGPD treats as no consent at all.
 */
export const MARKETING_YES_ID = 'marketing_yes';
export const MARKETING_NO_ID = 'marketing_no';

/**
 * Null rather than false for an unrecognised tap: a listener who typed
 * something has not declined, and writing a `granted = false` row they never
 * asked for is worse than asking again.
 */
export function marketingAnswerFromButtonId(buttonId: string): boolean | null {
  if (buttonId === MARKETING_YES_ID) return true;
  if (buttonId === MARKETING_NO_ID) return false;
  return null;
}

/**
 * The marketing question's own two buttons, Sim/Não. NOT overridable by a
 * Station -- the same asymmetry GENDER_BUTTON_LABELS carries below, and for
 * the same reason: station_message_templates (0109) holds one body per key,
 * so a Station may already reword the QUESTION
 * (SYSTEM_MESSAGE_DEFAULTS.MARKETING_CONSENT) and cannot reword its two
 * ANSWERS.
 */
export const MARKETING_YES_BUTTON_LABEL = 'Sim';
export const MARKETING_NO_BUTTON_LABEL = 'Não';

/**
 * Listener-facing copy. Portuguese, per the block's language rule (code and
 * comments English; only what the listener reads is not), and constants rather
 * than columns because the owner called them copy, changeable without a
 * migration (spec §4.1).
 *
 * The Templates block does not overturn that reasoning — it extends it. These
 * stay constants and stay changeable without a migration; they are now also
 * changeable without a DEPLOY, by a Station, one text at a time. What they
 * became is the FLOOR: `SYSTEM_MESSAGE_DEFAULTS` below collects them, and
 * `resolveSystemMessage` returns a Station's own wording when it has some and
 * these when it has not. An absent override is a valid state, never a hole.
 */
export const DEFAULT_YES_BUTTON_LABEL = 'Quero!';
export const DEFAULT_NO_BUTTON_LABEL = 'Agora não';
export const REFUSAL_MESSAGE = 'Tudo bem! Não vamos te inscrever nesta promoção. Obrigado!';

/**
 * The two halves of a WhatsApp list message, as copy rather than as something an
 * operator types (Block 24, D3).
 *
 * THEY ARE NOT DEFAULTS THE WAY THE TWO ABOVE ARE, and the difference matters.
 * `label()` below falls back to the yes/no defaults when a column is blank, so
 * those two are read at SEND time. These two are read at WRITE time, by
 * `savePromotionQuestionAction`, because `promotion_questions_list_fields`
 * (`0041`) requires `menu_title` and `button_label` to be present and non-blank
 * on every QUIZ — a question saved without them is a question the database
 * refuses, not one this file could paper over later.
 *
 * They live here anyway, with the rest of the listener-facing copy, because that
 * is what they are: the words a listener reads above the options and on the
 * button that opens them. The Quiz screen stopped asking an operator to invent
 * them once the widget became the door most Stations use.
 *
 * The lengths are WhatsApp's own and are why these two strings are short: a
 * section title is capped at 24 characters and a button at 20, and Meta
 * truncates silently past either, which reads as a bug in us.
 */
export const DEFAULT_QUESTION_MENU_TITLE = 'Escolha uma opção';
export const DEFAULT_QUESTION_BUTTON_LABEL = 'Responder';

/**
 * What the bot asks for each field, and the whole message rather than a column
 * heading -- somebody reading "cidade" on WhatsApp has no form around it to
 * explain what is wanted.
 *
 * Copy, so it lives here with the rest of it and not in a column: a promotion
 * has no per-field wording to override, and D6 of the 4a spec settled that a
 * requested field would never carry settings of its own. A TOTAL record, so the
 * compiler refuses a tenth field that nobody wrote a question for -- the failure
 * mode a lookup table would turn into a listener receiving an empty message.
 * Block 28's `country` is what that promise was written for: adding the enum
 * value named this file, FIELD_MESSAGE_KEYS, SYSTEM_MESSAGE_DEFAULTS and two
 * screens, and named them all at once.
 */
export const FIELD_PROMPTS: Record<RequestedField, string> = {
  full_name: 'Qual é o seu nome completo?',
  address: 'Qual é o seu endereço? (rua, número e complemento)',
  city: 'Em qual cidade você mora?',
  neighbourhood: 'Em qual bairro você mora?',
  age: 'Qual é a sua data de nascimento? (dia/mês/ano)',
  // The gender block. Sent with three reply buttons rather than as a bare
  // question (FIELD_SHAPE, ./steps), so it does NOT end in the instruction its
  // neighbours carry -- "(dia/mês/ano)" tells somebody how to type an answer,
  // and this one is answered by pressing.
  //
  // It still has to read as a question to somebody who types anyway, because
  // the WhatsApp keyboard stays open beneath the buttons and some people will.
  gender: 'Qual é o seu sexo?',
  cpf: 'Qual é o seu CPF? (só os números)',
  passport: 'Qual é o número do seu passaporte?',
  discovery_source: 'Como você conheceu a nossa rádio?',
  // Block 28, D10. Asked only by a promotion that requests it — the diaspora
  // case is real (a Brazilian in Portugal listening to a Maranhão station) and
  // rare, and a question nobody needs is a listener who stops answering. The
  // answer is free text and reaches members.country through country_alpha2
  // (0213), never raw: that column is a key the maps group by.
  country: 'Em qual país você mora?',
};
export const ABANDON_MESSAGE =
  'Não consegui entender a resposta. Vamos parar por aqui — é só mandar a hashtag de novo quando quiser tentar outra vez.';

/**
 * The three reply buttons the one choice-shaped field goes out with.
 *
 * WHY BUTTONS AT ALL, when `country` — also a closed set — is asked as prose:
 * three options fit, and a country's two hundred do not. The Cloud API caps a
 * reply-button message at three (`MAX_BUTTONS`, interactive.ts), which is
 * exactly the number this field has, and a fourth option would push it to the
 * LIST shape a promotion question already uses.
 *
 * THE LABELS ARE NOT OVERRIDABLE BY A STATION, and that is declared debt rather
 * than an oversight. `station_message_templates` (0109) holds ONE BODY PER KEY,
 * so a Station can already reword the QUESTION (`SYSTEM_MESSAGE_DEFAULTS.GENDER`)
 * and cannot reword its three ANSWERS. The asymmetry is real and is named in
 * §5b of the Block 29 brief with what closing it costs.
 *
 * Every label is inside the Cloud API's 20-character button cap, checked by
 * `validateButtons` at build time — but a label that FITS is not the same as one
 * that fits comfortably, and "Prefiro não dizer" was chosen over the more usual
 * "Prefiro não informar" (exactly 20) so that a future edit has somewhere to go
 * before it starts throwing.
 *
 * PORTUGUESE, like every constant in this file that a listener reads.
 */
export const GENDER_BUTTON_LABELS: Record<GenderValue, string> = {
  M: 'Masculino',
  F: 'Feminino',
  N: 'Prefiro não dizer',
};

/**
 * Block 19a. The three texts a matched hashtag now sends, one per purpose, in
 * front of the link `sendServiceLink` (src/services/whatsapp-link.ts)
 * appends. Portuguese, same rule as every other constant in this block: a
 * listener reads these, so English identifiers, English comments, and the
 * one exception is the words themselves.
 */
export const DEFAULT_MUSIC_LINK_TEXT =
  'Toque no link para pedir sua música. Ele vale por 15 minutos:';
export const DEFAULT_MENU_LINK_TEXT =
  'Toque no link para falar com a gente. Ele vale por 15 minutos:';
export const DEFAULT_PROMOTION_LINK_TEXT =
  'Toque no link para participar. Ele vale por 15 minutos:';

/**
 * Block 29c. Consent to marketing on a channel.
 */
export const MARKETING_CONSENT_MESSAGE =
  'Quer receber as promoções e notícias da nossa rádio por aqui?';
export const MARKETING_STOPPED_MESSAGE =
  'Pronto! Não vamos mais te enviar promoções por aqui.';

/**
 * The two override types live in `./steps` with the rest of the vocabulary and
 * are re-exported here, where the defaults and the resolver are — so a caller
 * needing the system texts imports one module rather than two.
 */
export type { SystemMessageKey, SystemMessageOverrides } from './steps';

/**
 * Which key carries each requested field's prompt.
 *
 * TOTAL, and that is the whole point of it existing rather than a
 * `field.toUpperCase()`: a NEW `RequestedField` fails to compile HERE as well
 * as in `FIELD_PROMPTS`, so the pair cannot drift into a field whose prompt
 * nobody can override and, worse, a key that resolves to nothing.
 */
export const FIELD_MESSAGE_KEYS: Record<RequestedField, SystemMessageKey> = {
  full_name: 'FULL_NAME',
  address: 'ADDRESS',
  city: 'CITY',
  neighbourhood: 'NEIGHBOURHOOD',
  age: 'AGE',
  gender: 'GENDER',
  cpf: 'CPF',
  passport: 'PASSPORT',
  discovery_source: 'DISCOVERY_SOURCE',
  country: 'COUNTRY',
};

/**
 * Block 19a's mirror of `FIELD_MESSAGE_KEYS` above, for the one other family
 * of copy a purpose picks a key from rather than a field: which of the three
 * LINK_* texts `sendServiceLink` puts in front of the link. Keyed on
 * `LinkPurpose` (`./steps`, the TypeScript form of `widget_link_purpose`,
 * 0178) rather than a hand-written `'MUSIC' | 'MENU' | 'PROMOTION'` union --
 * final review: the hand-written form made the same TOTAL claim this
 * comment used to state ("a fourth purpose... would fail to compile here")
 * without the compiler actually enforcing it, since a union re-typed by hand
 * can drift silently from the enum it was meant to mirror. Derived, the
 * claim is now true: a fourth value the enum grows fails this object
 * literal until somebody writes the LINK_* key that goes with it, the same
 * guarantee FIELD_MESSAGE_KEYS already has for RequestedField.
 */
export const LINK_MESSAGE_KEYS: Record<LinkPurpose, SystemMessageKey> = {
  MUSIC: 'LINK_MUSIC',
  MENU: 'LINK_MENU',
  PROMOTION: 'LINK_PROMOTION',
};

/** The constants above, collected under the keys a Station overrides them by. */
export const SYSTEM_MESSAGE_DEFAULTS: Record<SystemMessageKey, string> = {
  REFUSAL: REFUSAL_MESSAGE,
  ABANDON: ABANDON_MESSAGE,
  FULL_NAME: FIELD_PROMPTS.full_name,
  ADDRESS: FIELD_PROMPTS.address,
  CITY: FIELD_PROMPTS.city,
  NEIGHBOURHOOD: FIELD_PROMPTS.neighbourhood,
  AGE: FIELD_PROMPTS.age,
  GENDER: FIELD_PROMPTS.gender,
  CPF: FIELD_PROMPTS.cpf,
  PASSPORT: FIELD_PROMPTS.passport,
  DISCOVERY_SOURCE: FIELD_PROMPTS.discovery_source,
  COUNTRY: FIELD_PROMPTS.country,
  LINK_MUSIC: DEFAULT_MUSIC_LINK_TEXT,
  LINK_MENU: DEFAULT_MENU_LINK_TEXT,
  LINK_PROMOTION: DEFAULT_PROMOTION_LINK_TEXT,
  MARKETING_CONSENT: MARKETING_CONSENT_MESSAGE,
  MARKETING_STOPPED: MARKETING_STOPPED_MESSAGE,
};

/**
 * The Station's wording for one text, or the code's own if it has none.
 *
 * PER TEXT, never per Station. A Station that overrides the city prompt keeps
 * the other nine defaults — the all-or-nothing alternative is invisible until
 * a Station with one override goes silent on everything else, and silence is
 * what this whole block exists to end.
 *
 * A blank override resolves to the default rather than to nothing. 0109's
 * check constraint refuses a blank body and so does its door; this is the
 * third guard, and the only one standing at the moment the message is chosen.
 */
export function resolveSystemMessage(
  overrides: SystemMessageOverrides,
  key: SystemMessageKey,
): string {
  const override = overrides[key];
  return override !== undefined && override.trim() !== '' ? override : SYSTEM_MESSAGE_DEFAULTS[key];
}

/**
 * Narrows an untrusted key/text map to the texts this engine knows about.
 *
 * The map arrives as jsonb built in plpgsql (0114) and read in TypeScript, and
 * a `Record<string, string>` says nothing about which keys are in it. Rather
 * than a second list to keep in step with the enum, the keys are
 * checked against `SYSTEM_MESSAGE_DEFAULTS`, which is total over
 * `SystemMessageKey` and so cannot fall behind it.
 *
 * An unknown key is DROPPED rather than carried: the column is enum-typed so
 * one should be unreachable, and a value nothing resolves is a value nothing
 * should keep.
 */
export function toSystemMessageOverrides(source: Record<string, string>): SystemMessageOverrides {
  const overrides: SystemMessageOverrides = {};
  for (const [key, body] of Object.entries(source)) {
    if (key in SYSTEM_MESSAGE_DEFAULTS) overrides[key as SystemMessageKey] = body;
  }
  return overrides;
}

/**
 * Re-prompts allowed at ONE step; the fourth failure there ends the
 * conversation (spec §5). The counter resets when a step is answered, so three
 * mistakes spread across a long conversation do not end it -- without the reset
 * a six-step conversation would throw out a listener who mistyped once every
 * other step, which is the opposite of what a cap is for. Without the cap a
 * confused listener burns paid messages indefinitely.
 */
export const MAX_REPROMPTS_PER_STEP = 3;

/**
 * A birth date more than this many years before the message is not a date a
 * listener could have been born on. The oldest verified human lived 122 years;
 * this is a sanity bound on a typo, not a claim about longevity.
 */
const MAX_HUMAN_AGE_YEARS = 120;

/**
 * The floor used when the message carries no usable instant. Only reachable
 * through a caller bug -- see `parseBirthDate`.
 */
const EARLIEST_PLAUSIBLE_BIRTH_YEAR = 1900;

/** Thrown when the context cannot produce the prompt the cursor asks for. Always a caller bug. */
export class PromptContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptContextError';
  }
}

/**
 * The message that opens the conversation: the prompt for the step the cursor
 * is on, which for a conversation that has just started is the consent message.
 */
export function firstPrompt(conversation: Conversation, context: PromptContext): Outbound {
  const step = conversation.steps[conversation.cursor];
  if (!step) {
    throw new PromptContextError(
      `no step at cursor ${conversation.cursor} of ${conversation.steps.length}`,
    );
  }
  return promptFor(step, context);
}

/**
 * One inbound message, one decision.
 *
 * Order matters here: an answer is VALIDATED, then stored, then the cursor
 * moves. A value that does not fit its step is never written to `answers` --
 * storing first and rejecting after would leave a rejected value in the state
 * that the final write would happily put on the listener's record.
 */
export function advance(
  conversation: Conversation,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
  const step = conversation.steps[conversation.cursor];
  // Nothing left to answer. The state has not been cleared yet (the caller
  // does that after the final write), so a straggler arrives here rather than
  // at a closed window; it is not an error and it is not a re-prompt.
  if (!step) return { kind: 'ignore' };

  switch (step.kind) {
    case 'consent':
      return consentTurn(conversation, message, context);
    case 'field':
      return fieldTurn(conversation, step.field, message, context);
    case 'question':
      return questionTurn(conversation, step, message, context);
    case 'marketing_consent':
      return marketingConsentTurn(conversation, message, context);
  }
}

/**
 * Block 29c. Answered by a tap, and by nothing else -- the same rule
 * `consentTurn` states for the promotion's own two buttons. Text is not a
 * second way to answer this one the way it is for the gender field: a stop
 * word typed here is withdrawal, not an answer, and reading it is the
 * SERVICE's job (`advanceLive`, src/services/conversation.ts), not this
 * function's -- this module may import only `./steps` and `interactive.ts`
 * (this file's header), and `@/lib/consent/stop-words` is neither.
 */
function marketingConsentTurn(
  conversation: Conversation,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
  if (message.kind !== 'button') return failure(conversation, context);
  const granted = marketingAnswerFromButtonId(message.buttonId);
  if (granted === null) return failure(conversation, context);
  return { kind: 'marketing_answered', granted };
}

function consentTurn(
  conversation: Conversation,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
  if (message.kind !== 'button') return failure(conversation, context);
  if (message.buttonId === CONSENT_NO_ID) {
    return {
      kind: 'refused',
      outbound: {
        kind: 'text',
        body: resolveSystemMessage(context.systemMessages, 'REFUSAL'),
      },
    };
  }
  if (message.buttonId !== CONSENT_YES_ID) return failure(conversation, context);
  return answered(conversation, conversation.answers, context);
}

/**
 * WHY A BUTTON ANSWER DOES NOT REPLACE THE TEXT ONE, but sits beside it.
 *
 * The three buttons go out and the WhatsApp keyboard stays open underneath
 * them. Somebody types "masculino". If this function accepted only the button,
 * that reply would be a `failure()`, and three of them abandon the conversation
 * — on a field the promotion marked optional, taking every answer already given
 * with it. So a choice-shaped field accepts BOTH, and the two converge:
 *
 *   button -> `genderFromButtonId` -> 'M' | 'F' | 'N'
 *   text   -> stored raw -> `gender_normalize` in SQL (0220) -> the same three
 *             or null, and null leaves the column alone
 *
 * The text half is NOT normalised here, deliberately. `country` (Block 28) does
 * exactly the same: the engine stores what the listener wrote and
 * `apply_member_field_values` resolves it on the way into the column. Keeping
 * one resolver in one language is what stops "masculino" and "Masculino"
 * becoming two audiences, and this module may not reach the database to call it.
 */
function fieldTurn(
  conversation: Conversation,
  field: RequestedField,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
  if (message.kind === 'button') {
    // A button reply to a TEXT-shaped field is not an answer to this question —
    // an old message re-pressed, most likely — and gets a re-prompt rather than
    // a guess, the same rule `consentTurn` states for an unknown id.
    if (FIELD_SHAPE[field] !== 'choice') return failure(conversation, context);
    const chosen = genderFromButtonId(message.buttonId);
    if (chosen === null) return failure(conversation, context);
    return answered(
      conversation,
      {
        fields: { ...conversation.answers.fields, [field]: chosen },
        questions: [...conversation.answers.questions],
      },
      context,
    );
  }

  if (message.kind !== 'text') return failure(conversation, context);

  const value = validateField(field, message.text, message.receivedAt);
  if (value === null) return failure(conversation, context);

  return answered(
    conversation,
    {
      fields: { ...conversation.answers.fields, [field]: value },
      questions: [...conversation.answers.questions],
    },
    context,
  );
}

function questionTurn(
  conversation: Conversation,
  step: Extract<Step, { kind: 'question' }>,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
  const question = questionPrompt(step.questionId, context);

  if (step.questionKind === 'ESSAY') {
    if (message.kind !== 'text') return failure(conversation, context);
    const answerText = message.text.trim();
    if (answerText === '') return failure(conversation, context);
    return answered(
      conversation,
      appendQuestion(conversation.answers, step.questionId, null, answerText),
      context,
    );
  }

  // QUIZ and MULTIPLE_CHOICE are the same conversation: a list went out, an
  // option id must come back. An id the question does not have is refused
  // rather than stored -- `apply_participation` would refuse it at the end
  // anyway, and by then the listener has answered everything else for nothing.
  if (message.kind !== 'list') return failure(conversation, context);
  if (!question.options.some((option) => option.id === message.optionId)) {
    return failure(conversation, context);
  }
  return answered(
    conversation,
    appendQuestion(conversation.answers, step.questionId, message.optionId, null),
    context,
  );
}

function appendQuestion(
  answers: ConversationAnswers,
  questionId: string,
  optionId: string | null,
  answerText: string | null,
): ConversationAnswers {
  return {
    fields: { ...answers.fields },
    questions: [...answers.questions, { questionId, optionId, answerText }],
  };
}

/**
 * A step was answered: keep the answer, move on, and forget the mistakes made
 * getting here. The cursor is `complete` only when it has moved PAST the last
 * step -- at the last step there is still a question to ask.
 */
function answered(
  conversation: Conversation,
  answers: ConversationAnswers,
  context: PromptContext,
): Turn {
  const cursor = conversation.cursor + 1;
  const next: Conversation = { ...conversation, answers, cursor, reprompts: 0 };

  const step = next.steps[cursor];
  if (!step) return { kind: 'complete', conversation: next };
  return { kind: 'prompt', conversation: next, outbound: promptFor(step, context) };
}

/**
 * The answer was unusable. The cursor does not move and nothing is stored; the
 * same prompt goes out again until the cap is spent (D10: while the state is
 * alive the bot knows this person is mid-conversation, so an unusable answer
 * gets a re-prompt rather than the silence a stranger gets).
 */
function failure(conversation: Conversation, context: PromptContext): Turn {
  const reprompts = conversation.reprompts + 1;
  if (reprompts > MAX_REPROMPTS_PER_STEP) {
    return {
      kind: 'abandon',
      outbound: {
        kind: 'text',
        body: resolveSystemMessage(context.systemMessages, 'ABANDON'),
      },
    };
  }

  const step = conversation.steps[conversation.cursor];
  if (!step) return { kind: 'ignore' };
  return {
    kind: 'prompt',
    conversation: { ...conversation, reprompts },
    outbound: promptFor(step, context),
  };
}

function promptFor(step: Step, context: PromptContext): Outbound {
  switch (step.kind) {
    case 'consent':
      return {
        kind: 'interactive',
        // Composed there, not here. See this file's header.
        interactive: buildConsentInteractive({
          name: context.promotion.name,
          callToAction: context.promotion.callToAction,
          useArt: context.promotion.useArt,
          artUrl: context.promotion.artUrl,
          buttons: [
            {
              id: CONSENT_YES_ID,
              title: label(context.promotion.yesButtonLabel, DEFAULT_YES_BUTTON_LABEL),
            },
            {
              id: CONSENT_NO_ID,
              title: label(context.promotion.noButtonLabel, DEFAULT_NO_BUTTON_LABEL),
            },
          ],
        }),
      };
    case 'field':
      return fieldOutbound(step.field, context);
    case 'question':
      return questionOutbound(step, context);
    case 'marketing_consent':
      return {
        kind: 'interactive',
        interactive: {
          kind: 'buttons',
          body: resolveSystemMessage(context.systemMessages, 'MARKETING_CONSENT'),
          // No header, the same reasoning fieldOutbound gives for the gender
          // buttons: this asks about the listener, not the promotion, and the
          // promotion is the only thing in this conversation that has art.
          imageUrl: null,
          buttons: [
            { id: MARKETING_YES_ID, title: MARKETING_YES_BUTTON_LABEL },
            { id: MARKETING_NO_ID, title: MARKETING_NO_BUTTON_LABEL },
          ],
        },
      };
  }
}

/**
 * Block 29c. The follow-up conversation a just-completed participation may
 * still owe: one step, asked only when `context.needsMarketingConsent` says
 * the service found no whatsapp_marketing row for this listener at this
 * Station yet (D2's "once"). An empty array on the other branch, not null,
 * so the caller's "is there anything to send" is one array check away --
 * `firstPrompt` throws on an empty step list, so the caller must make that
 * check regardless, and an empty array is the cheaper thing to check than a
 * second kind of absence.
 */
export function marketingConsentSteps(context: PromptContext): Step[] {
  return context.needsMarketingConsent ? [{ kind: 'marketing_consent' }] : [];
}

/**
 * One field's prompt, in the shape that field is answered in.
 *
 * THE SWITCH IS ON THE SHAPE, NOT ON THE FIELD (`FIELD_SHAPE`, ./steps). Nine of
 * the ten fields are text and one is a choice; writing that as
 * `if (field === 'gender')` would be shorter today and would have to be written
 * again for the next closed set, in both of the two places that ask a field —
 * here and the widget's own form.
 *
 * The body is the SAME resolved system message either way, so a Station that
 * rewords the question rewords it for both shapes. Only the three buttons are
 * added, and only for a choice.
 */
function fieldOutbound(field: RequestedField, context: PromptContext): Outbound {
  const body = resolveSystemMessage(context.systemMessages, FIELD_MESSAGE_KEYS[field]);
  if (FIELD_SHAPE[field] === 'text') return { kind: 'text', body };

  // The one choice-shaped field today. Composed here rather than in
  // interactive.ts — unlike the consent message, which has a picture, a header
  // and a caption and earns a composer of its own — because this is the plain
  // three-button shape with nothing above it but the question.
  return {
    kind: 'interactive',
    interactive: {
      kind: 'buttons',
      body,
      // No header. `imageUrl: null` is the shape's own way of saying so, and
      // omitting the key is not an option — the field is required. The
      // consent message is the only one that carries art, because a promotion
      // has art and a question about the listener does not.
      imageUrl: null,
      buttons: GENDER_VALUES.map((value) => ({
        id: GENDER_BUTTON_IDS[value],
        title: GENDER_BUTTON_LABELS[value],
      })),
    },
  };
}

function questionOutbound(
  step: Extract<Step, { kind: 'question' }>,
  context: PromptContext,
): Outbound {
  const question = questionPrompt(step.questionId, context);
  if (step.questionKind === 'ESSAY') return { kind: 'text', body: question.prompt };

  // 0041's own CHECK makes both non-null for QUIZ and MULTIPLE_CHOICE, so
  // reaching this is a context assembled wrongly rather than a promotion
  // configured wrongly -- and a list message without them is a 400 from Meta
  // that nobody would trace back here.
  if (question.menuTitle === null || question.buttonLabel === null) {
    throw new PromptContextError(
      `question ${step.questionId} is a ${step.questionKind} but carries no menu title or button label`,
    );
  }
  return {
    kind: 'interactive',
    interactive: {
      kind: 'list',
      body: question.prompt,
      menuTitle: question.menuTitle,
      buttonLabel: question.buttonLabel,
      rows: question.options.map((option) => ({ id: option.id, title: option.label })),
    },
  };
}

function questionPrompt(questionId: string, context: PromptContext): QuestionPrompt {
  const question = context.questions[questionId];
  if (!question) {
    throw new PromptContextError(`no prompt in context for question ${questionId}`);
  }
  return question;
}

/** A blank label is a label the operator never set. The default is copy, not data. */
function label(configured: string | null, fallback: string): string {
  const trimmed = (configured ?? '').trim();
  return trimmed === '' ? fallback : trimmed;
}

// ---------------------------------------------------------------------------
// Field validation
//
// Per field kind, and the answer to a failure is always the same: a re-prompt,
// never a stored value. Returning the NORMALISED value rather than a boolean is
// what keeps that true -- there is no path on which the raw text reaches
// `answers`.
// ---------------------------------------------------------------------------

/** The normalised value to store, or null when the answer cannot be used. */
function validateField(field: RequestedField, raw: string, receivedAt: string): string | null {
  if (field === 'age') return parseBirthDate(raw, receivedAt);
  if (field === 'cpf') return normaliseCpf(raw);
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Digits only, and exactly eleven of them.
 *
 * The same normalisation `normalizeCpf` (services/members.ts) and the operator
 * form's schema apply, deliberately re-expressed rather than imported: this
 * module may not import `@/services` (see the header), and the alternative --
 * a shared home for one regex -- would move code two other blocks already
 * depend on for the sake of this one line. The value stored here is the raw
 * number; hashing stays where it has always been, in Node, before an RPC
 * argument ever carries it (0031's rule).
 */
function normaliseCpf(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  return /^[0-9]{11}$/.test(digits) ? digits : null;
}

const BR_DATE = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/**
 * A date somebody could have been born on, normalised to `YYYY-MM-DD` --
 * `members.birth_date` is a Postgres `date` (0031), so the value stored is
 * already the value written.
 *
 * Accepts what a Brazilian listener types (`dd/mm/yyyy`, with `/`, `.` or `-`,
 * the same separator throughout) and ISO. Day-first is not a guess: `15/03` and
 * `03/15` cannot both be read, and month-first would silently record the wrong
 * date for every day of the month above twelve rather than refusing anything.
 * A month above twelve is refused outright, so a listener who writes American
 * order is re-prompted rather than misrecorded.
 *
 * "In the past" is measured against `receivedAt` -- the moment the listener
 * wrote -- because this module has no clock. When that argument does not parse
 * (a caller bug: the transport always has a timestamp) the check degrades to a
 * fixed floor instead of rejecting the answer: a bad argument from the caller
 * must not cost the listener a valid birth date, and the calendar checks below
 * still apply.
 */
function parseBirthDate(raw: string, receivedAt: string): string | null {
  const written = raw.trim();
  const iso = ISO_DATE.exec(written);
  const br = iso ? null : BR_DATE.exec(written);

  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    const [, y = '', m = '', d = ''] = iso;
    year = Number(y);
    month = Number(m);
    day = Number(d);
  } else if (br) {
    const [, d = '', , m = '', y = ''] = br;
    year = Number(y);
    month = Number(m);
    day = Number(d);
  } else {
    return null;
  }

  // A real day of a real month: `Date.UTC` rolls 31 February over into March,
  // so the round trip is what refuses it. UTC throughout -- a local-time
  // constructor would shift the stored date by a day for half the world.
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  const reference = Date.parse(receivedAt);
  if (Number.isNaN(reference)) {
    if (year < EARLIEST_PLAUSIBLE_BIRTH_YEAR) return null;
  } else {
    if (time >= reference) return null;
    if (year < new Date(reference).getUTCFullYear() - MAX_HUMAN_AGE_YEARS) return null;
  }

  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}
