/**
 * What the answer filter offers, and how it reads back.
 *
 * In `@/lib` rather than beside the screen because the filter row is a client
 * component and `@/services/participations` is `server-only` — the same reason
 * `@/lib/participation-status` and `@/lib/linkable-prizes` exist.
 *
 * These functions decide what the row RENDERS. What it FILTERS is decided in
 * SQL (`list_participations`, 0090), and the two may disagree only in the safe
 * direction: the screen may offer less than the function accepts, never more.
 */

export interface AnswerFilterInput {
  /** Both filters need one: a question belongs to a promotion, and so does a right answer. */
  promotionId?: string;
  /** Whether the chosen promotion asks anything of kind QUIZ. */
  promotionHasQuiz: boolean;
  /** Whether it asks anything with options at all — a quiz or a poll. */
  promotionHasOptions: boolean;
  answeredCorrectly?: boolean;
  optionId?: string;
  /** For the description only; absent when the picker has not loaded its labels. */
  optionLabel?: string;
}

export interface AnswerFilterState {
  correctnessAvailable: boolean;
  optionsAvailable: boolean;
  /** Why nothing is on offer, for the row to say instead of rendering dead controls. */
  reason: string | null;
}

export function answerFilterState(input: AnswerFilterInput): AnswerFilterState {
  if (!input.promotionId) {
    return {
      correctnessAvailable: false,
      optionsAvailable: false,
      // Said rather than left blank: an operator looking for a filter they were
      // told about should learn what to do, not wonder where it went.
      reason: 'Choose a promotion to filter by what people answered.',
    };
  }

  return {
    // A promotion with no QUIZ question has nothing to be right about —
    // promotion_participation_correctness (0089) answers true for everybody, so
    // a correct/wrong control would offer a choice with one outcome.
    correctnessAvailable: input.promotionHasQuiz,
    optionsAvailable: input.promotionHasOptions,
    reason: null,
  };
}

/** A sentence for the filter summary, or null when neither filter is set. */
export function describeAnswerFilter(input: AnswerFilterInput): string | null {
  const parts: string[] = [];

  if (input.answeredCorrectly === true) parts.push('answered correctly');
  if (input.answeredCorrectly === false) parts.push('answered wrongly');

  if (input.optionId) {
    parts.push(input.optionLabel ? `chose “${input.optionLabel}”` : 'chose one option');
  }

  if (parts.length === 0) return null;
  // "and", never "or": the filters ADD (D5), and a summary reading "or" would
  // promise a list the query will not return.
  return parts.join(' and ');
}
