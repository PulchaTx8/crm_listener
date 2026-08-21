import { describe, expect, it } from 'vitest';
import {
  decideAutoOpen,
  enterRefusal,
  firstUnansweredScreen,
  needsNoWalk,
  readSteps,
  screensFor,
  type WidgetPromotion,
  type WidgetStep,
} from '@/lib/widget/promotion-mapping';

describe('enterRefusal', () => {
  it('passes through the reasons the panel has a sentence for', () => {
    for (const reason of [
      'promotion_closed',
      'already_entered',
      'missing_answers',
      'listener_anonymized',
      'unknown_installation',
    ] as const) {
      expect(enterRefusal(reason)).toBe(reason);
    }
  });

  it('turns unknown_listener into no_session, which is what they can act on', () => {
    expect(enterRefusal('unknown_listener')).toBe('no_session');
  });

  /**
   * Declining is a real outcome — the door writes a promotion_refusals row —
   * so the action gives it a state of its own rather than letting this
   * function dress it as an error.
   */
  it('does not pretend `refused` is a failure it has a message for', () => {
    expect(enterRefusal('refused')).toBe('failed');
  });

  it('turns a reason it does not know into failed rather than passing it on', () => {
    expect(enterRefusal('invented_by_a_later_migration')).toBe('failed');
    expect(enterRefusal(null)).toBe('failed');
    expect(enterRefusal('')).toBe('failed');
  });
});

describe('readSteps', () => {
  it('reads the three kinds the door produces', () => {
    expect(
      readSteps([
        { kind: 'consent' },
        { kind: 'field', field: 'city' },
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta essa música?' },
      ]),
    ).toEqual([
      { kind: 'consent' },
      { kind: 'field', field: 'city' },
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta essa música?' },
    ]);
  });

  /**
   * A step whose kind this code does not know would render as a screen that
   * asks nothing and submits nothing. Dropping it makes the walk shorter, and
   * the door then refuses the submission with missing_answers — a listener
   * sees a short walk rather than a broken one, and no half-answered entry
   * goes through.
   */
  it('drops a step it cannot render rather than rendering an empty one', () => {
    expect(readSteps([{ kind: 'seance' }, { kind: 'consent' }])).toEqual([{ kind: 'consent' }]);
  });

  it('drops a field step with no field name', () => {
    expect(readSteps([{ kind: 'field' }])).toEqual([]);
  });

  it('drops a question step missing either of its two identifiers', () => {
    expect(readSteps([{ kind: 'question', questionId: 'q1' }])).toEqual([]);
    expect(readSteps([{ kind: 'question', questionKind: 'QUIZ' }])).toEqual([]);
  });

  it('answers with an empty walk for anything that is not a list', () => {
    for (const value of [null, undefined, {}, 'consent', 7]) {
      expect(readSteps(value)).toEqual([]);
    }
  });

  it('keeps the prompt the door now sends', () => {
    const steps = readSteps([
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
    ]);

    expect(steps).toEqual([
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
    ]);
  });

  // THE DEPLOY ORDER THAT HAS BURNED THIS PROJECT BEFORE (Blocks 13a, 17b,
  // 17c): frontend code landing ahead of its migration. This module already
  // promises every question step a `prompt`; a door that has not applied
  // 0264 yet sends a step with no such key. The step must still be pushed,
  // not dropped for lacking one -- the door's own missing_answers check still
  // expects an answer to this question regardless of whether 0264 has run,
  // so a browser that dropped the step would refuse the entry forever.
  it('keeps a question that carries no prompt', () => {
    const steps = readSteps([{ kind: 'question', questionId: 'q1', questionKind: 'ESSAY' }]);

    expect(steps).toEqual([
      { kind: 'question', questionId: 'q1', questionKind: 'ESSAY', prompt: '' },
    ]);
  });
});

/** A minimal promotion, filled in only where a case needs to differ. */
function promotion(overrides: Partial<WidgetPromotion> = {}): WidgetPromotion {
  return {
    id: 'p1',
    name: 'A promotion',
    rules: 'Rules',
    artUrl: null,
    thumbUrl: null,
    alreadyEntered: false,
    // Block 30d, fix round 3. `[]` until this round, which is a list no door
    // ever returns: `whatsapp_conversation_steps` opens every list with
    // `consent`. It is also the shape that now decides `confirm`, so leaving
    // it empty would have made every case here turn on a fixture that cannot
    // occur. A case wanting a WALK says so by adding a field.
    steps: [{ kind: 'consent' }],
    options: {},
    ...overrides,
  };
}

