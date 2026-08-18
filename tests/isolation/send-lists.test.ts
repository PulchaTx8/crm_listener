import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import type { Database } from '@/lib/supabase/database.types';
import { createSendList, filterMemberIdsLinkedToStation, resolveListMembers } from '@/services/send-lists';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29d-1, Task 8. The tenancy proofs pgTAP cannot give: 67_send_lists.test.sql
 * runs every one of its own gate assertions with `set local role authenticated`
 * plus a hand-built JWT claim, which is real enough for has_permission but is
 * still one session inside pgTAP's own transaction — it never drives a second,
 * independent GoTrue session against the same rows the way a real Station-B
 * caller does, so it cannot show one Station's list going UNSEEN from another
 * (this file's third case) or send_list_members refusing a read at the GRANT
 * layer rather than the RLS layer (its fourth) — the grant is `revoke all …
 * from anon, authenticated` (0238), and pgTAP's superuser session, table-owner
 * or not, is the one caller alive that could never observe a REVOKE fire.
 */
async function accessTokenFor(client: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error(`could not read an access token: ${error?.message}`);
  return data.session.access_token;
}

/**
 * A member row, hard-deleted outside the API entirely — there is no door that
 * does this (anonymize_member, 0034/0220, erases IN PLACE and never removes the
 * row), so the only way to drive send_list_members' `on delete cascade` (0238)
 * at all is the same direct-connection shape consent.test.ts's own
 * backdateTokenExpiry uses for a state the API cannot produce either.
 *
 * The two deletes before it are not the property under test — they are what a
 * bare `delete from members` would otherwise refuse on: member_company_links
 * (0031) and member_field_confirmations (0065) both carry a foreign key to
 * members with no `on delete cascade` of their own, and create_member (0034/
 * 0220) always writes one row into each — the link itself, and a `full_name`
 * confirmation, since full_name is one of the eight promotion_requested_field
 * values apply_member_field_confirmations (0073) compares. A fixture built
 * with nothing beyond a full name has no other referencing row anywhere else
 * in the schema, so these two deletes are the whole list.
 */
async function hardDeleteMemberDirectly(memberId: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query('delete from public.member_field_confirmations where member_id = $1', [
      memberId,
    ]);
    await client.query('delete from public.member_company_links where member_id = $1', [memberId]);
    await client.query('delete from public.members where id = $1', [memberId]);
  } finally {
    await client.end();
  }
}

const STAMP = Date.now();

