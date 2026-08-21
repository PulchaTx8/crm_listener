/**
 * Block 17c. The pure half of `promotion-actions.ts`.
 *
 * IT LIVES HERE TO BE TESTABLE. A module carrying `'use server'` may export
 * nothing but async functions, so a mapping written in that file cannot be
 * imported by a test at all — the same split 17b made for `music-mapping.ts`.
 */

/** One step the listener still has to answer, as `whatsapp_conversation_steps` (0066) returns it. */
export type WidgetStep =
  | { kind: 'consent' }
  | { kind: 'field'; field: string }
  | {
      kind: 'question';
      questionId: string;
      questionKind: string;
      /**
       * The text the operator wrote (`promotion_questions.prompt`, 0041, which
       * is `not null` with a non-blank CHECK). Block 30d, item 1: until 0264
       * the step carried the question's id and kind and no words at all, so the
       * panel drew alternatives under nothing.
       *
       * EMPTY STRING WHEN THE DOOR DID NOT SEND ONE. THE DIRECTION THIS GUARDS
       * IS THE BUNDLE AHEAD OF THE MIGRATION, NOT BEHIND IT: this type already
       * promises every question step a `prompt`, and a door that has not
       * applied 0264 yet answers without that key -- not hypothetical here,
       * since this project has shipped frontend code ahead of its own
       * migrations three times before (Blocks 13a, 17b, 17c). Without the
       * coercion, `step.prompt` would be `undefined` at runtime despite the
       * type declaring it a `string`, and the panel renders it unconditionally.
       * An OLD bundle meeting THIS door needs no guard at all -- it never
       * reads `step.prompt`, which is what makes a step gaining a key
       * backward compatible by construction (design spec D1).
       */
      prompt: string;
    };

/** One alternative a listener can choose. Never carries which one is right. */
export interface WidgetOption {
  id: string;
  label: string;
}

/** One promotion, as the widget shows it. */
export interface WidgetPromotion {
  id: string;
  name: string;
  rules: string;
  artUrl: string | null;
  thumbUrl: string | null;
  alreadyEntered: boolean;
  steps: WidgetStep[];
  /**
   * The alternatives, by question id. Empty for an open question, and for any
   * question this code could not read — the panel draws a text box only for
   * `ESSAY`, so an unreadable quiz shows no options and the door then refuses
   * the submission rather than recording an answer nobody chose.
   */
  options: Record<string, WidgetOption[]>;
}

/**
 * `answer_text` or `option_id`, decided by the question's kind.
 *
 * participation_answers_shape (0052) requires `option_id` with a null
 * `answer_text` for QUIZ and MULTIPLE_CHOICE, and exactly the opposite for
 * ESSAY. Sending the wrong one trips a CHECK deep inside apply_participation
 * and reaches a listener as "something went wrong" — which is what the first
 * version of this panel did, because it drew a text box for every kind.
 */
export function answersFor(
  steps: WidgetStep[],
  chosen: Record<string, string>,
): Array<{ question_id: string; option_id?: string; answer_text?: string }> {
  return steps.flatMap((step) => {
    if (step.kind !== 'question') return [];
    const value = chosen[step.questionId];
    if (value === undefined || value === '') return [];

    return [
      step.questionKind === 'ESSAY'
        ? { question_id: step.questionId, answer_text: value }
        : { question_id: step.questionId, option_id: value },
    ];
  });
}

export function readOptions(value: unknown): Record<string, WidgetOption[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const byQuestion: Record<string, WidgetOption[]> = {};
  for (const [questionId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(raw)) continue;
    byQuestion[questionId] = raw.flatMap((entry): WidgetOption[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const option = entry as Record<string, unknown>;
      if (typeof option.id !== 'string' || typeof option.label !== 'string') return [];
      return [{ id: option.id, label: option.label }];
    });
  }
  return byQuestion;
}

export type EnterRefusal =
  | 'invalid'
  | 'no_session'
  | 'rate_limited'
  | 'promotion_closed'
  | 'already_entered'
  | 'missing_answers'
  | 'listener_anonymized'
  | 'unknown_installation'
  | 'failed';

/**
 * A reason from 0171, narrowed to one this application has a sentence for.
 *
 * `refused` IS NOT HERE, and its absence is the design. Declining is a real
 * outcome rather than a failure — the door writes a `promotion_refusals` row
 * and the panel says the entry was not recorded — so the action gives it a
 * state of its own instead of dressing it as an error.
 *
 * An unrecognised value becomes `failed` rather than reaching the client
 * verbatim: the panel renders a message per reason, and a reason with no
 * message renders as nothing at all, which is the failure mode where the
 * button appears to do nothing.
 *
 * `unknown_listener` becomes `no_session`. The door uses it both for a listener
 * belonging to another Station and for one that does not exist; from a
 * visitor's side those are the same fact, neither is actionable, and what they
 * CAN do is identify again.
 */
