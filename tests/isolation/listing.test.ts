import { afterAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeCursor } from '@/lib/keyset';
import { listOrganizationMembers } from '@/services/members';
import type { MemberListPage, MemberSortKey } from '@/services/members';
import type { SortDirection } from '@/lib/keyset';
import type { Database } from '@/lib/supabase/database.types';
import {
  addCompany,
  addMemberByInvitation,
  cleanupUsers,
  createMemberAs,
  createRoleAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

/**
 * Block 3b's proof. The defect it exists to catch is a keyset page that skips
 * or repeats a row when sort values tie or turn null — invisible in every
 * other kind of testing, because the pages still load, the footer still shows
 * a plausible total, and only the person who vanished out of the middle of the
 * list would know.
 *
 * Every case is driven by a NON-OWNER delegate: Block 1c shipped two defects
 * that thirteen reviews missed because the owner's bypass hid the delegate's
 * failure. Owner clients appear below only as fixture setup (registering,
 * erasing and blocking listeners), never as the actor an assertion names.
 */

/** One more than a page, so every traversal below actually crosses a cursor. */
const OVER_ONE_PAGE = 55;

async function accessTokenFor(client: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error(`could not read an access token: ${error?.message}`);
  return data.session.access_token;
}

/**
 * Registers `count` listeners through the real RPC on ONE signed-in client.
 * createMemberAs signs in per call, which is fine for the two or three
 * listeners other suites need and is fifty-five needless auth round trips
 * here.
 */
async function seedMembers(
  owner: SupabaseClient<Database>,
  companyId: string,
  count: number,
  nameFor: (index: number) => string,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { data, error } = await owner.rpc('create_member', {
      p_company_id: companyId,
      p_full_name: nameFor(i),
    });
    if (error) throw new Error(`create_member failed at ${i}: ${error.message}`);
    ids.push(data as string);
  }
  return ids;
}

/**
 * Walks the whole list one page at a time, exactly as the screen's Next link
 * does, and returns every id it saw in order. The guard is a runaway bound: a
 * cursor bug that fails to advance would otherwise loop forever instead of
 * failing.
 */
async function traverse(
  organizationId: string,
  accessToken: string,
  sort: MemberSortKey,
  direction: SortDirection,
): Promise<{ ids: string[]; pages: number; total: number | null }> {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total: number | null = null;

  for (let guard = 0; guard < 20; guard += 1) {
    const page: MemberListPage = await listOrganizationMembers(
      {
        organizationId,
        sort,
        direction,
        cursor: decodeCursor(cursor),
        cursorSide: 'after',
      },
      accessToken,
    );
    if (pages === 0) total = page.total;
    pages += 1;
    ids.push(...page.rows.map((r) => r.id));
    if (!page.nextCursor) return { ids, pages, total };
    cursor = page.nextCursor;
  }
  throw new Error('traversal did not terminate within 20 pages');
}

