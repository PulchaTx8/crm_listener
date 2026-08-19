import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Block 29d-2, Task 7 fix round 1 (F1, Critical). getMembersForCampaign
 * (services/members.ts) reads members' campaign-relevant fields by id, and
 * the id list can be the whole of a LIVING list's eligible audience -- up to
 * RESOLVE_CAP (10,000), the spec's own worked example names twenty thousand
 * recipients. A single PostgREST `.in()` GET carrying that many UUIDs is not
 * a request this project asks anywhere else; filterMemberIdsLinkedToStation
 * (services/send-lists.ts) already chunks the identical shape of read at
 * 200 per request, and this is the same bound applied a second place.
 *
 * The fake mirrors tests/unit/send-lists-resolve.test.ts's own shape for the
 * identical reason that file's header gives: this codebase's usual way to
 * prove a thin asCaller(...).from(...) wrapper is a fake recording exactly
 * the chain the function calls, not a broader ORM-style double.
 */
const { createClientMock, setFakeMembersDb } = vi.hoisted(() => {
  let current: unknown = null;
  return {
    createClientMock: vi.fn(() => current),
    setFakeMembersDb: (db: unknown) => {
      current = db;
    },
  };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: createClientMock }));
vi.mock('@/lib/supabase/config', () => ({
  getUserSupabaseConfig: () => ({ url: 'https://example.test', anonKey: 'anon-key' }),
}));

const { getMembersForCampaign } = await import('@/services/members');

const TOKEN = 'test-access-token';

interface MemberRow {
  id: string;
  full_name: string | null;
  city: string | null;
  phone_normalized: string | null;
  email_normalized: string | null;
}

class FakeMembersDb {
  readonly inCalls: string[][] = [];

  constructor(
    private readonly respond: (chunk: string[]) => { data: MemberRow[] | null; error: { message: string } | null },
  ) {}

  from(table: string) {
    if (table !== 'members') {
      throw new Error(`FakeMembersDb: unexpected table "${table}"`);
    }
    return {
      select: () => ({
        in: async (_column: string, ids: string[]) => {
          this.inCalls.push(ids);
          return this.respond(ids);
        },
      }),
    };
  }
}

beforeEach(() => {
  createClientMock.mockClear();
  setFakeMembersDb(null);
});

describe('getMembersForCampaign', () => {
  it('reads nothing at all for an empty id list', async () => {
    const db = new FakeMembersDb(() => ({ data: [], error: null }));
    setFakeMembersDb(db);

    const result = await getMembersForCampaign([], TOKEN);

    expect(result.size).toBe(0);
    expect(db.inCalls).toHaveLength(0);
  });

  it('fits within one request for 200 ids or fewer', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `member-${i}`);
    const db = new FakeMembersDb((chunk) => ({
      data: chunk.map((id) => ({
        id,
        full_name: `Name ${id}`,
        city: null,
        phone_normalized: null,
        email_normalized: null,
      })),
      error: null,
    }));
    setFakeMembersDb(db);

    const result = await getMembersForCampaign(ids, TOKEN);

    expect(db.inCalls).toHaveLength(1);
    expect(result.size).toBe(200);
  });

  /**
   * THE CASE THIS FIX EXISTS FOR. 450 ids -- three requests (200, 200, 50),
   * the same CHUNK constant filterMemberIdsLinkedToStation uses -- proving
   * both that the read is actually split and that every chunk's rows land in
   * the ONE map this function returns, not just the last chunk's.
   */
  it('chunks a list past 200 ids into multiple requests and merges every chunk into one map', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `member-${String(i).padStart(3, '0')}`);
    const db = new FakeMembersDb((chunk) => ({
      data: chunk.map((id) => ({
        id,
        full_name: `Name ${id}`,
        city: 'Recife',
        phone_normalized: '5511900000000',
        email_normalized: `${id}@example.test`,
      })),
      error: null,
    }));
    setFakeMembersDb(db);

    const result = await getMembersForCampaign(ids, TOKEN);

    expect(db.inCalls.map((chunk) => chunk.length)).toEqual([200, 200, 50]);
    expect(result.size).toBe(450);
    expect(result.get('member-000')).toEqual({
      fullName: 'Name member-000',
      city: 'Recife',
      phoneNormalized: '5511900000000',
      emailNormalized: 'member-000@example.test',
    });
    // The LAST chunk's own rows, not only the first's -- the failure mode a
    // merge bug (e.g. reassigning rather than accumulating) would produce.
    expect(result.get('member-449')).toEqual({
      fullName: 'Name member-449',
      city: 'Recife',
      phoneNormalized: '5511900000000',
      emailNormalized: 'member-449@example.test',
    });
  });

  it('throws InternalError when any one chunk fails, rather than silently returning a partial map', async () => {
    let call = 0;
    const ids = Array.from({ length: 450 }, (_, i) => `member-${i}`);
    const db = new FakeMembersDb((chunk) => {
      call += 1;
      if (call === 2) return { data: null, error: { message: 'connection reset' } };
      return { data: chunk.map((id) => ({ id, full_name: null, city: null, phone_normalized: null, email_normalized: null })), error: null };
    });
    setFakeMembersDb(db);

    await expect(getMembersForCampaign(ids, TOKEN)).rejects.toThrow('connection reset');
  });
});