describe('decideAutoOpen', () => {
  it('opens the promotion when it is in the list, not already entered, and has a walk', () => {
    const target = promotion({
      id: 'target',
      steps: [{ kind: 'consent' }, { kind: 'field', field: 'city' }],
    });
    expect(decideAutoOpen([promotion({ id: 'other' }), target], 'target')).toEqual({
      action: 'open',
      promotion: target,
    });
  });

  /**
   * Block 30d, fix round 3. A link that names a promotion asking this listener
   * nothing. `open` would draw a walk that has no screens -- which is how this
   * arrival fell through to the generic promotion list, breaking the one
   * promise the link makes.
   */
  it('answers confirm for a promotion with nothing left to ask', () => {
    const target = promotion({ id: 'target', steps: [{ kind: 'consent' }] });
    expect(decideAutoOpen([target], 'target')).toEqual({ action: 'confirm', promotion: target });
  });

  /**
   * Fix round 1. An id that names a promotion this listener already entered
   * is not the same case as one naming nothing they can see: the promotion IS
   * in their own list, merely finished. `show-list` does not open a walk that
   * can only end in `already_entered` -- it says "do nothing", so the panel's
   * ordinary render is left to show that exact promotion, disabled, with its
   * own `alreadyEntered` label already on screen.
   */
  it('answers show-list rather than opening a promotion already entered', () => {
    const entered = promotion({
      id: 'target',
      alreadyEntered: true,
      steps: [{ kind: 'consent' }, { kind: 'field', field: 'city' }],
    });
    expect(decideAutoOpen([entered], 'target')).toEqual({ action: 'show-list' });
  });

  /**
   * Block 30d, fix round 3. THE ORDER OF THE TWO TESTS INSIDE THE FUNCTION,
   * pinned: already-entered is asked BEFORE nothing-left-to-ask. Reversed, a
   * finished no-walk promotion would be offered an entry the door can only
   * refuse with `already_entered` -- a button that cannot work, on a screen
   * built to have exactly one that does.
   */
  it('still answers show-list for a no-walk promotion this listener has already entered', () => {
    const entered = promotion({ id: 'target', alreadyEntered: true, steps: [{ kind: 'consent' }] });
    expect(decideAutoOpen([entered], 'target')).toEqual({ action: 'show-list' });
  });

  it('falls back to the menu for an id naming nothing in this list', () => {
    expect(decideAutoOpen([promotion({ id: 'other' })], 'target')).toEqual({
      action: 'back-to-menu',
    });
  });

  it('falls back to the menu for an empty list', () => {
    expect(decideAutoOpen([], 'target')).toEqual({ action: 'back-to-menu' });
  });
});

describe('screensFor', () => {
  /**
   * The walk is not a chat. The bot asks one thing per message because a
   * conversation has no other shape; a page groups every requested field onto
   * one screen, which is what somebody filling in a form expects.
   */
  it('puts consent alone, every field together, and one question per screen', () => {
    expect(
      screensFor([
        { kind: 'consent' },
        { kind: 'field', field: 'city' },
        { kind: 'field', field: 'address' },
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
        { kind: 'question', questionId: 'q2', questionKind: 'ESSAY', prompt: 'Qual é a sua opinião?' },
      ]),
    ).toEqual([
      [{ kind: 'consent' }],
      [
        { kind: 'field', field: 'city' },
        { kind: 'field', field: 'address' },
      ],
      [{ kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' }],
      [{ kind: 'question', questionId: 'q2', questionKind: 'ESSAY', prompt: 'Qual é a sua opinião?' }],
    ]);
  });

  it('draws no field screen at all when nothing is asked for', () => {
    expect(screensFor([{ kind: 'consent' }])).toEqual([[{ kind: 'consent' }]]);
  });
});

describe('firstUnansweredScreen', () => {
  const walk = screensFor([
    { kind: 'consent' },
    { kind: 'field', field: 'city' },
    { kind: 'field', field: 'address' },
    { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
  ]);

  it('answers null when every step has something in it', () => {
    expect(
      firstUnansweredScreen(walk, { city: 'São Paulo', address: 'Rua X, 1' }, { q1: 'o1' }),
    ).toBeNull();
  });

  it('finds the field screen when one field is empty', () => {
    expect(firstUnansweredScreen(walk, { city: 'São Paulo' }, { q1: 'o1' })).toBe(1);
  });

  /**
   * The same rule the door applies: `nullif(btrim(...), '')` in 0171, so
   * whitespace is not an answer on either side of the wire.
   */
  it('treats whitespace as no answer, exactly as the door does', () => {
    expect(
      firstUnansweredScreen(walk, { city: '   ', address: 'Rua X, 1' }, { q1: 'o1' }),
    ).toBe(1);
  });

  it('finds the question screen when the fields are done and the answer is not', () => {
    expect(
      firstUnansweredScreen(walk, { city: 'São Paulo', address: 'Rua X, 1' }, {}),
    ).toBe(2);
  });

  it('answers with the FIRST unanswered screen, not the last', () => {
    expect(firstUnansweredScreen(walk, {}, {})).toBe(1);
  });

  /**
   * Consent is never this function's business. Declining is not a
   * missing_answers refusal at all -- the door writes a promotion_refusals row
   * and answers `refused` -- so a walk whose only screen is consent has
   * nothing here to find.
   */
  it('never points at the consent screen', () => {
    expect(firstUnansweredScreen(screensFor([{ kind: 'consent' }]), {}, {})).toBeNull();
  });
});

describe('needsNoWalk', () => {
  it('is true when consent is the only step left', () => {
    expect(needsNoWalk([{ kind: 'consent' }])).toBe(true);
  });

  it('is false when a field is still to fill', () => {
    expect(needsNoWalk([{ kind: 'consent' }, { kind: 'field', field: 'full_name' }])).toBe(false);
  });

  it('is false when a question is still to answer', () => {
    expect(
      needsNoWalk([
        { kind: 'consent' },
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
      ]),
    ).toBe(false);
  });

  /**
   * The pair `screensFor` cannot tell apart on its own: a promotion whose walk
   * is one screen IS a promotion with nothing to ask, so these two functions
   * have to agree or the panel would draw a screen it also decided to skip.
   */
  it('agrees with screensFor about what a one-screen walk means', () => {
    const nothingToAsk: WidgetStep[] = [{ kind: 'consent' }];
    expect(screensFor(nothingToAsk)).toHaveLength(1);
    expect(needsNoWalk(nothingToAsk)).toBe(true);

    const somethingToAsk: WidgetStep[] = [{ kind: 'consent' }, { kind: 'field', field: 'city' }];
    expect(screensFor(somethingToAsk).length).toBeGreaterThan(1);
    expect(needsNoWalk(somethingToAsk)).toBe(false);
  });
});