export function enterRefusal(reason: string | null): EnterRefusal {
  switch (reason) {
    case 'promotion_closed':
    case 'already_entered':
    case 'missing_answers':
    case 'listener_anonymized':
    case 'unknown_installation':
      return reason;
    case 'unknown_listener':
      return 'no_session';
    default:
      return 'failed';
  }
}

/**
 * The steps as the panel walks them, checked rather than asserted.
 *
 * The door computes this list and the browser only renders it, so a shape this
 * code does not recognise means the two have drifted — and rendering a step
 * whose kind is unknown would be a screen that asks for nothing and submits
 * nothing. Unknown kinds are dropped, and the door refuses the submission that
 * results, which is the safe direction: a listener sees a shorter walk rather
 * than a broken one, and the entry does not go through half-answered.
 */
export function readSteps(value: unknown): WidgetStep[] {
  if (!Array.isArray(value)) return [];

  const steps: WidgetStep[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const step = raw as Record<string, unknown>;

    if (step.kind === 'consent') {
      steps.push({ kind: 'consent' });
    } else if (step.kind === 'field' && typeof step.field === 'string') {
      steps.push({ kind: 'field', field: step.field });
    } else if (
      step.kind === 'question' &&
      typeof step.questionId === 'string' &&
      typeof step.questionKind === 'string'
    ) {
      steps.push({
        kind: 'question',
        questionId: step.questionId,
        questionKind: step.questionKind,
        prompt: typeof step.prompt === 'string' ? step.prompt : '',
      });
    }
  }
  return steps;
}

/**
 * Block 19a, Task 7 (fix round 1). What `?open=promotion&id=…` should do,
 * once `EnterPromotionPanel`'s own list has settled — the second half of
 * validating that id, after `parseOpenTarget` (open-target.ts) has already
 * checked its SHAPE. `promotions` is exactly the list this listener is
 * entitled to see; there is no fourth outcome to invent because there is no
 * fourth thing this list can say about an id.
 *
 * FOUR OUTCOMES SINCE BLOCK 30d's FIX ROUND 3, and the fourth is here rather
 * than in the panel's effect for the reason the third is: it is decided by the
 * same two inputs as the others, so answering it anywhere else would be the
 * same question asked in two places, free to drift. `confirm` is a promotion
 * this listener has nothing left to answer for -- `needsNoWalk`, below in this
 * file -- reached by a LINK rather than by a tap on the list.
 *
 * WHY IT IS NOT `open`. `open` means "walk this promotion", and a promotion
 * with nothing to ask has no walk to draw: the panel would render a consent
 * screen the owner's ruling of 2026-08-21 removed from this path, or, once it
 * stopped rendering that, nothing at all -- which is the defect this outcome
 * exists to close. A link that named a promotion dropped the listener on the
 * generic list.
 *
 * WHY IT IS NOT AN ENTRY. The list's own fast path submits on the tap, and the
 * tap is the deliberate act. Arriving by link, no act has happened yet: a
 * screen that entered on render would enter again on a refresh, on a link
 * opened by mistake, and on whatever fetches a URL to preview it -- and this
 * door writes a participation and a consent row. So `confirm` names a SCREEN,
 * and the panel puts one button on it. One tap, exactly what the list costs,
 * and not one more question -- which is what item 14 asked for.
 *
 * ALREADY-ENTERED IS TESTED FIRST and that order is load-bearing: a no-walk
 * promotion this listener has already entered is still `show-list`, the
 * answer that shows them their own promotion with `alreadyEntered` on it.
 * Reversing the two would offer them an entry the door would refuse.
 *
 * WHY THERE WERE THREE, which is the reasoning the fourth was added on top of
 * rather than a live count -- Block 20a's fix round 1: a first version folded
 * "already entered" into the
 * same bucket as "not in the list at all" and sent both back to the bare
 * two-button menu — which is wrong for the one that IS in the list: a
 * listener who tapped a link about a specific promotion they already
 * finished is not the same case as one whose link names nothing they can
 * see, and dropping them on two context-free buttons answers neither. Doing
 * nothing and letting the ordinary list render is what shows them their own
 * promotion, disabled, with `alreadyEntered` already on screen — the answer
 * to the question their link actually asked, in less code than a special
 * screen would have taken. That argument is why `show-list` still wins over
 * `confirm` today.
 */
