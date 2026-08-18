import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import {
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@/lib/errors';
import { decodeCursor, encodeCursor, keysetFilter } from '@/lib/keyset';
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
  DeleteSendListInput,
  MemberSendListFilters,
  ParticipationSendListFilters,
  RenameSendListInput,
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
 * A LIVING list's people, resolved fresh every time -- there is nothing frozen
 * for one of these to read, so its people are exactly whoever its stored
 * filters match right now (0238's own header). `list.filters` comes back as
 * plain jsonb -- create_send_list (0239) stores whatever it is given, with no
 * shape enforced by the database -- so it is parsed here through the same
 * three schemas resolveListMembers' own overloads require, which is what
 * turns that untyped value back into one TypeScript -- not just this
 * function's author -- knows matches the source it is paired with, and where
 * a row whose filters no longer fit its own source's shape would surface,
 * rather than being passed on silently.
 *
 * A FIXED list does NOT go through here -- see peopleForList below.
 */
function resolveLivingListPeople(
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

/**
 * FIXED and LIVING diverge here on purpose, not by oversight (Task 5 fix
 * round 1, F3). A FIXED list's people are frozen into send_list_members at
 * creation and, per 0238's own header, never change -- send_list_member_ids
 * (0240) is the one read door onto that table, since it carries RLS with no
 * policy of its own. A LIVING list has nothing frozen to read; its people are
 * whatever its stored filters match right now, which resolveLivingListPeople
 * already computes the same way the screens themselves do.
 *
 * Resolving a FIXED list through its filters instead -- which is what this
 * function did before 0240 existed, for lack of any door onto
 * send_list_members -- reports reach for whoever matches TODAY, not for the
 * roster the list actually holds. That is wrong specifically for the one kind
 * of list that exists so that number does not move.
 */
function peopleForList(
  client: ReturnType<typeof asCaller>,
  listId: string,
  list: { source: SendListSource; filters: unknown; kind: Database['public']['Enums']['send_list_kind'] },
  accessToken: string,
): Promise<string[]> {
  if (list.kind === 'fixed') {
    return readFixedListMemberIds(client, listId);
  }
  return resolveLivingListPeople(list.source, list.filters, accessToken);
}

async function readFixedListMemberIds(
  client: ReturnType<typeof asCaller>,
  listId: string,
): Promise<string[]> {
  const { data, error } = await client.rpc('send_list_member_ids', { p_list_id: listId });

  if (error) {
    // listReach's own SELECT on send_lists (below) already found this row
    // moments earlier, RLS-gated on the same messaging.view the door
    // re-checks -- so a caller who got that row already had the permission.
    // A 42501 from the door after that means the permission changed BETWEEN
    // the two calls, not that the list is missing, so it is left to fall
    // through to InternalError below rather than being folded into P0002.
    if (error.code === 'P0002') throw new NotFoundError(`send list not found: ${listId}`);
    throw new InternalError(`Could not read send list members for ${listId}: ${error.message}`);
  }

  return data ?? [];
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
 *
 * WHO COUNTS AS "the list's people" ALSO SPLITS ON kind, since Task 5's own
 * fix round 1 (F3): see peopleForList's comment for why a FIXED list reads
 * send_list_member_ids (0240) and a LIVING one re-resolves its filters.
 */
export async function listReach(listId: string, accessToken: string): Promise<ListReach> {
  const client = asCaller(accessToken);

  const { data: list, error: listError } = await client
    .from('send_lists')
    .select('company_id, source, filters, kind')
    .eq('id', listId)
    .is('deleted_at', null)
    .maybeSingle();

  if (listError) throw new InternalError(`Could not read send list ${listId}: ${listError.message}`);
  if (!list) throw new NotFoundError(`send list not found: ${listId}`);

  const memberIds = await peopleForList(client, listId, list, accessToken);

  const [whatsapp, email] = await Promise.all([
    channelReach(client, memberIds, list.company_id, 'WHATSAPP'),
    channelReach(client, memberIds, list.company_id, 'EMAIL'),
  ]);

  return { people: memberIds.length, whatsapp, email };
}

// ---------------------------------------------------------------------------
// Task 6: the grid, and the two writes it offers (rename, soft delete).
// create_send_list has no wrapper here -- nothing built in this task calls it;
// the dialog that does is a later task's own file.
// ---------------------------------------------------------------------------

/**
 * The code taxonomy `create_send_list`, `rename_send_list` and
 * `delete_send_list` (0239) actually raise -- narrower than templates.ts's own
 * `mapTemplateError`, which also carries `23505`/`23514` for doors that upsert
 * or hit a check constraint neither of these three can reach (all three either
 * `insert` once with no conflict target or `update` by primary key).
 *
 * - `42501` is a permission refusal, and -- by 0093's rule, which all three
 *   doors follow -- ALSO an id that names nothing: rename/delete resolve the
 *   Station from the row, so an unknown id fails existence (`P0002`) before
 *   permission is even checked, and this ambiguity is therefore narrower than
 *   templates.ts's own equivalent note describes for its own doors.
 * - `P0002` is a list id that names nothing live -- unknown, or already
 *   soft-deleted, since 0238's own select policy hides one from every read.
 * - `22023` is the one validation raise reachable through these three from a
 *   caller who bypassed the form: a blank name.
 * - Anything else is ours, not the caller's.
 */
function mapSendListError(code: string | undefined, message: string): Error {
  if (code === '22023') return new ValidationError(message);
  if (code === 'P0002') return new NotFoundError(message);
  if (code === '42501') return new UnauthorizedError(message);
  return new InternalError(message);
}

/** One row of the grid, before Task 5's `listReach` is asked about it -- ReachCells (lists-grid.tsx) asks for that on demand, per row, never here. */
export interface SendListRecord {
  id: string;
  companyId: string;
  name: string;
  source: SendListSource;
  kind: Database['public']['Enums']['send_list_kind'];
  /** Still raw jsonb -- lists-grid.tsx parses it through the matching schema above to render it as text, the same schemas listReach itself parses `filters` through. */
  filters: unknown;
  createdAt: string;
}

export interface SendListsPage {
  rows: SendListRecord[];
  nextCursor: string | null;
}

/** One page of rows, never the whole table in one round trip -- see listSendLists' own header for why this bound exists at all. */
export const SEND_LIST_PAGE_SIZE = 50;

/**
 * Every list this caller's `messaging.view` reaches, across every Station --
 * never narrowed to one Company the way `listTemplates` narrows to the
 * Station its own screen has selected. A send list names its own Station as a
 * COLUMN (spec D3: one Station per list), so an operator holding the
 * permission at more than one sees all of them in one screen rather than
 * switching between Stations to find one, and 0238's own RLS policy
 * (`deleted_at is null and has_permission('messaging.view', company_id)`) is
 * what actually bounds WHICH rows this can return -- this function adds no
 * `.eq('company_id', ...)` of its own.
 *
 * BOUNDED, since Task 6's fix round 1 (F5, Critical): the first version read
 * every visible row in one query and then asked `listReach` for every one of
 * them before the page could render -- for a LIVING list that resolver pages
 * at 50 up to `RESOLVE_CAP` (10,000), so a dozen modest living lists made a
 * page view hundreds of sequential round trips deep. Reach is no longer
 * fetched here at all (see `getSendListReachAction`, actions.ts, and
 * `ReachCells`, lists-grid.tsx) and this read itself is now PAGED, on the
 * same keyset machinery (`keysetFilter`/`encodeCursor`, @/lib/keyset)
 * `listVendorsPage` (services/vendors.ts) already uses for its own small,
 * named-things listing -- an over-fetch of `SEND_LIST_PAGE_SIZE + 1` rows
 * answers "is there another page" without a second round trip, the same
 * shape `listAuditLogs` (services/audit.ts) uses for its own forward-only
 * cursor.
 *
 * ORDERED `created_at desc, id desc`, A TOTAL ORDER: both columns are
 * `not null` (`created_at` defaults to `now()`; `id` is the primary key), so
 * two renders of the same unchanged set of lists cannot disagree the way
 * `listTemplates`' own marketing half once did ordering by `purpose` alone,
 * a column that is null on every row PostgREST could return there (read
 * directly at src/services/templates.ts:277-288 before writing this comment,
 * rather than trusted from the brief that named the defect). `id` is the
 * tiebreak precisely because it can never collide, the same pairing
 * `listTemplates` uses for its own total order -- and the same column pair
 * this keyset cursor is built from below, since a keyset filter needs the
 * identical total order the query itself applies.
 */
export async function listSendLists(
  accessToken: string,
  cursor: Cursor | null = null,
): Promise<SendListsPage> {
  let query = asCaller(accessToken)
    .from('send_lists')
    .select('id, company_id, name, source, kind, filters, created_at')
    .order('created_at', { ascending: false });

  if (cursor) {
    // created_at is never null (not null default now()), so nullsLast is
    // inert here -- passed as false to match how members.ts's own
    // nullable-aware caller resolves it for a non-nullable column
    // (`nullable && ascending`, always false when nullable is false).
    query = query.or(keysetFilter('created_at', 'desc', cursor, false));
  }

  const { data, error } = await query
    .order('id', { ascending: false })
    .limit(SEND_LIST_PAGE_SIZE + 1);

  if (error) throw new InternalError(`Could not list send lists: ${error.message}`);

  const fetched = data ?? [];
  const more = fetched.length > SEND_LIST_PAGE_SIZE;
  const page = more ? fetched.slice(0, SEND_LIST_PAGE_SIZE) : fetched;
  const last = page[page.length - 1];

  return {
    rows: page.map((row) => ({
      id: row.id,
      companyId: row.company_id,
      name: row.name,
      source: row.source,
      kind: row.kind,
      filters: row.filters,
      createdAt: row.created_at,
    })),
    nextCursor: more && last ? encodeCursor({ value: last.created_at, id: last.id }) : null,
  };
}

export async function renameSendList(input: RenameSendListInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('rename_send_list', {
    p_list_id: input.listId,
    p_name: input.name,
  });
  if (error) throw mapSendListError(error.code, error.message);
}

export async function deleteSendList(input: DeleteSendListInput, accessToken: string): Promise<void> {
  const { error } = await asCaller(accessToken).rpc('delete_send_list', {
    p_list_id: input.listId,
  });
  if (error) throw mapSendListError(error.code, error.message);
}
