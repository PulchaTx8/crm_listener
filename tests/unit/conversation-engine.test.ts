import { describe, expect, it } from 'vitest';
import {
  ABANDON_MESSAGE,
  advance,
  CONSENT_NO_ID,
  CONSENT_YES_ID,
  DEFAULT_NO_BUTTON_LABEL,
  DEFAULT_YES_BUTTON_LABEL,
  FIELD_PROMPTS,
  firstPrompt,
  GENDER_BUTTON_LABELS,
  PromptContextError,
  REFUSAL_MESSAGE,
} from '@/lib/conversation/engine';
import type {
  Conversation,
  InboundAnswer,
  Outbound,
  PromptContext,
  Step,
  Turn,
} from '@/lib/conversation/steps';
import { buildInteractivePayload } from '@/lib/integrations/whatsapp/interactive';
import type { Interactive } from '@/lib/integrations/whatsapp/interactive';

// ---------------------------------------------------------------------------
// Fixtures
//
// Everything the engine is allowed to know arrives in these two values. There
// is no store, no transport and no clock anywhere in this file -- if one were
// needed, the design would have failed, which is the point of the task.
// ---------------------------------------------------------------------------

/** The instant the listener wrote. The engine's only reference to "now" (see steps.ts). */
const RECEIVED_AT = '2026-08-01T12:00:00.000Z';

const CONSENT: Step = { kind: 'consent' };
const CITY: Step = { kind: 'field', field: 'city' };
const CPF: Step = { kind: 'field', field: 'cpf' };
const AGE: Step = { kind: 'field', field: 'age' };
const QUIZ: Step = { kind: 'question', questionId: 'q-quiz', questionKind: 'QUIZ' };
const CHOICE: Step = {
  kind: 'question',
  questionId: 'q-choice',
  questionKind: 'MULTIPLE_CHOICE',
};
const ESSAY: Step = { kind: 'question', questionId: 'q-essay', questionKind: 'ESSAY' };

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    promotion: {
      name: 'Summer Giveaway',
      callToAction: 'Answer to enter.',
      useArt: true,
      artUrl: 'https://cdn.example.com/banner.png',
      yesButtonLabel: null,
      noButtonLabel: null,
    },
    // A Station that has overridden every one of the eight field prompts, so
    // the cases below assert against wording that is demonstrably NOT the
    // constant in engine.ts -- which is what makes them a test of the
    // resolution and not of the default. The two standalone texts (REFUSAL,
    // ABANDON) are deliberately left un-overridden here: their cases assert
    // the exported constants, and so they hold the fallback direction.
    systemMessages: {
      FULL_NAME: 'Qual é o seu nome completo?',
      ADDRESS: 'Qual é o seu endereço?',
      CITY: 'Em que cidade você mora?',
      NEIGHBOURHOOD: 'Qual é o seu bairro?',
      AGE: 'Qual é a sua data de nascimento? (dd/mm/aaaa)',
      CPF: 'Qual é o seu CPF?',
      PASSPORT: 'Qual é o número do seu passaporte?',
      DISCOVERY_SOURCE: 'Como você ficou sabendo desta promoção?',
    },
    questions: {
      'q-quiz': {
        prompt: 'Em que ano a rádio foi fundada?',
        menuTitle: 'Opções',
        buttonLabel: 'Responder',
        options: [
          { id: 'o-1', label: '1985' },
          { id: 'o-2', label: '1992' },
        ],
      },
      'q-choice': {
        prompt: 'Qual prêmio você prefere?',
        menuTitle: 'Prêmios',
        buttonLabel: 'Escolher',
        options: [
          { id: 'o-a', label: 'Ingresso' },
          { id: 'o-b', label: 'Camiseta' },
        ],
      },
      'q-essay': {
        prompt: 'Por que você quer este prêmio?',
        menuTitle: null,
        buttonLabel: null,
        options: [],
      },
    },
    ...overrides,
  };
}

function conversation(steps: Step[], overrides: Partial<Conversation> = {}): Conversation {
  return {
    integrationId: 'integration-1',
    phone: '5541999990000',
    promotionId: 'promotion-1',
    memberId: 'member-1',
    steps,
    cursor: 0,
    answers: { fields: {}, questions: [] },
    reprompts: 0,
    expiresAt: '2026-08-01T12:30:00.000Z',
    ...overrides,
  };
}

