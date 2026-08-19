import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@/lib/keyset';
import { NotFoundError } from '@/lib/errors';

/**
 * Block 29d-1, Task 4. resolveListMembers delegates to the three listing
 * services -- the same ones the screens call -- rather than restating any of
 * their predicates. What is proved here is the orchestration around that
 * delegation: which service gets called for which source, that rows collapse
 * to distinct people, that a falsy member_id is dropped by a defensive guard,
 * that paging continues past a first page, and that a resolution exceeding
 * either of its two bounds -- RESOLVE_CAP on people, RESOLVE_PAGE_CAP on the
 * reads it takes to find them -- is reported rather than silently truncated. None of the three
 * services' own filtering is re-tested here -- that already lives beside each
 * one (member-search-filter.test.ts and the services' own pgTAP).
 */
const { listOrganizationMembers } = vi.hoisted(() => ({ listOrganizationMembers: vi.fn() }));
vi.mock('@/services/members', () => ({ listOrganizationMembers }));

const { listParticipationsPage } = vi.hoisted(() => ({ listParticipationsPage: vi.fn() }));
vi.mock('@/services/participations', () => ({ listParticipationsPage }));

const { listMusicRequestsPage } = vi.hoisted(() => ({ listMusicRequestsPage: vi.fn() }));
vi.mock('@/services/music', () => ({ listMusicRequestsPage }));

/**
 * Task 5. listReach builds its own client the same way every other service in
 * this codebase does -- asCaller(accessToken), a bare createClient call, not
 * an injected dependency (that shape belongs to services/whatsapp-link.ts and
 * its neighbours; listReach's signature is fixed by this block's plan to
 * (listId, accessToken)). Faking that out means replacing createClient itself
 * for this file, which tests/unit/music-request-service.test.ts's own header
 * notes is NOT this codebase's usual approach -- the usual one is to prove a
 * thin asCaller(...).rpc(...) wrapper in pgTAP, where its behaviour actually
 * lives. There is no pgTAP for listReach's own orchestration (which channel
 * count belongs to which call, that a 42501 becomes 'forbidden' rather than
 * 0), because it is new TypeScript with no SQL under it, so that orchestration
 * is what gets proved here.
 */
