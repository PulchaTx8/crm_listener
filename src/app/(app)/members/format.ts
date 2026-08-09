import type { MemberBlockKind, MemberConsentType } from '@/services/members';

/** The four consents: three from decision 2 (0032_member_lifecycle_tables.sql) and identification from Block 17a. */
export const CONSENT_TYPE_LABEL_KEYS: Record<MemberConsentType, string> = {
  rules: 'consentRules',
  image_use: 'consentImageUse',
  sponsor_communication: 'consentSponsorCommunication',
  identification: 'consentIdentification',
};

/** The two things a block covers (0032) — matches the members.block permission label. */
export const BLOCK_KIND_LABEL_KEYS: Record<MemberBlockKind, string> = {
  draw_ban: 'blockDrawBan',
  suspension: 'blockSuspension',
};

/**
 * For a timestamptz field (createdAt, anonymizedAt, linkedAt) — an instant,
 * rendered as a calendar day pinned to UTC.
 *
 * The pin is not cosmetic. Until Block 3c both callers were Server Components,
 * so leaving the zone implicit meant "the Node process's zone" — disclosed as
 * debt, but at least deterministic. The audience grid and the record dialog are
 * CLIENT components: React renders them once on the server and again in the
 * browser, and an implicit zone would produce the server's calendar day in the
 * HTML and the viewer's in the hydrated DOM. Near midnight those differ, which
 * is a hydration mismatch and, worse, two different dates for the same stored
 * instant depending on when you looked.
 *
 * So this reads UTC on both sides, exactly as formatCalendarDate already does
 * for birth_date, and every screen agrees with itself. What it still does NOT
 * do is render the operator's own day: `companies.timezone` (0003) exists and
 * nothing reads it, which is the same debt Block 3 recorded, now uniform
 * instead of nondeterministic.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
}

/** Same UTC pin, same reason: this one renders inside the record dialog. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
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
 * timezone-naive for its own three timestamptz callers until Block 3c, when
 * moving them into client components forced the same UTC pin on formatDate
 * for a different reason: determinism between the server's render and the
 * browser's. This function still exists separately because birth_date is a
 * date-only column with no zone of its own, which is a different problem
 * from an instant needing to be shown as a day.
 */
export function formatCalendarDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
}

/**
 * Whole years, or null when there is no birth date on file — the audience
 * table's Age column (Block 3b). Computed entirely in UTC, the same anchor
 * formatCalendarDate uses to pin the rendered birthday and the same one the
 * age FILTER uses to turn a band into a birth_date range (isoDateYearsAgo,
 * services/members.ts): column and filter have to agree about which day it
 * is, or a listener could be filtered in as 30 and displayed as 29.
 *
 * Both therefore read the SERVER's calendar day, which can differ from the
 * operator's for a few hours a day — disclosed in isoDateYearsAgo's own
 * comment and in the block report, not silently absorbed here.
 */
export function ageFromBirthDate(iso: string | null): number | null {
  if (!iso) return null;
  const birth = new Date(iso);
  if (Number.isNaN(birth.getTime())) return null;

  const today = new Date();
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const monthsApart = today.getUTCMonth() - birth.getUTCMonth();
  if (monthsApart < 0 || (monthsApart === 0 && today.getUTCDate() < birth.getUTCDate())) {
    age -= 1;
  }
  return age < 0 ? null : age;
}
