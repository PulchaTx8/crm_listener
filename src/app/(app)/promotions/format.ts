import type { PromotionSituation } from '@/lib/promotion-situation';
import type { PromotionQuestionKind } from '@/services/promotions';
import type { RequestedField } from '@/schemas/promotions';

/**
 * The four situations a promotion can be in, in the order the filter offers
 * them: the two that are still ahead of the operator, then the two that are
 * behind.
 *
 * Computed, never stored — the owner's decision was that the window decides,
 * with cancellation the one exception (design spec D1/D2). `situationOf` in
 * services/promotions.ts is the single place that computes it, called by both
 * the grid and the dialog; a second copy of that rule is how the two screens
 * start disagreeing about what "Live" means.
 */
export const SITUATION_LABELS: Record<PromotionSituation, string> = {
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

export const SITUATION_ORDER: PromotionSituation[] = ['scheduled', 'live', 'ended', 'cancelled'];

/** Muted for what is over, strong for what is running now. */
export const SITUATION_CLASSES: Record<PromotionSituation, string> = {
  scheduled: 'bg-amber-100 text-amber-900',
  live: 'bg-emerald-100 text-emerald-900',
  ended: 'bg-muted text-muted-foreground',
  cancelled: 'bg-destructive/10 text-destructive',
};

export const QUESTION_KIND_LABELS: Record<PromotionQuestionKind, string> = {
  QUIZ: 'Quiz',
  MULTIPLE_CHOICE: 'Poll',
  ESSAY: 'Written answer',
};

export const QUESTION_KIND_HINTS: Record<PromotionQuestionKind, string> = {
  QUIZ: 'Options, one of them the right answer.',
  MULTIPLE_CHOICE: 'Options, none of them right or wrong.',
  ESSAY: 'The listener types their own answer.',
};

/**
 * What the WhatsApp tab calls each field it can ask for, against the `members`
 * column it fills. Reworded freely: these are labels, and the enum value
 * underneath is the contract.
 */
export const REQUESTED_FIELD_LABELS: Record<RequestedField, string> = {
  full_name: 'Full name',
  address: 'Address',
  city: 'City',
  neighbourhood: 'Neighbourhood',
  age: 'Age',
  cpf: 'CPF',
  passport: 'Passport',
  discovery_source: 'How they found the Station',
};

/**
 * A window, in the Station's timezone rather than the reader's.
 *
 * The Station's zone is the one the promotion actually runs in: an operator in
 * another state reading their own local time would see a window that starts an
 * hour off from the one the bot enforces (spec L2).
 */
export function formatWindow(startsAt: string, endsAt: string, timeZone: string): string {
  return `${formatInstant(startsAt, timeZone)} → ${formatInstant(endsAt, timeZone)}`;
}

export function formatInstant(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(instant));
}

/** "1 question" / "3 questions" / "No quiz" — the grid's own column. */
export function formatQuestionCount(count: number): string {
  if (count === 0) return 'No quiz';
  return count === 1 ? '1 question' : `${count} questions`;
}
