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
import type {
  Conversation,
  ConversationAnswers,
  InboundAnswer,
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
 * What the bot asks for each field, and the whole message rather than a column
 * heading -- somebody reading "cidade" on WhatsApp has no form around it to
 * explain what is wanted.
 *
 * Copy, so it lives here with the rest of it and not in a column: a promotion
 * has no per-field wording to override, and D6 of the 4a spec settled that a
 * requested field would never carry settings of its own. A TOTAL record, so the
 * compiler refuses a ninth field that nobody wrote a question for -- the failure
 * mode a lookup table would turn into a listener receiving an empty message.
 */
export const FIELD_PROMPTS: Record<RequestedField, string> = {
  full_name: 'Qual é o seu nome completo?',
  address: 'Qual é o seu endereço? (rua, número e complemento)',
  city: 'Em qual cidade você mora?',
  neighbourhood: 'Em qual bairro você mora?',
  age: 'Qual é a sua data de nascimento? (dia/mês/ano)',
  cpf: 'Qual é o seu CPF? (só os números)',
  passport: 'Qual é o número do seu passaporte?',
  discovery_source: 'Como você conheceu a nossa rádio?',
};
export const ABANDON_MESSAGE =
  'Não consegui entender a resposta. Vamos parar por aqui — é só mandar a hashtag de novo quando quiser tentar outra vez.';

/**
 * The two override types live in `./steps` with the rest of the vocabulary and
 * are re-exported here, where the defaults and the resolver are — so a caller
 * needing "the ten texts" imports one module rather than two.
 */
export type { SystemMessageKey, SystemMessageOverrides } from './steps';

/**
 * Which key carries each requested field's prompt.
 *
 * TOTAL, and that is the whole point of it existing rather than a
 * `field.toUpperCase()`: a ninth `RequestedField` fails to compile HERE as well
 * as in `FIELD_PROMPTS`, so the pair cannot drift into a field whose prompt
 * nobody can override and, worse, a key that resolves to nothing.
 */
export const FIELD_MESSAGE_KEYS: Record<RequestedField, SystemMessageKey> = {
  full_name: 'FULL_NAME',
  address: 'ADDRESS',
  city: 'CITY',
  neighbourhood: 'NEIGHBOURHOOD',
  age: 'AGE',
  cpf: 'CPF',
  passport: 'PASSPORT',
  discovery_source: 'DISCOVERY_SOURCE',
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
  CPF: FIELD_PROMPTS.cpf,
  PASSPORT: FIELD_PROMPTS.passport,
  DISCOVERY_SOURCE: FIELD_PROMPTS.discovery_source,
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
 * Narrows an untrusted key/text map to the ten texts this engine knows about.
 *
 * The map arrives as jsonb built in plpgsql (0114) and read in TypeScript, and
 * a `Record<string, string>` says nothing about which keys are in it. Rather
 * than a second list of the ten to keep in step with the enum, the keys are
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
  }
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

function fieldTurn(
  conversation: Conversation,
  field: RequestedField,
  message: InboundAnswer,
  context: PromptContext,
): Turn {
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
      return {
        kind: 'text',
        body: resolveSystemMessage(context.systemMessages, FIELD_MESSAGE_KEYS[step.field]),
      };
    case 'question':
      return questionOutbound(step, context);
  }
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
