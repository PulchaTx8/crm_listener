import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUnsubscribeToken } from '@/services/consent';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import {
  addCompany,
  admin,
  anonClient,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29c, Task 10. The unsubscribe token and the eligibility predicate,
 * against real sessions.
 *
 * pgTAP runs as superuser with a null auth.uid(), so every RLS-gated read in
 * this file — `members_marketing_eligible_bulk` (0229) is SECURITY INVOKER for
 * exactly this reason — passes unconditionally there and proves nothing about
 * who is actually refused. It can hold the grants and the shape; only a real
 * session can show a door refusing somebody, the same argument
 * marketing-templates.test.ts's own header makes.
 */
const STAMP = Date.now();

/**
 * `issue_unsubscribe_token` (0232) always writes `now() + interval '1 year'`
 * and takes no parameter to say otherwise, so an expired token can only be
 * produced by moving the clock on the row directly — the same reason
 * `retention.test.ts`'s `callSweep` opens its own connection rather than going
 * through the API. One connection per call, closed in a `finally`, matching
 * that file's own shape.
 */
async function backdateTokenExpiry(tokenId: string): Promise<void> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    await client.query(
      `update public.unsubscribe_tokens set expires_at = now() - interval '1 day' where id = $1`,
      [tokenId],
    );
  } finally {
    await client.end();
  }
}

/**
 * Mints a token the way the (future) campaign sender does: service_role only
 * holds `issue_unsubscribe_token` (0232's own fix round 2, F15), so `admin` is
 * the one client in this suite that can call it at all.
 */
async function mintToken(
  memberId: string,
  companyId: string,
): Promise<{ hash: string; tokenId: string }> {
  const { hash } = newUnsubscribeToken();
  const { data, error } = await admin.rpc('issue_unsubscribe_token', {
    p_member_id: memberId,
    p_company_id: companyId,
    p_token_hash: hash,
  });
  if (error) throw new Error(`issue_unsubscribe_token failed: ${error.message}`);
  return { hash, tokenId: data as string };
}

