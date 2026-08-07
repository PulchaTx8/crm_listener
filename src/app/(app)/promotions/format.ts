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

export const QUESTION_KIND_LABEL_KEYS: Record<PromotionQuestionKind, string> = {
  QUIZ: 'questionKindQuiz',
  MULTIPLE_CHOICE: 'questionKindPoll',
  ESSAY: 'questionKindEssay',
};

export const QUESTION_KIND_HINT_KEYS: Record<PromotionQuestionKind, string> = {
  QUIZ: 'questionHintQuiz',
  MULTIPLE_CHOICE: 'questionHintPoll',
  ESSAY: 'questionHintEssay',
};

/**
 * What the WhatsApp tab calls each field it can ask for, against the `members`
 * column it fills. Reworded freely: these are labels, and the enum value
 * underneath is the contract.
 */
export const REQUESTED_FIELD_LABEL_KEYS: Record<RequestedField, string> = {
  full_name: 'requestedFieldFullName',
  address: 'requestedFieldAddress',
  city: 'requestedFieldCity',
  neighbourhood: 'requestedFieldNeighbourhood',
  age: 'requestedFieldAge',
  cpf: 'requestedFieldCpf',
  passport: 'requestedFieldPassport',
  discovery_source: 'requestedFieldDiscoverySource',
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

/**
 * "1 question" / "3 questions" / "No quiz" — the grid's own column, as a
 * single ICU message with a `=0` case. English adds a letter for the plural
 * and nothing else here does, so each language answers for itself.
 */
export function formatQuestionCount(
  count: number,
  t: (key: string, values?: Record<string, string | number | Date>) => string,
): string {
  return t('questionCount', { count });
}
