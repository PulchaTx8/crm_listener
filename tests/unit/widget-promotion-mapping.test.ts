import { describe, expect, it } from 'vitest';
import { enterRefusal, readSteps } from '@/lib/widget/promotion-mapping';

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
