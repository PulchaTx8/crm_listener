import { describe, expect, it } from 'vitest';
import {
  decideAutoOpen,
  enterRefusal,
  firstUnansweredScreen,
  readSteps,
  screensFor,
  type WidgetPromotion,
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
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
      ]),
    ).toEqual([
      { kind: 'consent' },
      { kind: 'field', field: 'city' },
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
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
    steps: [],
    options: {},
    ...overrides,
  };
}

describe('decideAutoOpen', () => {
  it('opens the promotion when it is in the list and not already entered', () => {
    const target = promotion({ id: 'target' });
    expect(decideAutoOpen([promotion({ id: 'other' }), target], 'target')).toEqual({
      action: 'open',
      promotion: target,
    });
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
    const entered = promotion({ id: 'target', alreadyEntered: true });
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
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
        { kind: 'question', questionId: 'q2', questionKind: 'ESSAY' },
      ]),
    ).toEqual([
      [{ kind: 'consent' }],
      [
        { kind: 'field', field: 'city' },
        { kind: 'field', field: 'address' },
      ],
      [{ kind: 'question', questionId: 'q1', questionKind: 'QUIZ' }],
      [{ kind: 'question', questionId: 'q2', questionKind: 'ESSAY' }],
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
    { kind: 'question', questionId: 'q1', questionKind: 'QUIZ' },
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