const { createClientMock, setFakeSendListsDb } = vi.hoisted(() => {
  let current: unknown = null;
  return {
    createClientMock: vi.fn(() => current),
    setFakeSendListsDb: (db: unknown) => {
      current = db;
    },
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
vi.mock('@/lib/supabase/config', () => ({
  getUserSupabaseConfig: () => ({ url: 'https://example.test', anonKey: 'anon-key' }),
}));

const {
  resolveListMembers,
  RESOLVE_CAP,
  RESOLVE_PAGE_CAP,
  SendListResolutionCappedError,
  listReach,
} = await import('@/services/send-lists');

const TOKEN = 'test-access-token';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * Records `.rpc()` calls structurally (fn + full args), the same shape
 * tests/unit/whatsapp-link.test.ts's own FakeDb uses, so an eligibility call
 * carrying a wrong or missing argument fails an assertion here rather than
 * passing because only one field was checked. `.from('send_lists')` supports
 * only the exact chain listReach calls (select -> eq -> is -> maybeSingle);
 * anything else throws, so a chain this fake does not expect fails loudly
 * instead of silently returning undefined.
 */
interface FixedMembersFixture {
  data: string[] | null;
  error: { code?: string; message: string } | null;
}

/**
 * Whole-branch review, F8. Which member ids member_company_links shows for the
 * Station being asked about -- the read filterMemberIdsLinkedToStation makes,
 * and now the read a LIVING members list's people count passes through too.
 * Absent, the fake throws on the table entirely, which is what keeps the
 * requests-sourced and FIXED cases below honest: neither may narrow, and
 * neither carries this fixture.
 */
interface LinkFixture {
  linked: string[];
}

class FakeSendListsDb {
  readonly rpcCalls: RpcCall[] = [];
  /** Every member_company_links narrowing this run made, so a case can assert it made NONE. */
  readonly linkQueries: { companyId: string; memberIds: string[] }[] = [];

  constructor(
    private readonly listRow: { company_id: string; source: string; filters: unknown; kind: 'fixed' | 'living' } | null,
    private readonly eligibility: Record<
      string,
      { data: { member_id: string; eligible: boolean }[] | null; error: { code?: string; message: string } | null }
    >,
    // Task 5 fix round 1 (F3). Only consulted for a 'fixed' listRow -- a
    // 'living' one must never even call send_list_member_ids, which is
    // exactly what leaving this undefined and still passing enforces: the
    // fake throws if a living-list test somehow reaches it anyway.
    private readonly fixedMembers?: FixedMembersFixture,
    // Whole-branch review, F8. Only consulted for a LIVING 'members' listRow;
    // leaving it undefined is what makes any other case that narrows fail
    // loudly rather than quietly reading an empty table.
    private readonly links?: LinkFixture,
  ) {}

  from(table: string) {
    if (table === 'send_lists') {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              maybeSingle: async () => ({ data: this.listRow, error: null }),
            }),
          }),
        }),
      };
    }

    if (table === 'member_company_links') {
      const links = this.links;
      if (!links) {
        throw new Error('FakeSendListsDb: member_company_links read with no links fixture set');
      }
      const queries = this.linkQueries;
      return {
        select: () => ({
          eq: (_column: string, companyId: string) => ({
            in: async (_memberColumn: string, memberIds: string[]) => {
              queries.push({ companyId, memberIds });
              return {
                data: memberIds
                  .filter((id) => links.linked.includes(id))
                  .map((id) => ({ member_id: id })),
                error: null,
              };
            },
          }),
        }),
      };
    }

    throw new Error(`FakeSendListsDb: unexpected table "${table}"`);
  }

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });

    if (fn === 'members_marketing_eligible_bulk') {
      const channel = String(args.p_channel);
      const result = this.eligibility[channel];
      if (!result) throw new Error(`FakeSendListsDb: no eligibility fixture for channel "${channel}"`);
      return Promise.resolve(result);
    }

    if (fn === 'send_list_member_ids') {
      if (!this.fixedMembers) {
        throw new Error('FakeSendListsDb: send_list_member_ids called with no fixedMembers fixture set');
      }
      return Promise.resolve(this.fixedMembers);
    }

    throw new Error(`FakeSendListsDb: unexpected rpc "${fn}"`);
  }
}

const ORG = '11111111-1111-1111-1111-111111111111';
const STATION_A = '22222222-2222-2222-2222-222222222222';
const STATION_B = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  listOrganizationMembers.mockReset();
  listParticipationsPage.mockReset();
  listMusicRequestsPage.mockReset();
  createClientMock.mockClear();
  setFakeSendListsDb(null);
});