describe('Block 29c — the unsubscribe token, against real sessions', () => {
  let customer: ProvisionedCustomer;
  let stationB: string;
  let stationC: string;

  beforeAll(async () => {
    customer = await provisionCustomer(`consent-tok-${STAMP}`);
    stationB = await addCompany(customer, `Consent Station B ${STAMP}`);
    stationC = await addCompany(customer, `Consent Station C ${STAMP}`);
  }, 120_000);

  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('a token minted for Station A withdraws only Station A, leaving the other Station this listener is linked to untouched', async () => {
    const ownerClient = await signInAs(customer.email, customer.password);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Two Station Listener ${STAMP}`,
    });
    const { error: linkError } = await ownerClient.rpc('link_member_to_company', {
      p_member_id: memberId,
      p_company_id: stationB,
    });
    expect(linkError, linkError?.message).toBeNull();

    const { hash } = await mintToken(memberId, customer.companyId);

    const { data, error } = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: false,
    });
    expect(error, error?.message).toBeNull();
    expect(data?.[0]?.company_id).toBe(customer.companyId);

    const { data: stationARows } = await admin
      .from('member_consents')
      .select('consent_type, granted')
      .eq('member_id', memberId)
      .eq('company_id', customer.companyId);
    expect(stationARows).toHaveLength(1);
    expect(stationARows?.[0]?.consent_type).toBe('email_marketing');
    expect(stationARows?.[0]?.granted).toBe(false);

    const { data: stationBRows } = await admin
      .from('member_consents')
      .select('id')
      .eq('member_id', memberId)
      .eq('company_id', stationB);
    expect(stationBRows ?? [], 'the Station this token was not minted for').toHaveLength(0);
  }, 60_000);

  it('refuses an expired token', async () => {
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Expired Token Listener ${STAMP}`,
    });
    const { hash, tokenId } = await mintToken(memberId, customer.companyId);
    await backdateTokenExpiry(tokenId);

    const { data, error } = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: false,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('P0002');
  }, 60_000);

  it('refuses a spent token a second time, and leaves exactly one withdrawal row behind', async () => {
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Spent Token Listener ${STAMP}`,
    });
    const { hash } = await mintToken(memberId, customer.companyId);

    const first = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: false,
    });
    expect(first.error, first.error?.message).toBeNull();

    const second = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: false,
    });
    expect(second.data).toBeNull();
    expect(second.error?.code).toBe('P0002');

    const { data: rows } = await admin
      .from('member_consents')
      .select('id')
      .eq('member_id', memberId)
      .eq('company_id', customer.companyId)
      .eq('consent_type', 'email_marketing');
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('p_all_stations writes exactly the Stations this listener is linked to, and nothing for one they never joined', async () => {
    const ownerClient = await signInAs(customer.email, customer.password);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `All Stations Listener ${STAMP}`,
    });
    const { error: linkError } = await ownerClient.rpc('link_member_to_company', {
      p_member_id: memberId,
      p_company_id: stationB,
    });
    expect(linkError, linkError?.message).toBeNull();
    // stationC deliberately holds no link — the third Station this case exists
    // to seed, so a regression writing to every Station in the Organization
    // rather than only the ones this listener joined has something to catch it.

    const { hash } = await mintToken(memberId, customer.companyId);

    const { data, error } = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: true,
    });
    expect(error, error?.message).toBeNull();
    // Two Stations, two consent types each (§7's ruling on the group action).
    expect(data?.[0]?.consents_written).toBe(4);

    for (const companyId of [customer.companyId, stationB]) {
      const { data: rows } = await admin
        .from('member_consents')
        .select('granted')
        .eq('member_id', memberId)
        .eq('company_id', companyId);
      expect(rows, `Station ${companyId}`).toHaveLength(2);
      expect(rows?.every((row) => row.granted === false)).toBe(true);
    }

    const { data: stationCRows } = await admin
      .from('member_consents')
      .select('id')
      .eq('member_id', memberId)
      .eq('company_id', stationC);
    expect(stationCRows ?? [], 'the Station this listener never joined').toHaveLength(0);
  }, 60_000);

  it('anon may spend a token through the door, and may not read the table behind it', async () => {
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: `Anon Door Listener ${STAMP}`,
    });
    const { hash } = await mintToken(memberId, customer.companyId);

    const { error: consumeError } = await anonClient.rpc('consume_unsubscribe_token', {
      p_token_hash: hash,
      p_all_stations: false,
    });
    expect(consumeError, consumeError?.message).toBeNull();

    const { data, error: readError } = await anonClient.from('unsubscribe_tokens').select('id').limit(1);
    expect(data).toBeNull();
    expect(readError?.code).toBe('42501');
  }, 60_000);

  it('an eligible-listener query from Station A never returns a listener of Station B', async () => {
    const memberA = await createMemberAs(customer, customer.companyId, {
      fullName: `Eligible Station A Listener ${STAMP}`,
    });
    const memberB = await createMemberAs(customer, stationB, {
      fullName: `Eligible Station B Listener ${STAMP}`,
    });
    // Scoped to Station A alone — the precondition this case rests on: a
    // delegate who could also read Station B would make an absent row
    // ambiguous between "refused" and "never linked there in the first place".
    const delegate = await grantRoleWith(customer, `consent-eligible-${STAMP}`, ['members.view'], [
      customer.companyId,
    ]);
    const delegateClient = await signInAs(delegate.email, delegate.password);

    const { data, error } = await delegateClient.rpc('members_marketing_eligible_bulk', {
      p_member_ids: [memberA, memberB],
      p_company_id: customer.companyId,
      p_channel: 'EMAIL',
    });
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((row) => row.member_id);
    expect(ids).toContain(memberA);
    expect(ids).not.toContain(memberB);
  }, 60_000);
});

/**
 * Task 10 review gap 1. `members_marketing_eligible_bulk`'s block check scopes
 * with `b.organization_id = co.organization_id` — untouched by every case
 * above, which shares one Organization throughout, the same limit this
 * comment's own brief names in the pgTAP suite. `member_blocks_member_org_fk`
 * (0032) ties a block's `organization_id` to the blocked listener's OWN
 * organization_id, so no write path can ever record a block for a listener
 * under a DIFFERENT Organization's id — the only way left to exercise the
 * term is to ask about that listener through a Station of a different
 * Organization, which needs a caller RLS lets see across both at once: a
 * platform admin, which is what `provisionCustomer` already signs in as.
 */
describe('Block 29c, Task 10 review gap 1 — a suspension does not cross an Organization', () => {
  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('a suspension recorded in Organization B does not bar a listener asked about through Organization A', async () => {
    const orgA = await provisionCustomer(`consent-gap1-a-${STAMP}`);
    const orgB = await provisionCustomer(`consent-gap1-b-${STAMP}`);

    const memberB = await createMemberAs(orgB, orgB.companyId, {
      fullName: `Cross Org Suspended Listener ${STAMP}`,
    });

    const orgBOwnerClient = await signInAs(orgB.email, orgB.password);
    const { error: blockError } = await orgBOwnerClient.rpc('block_member', {
      p_member_id: memberB,
      p_kind: 'suspension',
      p_reason: 'Task 10 review gap 1 fixture',
    });
    expect(blockError, blockError?.message).toBeNull();

    // orgA.adminClient: a platform admin, which platform_admins makes a
    // system-wide status rather than one scoped to the Organization it
    // happened to provision — the same fact member_reachable's (0033) and
    // companies_select_org_member's (0021) own bypasses rely on, and what
    // lets this one session read a listener and a Station from two different
    // Organizations in the same call.
    const { data, error } = await orgA.adminClient.rpc('members_marketing_eligible_bulk', {
      p_member_ids: [memberB],
      p_company_id: orgA.companyId,
      p_channel: 'EMAIL',
    });
    expect(error, error?.message).toBeNull();
    // EMAIL's own default (spec D1) is eligible absent a consent row for this
    // pair — which is exactly what should still hold: Organization B's own
    // suspension must not reach across to a question asked through A.
    expect(data?.[0]?.eligible).toBe(true);
  }, 120_000);
});
