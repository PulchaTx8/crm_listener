import { describe, expect, it } from 'vitest';
import { decideAutoOpen, enterRefusal, readSteps, type WidgetPromotion } from '@/lib/widget/promotion-mapping';

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
