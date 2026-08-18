import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCursor } from '@/lib/keyset';

/**
 * Block 29d-1, Task 4. resolveListMembers delegates to the three listing
 * services -- the same ones the screens call -- rather than restating any of
 * their predicates. What is proved here is the orchestration around that
 * delegation: which service gets called for which source, that rows collapse
 * to distinct people, that a falsy member_id is dropped by a defensive guard,
 * that paging continues past a first page, and that a resolution exceeding
 * RESOLVE_CAP is reported rather than silently truncated. None of the three
 * services' own filtering is re-tested here -- that already lives beside each
 * one (member-search-filter.test.ts and the services' own pgTAP).
 */
const { listOrganizationMembers } = vi.hoisted(() => ({ listOrganizationMembers: vi.fn() }));
vi.mock('@/services/members', () => ({ listOrganizationMembers }));

const { listParticipationsPage } = vi.hoisted(() => ({ listParticipationsPage: vi.fn() }));
vi.mock('@/services/participations', () => ({ listParticipationsPage }));

const { listMusicRequestsPage } = vi.hoisted(() => ({ listMusicRequestsPage: vi.fn() }));
vi.mock('@/services/music', () => ({ listMusicRequestsPage }));

const { resolveListMembers, RESOLVE_CAP, SendListResolutionCappedError } = await import(
  '@/services/send-lists'
);

const TOKEN = 'test-access-token';

beforeEach(() => {
  listOrganizationMembers.mockReset();
  listParticipationsPage.mockReset();
  listMusicRequestsPage.mockReset();
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
  });
});
