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
 * pgTAP runs as superuser and has to hand-build a session with `set local role`
 * and a claims GUC before it can ask anything of a gated door; here the session
 * is real, issued by GoTrue, and carries whatever the invitation flow actually
 * granted. That is the difference this file exists for: it can show a door
 * refusing somebody whose permissions were produced the way production produces
 * them, the same argument marketing-templates.test.ts's own header makes.
 *
 * `members_marketing_eligible_bulk` is SECURITY DEFINER with its own caller
 * gate since 0235 (whole-branch review, F29). It was SECURITY INVOKER, and the
 * cases below were written against that: two of its four layers are phrased as
 * the ABSENCE of a row, so a caller whose RLS merely HID a Station's consent
 * and block rows was told every listener there was eligible — including one who
 * had unsubscribed and one under an active suspension.
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

  it('an eligible-listener query from Station A never reports a listener of Station B as a recipient', async () => {
    const memberA = await createMemberAs(customer, customer.companyId, {
      fullName: `Eligible Station A Listener ${STAMP}`,
    });
    const memberB = await createMemberAs(customer, stationB, {
      fullName: `Eligible Station B Listener ${STAMP}`,
    });
    // Scoped to Station A alone — the precondition this case rests on, and now
    // also what the next case turns on: this delegate holds nothing whatever at
    // Station B.
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

    // A ROW PER ID, AND THE ANSWER IS IN THE ROW — not in whether the row came
    // back. That is what changed with 0235: under SECURITY INVOKER, a listener
    // the caller's RLS hid simply vanished from the result, which read as
    // "not a recipient" only by accident, and read as "eligible" for every
    // listener whose consent rows were hidden the same way. A definer function
    // sees every row and has to SAY no, which is a claim a test can pin.
    const answers = new Map((data ?? []).map((row) => [row.member_id, row.eligible]));
    expect(answers.get(memberA), 'a listener of the Station being asked about').toBe(true);
    expect(answers.get(memberB), 'a listener of a Station this campaign is not for').toBe(false);
  }, 60_000);

  /**
   * The whole-branch review's F29, as the failure it actually was. This
   * delegate holds `members.view` at Station A and nothing at all at Station B.
   * Under 0229 the same call answered — with no consent rows and no block rows
   * visible at B, both absences read as permission and every listener there came
   * back eligible, an unsubscribed one and a suspended one included. There is no
   * assertion about the CONTENT of that answer here on purpose: an answer at all
   * is the defect.
   */
  it('a caller holding members.view at one Station is refused outright at another, not answered permissively', async () => {
    const memberAtB = await createMemberAs(customer, stationB, {
      fullName: `Refused Station B Listener ${STAMP}`,
    });
    const delegate = await grantRoleWith(customer, `consent-gate-${STAMP}`, ['members.view'], [
      customer.companyId,
    ]);
    const delegateClient = await signInAs(delegate.email, delegate.password);

    const { data, error } = await delegateClient.rpc('members_marketing_eligible_bulk', {
      p_member_ids: [memberAtB],
      p_company_id: stationB,
      p_channel: 'EMAIL',
    });
    expect(data ?? [], 'nothing may come back from a Station the caller cannot ask about').toEqual(
      [],
    );
    expect(error?.code, error?.message).toBe('42501');
  }, 60_000);
});

/**
 * Task 10 review gap 1, REWRITTEN BY THE WHOLE-BRANCH REVIEW (F29). The case
 * below used to assert that a listener of Organization B, asked about through a
 * Station of Organization A, came back ELIGIBLE — reasoning that Organization
 * B's own suspension must not reach across, which is true, and concluding from
 * it that EMAIL's default should therefore apply, which is not. Nothing in the
 * old function asked whether the listener had any relationship to the Station
 * at all, so "the block does not cross" and "so send them a campaign" had been
 * run together into one assertion, and the second half of it was the defect
 * being pinned as correct.
 *
 * The Organization term in the block check (`b.organization_id =
 * co.organization_id`) is still there and still right — it is simply no longer
 * the first thing that answers this question. `member_company_links`'
 * composite foreign keys force a link's member and company to share one
 * Organization, so a listener of B can never be linked to a Station of A, and
 * 0235's link check refuses before the block layer is ever consulted.
 *
 * The platform-admin session is kept: it is the only caller RLS lets see a
 * listener and a Station from two different Organizations at once, and — since
 * 0235 — the only one the gate lets ask the question at all. That is what makes
 * this a test of the ANSWER rather than of the gate, which the two cases above
 * already cover.
 */
describe('Block 29c, F29 — a listener of another Organization is never a recipient here', () => {
  afterAll(async () => {
    await cleanupUsers();
  }, 60_000);

  it('a listener of Organization B is answered "not a recipient" when asked about through a Station of Organization A', async () => {
    const orgA = await provisionCustomer(`consent-gap1-a-${STAMP}`);
    const orgB = await provisionCustomer(`consent-gap1-b-${STAMP}`);

    const memberB = await createMemberAs(orgB, orgB.companyId, {
      fullName: `Cross Org Suspended Listener ${STAMP}`,
    });

    // The suspension is kept as a fixture rather than dropped: it is what makes
    // the answer unambiguous. Whatever a future change does to the block
    // layers, this listener has no business being called a recipient of
    // Organization A's campaigns.
    const orgBOwnerClient = await signInAs(orgB.email, orgB.password);
    const { error: blockError } = await orgBOwnerClient.rpc('block_member', {
      p_member_id: memberB,
      p_kind: 'suspension',
      p_reason: 'Task 10 review gap 1 fixture',
    });
    expect(blockError, blockError?.message).toBeNull();

    const { data, error } = await orgA.adminClient.rpc('members_marketing_eligible_bulk', {
      p_member_ids: [memberB],
      p_company_id: orgA.companyId,
      p_channel: 'EMAIL',
    });
    // A platform admin passes the gate's first arm, so this is answered rather
    // than refused — and the answer is no, on the link check, before EMAIL's
    // default (spec D1) is reached.
    expect(error, error?.message).toBeNull();
    expect(data?.[0]?.member_id, 'still a row per id asked about').toBe(memberB);
    expect(data?.[0]?.eligible).toBe(false);
  }, 120_000);
});