describe('Block 29d-1 — send lists, against real sessions', () => {
  let customer: ProvisionedCustomer;
  let stationB: string;
  let ownerClient: SupabaseClient<Database>;
  let managerAClient: SupabaseClient<Database>;
  let viewerAClient: SupabaseClient<Database>;
  let viewerBClient: SupabaseClient<Database>;

  beforeAll(async () => {
    customer = await provisionCustomer(`send-lists-${STAMP}`);
    stationB = await addCompany(customer, `Send Lists Station B ${STAMP}`);
    ownerClient = await signInAs(customer.email, customer.password);

    const manager = await grantRoleWith(customer, `sendlist-manager-${STAMP}`, ['messaging.manage'], [
      customer.companyId,
    ]);
    managerAClient = await signInAs(manager.email, manager.password);

    // messaging.view ALONE at Station A — the door's own gate names
    // messaging.manage, so this is the narrowest caller who can already see
    // this Station's lists and still must be refused the write.
    const viewerA = await grantRoleWith(customer, `sendlist-viewer-a-${STAMP}`, ['messaging.view'], [
      customer.companyId,
    ]);
    viewerAClient = await signInAs(viewerA.email, viewerA.password);

    // messaging.view at Station B ONLY — nothing at Station A, the precondition
    // the third case rests on.
    const viewerB = await grantRoleWith(customer, `sendlist-viewer-b-${STAMP}`, ['messaging.view'], [
      stationB,
    ]);
    viewerBClient = await signInAs(viewerB.email, viewerB.password);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('a caller holding messaging.view but not messaging.manage cannot create a list at that Station', async () => {
    const { data, error } = await viewerAClient.rpc('create_send_list', {
      p_company_id: customer.companyId,
      p_name: `Should not exist ${STAMP}`,
      p_source: 'members',
      p_kind: 'living',
      p_filters: {},
      p_member_ids: [],
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  }, 60_000);

  it('create_send_list refuses a member id linked only to another Station', async () => {
    const memberAtB = await createMemberAs(customer, stationB, {
      fullName: `Only At Station B ${STAMP}`,
    });

    const { data, error } = await managerAClient.rpc('create_send_list', {
      p_company_id: customer.companyId,
      p_name: `Should not exist either ${STAMP}`,
      p_source: 'members',
      p_kind: 'fixed',
      p_filters: {},
      p_member_ids: [memberAtB],
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('P0002');
  }, 60_000);

  it('a list of Station A is not visible to a session of Station B', async () => {
    const { data: listId, error: createError } = await managerAClient.rpc('create_send_list', {
      p_company_id: customer.companyId,
      p_name: `Station A only ${STAMP}`,
      p_source: 'members',
      p_kind: 'living',
      p_filters: {},
      p_member_ids: [],
    });
    expect(createError, createError?.message).toBeNull();

    const { data, error } = await viewerBClient.from('send_lists').select('id').eq('id', listId as string);
    // Not a 42501: 0238's select policy FILTERS the row rather than refusing the
    // query outright (`authenticated` holds a bare SELECT grant on the table),
    // so the caller who cannot see this Station simply gets nothing back.
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  }, 60_000);

  it('send_list_members cannot be read directly by an authenticated caller — only the doors and the resolver reach it', async () => {
    const { data, error } = await managerAClient.from('send_list_members').select('member_id').limit(1);
    // 0238 revokes ALL on this table from anon and authenticated outright — this
    // is the grant refusing the query before RLS (which carries no policy here
    // at all) is ever consulted, unlike the previous case's filtered-to-empty
    // result on send_lists.
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  }, 60_000);

  it("deleting a member removes them from every list they were frozen into — the cascade §12's obligation would reach through", async () => {
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Cascade Listener ${STAMP}`,
    });

    const { data: listId, error: createError } = await ownerClient.rpc('create_send_list', {
      p_company_id: customer.companyId,
      p_name: `Holds the cascade listener ${STAMP}`,
      p_source: 'members',
      p_kind: 'fixed',
      p_filters: {},
      p_member_ids: [memberId],
    });
    expect(createError, createError?.message).toBeNull();

    // send_list_member_ids (0240), not a direct table read: service_role holds
    // no grant on send_list_members at all (0238 grants authenticated and
    // service_role alike nothing on it, unlike send_lists' own explicit
    // `grant select … to service_role`) — the RPC is the one caller alive that
    // can see this table's real contents, being SECURITY DEFINER, and the owner
    // reaches it through the same is_owner bypass has_permission itself uses.
    const { data: before, error: beforeError } = await ownerClient.rpc('send_list_member_ids', {
      p_list_id: listId as string,
    });
    expect(beforeError, beforeError?.message).toBeNull();
    expect(before).toHaveLength(1);

    await hardDeleteMemberDirectly(memberId);

    const { data: after, error: afterError } = await ownerClient.rpc('send_list_member_ids', {
      p_list_id: listId as string,
    });
    expect(afterError, afterError?.message).toBeNull();
    expect(after ?? []).toHaveLength(0);
  }, 60_000);
});

/**
 * Task 8's own added case, not one of the brief's original five: the block's
 * central promise (a list holds exactly what its own preview counted) proved
 * end to end rather than at either layer alone. resolveMemberIds (services/
 * send-lists.ts) resolves Members ORGANIZATION-WIDE — its own header states
 * why — and create_send_list (0239) aborts the WHOLE creation on the first id
 * it finds unlinked to the chosen Station (0239:83-91), so a caller stationed
 * between those two facts either gets a count the door refuses outright, or —
 * after Task 7's fix round 1, F6 — gets a count filterMemberIdsLinkedToStation
 * already narrowed to match.
 *
 * A dedicated Organization, not customer/stationB above: this case's whole
 * assertion is that resolveListMembers' candidate set is EXACTLY two ids, and
 * anything else this file created in the shared describe block above (Station
 * B listeners, cascade fixtures) would have polluted an org-wide read sharing
 * that Organization.
 */
describe('Block 29d-1, Task 8 — a Members list for one Station holds exactly who is linked there', () => {
  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('a Members filter matching both Stations still creates a list for Station B holding only the person linked to B', async () => {
    const customer = await provisionCustomer(`send-lists-exact-${STAMP}`);
    const stationB = await addCompany(customer, `Send Lists Exact Station B ${STAMP}`);
    const ownerClient = await signInAs(customer.email, customer.password);
    const accessToken = await accessTokenFor(ownerClient);

    const memberA = await createMemberAs(customer, customer.companyId, {
      fullName: `Exact Count Station A ${STAMP}`,
    });
    const memberB = await createMemberAs(customer, stationB, {
      fullName: `Exact Count Station B ${STAMP}`,
    });

    const candidates = await resolveListMembers(
      'members',
      { organizationId: customer.organizationId },
      accessToken,
    );
    // Organization-wide, and nothing else in this fresh Organization to blur it.
    expect(candidates.sort()).toEqual([memberA, memberB].sort());

    const linkedToB = await filterMemberIdsLinkedToStation(candidates, stationB, accessToken);
    expect(linkedToB).toEqual([memberB]);

    const listId = await createSendList(
      {
        companyId: stationB,
        name: `Exact count for Station B ${STAMP}`,
        source: 'members',
        kind: 'fixed',
        filters: { organizationId: customer.organizationId },
        memberIds: linkedToB,
      },
      accessToken,
    );

    // send_list_member_ids (0240), for the same reason the cascade case above
    // gives: send_list_members has no grant for service_role to read directly,
    // so the door is what actually reaches it.
    const { data: rows, error } = await ownerClient.rpc('send_list_member_ids', { p_list_id: listId });
    expect(error, error?.message).toBeNull();
    // Exactly the dialog's own preview count (1) — the Organization-wide set
    // was 2, and create_send_list did not abort on memberA the way a preview
    // that skipped filterMemberIdsLinkedToStation would have forced it to.
    expect(rows ?? []).toEqual([memberB]);
  }, 120_000);
});
