import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import type { Database } from '@/lib/supabase/database.types';
import {
  createSendList,
  eligibleMemberIds,
  filterMemberIdsLinkedToStation,
  listReach,
  resolveListMembers,
} from '@/services/send-lists';
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

  // NAMED FOR WHAT IT ACTUALLY PROVES (whole-branch review, F10). This case
  // deletes the members ROW, through a superuser connection, because nothing
  // in the application ever does — erasure under §12 is anonymize_member
  // (0034, last replaced in 0220), an UPDATE in place, so send_list_members'
  // ON DELETE CASCADE never fires for it and an erased listener's id STAYS in
  // every fixed list. Reading this case as "§12 reaches through the cascade",
  // which its own name used to say, is exactly the wrong conclusion to carry
  // into 29d-2. What bars an anonymised listener is
  // members_marketing_eligible_bulk (0235), at send, not this foreign key.
  it('HARD-deleting a members row removes them from every list they were frozen into — which is not what erasure does', async () => {
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
    // no SELECT on send_list_members — 0238 grants it none, unlike send_lists'
    // own explicit `grant select … to service_role`. NOT "no grant at all":
    // it keeps the default ACL's REFERENCES and TRIGGER, and kept TRUNCATE too
    // until the whole-branch review's F9 had 0238 revoke it beside the one it
    // already revoked on send_lists. What is true is only that it cannot READ
    // a row here, which is what this line needs. The RPC is the one caller
    // alive that can see this table's real contents, being SECURITY DEFINER,
    // and the owner reaches it through the same is_owner bypass has_permission
    // itself uses.
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

  /**
   * Whole-branch review, F8. The case above proves it for a FIXED list, whose
   * membership is frozen by the very ids the preview returned — the two
   * numbers agree there almost by construction. A LIVING list stores no ids at
   * all: listReach re-resolves its filters every time it is asked, and until
   * F8 that resolution was Organization-wide while the preview beside it was
   * not. So the list was created saying "1 person" and reported 2 on the list
   * screen the moment it rendered, with no send and no data change in between.
   *
   * Asserted as an EQUALITY between the two numbers, not as `toBe(1)` alone:
   * 1 is what both should say here, but the property is that they say the SAME
   * thing, and a future change that moved both together would still be honest.
   */
  it('a LIVING Members list reports the same people its own preview counted, not the whole Organization', async () => {
    const customer = await provisionCustomer(`send-lists-living-${STAMP}`);
    const stationB = await addCompany(customer, `Send Lists Living Station B ${STAMP}`);
    const ownerClient = await signInAs(customer.email, customer.password);
    const accessToken = await accessTokenFor(ownerClient);

    const memberA = await createMemberAs(customer, customer.companyId, {
      fullName: `Living Count Station A ${STAMP}`,
    });
    const memberB = await createMemberAs(customer, stationB, {
      fullName: `Living Count Station B ${STAMP}`,
    });

    const filters = { organizationId: customer.organizationId };

    // What the dialog shows before Save: Organization-wide candidates, then
    // narrowed to the Station the list will belong to.
    const candidates = await resolveListMembers('members', filters, accessToken);
    expect(candidates.sort()).toEqual([memberA, memberB].sort());
    const preview = await filterMemberIdsLinkedToStation(candidates, stationB, accessToken);
    expect(preview).toEqual([memberB]);

    const listId = await createSendList(
      {
        companyId: stationB,
        name: `Living count for Station B ${STAMP}`,
        source: 'members',
        kind: 'living',
        filters,
        // Empty, always, for a living list — 0239 refuses one carrying ids.
        memberIds: [],
      },
      accessToken,
    );

    const reach = await listReach(listId, accessToken);
    expect(reach.people).toBe(preview.length);
    // And named outright, so a regression that made BOTH sides Organization-wide
    // could not satisfy the equality above while quietly counting memberA again.
    expect(reach.people).toBe(1);
  }, 120_000);

  /**
   * Whole-branch review I2, ruling R36. A LISTENER WITH NO ADDRESS ON THE
   * CHANNEL IS NOT REACHABLE ON IT, and the number the operator reads has to
   * be the number that gets queued.
   *
   * The two halves used to disagree in a way nothing noticed. EMAIL
   * eligibility (0246's channel default) is TRUE when no consent row exists,
   * and nothing anywhere asked whether the listener had an e-mail address at
   * all -- so a Station whose listeners register by WhatsApp saw the whole
   * list in `reach.email`, created a campaign with `total_recipients` to
   * match, and the drain then settled every addressless row `failed` with
   * `no_address`. `failed` means OUR error in this block's taxonomy, and
   * "this person never gave us an e-mail" is not an error at all.
   *
   * Asserted through BOTH doors in one case, because the finding is about
   * them agreeing: `listReach` is what the dialog shows, `eligibleMemberIds`
   * is what `createCampaignAction` snapshots, and a fix applied to one alone
   * would restore the same disagreement from the other side.
   *
   * WHATSAPP is asserted at zero as the control: neither listener granted
   * whatsapp_marketing (29c's D1 opt-in), so that channel's number is zero
   * for a reason that has nothing to do with addresses -- which is what shows
   * the e-mail number below is answering the address question and not
   * accidentally counting consent twice.
   */
  it('a listener with no e-mail address counts in neither the e-mail reach nor the campaign snapshot', async () => {
    const customer = await provisionCustomer(`send-lists-address-${STAMP}`);
    const ownerClient = await signInAs(customer.email, customer.password);
    const accessToken = await accessTokenFor(ownerClient);

    const withEmail = await createMemberAs(customer, customer.companyId, {
      fullName: `Reachable By Email ${STAMP}`,
      email: `reachable-${STAMP}@example.com`,
    });
    // Registered by WhatsApp, which is how this Station's listeners arrive:
    // a real, complete listener row with a phone and no e-mail at all.
    const phoneOnly = await createMemberAs(customer, customer.companyId, {
      fullName: `Phone Only ${STAMP}`,
      phone: `+5511${String(STAMP).slice(-8)}`,
    });

    const listId = await createSendList(
      {
        companyId: customer.companyId,
        name: `Address reach ${STAMP}`,
        source: 'members',
        kind: 'fixed',
        // Stored, never resolved: a FIXED list's people are the ids below,
        // frozen into send_list_members (0238), and peopleForList reads them
        // through send_list_member_ids (0240) rather than through these.
        filters: { organizationId: customer.organizationId },
        memberIds: [withEmail, phoneOnly],
      },
      accessToken,
    );

    const reach = await listReach(listId, accessToken);
    // Both are ON the list -- `people` answers "who is on it", which is not a
    // question about addresses and must not move.
    expect(reach.people).toBe(2);
    // THE ASSERTION THIS CASE EXISTS FOR: one, not two. Neither has an
    // email_marketing consent row, so both are ELIGIBLE by 0246's own
    // default; only one of them can actually be written to.
    expect(reach.email).toBe(1);
    expect(reach.whatsapp).toBe(0);

    // And the snapshot the create action would take agrees with the number
    // the operator just read, id for id.
    const eligible = await eligibleMemberIds(
      [withEmail, phoneOnly],
      customer.companyId,
      'EMAIL',
      accessToken,
    );
    expect(eligible).toEqual([withEmail]);
  }, 120_000);
});
