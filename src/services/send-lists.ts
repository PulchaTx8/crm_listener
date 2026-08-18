import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { InternalError, NotFoundError } from '@/lib/errors';
import { decodeCursor } from '@/lib/keyset';
import type { Cursor } from '@/lib/keyset';
import { listOrganizationMembers } from '@/services/members';
import { listParticipationsPage } from '@/services/participations';
import { listMusicRequestsPage } from '@/services/music';
import type { Database } from '@/lib/supabase/database.types';
import {
  memberSendListFiltersSchema,
  participationSendListFiltersSchema,
  requestSendListFiltersSchema,
} from '@/schemas/send-lists';
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
 * AND A ROW WITH NO member_id IS DROPPED, not counted, if one ever arrived.
 * Nothing today can produce one: music_requests.member_id is `uuid not null`
 * with a mandatory FK (0098_music_catalogue.sql:193, 213-215) and
 * list_music_requests inner-joins members (0191_music_requests_list_triage.sql:123),
 * so every row it returns already has one. The check guards against a future
 * change to either fact, at no cost today.
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
      // Defensive, not descriptive of anything that can happen today:
      // music_requests.member_id is `uuid not null` (0098_music_catalogue.sql:193)
      // and list_music_requests inner-joins members (0191:123), so no row
      // here can actually carry a null. Nothing at the type level enforces
      // that fact, so the check stays rather than being trusted away.
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

/**
 * members_marketing_eligible_bulk (0235) re-checks the caller's own
 * permission inside its own SECURITY DEFINER body -- has_permission reads
 * auth.uid() -- so a client carrying anything other than the caller's own JWT
 * would answer a different question than the one being asked. Its own header
 * is explicit about the alternative: called with no identity, it now REFUSES
 * (42501) rather than silently answering, which is exactly what listReach
 * below turns into 'forbidden' instead of a count.
 */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * A channel's reach, or the reason there is no number: 'forbidden' when 0235
 * refused the call outright (42501) rather than answering. A caller who can
 * see this list (messaging.view) is not guaranteed to hold what 0235 itself
 * requires (members.view, the platform admin, or the Organization's owner) --
 * a Station may hand those to different people -- so a real 0 and "not
 * permitted to know" cannot share a representation. `'forbidden'` can never be
 * mistaken for a count the way a numeric 0 could.
 */
export type ChannelReach = number | 'forbidden';

export interface ListReach {
  people: number;
  whatsapp: ChannelReach;
  email: ChannelReach;
}

/**
 * `list.filters` comes back as plain jsonb (0238) -- create_send_list (0239)
 * stores whatever it is given, with no shape enforced by the database. Parsing
 * it here through the same three schemas resolveListMembers' own overloads
 * require is what turns that untyped value back into one TypeScript -- not
 * just this function's author -- knows matches the source it is paired with,
 * and it is where a row whose filters no longer fit its own source's shape
 * would surface, rather than being passed on silently.
 */
function resolvePeopleForList(
  source: SendListSource,
  filters: unknown,
  accessToken: string,
): Promise<string[]> {
  switch (source) {
    case 'members':
      return resolveListMembers('members', memberSendListFiltersSchema.parse(filters), accessToken);
    case 'participations':
      return resolveListMembers(
        'participations',
        participationSendListFiltersSchema.parse(filters),
        accessToken,
      );
    case 'requests':
      return resolveListMembers('requests', requestSendListFiltersSchema.parse(filters), accessToken);
    default: {
      // Same exhaustiveness guard resolveListMembers' own switch carries above.
      const exhaustive: never = source;
      throw new Error(`Unknown send list source: ${String(exhaustive)}`);
    }
  }
}

async function channelReach(
  client: ReturnType<typeof asCaller>,
  memberIds: string[],
  companyId: string,
  channel: Database['public']['Enums']['message_channel'],
): Promise<ChannelReach> {
  const { data, error } = await client.rpc('members_marketing_eligible_bulk', {
    p_member_ids: memberIds,
    p_company_id: companyId,
    p_channel: channel,
  });

  if (error) {
    // 0235's own three-arm guard, checked once for the whole batch: refused
    // outright as 42501 for a caller holding none of platform admin, the
    // Organization's owner, or members.view at this Station. Nothing else
    // this call can fail with means "not permitted" -- an unrelated error
    // (a down connection, say) must still surface as a failure, not quietly
    // become the same 'forbidden' a permission refusal produces.
    if (error.code === '42501') return 'forbidden';
    throw new InternalError(`Could not compute ${channel} reach: ${error.message}`);
  }

  return (data ?? []).filter((row) => row.eligible).length;
}

/**
 * How many of a list's people may actually be written to, per channel.
 *
 * A list of 500 is not 500 messages. On e-mail it is nearly that; on WhatsApp
 * today it is close to zero, because 29c's D1 requires an explicit opt-in and
 * collection only began with that block. Both numbers sit on the screen before
 * anything is sent -- without them the first WhatsApp campaign looks like a
 * defect rather than like an audience that has not been asked yet.
 *
 * ASKED AS THE OPERATOR, never as a worker. members_marketing_eligible_bulk
 * (0235) is SECURITY DEFINER behind a permission gate and refuses a caller with
 * no identity outright.
 *
 * THE LIST SCREEN IS GATED ON messaging.view (0238); 0235's OWN GATE WANTS
 * members.view (or the platform admin, or the Organization's owner). Those are
 * two different permissions a Station can hand to two different people, so a
 * caller who can see this list can still be refused reach on it -- see
 * channelReach and ChannelReach above for how that refusal is told apart from
 * an audience of zero.
 */
export async function listReach(listId: string, accessToken: string): Promise<ListReach> {
  const client = asCaller(accessToken);

  const { data: list, error: listError } = await client
    .from('send_lists')
    .select('company_id, source, filters')
    .eq('id', listId)
    .is('deleted_at', null)
    .maybeSingle();

  if (listError) throw new InternalError(`Could not read send list ${listId}: ${listError.message}`);
  if (!list) throw new NotFoundError(`send list not found: ${listId}`);

  const memberIds = await resolvePeopleForList(list.source, list.filters, accessToken);

  const [whatsapp, email] = await Promise.all([
    channelReach(client, memberIds, list.company_id, 'WHATSAPP'),
    channelReach(client, memberIds, list.company_id, 'EMAIL'),
  ]);

  return { people: memberIds.length, whatsapp, email };
}
