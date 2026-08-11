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

/** One promotion, as the widget shows it. */
export interface WidgetPromotion {
  id: string;
  name: string;
  rules: string;
  artUrl: string | null;
  thumbUrl: string | null;
  alreadyEntered: boolean;
  steps: WidgetStep[];
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
