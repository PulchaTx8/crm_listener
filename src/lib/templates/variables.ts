import type { Enums } from '@/lib/supabase/database.types';

/**
 * What a template may substitute. `template_variable` (0222), derived rather
 * than re-declared for the reason `lib/conversation/steps.ts` gives for
 * `RequestedField`: a hand-written union here would be a second place an eighth
 * value has to be added, and the two would disagree in silence.
 */
export type TemplateVariable = Enums<'template_variable'>;

/**
 * Whether a campaign can fill this value from the row it already reads.
 *
 * TOTAL OVER THE ENUM, and that is the only reason it exists as a record rather
 * than as two arrays: an eighth value does not compile until somebody says
 * which family it is in. The database cannot hold this fact — it is a statement
 * about what 29d's send loop has in hand — and a comment could not be checked.
 *
 * `false` does not mean unusable. The three false values are what the SYSTEM
 * templates carry, supplied by the specific caller that enqueues them
 * (`enqueue_pickup_reminder` computes the prize and the deadline;
 * `widget_request_code` mints the code). A campaign has none of those and never
 * will, which is why offering them would be offering a blank.
 */
export const CAMPAIGN_RESOLVABLE: Record<TemplateVariable, boolean> = {
  LISTENER_FIRST_NAME: true,
  LISTENER_FULL_NAME: true,
  LISTENER_CITY: true,
  STATION_NAME: true,
  PRIZE_NAME: false,
  PICKUP_DEADLINE: false,
  VERIFICATION_CODE: false,
};

/** The values a campaign may offer, in the enum's own order. */
export const CAMPAIGN_VARIABLES = (
  Object.keys(CAMPAIGN_RESOLVABLE) as TemplateVariable[]
).filter((value) => CAMPAIGN_RESOLVABLE[value]);

/**
 * The email notation for a value: `{{listener_first_name}}`.
 *
 * DERIVED, never declared. WhatsApp takes positional `{{1}}` because that is
 * what the Cloud API accepts, and email takes a name because a body is
 * self-describing — but both notations name the SAME vocabulary, and spelling
 * the second one out in a table would be the copy that goes stale.
 */
export function namedPlaceholder(value: TemplateVariable): string {
  return `{{${value.toLowerCase()}}}`;
}

/**
 * The value a placeholder names, or null.
 *
 * Null rather than a guess: the screen offers a closed list, so a name that
 * resolves to nothing is a hand-edited body, and substituting an empty string
 * for it is how a listener reads "Oi !" and nobody finds out.
 */
export function variableFromPlaceholder(name: string): TemplateVariable | null {
  const match = (Object.keys(CAMPAIGN_RESOLVABLE) as TemplateVariable[]).find(
    (value) => value.toLowerCase() === name.toLowerCase(),
  );
  return match ?? null;
}