describe('resolveListMembers', () => {
  it('calls only the service matching the source, with that source\'s filters', async () => {
    listOrganizationMembers.mockResolvedValue({
      rows: [{ id: 'm1' }],
      nextCursor: null,
      previousCursor: null,
      total: 1,
    });

    const ids = await resolveListMembers('members', { organizationId: 'org-1' }, TOKEN);

    expect(ids).toEqual(['m1']);
    expect(listOrganizationMembers).toHaveBeenCalledTimes(1);
    expect(listOrganizationMembers).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', cursor: null, cursorSide: 'after' }),
      TOKEN,
    );
    expect(listParticipationsPage).not.toHaveBeenCalled();
    expect(listMusicRequestsPage).not.toHaveBeenCalled();
  });

  it('returns distinct member ids when the underlying pages repeat one (participations are per event)', async () => {
    listParticipationsPage.mockResolvedValue({
      rows: [{ memberId: 'p1' }, { memberId: 'p1' }, { memberId: 'p2' }],
      nextCursor: null,
      previousCursor: null,
      total: 3,
    });

    const ids = await resolveListMembers('participations', { companyId: 'co-1' }, TOKEN);

    expect([...ids].sort()).toEqual(['p1', 'p2']);
  });

  it('drops a falsy member_id as a defensive guard, though every real row has one (music_requests.member_id is not null, 0098:193; 0191 inner-joins members)', async () => {
    listMusicRequestsPage.mockResolvedValue({
      rows: [{ memberId: 'r1' }, { memberId: null }, { memberId: 'r2' }],
      nextCursor: null,
      previousCursor: null,
      total: 3,
    });

    const ids = await resolveListMembers('requests', { companyId: 'co-1' }, TOKEN);

    expect([...ids].sort()).toEqual(['r1', 'r2']);
  });

  it('pages until exhausted rather than returning only the first page', async () => {
    // decodeCursor (src/lib/keyset.ts) refuses anything whose id is not a
    // well-formed UUID, exactly as every real cursor in this codebase is.
    const cursor = { value: '2026-08-01T00:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' };
    listOrganizationMembers
      .mockResolvedValueOnce({
        rows: [{ id: 'a' }],
        nextCursor: encodeCursor(cursor),
        previousCursor: null,
        total: 2,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'b' }],
        nextCursor: null,
        previousCursor: encodeCursor(cursor),
        total: 2,
      });

    const ids = await resolveListMembers('members', { organizationId: 'org-1' }, TOKEN);

    expect(listOrganizationMembers).toHaveBeenCalledTimes(2);
    // The second call resumes from exactly the cursor the first page handed
    // back -- not a fresh, unpaged read of the same first page again.
    expect(listOrganizationMembers.mock.calls[1]?.[0]).toMatchObject({ cursor, cursorSide: 'after' });
    expect(ids.sort()).toEqual(['a', 'b']);
  });

  it('stops at RESOLVE_CAP and reports that it was capped rather than silently truncating', async () => {
    // Each page hands back 3,000 brand-new ids and always claims there is
    // more -- a resolver that did not stop would call this forever.
    let call = 0;
    listParticipationsPage.mockImplementation(async () => {
      call += 1;
      const rows = Array.from({ length: 3000 }, (_, i) => ({ memberId: `page${call}-${i}` }));
      return { rows, nextCursor: `cursor-${call}`, previousCursor: null, total: 999_999 };
    });

    await expect(
      resolveListMembers('participations', { companyId: 'co-1' }, TOKEN),
    ).rejects.toThrow(SendListResolutionCappedError);

    // 3,000 x 4 = 12,000, already past RESOLVE_CAP (10,000): the resolver
    // must have stopped there rather than reading toward "always more".
    expect(RESOLVE_CAP).toBe(10_000);
    expect(call).toBeLessThanOrEqual(4);

    // WHICH bound refused, since the whole-branch review's F11 added a second
    // one: the two need different sentences on screen, and the actions read
    // this field to choose between them.
    await expect(
      resolveListMembers('participations', { companyId: 'co-1' }, TOKEN),
    ).rejects.toMatchObject({ bound: 'people' });
  });

  /**
   * Whole-branch review, F11 (Important). RESOLVE_CAP counts PEOPLE while the
   * loop's cost is proportional to ROWS, and Participations and Requests are
   * per event: one listener is many rows. A promotion with 120,000
   * participations across 6,000 listeners leaves ids.size at 6,000 for ever --
   * RESOLVE_CAP never trips -- while the resolver runs thousands of sequential
   * round trips inside one Server Action. Invisible against the empty database
   * db:reset creates, certain on the first real Station.
   *
   * The mock below is that shape reduced to its essence: every page returns
   * the SAME person and claims there is more, so the answer never grows and
   * only the work does.
   */
  it('stops at RESOLVE_PAGE_CAP when the rows keep coming but the people do not', async () => {
    let call = 0;
    listParticipationsPage.mockImplementation(async () => {
      call += 1;
      // One row, one person, every page -- the answer is a set of size 1 no
      // matter how long this runs.
      return {
        rows: [{ memberId: 'the-same-listener' }],
        nextCursor: `cursor-${call}`,
        previousCursor: null,
        total: 999_999,
      };
    });

    await expect(
      resolveListMembers('participations', { companyId: 'co-1' }, TOKEN),
    ).rejects.toThrow(SendListResolutionCappedError);

    expect(RESOLVE_PAGE_CAP).toBe(400);
    // Exactly the bound, not "somewhere under it": a resolver that stopped
    // early would bound the work by accident rather than by this constant.
    expect(call).toBe(RESOLVE_PAGE_CAP);

    call = 0;
    await expect(
      resolveListMembers('participations', { companyId: 'co-1' }, TOKEN),
    ).rejects.toMatchObject({ bound: 'pages' });
  });
});