export type AutoOpenDecision =
  | { action: 'open'; promotion: WidgetPromotion }
  | { action: 'confirm'; promotion: WidgetPromotion }
  | { action: 'show-list' }
  | { action: 'back-to-menu' };

export function decideAutoOpen(promotions: WidgetPromotion[], autoOpenId: string): AutoOpenDecision {
  const match = promotions.find((promotion) => promotion.id === autoOpenId);
  if (!match) return { action: 'back-to-menu' };
  if (match.alreadyEntered) return { action: 'show-list' };
  if (needsNoWalk(match.steps)) return { action: 'confirm', promotion: match };
  return { action: 'open', promotion: match };
}

/**
 * The step list collapsed into the screens the panel walks.
 *
 * MOVED HERE FROM `enter-promotion.tsx` (Block 20a) so that
 * `firstUnansweredScreen` below and the panel agree on what a screen index
 * means. Two copies of this layout would be two places for them to drift, and
 * the drift would show up as the panel jumping to the wrong screen — which is
 * worse than not jumping at all.
 *
 * Consent alone, because it gates everything after it; then every requested
 * field on one screen, which is what somebody filling in a form expects; then
 * one question per screen, because each carries its own alternatives.
 */
export function screensFor(steps: WidgetStep[]): WidgetStep[][] {
  const fieldSteps = steps.filter((step) => step.kind === 'field');
  const questions = steps.filter((step) => step.kind === 'question');
  return [
    [{ kind: 'consent' } as WidgetStep],
    ...(fieldSteps.length > 0 ? [fieldSteps] : []),
    ...questions.map((question) => [question]),
  ];
}

/**
 * Whether this promotion asks this listener nothing at all.
 *
 * Block 30d, D8 and D10. Consent is not counted: by the owner's ruling of
 * 2026-08-21 the rules screen does not appear on this path, and the door
 * records the consent from the act of entering instead. Which is also why
 * this is not `screensFor(steps).length === 1` written another way round --
 * that reads as an opinion about layout, and this is a question about what is
 * being asked.
 *
 * READ BY `decideAutoOpen` ABOVE AS WELL AS BY THE PANEL, which is why the two
 * cannot disagree about what a link should open: one function, both callers.
 *
 * A COURTESY, NEVER A GUARD -- the same standing `firstUnansweredScreen` has.
 * `widget_enter_promotion` recomputes the step list and remains the only
 * authority on what a promotion asks; this function decides which screen a
 * browser draws, and a disagreement between the two shows up as a refusal the
 * panel already renders rather than as an entry nobody checked. Answering true
 * where the door disagrees costs a `missing_answers` the panel has a sentence
 * for; answering false where the door agrees costs a consent screen the
 * listener can still tick.
 */
export function needsNoWalk(steps: WidgetStep[]): boolean {
  return !steps.some((step) => step.kind === 'field' || step.kind === 'question');
}

/**
 * The first screen still holding a step with nothing in it, or null.
 *
 * Block 20a, D4. `missing_answers` says something was skipped and not which
 * thing, on a walk that can be four screens long — so the panel, which holds
 * every answer, works out where to send the listener rather than asking them
 * to search.
 *
 * A COURTESY, NEVER A GUARD. The door recomputes the step list and remains the
 * only authority on what a promotion asks (0171's own comment). This function
 * answering null while the door refuses is a real and informative state: it
 * means the screen and the door disagree about what was asked, which is
 * exactly the shape of the defect this block investigated, and the panel
 * leaves the listener where they are with the message on screen rather than
 * smoothing it over.
 *
 * CONSENT IS NOT CHECKED. Declining is not a missing_answers refusal — the
 * door writes a promotion_refusals row and answers `refused`, which the panel
 * renders as its own state.
 *
 * `btrim`-equivalent on purpose: 0171 tests `nullif(btrim(coalesce(...)), '')`,
 * so whitespace is not an answer on either side of the wire.
 */
export function firstUnansweredScreen(
  screens: WidgetStep[][],
  fields: Record<string, string>,
  answers: Record<string, string>,
): number | null {
  const index = screens.findIndex((screen) =>
    screen.some((step) => {
      if (step.kind === 'field') return (fields[step.field] ?? '').trim() === '';
      if (step.kind === 'question') return (answers[step.questionId] ?? '').trim() === '';
      return false;
    }),
  );
  return index === -1 ? null : index;
}
