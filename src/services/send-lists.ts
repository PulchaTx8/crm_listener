import 'server-only';
import { decodeCursor } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import { listOrganizationMembers } from '@/services/members';
import { listParticipationsPage } from '@/services/participations';
import { listMusicRequestsPage } from '@/services/music';
import type {
  MemberSendListFilters,
  ParticipationSendListFilters,
  RequestSendListFilters,
  SendListSource,
} from '@/schemas/send-lists';

/**
 * Thrown by resolveListMembers when a list's true population runs past
 * RESOLVE_CAP and more remains unread. There is no other signal for this —
 * resolveListMembers never returns a quietly shortened array — which is the
 * whole reason RESOLVE_CAP's own comment gives for existing at all.
 */
export class SendListResolutionCappedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendListResolutionCappedError';
  }
}

/**
 * The people a list holds, found by asking the same service the screen asked.
 *
 * NOTHING HERE RE-IMPLEMENTS A FILTER, and that is the whole design. The three
 * listing services hold the only correct definition of what each screen shows;
 * a predicate restated here would drift, and a drifted list means something
 * different from what the operator saw when they made it — which is the one
 * failure this feature exists to avoid.
 *
 * DISTINCT PEOPLE, not rows. Requests and Participations are per event:
 * somebody who asked for twelve songs is twelve rows and one recipient.
 *
 * AND A NULL member_id IS DROPPED, not counted. `list_music_requests`
 * (0191_music_requests_list_triage.sql:50) returns a nullable member_id — a
 * request whose listener was never resolved has none. Carrying those forward
 * would put holes in a list whose count the operator is about to trust.
 *
 * CAPPED, and the cap is reported rather than silently applied. A list that
 * quietly held the first ten thousand of forty thousand would be a number the
 * operator trusts and should not.
 */
export const RESOLVE_CAP = 10_000;

function cappedError(): SendListResolutionCappedError {
  return new SendListResolutionCappedError(
    `A send list cannot hold more than ${RESOLVE_CAP} people; this filter resolves to more, and resolution stopped rather than silently keeping only the first ${RESOLVE_CAP}.`,
  );
}

/**
 * organizationId, not companyId: the Members screen is Organization-wide
 * (spec — a listener is not owned by one Station), unlike Requests and
 * Participations below. Which Station a list built from Members belongs to
 * is asked separately, by the dialog that calls this (D3) — not decided here.
 *
 * `sort`/`direction` are fixed to 'created'/'asc' rather than taken from the
 * filters: this resolver never renders anything, so which column the screen
 * happened to be sorted by does not matter, and 'created' — unlike 'name' —
 * is never null, so there is no null-region boundary a fixed choice could
 * strand rows behind the way an arbitrary one might.
 */
async function resolveMemberIds(
  filters: MemberSendListFilters,
  accessToken: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: Cursor | null = null;

  for (;;) {
    const page = await listOrganizationMembers(
      {
        organizationId: filters.organizationId,
        search: filters.search,
        sort: 'created',
        direction: 'asc',
        cursor,
        cursorSide: 'after',
        ageMin: filters.ageMin,
        ageMax: filters.ageMax,
        blockedOnly: filters.blockedOnly,
        hasRulesConsent: filters.hasRulesConsent,
        gender: filters.gender,
        registeredFrom: filters.registeredFrom,
        registeredTo: filters.registeredTo,
      },
      accessToken,
    );

    for (const row of page.rows) ids.add(row.id);

    if (page.nextCursor === null) return ids;
    if (ids.size >= RESOLVE_CAP) throw cappedError();
    cursor = decodeCursor(page.nextCursor);
  }
}

async function resolveParticipationIds(
  filters: ParticipationSendListFilters,
  accessToken: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: Cursor | null = null;

  for (;;) {
    const page = await listParticipationsPage(
      {
        companyId: filters.companyId,
        promotionId: filters.promotionId,
        status: filters.status,
        source: filters.source,
        from: filters.from,
        to: filters.to,
        search: filters.search,
        answeredCorrectly: filters.answeredCorrectly,
        optionId: filters.optionId,
        cursor,
        cursorSide: 'after',
      },
      accessToken,
    );

    // DISTINCT PEOPLE, not rows: a listener with twelve valid entries in one
    // promotion is twelve rows here and one id in the Set.
    for (const row of page.rows) ids.add(row.memberId);

    if (page.nextCursor === null) return ids;
    if (ids.size >= RESOLVE_CAP) throw cappedError();
    cursor = decodeCursor(page.nextCursor);
  }
}

async function resolveRequestIds(
  filters: RequestSendListFilters,
  accessToken: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: Cursor | null = null;

  for (;;) {
    const page = await listMusicRequestsPage(
      {
        companyId: filters.companyId,
        songId: filters.songId,
        showId: filters.showId,
        channel: filters.channel,
        search: filters.search,
        readStatus: filters.readStatus,
        playStatus: filters.playStatus,
        // The only ordering list_music_requests can page through a cursor
        // (0191's own comment) — the other three return one bounded batch
        // each and ignore the cursor entirely, which would make this loop
        // re-read the same rows forever. Order is display-only; forcing it
        // here changes nothing this resolver keeps (a Set has none).
        sort: 'requested',
        cursor,
        cursorSide: 'after',
      },
      accessToken,
    );

    for (const row of page.rows) {
      // list_music_requests declares `member_id uuid` with no `not null`
      // (0191_music_requests_list_triage.sql:50) — a request whose listener
      // was never resolved has none. Neither RequestSummary's own field nor
      // the generated Supabase RPC return type mark it nullable; both were
      // checked against 0191's `returns table` directly rather than trusted,
      // and both disagree with what the SQL actually declares. Read
      // defensively here regardless of what either type claims.
      if (row.memberId) ids.add(row.memberId);
    }

    if (page.nextCursor === null) return ids;
    if (ids.size >= RESOLVE_CAP) throw cappedError();
    cursor = decodeCursor(page.nextCursor);
  }
}

export function resolveListMembers(
  source: 'members',
  filters: MemberSendListFilters,
  accessToken: string,
): Promise<string[]>;
export function resolveListMembers(
  source: 'participations',
  filters: ParticipationSendListFilters,
  accessToken: string,
): Promise<string[]>;
export function resolveListMembers(
  source: 'requests',
  filters: RequestSendListFilters,
  accessToken: string,
): Promise<string[]>;
export async function resolveListMembers(
  source: SendListSource,
  filters: MemberSendListFilters | ParticipationSendListFilters | RequestSendListFilters,
  accessToken: string,
): Promise<string[]> {
  switch (source) {
    case 'members':
      return [...(await resolveMemberIds(filters as MemberSendListFilters, accessToken))];
    case 'participations':
      return [
        ...(await resolveParticipationIds(filters as ParticipationSendListFilters, accessToken)),
      ];
    case 'requests':
      return [...(await resolveRequestIds(filters as RequestSendListFilters, accessToken))];
    default: {
      // Exhaustiveness: a fourth send_list_source value added to 0237 without
      // a branch here is a compile error, not a silent no-op resolution.
      const exhaustive: never = source;
      throw new Error(`Unknown send list source: ${String(exhaustive)}`);
    }
  }
}