/**
 * Task 5. listReach reads the send_lists row (source, filters, company_id),
 * resolves its people the same way resolveListMembers already does above, and
 * asks members_marketing_eligible_bulk (0235) once per channel over that
 * population. What is proved here is that orchestration -- one call per
 * channel, carrying the right ids and company_id, counted independently -- and
 * the R5 decision this block's plan records: 0235 is gated on members.view,
 * the list screen itself only on messaging.view, so a caller who can see a
 * list can still be refused reach on it, and that refusal (42501) must read
 * as 'forbidden', never silently as 0 -- an operator reading 0 would go
 * looking for an audience problem that is not the one they have.
 */
describe('listReach', () => {
  it("asks members_marketing_eligible_bulk once per channel over the list's people, and the two channel numbers may differ from the people count and from each other", async () => {
    listOrganizationMembers.mockResolvedValue({
      rows: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
      nextCursor: null,
      previousCursor: null,
      total: 3,
    });

    const db = new FakeSendListsDb(
      { company_id: STATION_A, source: 'members', filters: { organizationId: ORG }, kind: 'living' },
      {
        WHATSAPP: {
          data: [
            { member_id: 'm1', eligible: true },
            { member_id: 'm2', eligible: false },
            { member_id: 'm3', eligible: false },
          ],
          error: null,
        },
        EMAIL: {
          data: [
            { member_id: 'm1', eligible: true },
            { member_id: 'm2', eligible: true },
            { member_id: 'm3', eligible: false },
          ],
          error: null,
        },
      },
      undefined,
      // All three are linked to STATION_A, so F8's narrowing changes nothing
      // here and the three channel numbers stay the point of this case.
      { linked: ['m1', 'm2', 'm3'] },
    );
    setFakeSendListsDb(db);

    const reach = await listReach('list-1', TOKEN);

    // people (3) != whatsapp (1) != email (2): none of the three numbers a
    // screen would show here can be produced by copying either of the others.
    expect(reach).toEqual({ people: 3, whatsapp: 1, email: 2 });

    const eligibilityCalls = db.rpcCalls.filter((call) => call.fn === 'members_marketing_eligible_bulk');
    expect(eligibilityCalls).toHaveLength(2);
    expect(eligibilityCalls.map((call) => call.args.p_channel).sort()).toEqual(['EMAIL', 'WHATSAPP']);
    for (const call of eligibilityCalls) {
      expect(call.args).toEqual({
        p_member_ids: ['m1', 'm2', 'm3'],
        p_company_id: STATION_A,
        p_channel: call.args.p_channel,
      });
    }

    // Task 5 fix round 1 (F3). A LIVING list's people come from
    // resolveListMembers (proven above by the m1/m2/m3 that only
    // listOrganizationMembers's mock could have produced) -- never from the
    // door onto send_list_members, which exists specifically for the kind of
    // list that freezes its people rather than re-matching a filter.
    expect(db.rpcCalls.some((call) => call.fn === 'send_list_member_ids')).toBe(false);
  });

  it('reports a channel as \'forbidden\', never as 0, when 0235 refuses the caller (42501) for lacking members.view', async () => {
    listOrganizationMembers.mockResolvedValue({
      rows: [{ id: 'm1' }],
      nextCursor: null,
      previousCursor: null,
      total: 1,
    });

    const db = new FakeSendListsDb(
      { company_id: STATION_A, source: 'members', filters: { organizationId: ORG }, kind: 'living' },
      {
        WHATSAPP: { data: null, error: { code: '42501', message: 'permission denied: members.view required' } },
        EMAIL: { data: null, error: { code: '42501', message: 'permission denied: members.view required' } },
      },
      undefined,
      { linked: ['m1'] },
    );
    setFakeSendListsDb(db);

    const reach = await listReach('list-1', TOKEN);

    // The list itself resolved fine (messaging.view was enough for that) --
    // only the two channel numbers are unavailable, and 'forbidden' cannot be
    // mistaken for a real count the way 0 could.
    expect(reach.people).toBe(1);
    expect(reach.whatsapp).toBe('forbidden');
    expect(reach.email).toBe('forbidden');
  });

  it('propagates a non-permission RPC error rather than folding it into \'forbidden\'', async () => {
    listOrganizationMembers.mockResolvedValue({
      rows: [{ id: 'm1' }],
      nextCursor: null,
      previousCursor: null,
      total: 1,
    });

    const db = new FakeSendListsDb(
      { company_id: STATION_A, source: 'members', filters: { organizationId: ORG }, kind: 'living' },
      {
        WHATSAPP: { data: null, error: { code: '55000', message: 'db is down' } },
        EMAIL: { data: [{ member_id: 'm1', eligible: true }], error: null },
      },
      undefined,
      { linked: ['m1'] },
    );
    setFakeSendListsDb(db);

    await expect(listReach('list-1', TOKEN)).rejects.toThrow('db is down');
  });

  it('dispatches a requests-sourced list through listMusicRequestsPage with its own stored filters', async () => {
    listMusicRequestsPage.mockResolvedValue({
      rows: [{ memberId: 'r1' }],
      nextCursor: null,
      previousCursor: null,
      total: 1,
    });

    const db = new FakeSendListsDb(
      { company_id: STATION_B, source: 'requests', filters: { companyId: STATION_B }, kind: 'living' },
      {
        WHATSAPP: { data: [{ member_id: 'r1', eligible: false }], error: null },
        EMAIL: { data: [{ member_id: 'r1', eligible: true }], error: null },
      },
    );
    setFakeSendListsDb(db);

    const reach = await listReach('list-2', TOKEN);

    expect(reach).toEqual({ people: 1, whatsapp: 0, email: 1 });
    expect(listMusicRequestsPage).toHaveBeenCalledTimes(1);
    expect(listOrganizationMembers).not.toHaveBeenCalled();
    expect(listParticipationsPage).not.toHaveBeenCalled();
    // Whole-branch review, F8: a requests-sourced list is ALREADY one
    // Station's, through its own filters.companyId, so narrowing it again
    // would ask the same question twice. No links fixture is set above, so a
    // narrowing here would have thrown before reaching this line -- this
    // records the intent that the throw is the assertion.
    expect(db.linkQueries).toEqual([]);
  });

  /**
   * Whole-branch review, F8 (Important). A LIVING list built from MEMBERS
   * resolves ORGANIZATION-WIDE -- resolveMemberIds' own header says why -- but
   * belongs to exactly one Station (D3). Until this fix only the dialog's
   * preview narrowed (filterMemberIdsLinkedToStation, applied inside
   * resolveSendListPreviewAction), so a list created saying "2 people" went on
   * to report 3 on the list screen, and the next block's send-time resolution
   * would have started from the wider set.
   *
   * The mocked resolution deliberately returns somebody who is NOT linked to
   * the list's Station: without that third id the case would pass with no
   * narrowing at all and prove nothing.
   */
  it('narrows a LIVING members list to its own Station, so its people count matches the preview that created it', async () => {
    listOrganizationMembers.mockResolvedValue({
      rows: [{ id: 'm1' }, { id: 'm2' }, { id: 'elsewhere' }],
      nextCursor: null,
      previousCursor: null,
      total: 3,
    });

    const db = new FakeSendListsDb(
      { company_id: STATION_A, source: 'members', filters: { organizationId: ORG }, kind: 'living' },
      {
        WHATSAPP: {
          data: [
            { member_id: 'm1', eligible: true },
            { member_id: 'm2', eligible: false },
          ],
          error: null,
        },
        EMAIL: {
          data: [
            { member_id: 'm1', eligible: true },
            { member_id: 'm2', eligible: true },
          ],
          error: null,
        },
      },
      undefined,
      // 'elsewhere' matches the filters and is in the Organization, but is
      // linked to another Station -- the median case, not an edge one.
      { linked: ['m1', 'm2'] },
    );
    setFakeSendListsDb(db);

    const reach = await listReach('list-4', TOKEN);

    // 2, not the 3 the Organization-wide resolution returned.
    expect(reach.people).toBe(2);

    // Narrowed against THIS list's Station, read from the row rather than
    // from the stored filters.
    expect(db.linkQueries).toEqual([
      { companyId: STATION_A, memberIds: ['m1', 'm2', 'elsewhere'] },
    ]);

    // And eligibility is asked about the narrowed set, so the two channel
    // numbers cannot silently be computed over somebody this list does not
    // hold.
    for (const call of db.rpcCalls.filter((c) => c.fn === 'members_marketing_eligible_bulk')) {
      expect(call.args.p_member_ids).toEqual(['m1', 'm2']);
    }
  });

  /**
   * Task 5 fix round 1 (F3, Critical). A FIXED list's people are frozen at
   * creation and must never move -- that is the entire reason a fixed list
   * exists rather than a living one. Before 0240 there was no door onto
   * send_list_members, so this fell back to resolveListMembers, re-matching
   * the stored filters against TODAY's data: a member added, edited or removed
   * after the list was frozen would silently change the reach numbers of a
   * list whose whole point was that they do not change. This proves the fix:
   * a fixed list's people come from send_list_member_ids and NEVER from the
   * three listing services (their mocks stay untouched throughout).
   */
  it("reads a FIXED list's people from send_list_member_ids (the frozen roster), never by re-resolving its stored filters", async () => {
    const db = new FakeSendListsDb(
      { company_id: STATION_A, source: 'members', filters: { organizationId: ORG }, kind: 'fixed' },
      {
        WHATSAPP: {
          data: [
            { member_id: 'f1', eligible: true },
            { member_id: 'f2', eligible: false },
          ],
          error: null,
        },
        EMAIL: {
          data: [
            { member_id: 'f1', eligible: true },
            { member_id: 'f2', eligible: true },
          ],
          error: null,
        },
      },
      { data: ['f1', 'f2'], error: null },
    );
    setFakeSendListsDb(db);

    const reach = await listReach('list-3', TOKEN);

    expect(reach).toEqual({ people: 2, whatsapp: 1, email: 2 });

    const doorCalls = db.rpcCalls.filter((call) => call.fn === 'send_list_member_ids');
    expect(doorCalls).toEqual([{ fn: 'send_list_member_ids', args: { p_list_id: 'list-3' } }]);

    const eligibilityCalls = db.rpcCalls.filter((call) => call.fn === 'members_marketing_eligible_bulk');
    for (const call of eligibilityCalls) {
      expect(call.args.p_member_ids).toEqual(['f1', 'f2']);
    }

    // The point of the fix: NONE of resolveListMembers' three underlying
    // services ran, even though this list's own `source` is 'members' and
    // its `filters` are present -- a fixed list's stored filters are a
    // record (0238's own comment), not a query to run again.
    expect(listOrganizationMembers).not.toHaveBeenCalled();
    expect(listParticipationsPage).not.toHaveBeenCalled();
    expect(listMusicRequestsPage).not.toHaveBeenCalled();
  });

  it('throws rather than reaching for a company_id that does not exist, when the list is unknown or RLS hides it', async () => {
    const db = new FakeSendListsDb(null, {});
    setFakeSendListsDb(db);

    await expect(listReach('missing-list', TOKEN)).rejects.toBeInstanceOf(NotFoundError);
    expect(listOrganizationMembers).not.toHaveBeenCalled();
    expect(db.rpcCalls).toHaveLength(0);
  });
});