describe('listing at scale', () => {
  describe('keyset traversal', () => {
    it(
      'pages through listeners who all share one name without losing or repeating anybody',
      async () => {
        const label = `list-tie-${Date.now()}`;
        const customer = await provisionCustomer(label);
        const delegate = await grantRoleWith(customer, label, ['members.view']);
        const owner = await signInAs(customer.email, customer.password);

        // Every listener carries the SAME name, so full_name ties on every
        // comparison and the id tiebreak is the only thing ordering them. An
        // ordering without it skips or repeats rows at each page boundary.
        const seeded = await seedMembers(
          owner,
          customer.companyId,
          OVER_ONE_PAGE,
          () => `Tie ${label}`,
        );

        const client = await signInAs(delegate.email, delegate.password);
        const token = await accessTokenFor(client);

        const { ids, pages, total } = await traverse(
          customer.organizationId,
          token,
          'name',
          'asc',
        );

        expect(pages).toBe(2);
        expect(total).toBe(OVER_ONE_PAGE);
        expect(ids).toHaveLength(OVER_ONE_PAGE);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(ids)).toEqual(new Set(seeded));
      },
      60_000,
    );

    it(
      'reaches the listeners with no name at all, sorting in either direction',
      async () => {
        const label = `list-null-${Date.now()}`;
        const customer = await provisionCustomer(label);
        const delegate = await grantRoleWith(customer, label, ['members.view']);
        const owner = await signInAs(customer.email, customer.password);

        // A nameless listener cannot be REGISTERED — create_member (0034)
        // refuses one with 22023 — so the null-name region exists for exactly
        // one reason: erasure nulls full_name (anonymize_member, 0034). That
        // is what this seeds, which also makes the case a real one rather
        // than a synthetic row: an erased listener still has to be findable
        // on the list that shows they were erased.
        //
        // The two counts are the whole point and neither is arbitrary. Fifty
        // named listeners fill page one exactly, so the ASCENDING traversal
        // resumes from a cursor sitting on the LAST NAMED row and only
        // reaches the erased ones through the arm that crosses INTO the null
        // region. Fifty-one erased ones overfill page one the other way, so
        // the DESCENDING traversal — where Postgres puts NULLs first —
        // resumes from a cursor whose value IS null and only reaches the
        // named ones through the arm that crosses OUT of it. An earlier
        // version of this case seeded four and fifty-one: both traversals
        // then began page two inside the null region, the ascending crossing
        // arm was never evaluated at all, and deleting it left this test
        // green. It is now the mutation that proves the case.
        const named = await seedMembers(owner, customer.companyId, 50, (i) => `Named ${label} ${i}`);
        const erased = await seedMembers(owner, customer.companyId, 51, (i) => `Erased ${label} ${i}`);
        for (const id of erased) {
          const { error } = await owner.rpc('anonymize_member', {
            p_member_id: id,
            p_reason: 'subject_request',
          });
          if (error) throw new Error(`anonymize_member failed: ${error.message}`);
        }

        const client = await signInAs(delegate.email, delegate.password);
        const token = await accessTokenFor(client);
        const everybody = new Set([...named, ...erased]);

        // Ascending puts NULLs last (Postgres' own default, which the query
        // leaves alone): page one is the fifty named listeners exactly, so
        // page two starts from a name and reaches the erased ones only
        // through `full_name.is.null`. Without that arm they are unreachable
        // — silently, since page one still looks perfectly correct.
        const ascending = await traverse(customer.organizationId, token, 'name', 'asc');
        expect(ascending.total).toBe(101);
        expect(new Set(ascending.ids)).toEqual(everybody);
        expect(new Set(ascending.ids).size).toBe(ascending.ids.length);

        // Descending puts NULLs first, so page one is fifty erased listeners
        // and the crossing runs the other way: page two starts from a null
        // and reaches the named ones only through `full_name.not.is.null`.
        const descending = await traverse(customer.organizationId, token, 'name', 'desc');
        expect(new Set(descending.ids)).toEqual(everybody);
        expect(new Set(descending.ids).size).toBe(descending.ids.length);
      },
      90_000,
    );

    it(
      'walks back to the page it came from, with the same rows in the same order',
      async () => {
        const label = `list-back-${Date.now()}`;
        const customer = await provisionCustomer(label);
        const delegate = await grantRoleWith(customer, label, ['members.view']);
        const owner = await signInAs(customer.email, customer.password);
        await seedMembers(owner, customer.companyId, OVER_ONE_PAGE, () => `Tie ${label}`);

        const client = await signInAs(delegate.email, delegate.password);
        const token = await accessTokenFor(client);
        const query = {
          organizationId: customer.organizationId,
          sort: 'name' as const,
          direction: 'asc' as const,
        };

        const first = await listOrganizationMembers(
          { ...query, cursor: null, cursorSide: 'after' },
          token,
        );
        expect(first.previousCursor).toBeNull();

        const second = await listOrganizationMembers(
          { ...query, cursor: decodeCursor(first.nextCursor), cursorSide: 'after' },
          token,
        );
        expect(second.previousCursor).not.toBeNull();

        // Previous is the same query read in the opposite direction with the
        // rows turned around, so it has to reproduce page one exactly — not
        // merely overlap it.
        const back = await listOrganizationMembers(
          { ...query, cursor: decodeCursor(second.previousCursor), cursorSide: 'before' },
          token,
        );
        expect(back.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
        expect(back.previousCursor).toBeNull();
      },
      60_000,
    );
  });

  describe('the blocked-only filter', () => {
    it(
      'counts each blocked listener once, however many active blocks they carry',
      async () => {
        const label = `list-blocked-${Date.now()}`;
        const customer = await provisionCustomer(label);
        const delegate = await grantRoleWith(customer, label, ['members.view']);
        const owner = await signInAs(customer.email, customer.password);
        const seeded = await seedMembers(owner, customer.companyId, 3, (i) => `Blocked ${label} ${i}`);
        const [first, second] = seeded as [string, string, string];

        // TWO active blocks on one listener: one Organization-wide, one
        // scoped to the Station. The filter is an inner join, and a join to a
        // child table is exactly where one parent row comes back twice —
        // which would put this listener on the page twice and count them
        // twice in a footer whose whole purpose is answering "how many".
        for (const companyId of [null, customer.companyId]) {
          const { error } = await owner.rpc('block_member', {
            p_member_id: first,
            p_kind: 'draw_ban',
            p_reason: `Two active blocks ${label}`,
            p_company_id: companyId as unknown as string,
          });
          if (error) throw new Error(`block_member failed: ${error.message}`);
        }

        // A block that has already ended is not an active one. It must not
        // put this listener on a "blocked only" page.
        const { error: expiredError } = await owner.rpc('block_member', {
          p_member_id: second,
          p_kind: 'suspension',
          p_reason: `Already over ${label}`,
          p_company_id: customer.companyId,
          p_ends_at: new Date(Date.now() - 60_000).toISOString(),
        });
        if (expiredError) throw new Error(`block_member failed: ${expiredError.message}`);

        const client = await signInAs(delegate.email, delegate.password);
        const token = await accessTokenFor(client);

        const page = await listOrganizationMembers(
          {
            organizationId: customer.organizationId,
            sort: 'created',
            direction: 'desc',
            cursor: null,
            cursorSide: 'after',
            blockedOnly: true,
          },
          token,
        );

        expect(page.rows.map((r) => r.id)).toEqual([first]);
        expect(page.total).toBe(1);
        expect(page.rows[0]?.blocked).toBe(true);

        // The same listener, unfiltered, still reports the block state the
        // badge renders — the filter and the badge answer the same question
        // through two different mechanisms (an RLS-visible join here, the
        // SECURITY DEFINER bulk predicate there), and they must agree.
        const unfiltered = await listOrganizationMembers(
          {
            organizationId: customer.organizationId,
            sort: 'created',
            direction: 'desc',
            cursor: null,
            cursorSide: 'after',
          },
          token,
        );
        expect(unfiltered.total).toBe(3);
        expect(unfiltered.rows.find((r) => r.id === first)?.blocked).toBe(true);
        expect(unfiltered.rows.find((r) => r.id === second)?.blocked).toBe(false);
      },
      60_000,
    );
  });

  describe('members_blocked_bulk', () => {
    it(
      'refuses a delegate holding members.view at another Station, while they hold a live membership at this one',
      async () => {
        const label = `list-bulk-guard-${Date.now()}`;
        const customer = await provisionCustomer(label);
        const stationB = await addCompany(customer, 'Station Two');

        const viewRole = await createRoleAs(customer, `View-${label}`, ['members.view']);
        const bystanderRole = await createRoleAs(customer, `Bystander-${label}`, []);
        const delegate = await addMemberByInvitation(customer, label, viewRole, [
          customer.companyId,
        ]);
        const owner = await signInAs(customer.email, customer.password);

        // A LIVE membership at Station B under a role granting nothing.
        // Without it, has_company_access(stationB) is already false and
        // has_permission short-circuits before the role branch runs — the
        // refusal would then come from the access gate, one layer above the
        // permission resolution this case names (members.test.ts case 4
        // carries the same correction for the same reason).
        const { error: assignError } = await owner.rpc('assign_company_role', {
          p_company_id: stationB,
          p_user_id: delegate.userId,
          p_role_id: bystanderRole,
        });
        expect(assignError).toBeNull();

        const memberId = await createMemberAs(customer, stationB, {
          fullName: `Bulk Guard Probe ${label}`,
        });

        const client = await signInAs(delegate.email, delegate.password);

        // The precondition the case rests on: the membership at B is live, so
        // what refuses below is members.view resolution and not access.
        const { data: access, error: accessError } = await client.rpc('has_company_access', {
          p_company_id: stationB,
        });
        expect(accessError).toBeNull();
        expect(access).toBe(true);

        const { data, error } = await client.rpc('members_blocked_bulk', {
          p_member_ids: [memberId],
          p_company_id: stationB,
        });
        expect(data).toBeNull();
        expect(error?.code).toBe('42501');

        // The same call at the Station they DO hold members.view in answers,
        // and answers for every id it was given — otherwise this case would
        // pass just as well against a function that refuses everybody.
        const { data: allowed, error: allowedError } = await client.rpc('members_blocked_bulk', {
          p_member_ids: [memberId],
          p_company_id: customer.companyId,
        });
        expect(allowedError).toBeNull();
        expect(allowed).toEqual([{ member_id: memberId, blocked: false }]);
      },
      60_000,
    );
  });
});
