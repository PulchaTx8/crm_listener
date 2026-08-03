import { describe, expect, it } from 'vitest';
import {
  answerFilterState,
  describeAnswerFilter,
  type AnswerFilterInput,
} from '@/lib/participations/answer-filter';

/**
 * The answer filter's own rules, as pure functions, because this project's unit
 * tests run in vitest's `node` environment with no DOM.
 *
 * These decide what the filter row RENDERS. What it FILTERS is decided in SQL
 * (0090), and the two are allowed to disagree only in the safe direction: the
 * screen may offer less than the function accepts, never more.
 */

function input(over: Partial<AnswerFilterInput> = {}): AnswerFilterInput {
  return {
    promotionId: '11111111-0000-0000-0000-000000000001',
    promotionHasQuiz: true,
    promotionHasOptions: true,
    answeredCorrectly: undefined,
    optionId: undefined,
    ...over,
  };
}

describe('answerFilterState', () => {
  it('offers nothing at all until a promotion is chosen', () => {
    // A question belongs to one promotion, and "answered correctly" has no
    // meaning across several — there is no shared right answer to be right
    // about.
    const state = answerFilterState(input({ promotionId: undefined }));

    expect(state.correctnessAvailable).toBe(false);
    expect(state.optionsAvailable).toBe(false);
    expect(state.reason).toMatch(/promotion/i);
  });

  it('offers the correctness filter when the promotion has a quiz', () => {
    const state = answerFilterState(input());

    expect(state.correctnessAvailable).toBe(true);
    expect(state.reason).toBeNull();
  });

  it('hides the correctness filter when there is nothing to be right about', () => {
    // A promotion with no QUIZ question: promotion_participation_correctness
    // answers true for everybody, so a correct/wrong control would offer a
    // choice with one outcome.
    const state = answerFilterState(input({ promotionHasQuiz: false }));

    expect(state.correctnessAvailable).toBe(false);
    expect(state.optionsAvailable).toBe(true);
  });

  it('still offers the option filter for a poll, which has no right answer', () => {
    const state = answerFilterState(
      input({ promotionHasQuiz: false, promotionHasOptions: true }),
    );

    expect(state.optionsAvailable).toBe(true);
  });

  it('offers no option filter when the promotion asks nothing with options', () => {
    // An essay-only promotion, or none at all: there is no option to pick.
    const state = answerFilterState(input({ promotionHasQuiz: false, promotionHasOptions: false }));

    expect(state.optionsAvailable).toBe(false);
    expect(state.correctnessAvailable).toBe(false);
  });
});

describe('describeAnswerFilter', () => {
  it('says nothing when neither filter is set', () => {
    expect(describeAnswerFilter(input())).toBeNull();
  });

  it('names the correctness filter on its own', () => {
    expect(describeAnswerFilter(input({ answeredCorrectly: true }))).toBe('answered correctly');
    expect(describeAnswerFilter(input({ answeredCorrectly: false }))).toBe('answered wrongly');
  });

  it('names the option filter on its own', () => {
    expect(describeAnswerFilter(input({ optionId: 'opt', optionLabel: 'Rock' }))).toBe(
      'chose “Rock”',
    );
  });

  it('joins the two with AND, because that is what the query does', () => {
    // D5: the filters add. A description reading "or" would promise a list the
    // database will not return.
    expect(
      describeAnswerFilter(input({ answeredCorrectly: true, optionId: 'opt', optionLabel: 'Rock' })),
    ).toBe('answered correctly and chose “Rock”');
  });

  it('falls back to the option id when its label is not to hand', () => {
    expect(describeAnswerFilter(input({ optionId: 'opt' }))).toBe('chose one option');
  });
});