const text = (body: string): InboundAnswer => ({
  kind: 'text',
  text: body,
  receivedAt: RECEIVED_AT,
});
const button = (buttonId: string): InboundAnswer => ({
  kind: 'button',
  buttonId,
  receivedAt: RECEIVED_AT,
});
const listReply = (optionId: string): InboundAnswer => ({
  kind: 'list',
  optionId,
  receivedAt: RECEIVED_AT,
});

// Narrowing helpers. `expect(...).toBe(...)` alone would leave the union
// unnarrowed for the assertions that follow, and a cast would hide exactly the
// failure these tests exist to catch.
function expectPrompt(turn: Turn): Extract<Turn, { kind: 'prompt' }> {
  expect(turn.kind).toBe('prompt');
  if (turn.kind !== 'prompt') throw new Error(`expected a prompt turn, got "${turn.kind}"`);
  return turn;
}

function expectComplete(turn: Turn): Extract<Turn, { kind: 'complete' }> {
  expect(turn.kind).toBe('complete');
  if (turn.kind !== 'complete') throw new Error(`expected a complete turn, got "${turn.kind}"`);
  return turn;
}

function expectInteractive(outbound: Outbound): Interactive {
  expect(outbound.kind).toBe('interactive');
  if (outbound.kind !== 'interactive') {
    throw new Error(`expected an interactive outbound, got "${outbound.kind}"`);
  }
  return outbound.interactive;
}

function expectButtons(outbound: Outbound): Extract<Interactive, { kind: 'buttons' }> {
  const interactive = expectInteractive(outbound);
  expect(interactive.kind).toBe('buttons');
  if (interactive.kind !== 'buttons') {
    throw new Error(`expected a buttons message, got "${interactive.kind}"`);
  }
  return interactive;
}

function expectList(outbound: Outbound): Extract<Interactive, { kind: 'list' }> {
  const interactive = expectInteractive(outbound);
  expect(interactive.kind).toBe('list');
  if (interactive.kind !== 'list') {
    throw new Error(`expected a list message, got "${interactive.kind}"`);
  }
  return interactive;
}

function expectText(outbound: Outbound): string {
  expect(outbound.kind).toBe('text');
  if (outbound.kind !== 'text') throw new Error(`expected a text outbound, got "${outbound.kind}"`);
  return outbound.body;
}

// ---------------------------------------------------------------------------

describe('the consent prompt', () => {
  it('is one interactive message carrying the composed body and both buttons', () => {
    const outbound = firstPrompt(conversation([CONSENT, CITY]), context());
    const message = expectButtons(outbound);

    // The composition itself is buildConsentInteractive's contract, pinned in
    // whatsapp-interactive.test.ts. What is pinned HERE is that the engine
    // produces exactly one message and does not compose a second body of its
    // own -- the name first, then the call to action, is the owner's order.
    expect(message.body).toBe('Summer Giveaway\n\nAnswer to enter.');
    expect(message.buttons).toEqual([
      { id: CONSENT_YES_ID, title: DEFAULT_YES_BUTTON_LABEL },
      { id: CONSENT_NO_ID, title: DEFAULT_NO_BUTTON_LABEL },
    ]);
  });

  it('carries the image header when the promotion has art', () => {
    const outbound = firstPrompt(conversation([CONSENT]), context());
    expect(expectButtons(outbound).imageUrl).toBe('https://cdn.example.com/banner.png');
  });

  it('has no image header when the promotion has no art', () => {
    const ctx = context();
    const outbound = firstPrompt(
      conversation([CONSENT]),
      context({ promotion: { ...ctx.promotion, useArt: false, artUrl: null } }),
    );
    expect(expectButtons(outbound).imageUrl).toBeNull();
  });

  it('has no image header when art is configured but switched off', () => {
    const ctx = context();
    const outbound = firstPrompt(
      conversation([CONSENT]),
      context({ promotion: { ...ctx.promotion, useArt: false } }),
    );
    expect(expectButtons(outbound).imageUrl).toBeNull();
  });

  it("uses the promotion's own button labels when it has them", () => {
    const ctx = context();
    const outbound = firstPrompt(
      conversation([CONSENT]),
      context({
        promotion: { ...ctx.promotion, yesButtonLabel: 'Bora!', noButtonLabel: 'Deixa pra lá' },
      }),
    );
    expect(expectButtons(outbound).buttons).toEqual([
      { id: CONSENT_YES_ID, title: 'Bora!' },
      { id: CONSENT_NO_ID, title: 'Deixa pra lá' },
    ]);
  });

  it('falls back to the default labels when a promotion leaves them blank', () => {
    const ctx = context();
    const outbound = firstPrompt(
      conversation([CONSENT]),
      context({ promotion: { ...ctx.promotion, yesButtonLabel: '   ', noButtonLabel: '' } }),
    );
    expect(expectButtons(outbound).buttons).toEqual([
      { id: CONSENT_YES_ID, title: DEFAULT_YES_BUTTON_LABEL },
      { id: CONSENT_NO_ID, title: DEFAULT_NO_BUTTON_LABEL },
    ]);
    expect(DEFAULT_YES_BUTTON_LABEL).toBe('Quero!');
    expect(DEFAULT_NO_BUTTON_LABEL).toBe('Agora não');
  });
});

