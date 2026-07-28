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

/**
 * For a timestamptz field (createdAt, anonymizedAt, linkedAt) — an instant,
 * rendered with no explicit `timeZone`, so `toLocaleDateString` uses the
 * RUNTIME's own zone. Both current callers (members/page.tsx and
 * members/[memberId]/page.tsx) are Server Components — `export const dynamic
 * = 'force-dynamic'`, no `'use client'` — so that runtime is the SERVER, not
 * the browser reading the page: this renders in whatever zone the Node
 * process happens to be running in, never the viewer's own (whole-branch
 * review, I3 — an earlier version of this comment claimed the opposite,
 * "meant to render in the viewer's own zone," which described a mechanism
 * this function does not have; docs/block-3-report.md §5.6 already stated
 * the correct fact, so the code and the report disagreed). `companies.timezone`
 * (0003) exists if a future change wants the Station's own zone instead of
 * the server's; nothing here reads it today.
 */
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
 * anonymizedAt, linkedAt) — birth_date needs the UTC pin THIS function
 * applies because it is a date-only column with no zone of its own to begin
 * with; formatDate's own callers do not have that specific problem, but they
 * carry a different, disclosed one of their own (see formatDate's own
 * comment: it currently renders in the SERVER's zone, not the viewer's,
 * since both pages that call it are Server Components) — this function
 * exists because birth_date is not a timestamptz and needs a different fix
 * than that one.
 */
export function formatCalendarDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
}
