// Kept synchronous and free of 'use server' (mirrors messages/errors.ts,
// dashboards/errors.ts and every other section's own) so a Server Component
// could call this directly with no await, the same reason those carry. /app
// has had no errors module until this task: page.tsx reads `companies`
// directly and logs a failure rather than throwing, so this is the FIRST
// write this section has, and the first AppError taxonomy to map.
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';

/**
 * The taxonomy `saveStationEmailIdentityAction` maps onto a sentence.
 *
 * Narrower than templates/errors.ts's own: mapProfileError
 * (services/company-profile.ts) never constructs a ConflictError or a
 * BusinessRuleError for this door -- there is no unique index behind
 * `save_station_email_identity` and no foreign key it could violate, only the
 * owner check (42501), a Station that no longer exists (P0002), and the two
 * CHECK constraints an address without an `@` in it fails (22023/23514). A
 * branch for a case mapProfileError cannot produce is not a safety margin;
 * it is a sentence nobody will ever see next to code that keeps claiming it
 * might be needed.
 *
 * `ValidationError` passes through verbatim, the same call templates/errors.ts
 * makes for its own: the CHECK is deliberately weak (companies_email_from_shape,
 * 0226) and typed by an operator reading an address off whatever their
 * provider gave them, not something a form validates ahead of the database.
 */
export function describeEmailIdentityError(
  cause: unknown,
  t: (key: string, values?: Record<string, string>) => string,
  actionKey: string,
): string {
  if (cause instanceof ValidationError) return cause.message;
  if (cause instanceof NotFoundError) {
    return t('thatCouldNotBeFound');
  }
  if (cause instanceof UnauthorizedError) {
    return t('youDoNotHavePermissionTo', { action: t(actionKey) });
  }
  // Generic on purpose: InternalError means the fault is ours, not theirs,
  // and its message may carry a raw database error -- not something to show.
  return t('couldNotSave');
}
