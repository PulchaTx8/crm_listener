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
  | { kind: 'question'; questionId: string; questionKind: string };

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
      steps.push({ kind: 'question', questionId: step.questionId, questionKind: step.questionKind });
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
 * THREE OUTCOMES, NOT TWO. A first version folded "already entered" into the
 * same bucket as "not in the list at all" and sent both back to the bare
 * two-button menu — which is wrong for the one that IS in the list: a
 * listener who tapped a link about a specific promotion they already
 * finished is not the same case as one whose link names nothing they can
 * see, and dropping them on two context-free buttons answers neither. Doing
 * nothing and letting the ordinary list render is what shows them their own
 * promotion, disabled, with `alreadyEntered` already on screen — the answer
 * to the question their link actually asked, in less code than a special
 * screen would have taken.
 */
export type AutoOpenDecision =
  | { action: 'open'; promotion: WidgetPromotion }
  | { action: 'show-list' }
  | { action: 'back-to-menu' };

export function decideAutoOpen(promotions: WidgetPromotion[], autoOpenId: string): AutoOpenDecision {
  const match = promotions.find((promotion) => promotion.id === autoOpenId);
  if (!match) return { action: 'back-to-menu' };
  if (match.alreadyEntered) return { action: 'show-list' };
  return { action: 'open', promotion: match };
}
