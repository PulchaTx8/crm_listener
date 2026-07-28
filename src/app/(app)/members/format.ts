import type { MemberBlockKind, MemberConsentType } from '@/services/members';

/** The three consents decision 2 fixed (0032_member_lifecycle_tables.sql) — no fourth value. */
export const CONSENT_TYPE_LABELS: Record<MemberConsentType, string> = {
  rules: 'Promotion rules',
  image_use: 'Use of image and name',
  sponsor_communication: 'Sponsor communication',
};

/** The two things a block covers (0032) — matches the members.block permission label. */
export const BLOCK_KIND_LABELS: Record<MemberBlockKind, string> = {
  draw_ban: 'Barred from draws',
  suspension: 'Suspended',
};

/** For a timestamptz field (createdAt, anonymizedAt, linkedAt) — an instant, rendered in the runtime's own zone. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * For a Postgres `date` column with no time component — birth_date (0031) is
 * the only field this screen renders that is one. `new Date(iso)` already
 * parses a date-only ISO string ("1990-05-10") as UTC midnight, per
 * ECMA-262; formatting with `timeZone: 'UTC'` pins the RENDERED calendar day
 * to that same anchor, so it cannot shift with the runtime's local zone the
 * way formatDate's plain toLocaleDateString did (Task 8 review, Important 1
 * — verified: "1990-05-10" rendered "9 May 1990" under
 * TZ=America/Sao_Paulo and "10 May 1990" under TZ=UTC before this fix, the
 * same stored value reading as two different birthdays depending on where
 * the Node process happened to be running — see the fix report for the
 * before/after under both zones). formatDate itself is intentionally left
 * timezone-naive for its own three timestamptz callers (createdAt,
 * anonymizedAt, linkedAt), which are real instants and are meant to render
 * in the viewer's own zone — this function exists because birth_date is not
 * one.
 */
export function formatCalendarDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
}