describe('the consent step', () => {
  it('returns refused when the NO button is pressed', () => {
    const turn = advance(conversation([CONSENT, CITY]), button(CONSENT_NO_ID), context());

    expect(turn.kind).toBe('refused');
    if (turn.kind !== 'refused') throw new Error('expected a refused turn');
    expect(expectText(turn.outbound)).toBe(REFUSAL_MESSAGE);
  });

  it('advances to the first substantive step when YES is pressed', () => {
    const turn = expectPrompt(
      advance(conversation([CONSENT, CITY]), button(CONSENT_YES_ID), context()),
    );

    // The step list is [consent, city]: answering consent lands ON the last
    // step, which is a prompt. Returning `complete` here is the off-by-one.
    expect(turn.conversation.cursor).toBe(1);
    expect(expectText(turn.outbound)).toBe('Em que cidade você mora?');
  });

  it('completes when consent is the only step', () => {
    const turn = expectComplete(
      advance(conversation([CONSENT]), button(CONSENT_YES_ID), context()),
    );

    expect(turn.conversation.cursor).toBe(1);
    expect(turn.conversation.answers).toStrictEqual({ fields: {}, questions: [] });
  });

  it('re-prompts with the same message when the listener types instead of pressing', () => {
    const conv = conversation([CONSENT, CITY]);
    const turn = expectPrompt(advance(conv, text('sim'), context()));

    expect(turn.conversation.cursor).toBe(0);
    expect(turn.conversation.reprompts).toBe(1);
    expect(turn.outbound).toEqual(firstPrompt(conv, context()));
  });

  it('re-prompts on a button id it did not send', () => {
    const turn = expectPrompt(
      advance(conversation([CONSENT, CITY]), button('some-other-button'), context()),
    );
    expect(turn.conversation.cursor).toBe(0);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('re-prompts on a list reply at the consent step', () => {
    const turn = expectPrompt(advance(conversation([CONSENT, CITY]), listReply('o-1'), context()));
    expect(turn.conversation.cursor).toBe(0);
    expect(turn.conversation.reprompts).toBe(1);
  });
});

describe('field steps', () => {
  const conv = (overrides: Partial<Conversation> = {}) =>
    conversation([CONSENT, CITY, CPF], { cursor: 1, ...overrides });

  it('stores the answer, advances the cursor and prompts for the next step', () => {
    const turn = expectPrompt(advance(conv(), text('Curitiba'), context()));

    expect(turn.conversation.answers.fields.city).toBe('Curitiba');
    expect(turn.conversation.cursor).toBe(2);
    expect(expectText(turn.outbound)).toBe('Qual é o seu CPF?');
  });

  it('trims the stored value', () => {
    const turn = expectPrompt(advance(conv(), text('  Curitiba  '), context()));
    expect(turn.conversation.answers.fields.city).toBe('Curitiba');
  });

  it('stores nothing at all when the answer is blank', () => {
    const turn = expectPrompt(advance(conv(), text('   '), context()));

    // toStrictEqual, not toEqual: a rejected value written before validation
    // would leave the key present, and toEqual treats `{city: undefined}` as
    // equal to `{}`. This is the assertion that catches "store, then validate".
    expect(turn.conversation.answers.fields).toStrictEqual({});
    expect(turn.conversation.cursor).toBe(1);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('stores nothing when the answer is the empty string', () => {
    const turn = expectPrompt(advance(conv(), text(''), context()));
    expect(turn.conversation.answers.fields).toStrictEqual({});
    expect(turn.conversation.cursor).toBe(1);
  });

  it('re-prompts with the field prompt, unchanged', () => {
    const turn = expectPrompt(advance(conv(), text(''), context()));
    expect(expectText(turn.outbound)).toBe('Em que cidade você mora?');
  });

  it('re-prompts when a button is pressed at a field step', () => {
    const turn = expectPrompt(advance(conv(), button(CONSENT_YES_ID), context()));
    expect(turn.conversation.answers.fields).toStrictEqual({});
    expect(turn.conversation.reprompts).toBe(1);
  });
});

describe('the age field', () => {
  const ask = (answer: string, receivedAt = RECEIVED_AT): Turn =>
    advance(
      conversation([CONSENT, AGE], { cursor: 1 }),
      { ...text(answer), receivedAt },
      context(),
    );

  it.each([
    ['15/03/1990', 'dd/mm/yyyy'],
    ['15-03-1990', 'dd-mm-yyyy'],
    ['15.03.1990', 'dd.mm.yyyy'],
    ['15/3/1990', 'a single-digit month'],
    ['1990-03-15', 'ISO'],
  ])('accepts %s (%s) and stores it as an ISO date', (written) => {
    const turn = expectComplete(ask(written));
    expect(turn.conversation.answers.fields.age).toBe('1990-03-15');
  });

  it('accepts a single-digit day and month', () => {
    const turn = expectComplete(ask('5/3/1990'));
    expect(turn.conversation.answers.fields.age).toBe('1990-03-05');
  });

  it.each([
    ['31/02/1990', 'a day that does not exist in that month'],
    ['32/01/1990', 'a day out of range'],
    ['15/13/1990', 'a month out of range'],
    ['15/03/90', 'a two-digit year'],
    ['15/03-1990', 'mixed separators'],
    ['ontem', 'a word'],
    ['35', 'an age in years rather than a date'],
    ['', 'nothing'],
    ['15/03/2090', 'a date nobody has been born on yet'],
    ['01/01/1880', 'a date no living listener was born on'],
  ])('refuses %s (%s)', (written) => {
    const turn = expectPrompt(ask(written));
    expect(turn.conversation.answers.fields).toStrictEqual({});
    expect(turn.conversation.cursor).toBe(1);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('judges the future against the message, not against a clock', () => {
    // The same written date is refused for a listener who wrote in 2026 and
    // accepted for one who wrote in 2100. Nothing here reads the system clock.
    expect(expectPrompt(ask('15/03/2090')).conversation.cursor).toBe(1);
    const later = expectComplete(ask('15/03/2090', '2100-01-01T00:00:00.000Z'));
    expect(later.conversation.answers.fields.age).toBe('2090-03-15');
  });
});

describe('the cpf field', () => {
  const ask = (answer: string): Turn =>
    advance(conversation([CONSENT, CPF], { cursor: 1 }), text(answer), context());

  it.each([
    ['123.456.789-09', 'dotted and dashed'],
    ['12345678909', 'bare digits'],
    ['123 456 789 09', 'space separated'],
  ])('normalises %s (%s) to eleven digits', (written) => {
    const turn = expectComplete(ask(written));
    expect(turn.conversation.answers.fields.cpf).toBe('12345678909');
  });

  it.each([
    ['1234567890', 'ten digits'],
    ['123456789012', 'twelve digits'],
    ['não tenho', 'no digits at all'],
    ['   ', 'blank'],
  ])('refuses %s (%s)', (written) => {
    const turn = expectPrompt(ask(written));
    expect(turn.conversation.answers.fields).toStrictEqual({});
    expect(turn.conversation.reprompts).toBe(1);
  });
});

describe('question steps', () => {
  it('renders a QUIZ as an interactive list', () => {
    const outbound = firstPrompt(conversation([QUIZ]), context());
    const message = expectList(outbound);

    expect(message.body).toBe('Em que ano a rádio foi fundada?');
    expect(message.menuTitle).toBe('Opções');
    expect(message.buttonLabel).toBe('Responder');
    expect(message.rows).toEqual([
      { id: 'o-1', title: '1985' },
      { id: 'o-2', title: '1992' },
    ]);
  });

  it('renders a MULTIPLE_CHOICE as an interactive list', () => {
    const outbound = firstPrompt(conversation([CHOICE]), context());
    expect(expectList(outbound).rows).toEqual([
      { id: 'o-a', title: 'Ingresso' },
      { id: 'o-b', title: 'Camiseta' },
    ]);
  });

  it('stores the chosen option id for a QUIZ', () => {
    const turn = expectComplete(advance(conversation([QUIZ]), listReply('o-2'), context()));

    expect(turn.conversation.answers.questions).toEqual([
      { questionId: 'q-quiz', optionId: 'o-2', answerText: null },
    ]);
  });

  it('refuses an option id the question does not have', () => {
    const turn = expectPrompt(advance(conversation([QUIZ]), listReply('o-999'), context()));

    expect(turn.conversation.answers.questions).toStrictEqual([]);
    expect(turn.conversation.cursor).toBe(0);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('refuses free text at a QUIZ step', () => {
    const turn = expectPrompt(advance(conversation([QUIZ]), text('1992'), context()));
    expect(turn.conversation.answers.questions).toStrictEqual([]);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('renders an ESSAY as a plain text question', () => {
    expect(expectText(firstPrompt(conversation([ESSAY]), context()))).toBe(
      'Por que você quer este prêmio?',
    );
  });

  it('accepts free text for an ESSAY and stores it with no option id', () => {
    const turn = expectComplete(
      advance(conversation([ESSAY]), text('  Porque escuto todo dia  '), context()),
    );

    expect(turn.conversation.answers.questions).toEqual([
      { questionId: 'q-essay', optionId: null, answerText: 'Porque escuto todo dia' },
    ]);
  });

  it('refuses a blank ESSAY answer', () => {
    const turn = expectPrompt(advance(conversation([ESSAY]), text('   '), context()));
    expect(turn.conversation.answers.questions).toStrictEqual([]);
    expect(turn.conversation.reprompts).toBe(1);
  });

  it('refuses a list reply at an ESSAY step', () => {
    const turn = expectPrompt(advance(conversation([ESSAY]), listReply('o-1'), context()));
    expect(turn.conversation.answers.questions).toStrictEqual([]);
  });

  it('throws when the context has no prompt for the question a step names', () => {
    const conv = conversation([
      { kind: 'question', questionId: 'q-missing', questionKind: 'ESSAY' },
    ]);
    expect(() => firstPrompt(conv, context())).toThrow(PromptContextError);
    expect(() => advance(conv, text('anything'), context())).toThrow(PromptContextError);
  });

  it('throws when a list question has no menu title or button label', () => {
    const ctx = context();
    const broken = context({
      questions: {
        ...ctx.questions,
        'q-quiz': {
          prompt: 'Em que ano a rádio foi fundada?',
          menuTitle: null,
          buttonLabel: null,
          options: [{ id: 'o-1', label: '1985' }],
        },
      },
    });
    expect(() => firstPrompt(conversation([QUIZ]), broken)).toThrow(PromptContextError);
  });
});

describe('the re-prompt cap', () => {
  it('re-prompts three times at one step and abandons on the fourth failure', () => {
    let conv = conversation([CONSENT, CITY], { cursor: 1 });

    for (const expected of [1, 2, 3]) {
      const turn = expectPrompt(advance(conv, text('   '), context()));
      expect(turn.conversation.reprompts).toBe(expected);
      expect(turn.conversation.cursor).toBe(1);
      conv = turn.conversation;
    }

    const fourth = advance(conv, text('   '), context());
    expect(fourth.kind).toBe('abandon');
    if (fourth.kind !== 'abandon') throw new Error('expected an abandon turn');
    expect(expectText(fourth.outbound)).toBe(ABANDON_MESSAGE);
  });

  it('still accepts a good answer on the third re-prompt', () => {
    const conv = conversation([CONSENT, CITY, CPF], { cursor: 1, reprompts: 3 });
    const turn = expectPrompt(advance(conv, text('Curitiba'), context()));

    expect(turn.conversation.answers.fields.city).toBe('Curitiba');
    expect(turn.conversation.cursor).toBe(2);
  });

  it('resets the counter when a step is answered', () => {
    const conv = conversation([CONSENT, CITY, CPF], { cursor: 1, reprompts: 2 });
    expect(expectPrompt(advance(conv, text('Curitiba'), context())).conversation.reprompts).toBe(0);
  });

  it('does not end a long conversation over mistakes spread across it', () => {
    // Four mistakes, one per step, in a conversation of four steps. Each is
    // the FIRST failure at its own step, so none of them is a fourth failure
    // and the conversation completes. Without the reset the counter reaches
    // four here and the listener is thrown out mid-conversation -- which is
    // the exact defect the cap must not cause, and the reason this fixture
    // spreads the mistakes instead of piling them on one step.
    let conv = conversation([CONSENT, CITY, CPF, ESSAY]);

    conv = expectPrompt(advance(conv, text('quero sim'), context())).conversation;
    conv = expectPrompt(advance(conv, button(CONSENT_YES_ID), context())).conversation;
    expect(conv.cursor).toBe(1);

    conv = expectPrompt(advance(conv, text('  '), context())).conversation;
    conv = expectPrompt(advance(conv, text('Curitiba'), context())).conversation;
    expect(conv.cursor).toBe(2);

    conv = expectPrompt(advance(conv, text('123'), context())).conversation;
    conv = expectPrompt(advance(conv, text('123.456.789-09'), context())).conversation;
    expect(conv.cursor).toBe(3);

    conv = expectPrompt(advance(conv, listReply('o-1'), context())).conversation;
    const finished = expectComplete(advance(conv, text('Porque escuto todo dia'), context()));

    expect(finished.conversation.cursor).toBe(4);
    expect(finished.conversation.reprompts).toBe(0);
    expect(finished.conversation.answers).toStrictEqual({
      fields: { city: 'Curitiba', cpf: '12345678909' },
      questions: [{ questionId: 'q-essay', optionId: null, answerText: 'Porque escuto todo dia' }],
    });
  });
});

describe('a message with nothing left to answer', () => {
  it('is ignored when the cursor is one past the end', () => {
    const conv = conversation([CONSENT, CITY], { cursor: 2 });
    expect(advance(conv, text('olá'), context())).toStrictEqual({ kind: 'ignore' });
  });

  it('is ignored however far past the end the cursor is', () => {
    const conv = conversation([CONSENT], { cursor: 7 });
    expect(advance(conv, button(CONSENT_YES_ID), context())).toStrictEqual({ kind: 'ignore' });
    expect(advance(conv, listReply('o-1'), context())).toStrictEqual({ kind: 'ignore' });
  });
});

describe('purity', () => {
  it('never mutates the conversation it is given', () => {
    const conv = conversation([CONSENT, CITY, ESSAY], { cursor: 1 });
    const before = structuredClone(conv);

    advance(conv, text('Curitiba'), context());
    advance(conv, text('  '), context());

    expect(conv).toStrictEqual(before);
  });

  it('gives the same answer for the same inputs', () => {
    const conv = conversation([CONSENT, CITY], { cursor: 1 });
    expect(advance(conv, text('Curitiba'), context())).toStrictEqual(
      advance(conv, text('Curitiba'), context()),
    );
  });
});

/**
 * The gender block. The one CHOICE-shaped field, and the two ways it is
 * answered.
 *
 * WHY THESE CASES EXIST AT ALL, stated once so nobody trims them as
 * duplication: until this block every field went out as text and came back as
 * text, and `fieldTurn` opened with `if (message.kind !== 'text') return
 * failure(...)`. Both halves of that changed, and the half that is easy to get
 * wrong is the SECOND one — a version that accepts only the button reply passes
 * every obvious test and abandons the conversation of anybody who types instead
 * of pressing, which on WhatsApp is a real fraction of people because the
 * keyboard stays open beneath the buttons.
 */
const GENDER: Step = { kind: 'field', field: 'gender' };

describe('a choice-shaped field', () => {
  const conv = () => conversation([GENDER], { cursor: 0 });

  it('goes out as three reply buttons rather than as a bare question', () => {
    const turn = expectPrompt(advance(conversation([CONSENT, GENDER]), button(CONSENT_YES_ID), context()));
    const buttons = expectButtons(turn.outbound);

    expect(buttons.buttons.map((b) => b.id)).toEqual(['gender_M', 'gender_F', 'gender_N']);
    expect(buttons.buttons.map((b) => b.title)).toEqual([
      GENDER_BUTTON_LABELS.M,
      GENDER_BUTTON_LABELS.F,
      GENDER_BUTTON_LABELS.N,
    ]);
    // No header. The consent message is the only one that carries art.
    expect(buttons.imageUrl).toBeNull();
  });

  it("carries the Station's own wording in the buttons message, not only in a text one", () => {
    // The half a "buttons work" test would miss: the body still goes through
    // `resolveSystemMessage`, so a Station that rewords the question rewords it
    // for the shape that has buttons too.
    const turn = expectPrompt(
      advance(
        conversation([CONSENT, GENDER]),
        button(CONSENT_YES_ID),
        context({ systemMessages: { GENDER: 'Você é homem ou mulher?' } }),
      ),
    );
    expect(expectButtons(turn.outbound).body).toBe('Você é homem ou mulher?');
  });

  it('falls back to the code default when the Station has overridden nothing', () => {
    const turn = expectPrompt(advance(conversation([CONSENT, GENDER]), button(CONSENT_YES_ID), context()));
    expect(expectButtons(turn.outbound).body).toBe(FIELD_PROMPTS.gender);
  });

  it('is a message the Cloud API would actually accept', () => {
    // The three labels are inside Meta's 20-character button cap and there are
    // three of them, which is the maximum. Asserted by BUILDING the payload
    // rather than by measuring the strings here: `validateButtons` is the rule,
    // and a second copy of it in a test would be the copy that goes stale.
    const turn = expectPrompt(advance(conversation([CONSENT, GENDER]), button(CONSENT_YES_ID), context()));
    expect(() => buildInteractivePayload(expectInteractive(turn.outbound))).not.toThrow();
  });

  it('stores the code when the listener presses a button', () => {
    const turn = expectComplete(advance(conv(), button('gender_F'), context()));
    expect(turn.conversation.answers.fields.gender).toBe('F');
  });

  it('stores what the listener TYPED, raw, when they type instead of pressing', () => {
    // Raw and un-normalised on purpose: `gender_normalize` (0220) is the one
    // authority on what a gender string means, it lives in SQL, and this module
    // may not reach a database. `country` (Block 28) does exactly the same.
    const turn = expectComplete(advance(conv(), text('masculino'), context()));
    expect(turn.conversation.answers.fields.gender).toBe('masculino');
  });

  it('accepts a typed answer the resolver will not understand, rather than abandoning', () => {
    // THE CASE THIS WHOLE DESIGN TURNS ON. The engine cannot tell a resolvable
    // answer from an unresolvable one — the resolver is in SQL — so it accepts
    // both, and an unrecognised one costs the FIELD at write time (coalesce
    // leaves the column alone) rather than costing the participation here.
    // Refusing it would burn a re-prompt, and three burn the entry.
    const turn = expectComplete(advance(conv(), text('sei lá'), context()));
    expect(turn.conversation.answers.fields.gender).toBe('sei lá');
  });

  it('re-prompts a button id that belongs to no answer', () => {
    // An old message re-pressed, or a consent button arriving one step late.
    const turn = expectPrompt(advance(conv(), button('gender_X'), context()));
    expect(turn.conversation.reprompts).toBe(1);
    expect(turn.conversation.answers.fields.gender).toBeUndefined();
  });

  it('re-prompts a consent button pressed at this step', () => {
    const turn = expectPrompt(advance(conv(), button(CONSENT_YES_ID), context()));
    expect(turn.conversation.reprompts).toBe(1);
    expect(turn.conversation.answers.fields.gender).toBeUndefined();
  });

  it('re-prompts a list reply, which no field takes', () => {
    const turn = expectPrompt(advance(conv(), listReply('o-1'), context()));
    expect(turn.conversation.reprompts).toBe(1);
  });
});

describe('a text-shaped field', () => {
  it('still refuses a button reply, which is not an answer to it', () => {
    // The other side of the shape. Without this, a version of `fieldTurn` that
    // accepted a button for EVERY field would pass every case above — and would
    // store `null` into `city` for anybody who pressed a stale button.
    const turn = expectPrompt(
      advance(conversation([CITY]), button('gender_M'), context()),
    );
    expect(turn.conversation.reprompts).toBe(1);
    expect(turn.conversation.answers.fields.city).toBeUndefined();
  });

  it('goes out as plain text, with no buttons attached', () => {
    const turn = expectPrompt(advance(conversation([CONSENT, CITY]), button(CONSENT_YES_ID), context()));
    expect(turn.outbound.kind).toBe('text');
  });
});
