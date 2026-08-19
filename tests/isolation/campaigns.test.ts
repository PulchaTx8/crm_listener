import { Client } from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_SUPABASE_DB_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, LOCAL_SUPABASE_URL } from '../local-supabase';
import type { Database } from '@/lib/supabase/database.types';
import { drainCampaigns } from '@/services/campaigns';
import { WhatsAppMessagingProvider } from '@/lib/messaging/whatsapp-provider';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import {
  addCompany,
  cleanupUsers,
  createMemberAs,
  grantRoleWith,
  provisionCustomer,
  seedIntegration,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 29d-2, Task 9. The tenancy proofs pgTAP cannot give (68_campaigns.test.sql
 * runs one session inside its own transaction, `set local role authenticated`
 * plus a hand-built JWT claim, never a second, independent GoTrue session of
 * different ownership -- send-lists.test.ts's own header gives the identical
 * reasoning for its own suite), plus two proofs nothing in this block has given
 * yet, carried in from outside this file's own task brief:
 *
 *   - `for update skip locked` inside claim_campaign_batch (0244), which
 *     68_campaigns.test.sql's own comment (line ~795) names explicitly as
 *     something ONLY a second, real, concurrent connection can prove -- its
 *     own case shows a row already claimed IN THE SAME SESSION is not
 *     returned twice, which is true whether or not `skip locked` is there at
 *     all. This file's own case opens two direct Postgres connections.
 *   - that a WhatsApp recipient's positional `variables` array reaches the
 *     transport exactly as `create_campaign` (0243) snapshotted it, even
 *     after the live template's own order changes mid-campaign -- the
 *     scramble 0242's own column comment warns a re-read against the
 *     template's CURRENT order would cause, and which nothing before this
 *     file asserts on the array `FakeTransport` (src/lib/integrations/
 *     whatsapp/fake.ts) was actually HANDED, only on what the queue says
 *     about itself afterwards.
 */

const STAMP = Date.now();

/**
 * service_role, the identical reason geocode-drain.test.ts's own `service`
 * const gives for itself: the drain IS the worker, there is no session to
 * check, and this file calls `drainCampaigns` directly against it for the
 * two cases (suppression, positional-variable fidelity) that need the drain
 * actually run rather than merely described.
 */
const service = createClient<Database>(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

afterAll(cleanupUsers);

interface CampaignFixture {
  customer: ProvisionedCustomer;
  companyId: string;
  ownerClient: SupabaseClient<Database>;
  templateId: string;
  listId: string;
  campaignId: string;
  memberIds: string[];
  /** Same order as memberIds -- message_campaign_recipients' own id per listener. */
  recipientIds: string[];
  /** Keyed by member id, the same shape create_campaign's own p_addresses takes. */
  addresses: Record<string, string>;
}

/**
 * A fully valid, sendable WHATSAPP campaign: one Station, `memberCount`
 * listeners each holding an explicit whatsapp_marketing consent (WHATSAPP's
 * own default is NOT eligible, unlike EMAIL -- 0246's own `channel` CTE), a
 * registered marketing template, a FIXED send list holding exactly these
 * listeners, and the campaign itself, created through the real doors an
 * operator's own screen calls (`save_marketing_template`, `create_send_list`,
 * `create_campaign`) -- never inserted directly, the same discipline every
 * other isolation file in this suite holds fixture setup to.
 *
 * A WhatsApp integration is seeded directly (`seedIntegration`, harness.ts's
 * own escape hatch for a table with no PostgREST grant to any role) because
 * the drain refuses to send WHATSAPP at all without a Station's own
 * `phone_number_id` on record -- UNLESS `opts.skipIntegration`, fix round 1
 * Item 2's own case, which needs a Station that genuinely has none.
 */
async function createWhatsAppCampaignFixture(
  label: string,
  memberCount: number,
  opts: { snapshotValues?: string[]; skipIntegration?: boolean } = {},
): Promise<CampaignFixture> {
  const customer = await provisionCustomer(`campaigns-${label}-${STAMP}`);
  const companyId = customer.companyId;
  if (!opts.skipIntegration) {
    await seedIntegration(customer, `e2e-campaigns-${label}-${STAMP}`, companyId);
  }
  const ownerClient = await signInAs(customer.email, customer.password);

  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i += 1) {
    const memberId = await createMemberAs(customer, companyId, {
      fullName: `Listener ${label} ${i} ${STAMP}`,
      phone: `+5511${String(STAMP).slice(-7)}${i}`,
    });
    const { error: consentError } = await ownerClient.rpc('record_member_consent', {
      p_member_id: memberId,
      p_company_id: companyId,
      p_consent_type: 'whatsapp_marketing',
      p_granted: true,
    });
    if (consentError) throw new Error(`record_member_consent failed: ${consentError.message}`);
    memberIds.push(memberId);
  }

  const { data: templateId, error: templateError } = await ownerClient.rpc('save_marketing_template', {
    p_company_id: companyId,
    p_channel: 'WHATSAPP',
    p_internal_name: `Campaign template ${label} ${STAMP}`,
    p_body: 'Oi {{1}}!',
    p_name: `campaign_template_${label}_${STAMP}`,
    p_language: 'pt_BR',
    p_variables: ['LISTENER_FIRST_NAME'],
  });
  if (templateError || typeof templateId !== 'string') {
    throw new Error(`save_marketing_template failed: ${templateError?.message}`);
  }

  const { data: listId, error: listError } = await ownerClient.rpc('create_send_list', {
    p_company_id: companyId,
    p_name: `Campaign list ${label} ${STAMP}`,
    p_source: 'members',
    p_kind: 'fixed',
    p_filters: {},
    p_member_ids: memberIds,
  });
  if (listError || typeof listId !== 'string') throw new Error(`create_send_list failed: ${listError?.message}`);

  const addresses: Record<string, string> = {};
  const variables: Record<string, string[]> = {};
  memberIds.forEach((id, i) => {
    addresses[id] = `+5511${String(STAMP).slice(-7)}${i}`;
    variables[id] = [opts.snapshotValues?.[i] ?? `SNAPSHOT_${label}_${i}_${STAMP}`];
  });

  const { data: campaignId, error: campaignError } = await ownerClient.rpc('create_campaign', {
    p_company_id: companyId,
    p_list_id: listId,
    p_channel: 'WHATSAPP',
    p_template_id: templateId,
    p_member_ids: memberIds,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_addresses: addresses as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p_variables: variables as any,
  });
  if (campaignError || typeof campaignId !== 'string') {
    throw new Error(`create_campaign failed: ${campaignError?.message}`);
  }

  const { data: recipientRows, error: recipientError } = await service
    .from('message_campaign_recipients')
    .select('id, member_id')
    .eq('campaign_id', campaignId);
  if (recipientError) throw new Error(`could not read recipient rows: ${recipientError.message}`);
  const byMember = new Map((recipientRows ?? []).map((row) => [row.member_id, row.id]));
  const recipientIds = memberIds.map((id) => {
    const recipientId = byMember.get(id);
    if (!recipientId) throw new Error(`create_campaign wrote no recipient row for member ${id}`);
    return recipientId;
  });

  return { customer, companyId, ownerClient, templateId, listId, campaignId, memberIds, recipientIds, addresses };
}

/** A signed-in owner with a fresh Organization and Station, and nothing else -- the minimal fixture cases 3 and 4 need. */
async function provisionOwner(label: string): Promise<{ customer: ProvisionedCustomer; ownerClient: SupabaseClient<Database> }> {
  const customer = await provisionCustomer(`campaigns-${label}-${STAMP}`);
  const ownerClient = await signInAs(customer.email, customer.password);
  return { customer, ownerClient };
}

describe('Block 29d-2 -- campaigns, against real sessions', () => {
  it('a caller holding messaging.manage but not messaging.send cannot create a campaign', async () => {
    const { customer } = await provisionOwner(`no-send-${STAMP}`);
    const delegate = await grantRoleWith(customer, `campaign-manager-${STAMP}`, ['messaging.manage']);
    const delegateClient = await signInAs(delegate.email, delegate.password);

    // Permission is checked before existence (create_campaign's own house
    // order, 0243), so the list/template/member ids never have to resolve to
    // anything real for this caller to be refused first.
    const { data, error } = await delegateClient.rpc('create_campaign', {
      p_company_id: customer.companyId,
      p_list_id: crypto.randomUUID(),
      p_channel: 'WHATSAPP',
      p_template_id: crypto.randomUUID(),
      p_member_ids: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p_addresses: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p_variables: {} as any,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  }, 60_000);

  it('a campaign of Station A is invisible to a session of Station B', async () => {
    const fixture = await createWhatsAppCampaignFixture(`crossstation-${STAMP}`, 1);
    const stationB = await addCompany(fixture.customer, `Cross-Station Campaigns B ${STAMP}`);
    const viewerB = await grantRoleWith(fixture.customer, `campaign-viewer-b-${STAMP}`, ['messaging.view'], [
      stationB,
    ]);
    const viewerBClient = await signInAs(viewerB.email, viewerB.password);

    try {
      const { data, error } = await viewerBClient
        .from('message_campaigns')
        .select('id')
        .eq('id', fixture.campaignId);
      // Not 42501: 0242's select policy FILTERS the row (`authenticated` holds a
      // bare SELECT grant on the table), so a caller who cannot see this
      // Station simply gets nothing back -- the identical shape
      // send-lists.test.ts's own cross-Station case documents for send_lists.
      expect(error, error?.message).toBeNull();
      expect(data ?? []).toHaveLength(0);
    } finally {
      // Cleanup, in a finally (fix round 1, Item 1). A plain statement after
      // the assertions above -- what this used to be -- is skipped on a
      // failing run, leaking this fixture's one `pending` recipient row into
      // whatever later case in this file next calls drainCampaigns (which
      // claims the globally-oldest due rows, not only its own fixture's) --
      // the exact contamination shape case 7's own comment documents for its
      // rollback, reached here by a failing assertion instead. cancel_campaign
      // is the real door for that, and messaging.send is what the owner holds
      // by the ownership bypass has_permission itself carries.
      const { error: cancelError } = await fixture.ownerClient.rpc('cancel_campaign', {
        p_campaign_id: fixture.campaignId,
        p_reason: 'isolation suite cleanup',
      });
      if (cancelError) throw new Error('cleanup cancel_campaign failed: ' + cancelError.message);
    }
  }, 60_000);

  it('message_campaign_recipients cannot be read directly by an authenticated caller -- only the doors and the drain reach it', async () => {
    const { ownerClient } = await provisionOwner(`no-direct-read-${STAMP}`);

    const { data, error } = await ownerClient.from('message_campaign_recipients').select('id').limit(1);
    // 0242 revokes ALL on this table from anon and authenticated outright --
    // the grant refusing the query before RLS (which carries no policy on
    // this table at all) is ever consulted.
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  }, 60_000);

  it('claim_campaign_batch is unreachable from an authenticated session', async () => {
    const { ownerClient } = await provisionOwner(`no-claim-${STAMP}`);

    const { data, error } = await ownerClient.rpc('claim_campaign_batch', { p_limit: 10 });
    // Granted to service_role alone (0244); every other role, the owner
    // bypass included, is refused at the grant layer.
    expect(data).toBeNull();
    expect(error?.code).toBe('42501');
  }, 60_000);

  it("a listener who withdrew consent after the snapshot is suppressed and never sent to -- the block's central promise", async () => {
    const fixture = await createWhatsAppCampaignFixture(`suppress-${STAMP}`, 1);

    // Withdrawn AFTER the snapshot, through the real door a Station's own
    // staff would use (member_consents is append-only -- 0032's own header --
    // so this is a NEW row, granted=false, dated after the one create_campaign
    // read at snapshot time).
    const { error: withdrawError } = await fixture.ownerClient.rpc('record_member_consent', {
      p_member_id: fixture.memberIds[0]!,
      p_company_id: fixture.companyId,
      p_consent_type: 'whatsapp_marketing',
      p_granted: false,
    });
    expect(withdrawError, withdrawError?.message).toBeNull();

    const transport = new FakeTransport();
    const result = await drainCampaigns(service, {
      whatsappProvider: new WhatsAppMessagingProvider(transport),
    });
    expect(result.dbErrors, 'the drain could not settle a recipient row').toBe(0);

    // THE ASSERTION THIS CASE EXISTS FOR: never handed to the transport at
    // all -- suppression happens before an address is ever read (drainCampaigns'
    // own header, services/campaigns.ts), so asserting FakeTransport never
    // received a send addressed to THIS listener's own number proves the
    // withdrawal stopped the send rather than merely that the row LOOKS
    // suppressed. Scoped to this fixture's own address rather than asserting
    // the whole array is empty: claim_campaign_batch claims the globally
    // oldest due rows, not only this fixture's, so a batch sharing this tick
    // with some other campaign's own legitimate send is the ordinary case,
    // not a contamination to fail on.
    const address = fixture.addresses[fixture.memberIds[0]!];
    expect(transport.sentTemplates.some((call) => call.to === address)).toBe(false);
    expect(transport.sent.some((call) => call.to === address)).toBe(false);
    expect(transport.sentInteractive.some((call) => call.to === address)).toBe(false);

    const { data: recipientRow, error: recipientReadError } = await service
      .from('message_campaign_recipients')
      .select('status, provider_message_id, error_code')
      .eq('id', fixture.recipientIds[0]!)
      .single();
    expect(recipientReadError, recipientReadError?.message).toBeNull();
    expect(recipientRow?.status).toBe('suppressed');
    // suppressed carries no provider id and no error code -- it is the
    // listener's own choice, never our failure (message_campaign_recipients_
    // sent_shape and _failed_says_why, 0242).
    expect(recipientRow?.provider_message_id).toBeNull();
    expect(recipientRow?.error_code).toBeNull();

    const { data: campaignRow, error: campaignReadError } = await service
      .from('message_campaigns')
      .select('sent_count, failed_count, suppressed_count')
      .eq('id', fixture.campaignId)
      .single();
    expect(campaignReadError, campaignReadError?.message).toBeNull();
    expect(campaignRow?.sent_count).toBe(0);
    expect(campaignRow?.failed_count).toBe(0);
    expect(campaignRow?.suppressed_count).toBe(1);
  }, 60_000);

  it('cancel_campaign marks a pending row cancelled and leaves an already-claimed row alone', async () => {
    const fixture = await createWhatsAppCampaignFixture(`cancel-${STAMP}`, 2);
    const [pendingRecipientId, claimedRecipientId] = fixture.recipientIds as [string, string];

    try {
      // Simulated the same way 68_campaigns.test.sql's own cancel_campaign
      // section sets one up: claim_campaign_batch is the only real door onto
      // `claimed`, and it is reachable only from service_role (case 4 above),
      // so a direct write, through the same connection every other superuser
      // escape hatch in this suite uses, is the only way to produce the state
      // at all.
      const superuser = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await superuser.connect();
      try {
        await superuser.query(
          `update public.message_campaign_recipients set status = 'claimed', claimed_at = now() where id = $1`,
          [claimedRecipientId],
        );
      } finally {
        await superuser.end();
      }

      const { data: cancelledCount, error: cancelError } = await fixture.ownerClient.rpc('cancel_campaign', {
        p_campaign_id: fixture.campaignId,
        p_reason: 'testing the boundary between pending and claimed',
      });
      expect(cancelError, cancelError?.message).toBeNull();
      // ONLY the pending row -- the claimed one is already in flight at a
      // provider and cancel_campaign does not touch it (0243's own header).
      expect(cancelledCount).toBe(1);

      const { data: rows, error: readError } = await service
        .from('message_campaign_recipients')
        .select('id, status')
        .in('id', [pendingRecipientId, claimedRecipientId]);
      expect(readError, readError?.message).toBeNull();
      const byId = new Map((rows ?? []).map((row) => [row.id, row.status]));
      expect(byId.get(pendingRecipientId)).toBe('cancelled');
      // THE ASSERTION THIS CASE EXISTS FOR: still `claimed`, untouched --
      // cancel_campaign's own WHERE clause names `status = 'pending'` and
      // nothing else, so a row already claimed answers to neither this UPDATE
      // nor any later one from this door.
      expect(byId.get(claimedRecipientId)).toBe('claimed');

      const { data: campaignRow, error: campaignReadError } = await service
        .from('message_campaigns')
        .select('status, cancelled_by, cancelled_at')
        .eq('id', fixture.campaignId)
        .single();
      expect(campaignReadError, campaignReadError?.message).toBeNull();
      expect(campaignRow?.status).toBe('cancelled');
      expect(campaignRow?.cancelled_by).toBe(fixture.customer.userId);
      expect(campaignRow?.cancelled_at).not.toBeNull();
    } finally {
      // Cleanup, in a finally (fix round 1, Item 1) -- not a plain statement
      // after the assertions above, which is what this used to be: a failing
      // assertion anywhere in the try block above used to skip this entirely
      // and leave `claimedRecipientId` sitting `claimed` forever. A row left
      // `claimed` stays reclaimable -- drainCampaigns' own reclaim step
      // (services/campaigns.ts) moves any `claimed` row older than
      // STALE_CLAIM (5 minutes, src/services/whatsapp.ts) back to `pending`
      // on its NEXT call, which would hand this fixture's own fully-eligible
      // listener to a LATER test's drain (case 8, or a future run of this
      // file) as a real, unexpected send -- the exact contamination shape
      // case 7's own comment documents for its rollback, reached here by a
      // failing run instead. Both ids, not only the claimed one: a failure
      // between the RPC call and the read-back above could leave
      // pendingRecipientId still `pending` too, and `cancelled` is the
      // correct rest state for either row regardless of which assertion
      // failed.
      const cleanup = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await cleanup.connect();
      try {
        await cleanup.query(
          `update public.message_campaign_recipients set status = 'cancelled' where id = any($1)`,
          [[pendingRecipientId, claimedRecipientId]],
        );
      } finally {
        await cleanup.end();
      }
    }
  }, 60_000);

  /**
   * THE EXPERIMENT THIS CASE EXISTS TO RECORD, not merely to run once.
   * `68_campaigns.test.sql` already says, in its own comment beside the
   * single-session case it CAN write, that this file is where `for update
   * skip locked` is actually proven -- pgTAP runs one session inside one
   * transaction, so "a row already claimed is not returned by a second call"
   * there only shows that a row ALREADY MARKED `claimed` is not returned
   * twice, which is true whether or not the clause exists at all.
   *
   * TWO REAL, INDEPENDENT CONNECTIONS. The first opens a transaction, claims
   * one row, and DELIBERATELY HOLDS THE TRANSACTION OPEN -- the row's UPDATE
   * lock is not released until COMMIT or ROLLBACK, which is the only way a
   * second connection's own claim can ever be made to contend with it at all.
   * The second claims with a large limit and must come back with the
   * DISJOINT remainder, immediately, rather than blocking on the first
   * connection's still-open lock -- which is exactly what `skip locked`
   * promises and a bare `for update` would not.
   *
   * `SET statement_timeout` on the second connection is not part of the
   * property under test; it is what keeps a REGRESSION here from hanging the
   * whole isolation suite for the length of its own `testTimeout` (or, on a
   * connection with no statement timeout at all, forever) instead of failing
   * this one case loudly and by itself.
   *
   * MEASURED, not merely reasoned about: with `for update skip locked`
   * (supabase/migrations/0244_claim_campaign_batch.sql) temporarily edited
   * down to a bare `for update` and the database reset, this case's second
   * connection blocked until its own 5-second statement_timeout fired,
   * failing with Postgres error 57014 ("canceling statement due to statement
   * timeout") rather than returning a disjoint set. The clause was restored
   * and the database reset again before any other case in this file ran
   * against it. See task-9-report.md for the verbatim error this produced.
   */
  it('claim_campaign_batch never returns the same row to two concurrent callers -- for update skip locked, proven live', async () => {
    const fixture = await createWhatsAppCampaignFixture(`skiplocked-${STAMP}`, 2);
    const [first, second] = fixture.recipientIds as [string, string];

    const connA = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
    const connB = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
    await connA.connect();
    await connB.connect();

    try {
      await connA.query('BEGIN');
      const claimA = await connA.query<{ id: string }>('select id from public.claim_campaign_batch($1)', [1]);
      expect(claimA.rows).toHaveLength(1);
      const idsA = claimA.rows.map((row) => row.id);
      // Confirms connA actually claimed one of THIS fixture's own rows,
      // rather than some other pending row left by an earlier case in this
      // file (every earlier case cleans its own pending rows away -- see
      // each one's own comment).
      expect([first, second]).toContain(idsA[0]);

      await connB.query("SET statement_timeout = '5s'");
      const claimB = await connB.query<{ id: string }>('select id from public.claim_campaign_batch($1)', [10]);
      const idsB = claimB.rows.map((row) => row.id);

      // THE PROPERTY: disjoint, and the other of this fixture's two rows is
      // in it -- not blocked, not silently dropped.
      expect(idsB).not.toContain(idsA[0]);
      const other = [first, second].find((id) => id !== idsA[0]);
      expect(idsB).toContain(other);
    } finally {
      // MEASURED, the expensive way, in an earlier draft of this file: a
      // ROLLBACK here undoes connA's own claim and reverts its row to
      // `pending` -- fully eligible, address and consent intact -- and
      // NOTHING ELSE IN THIS FILE EVER TOUCHES IT AGAIN. A later run of this
      // suite (or, within one run, drainCampaigns' own reclaim step on a
      // `claimed` row older than STALE_CLAIM, 5 minutes, once connB's own
      // committed claim goes stale) can pick that row up and actually send
      // it -- which is exactly what happened: a full-suite run inflated the
      // suppression case's `sentTemplates` count from the expected 0 to 2,
      // both of them stray `pending` rows a PREVIOUS run of this same case
      // had left behind by rolling back. COMMIT instead, then force BOTH of
      // this fixture's rows to `cancelled` directly -- a status nothing ever
      // reclaims or re-drains -- rather than trust either connection's own
      // transaction outcome to leave nothing sendable behind.
      await connA.query('COMMIT').catch(() => undefined);
      await connA.end();
      await connB.end();

      const cleanup = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await cleanup.connect();
      try {
        await cleanup.query(
          `update public.message_campaign_recipients set status = 'cancelled' where id = any($1)`,
          [[first, second]],
        );
      } finally {
        await cleanup.end();
      }
    }
  }, 30_000);

  it("a WhatsApp recipient's positional variables reach the transport exactly as snapshotted, unmoved by a later edit to the live template's own order", async () => {
    const fixture = await createWhatsAppCampaignFixture(`variables-${STAMP}`, 1, {
      snapshotValues: ['ORIGINAL_SNAPSHOT_VALUE'],
    });

    // The live template is edited AFTER the snapshot: two variables, in a
    // different order and naming different fields than the one this campaign
    // was created against. buildTemplatePayload never reads the body's own
    // {{n}} count against the variables array (it sends `name`+`language` and
    // lets Meta's own registration supply the body), so this update is free
    // to disagree with the frozen recipient snapshot's own single-element
    // array without either write refusing the other.
    const { error: updateError } = await fixture.ownerClient.rpc('save_marketing_template', {
      p_id: fixture.templateId,
      p_company_id: fixture.companyId,
      p_channel: 'WHATSAPP',
      p_internal_name: `Campaign template variables (edited) ${STAMP}`,
      p_body: 'Oi {{1}}, aqui e a {{2}}!',
      p_name: `campaign_template_variables_${STAMP}`,
      p_language: 'pt_BR',
      p_variables: ['STATION_NAME', 'LISTENER_FIRST_NAME'],
    });
    expect(updateError, updateError?.message).toBeNull();

    const transport = new FakeTransport();
    const result = await drainCampaigns(service, {
      whatsappProvider: new WhatsAppMessagingProvider(transport),
    });
    expect(result.dbErrors, 'the drain could not settle a recipient row').toBe(0);

    const sent = transport.sentTemplates.find((call) =>
      call.template.name === `campaign_template_variables_${STAMP}`,
    );
    expect(sent, "FakeTransport never received this recipient's send").toBeDefined();
    // THE ASSERTION THIS CASE EXISTS FOR: the exact snapshot array, one
    // element, unchanged -- never the edited template's two. A drain that
    // re-read message_templates.variables' CURRENT order instead of
    // message_campaign_recipients.variables' FROZEN one would hand the
    // transport either two values (one fabricated) or the single value
    // shifted into the wrong slot; either way this equality would fail.
    expect(sent!.template.variables).toEqual(['ORIGINAL_SNAPSHOT_VALUE']);
    expect(sent!.to).toBe(fixture.addresses[fixture.memberIds[0]!]);

    const { data: recipientRow, error: recipientReadError } = await service
      .from('message_campaign_recipients')
      .select('status, provider_message_id')
      .eq('id', fixture.recipientIds[0]!)
      .single();
    expect(recipientReadError, recipientReadError?.message).toBeNull();
    expect(recipientRow?.status).toBe('sent');
    // FakeTransport's own id shape (src/lib/integrations/whatsapp/fake.ts) --
    // proof the row's provider_message_id came from the fake actually being
    // called, not from a status flipped by hand.
    expect(recipientRow?.provider_message_id).toMatch(/^wamid\.FAKE\d+$/);
  }, 60_000);

  /**
   * Fix round 1, Item 2. No case anywhere in this file -- including the
   * fixture helper every other case shares -- ever exercises
   * claim_campaign_batch against a Station with NO integrations row:
   * `createWhatsAppCampaignFixture` seeds one unconditionally. The behaviour
   * without one is correct by code trace alone (0252's own LEFT JOIN returns
   * `phone_number_id` null; the drain's own `row.phone_number_id === null`
   * branch settles the row `failed` with `no_whatsapp_integration`,
   * services/campaigns.ts) -- but that LEFT JOIN is exactly the join whose
   * absence produced the real defect this task found and fixed (0252's own
   * header), and nothing stops a future "simplification" back to an INNER
   * JOIN, which would compile, pass every OTHER case in this file, and
   * silently strand every such row `claimed` forever instead: the claiming
   * CTE's UPDATE marks it claimed unconditionally (0244's own reasoning,
   * restated by 0252), and an INNER JOIN that then fails to match would drop
   * the row from what the function RETURNS while leaving it claimed in the
   * table -- never sent, never failed, never seen again.
   *
   * TWO RECIPIENT ROWS, not one, because the two halves of that claim need
   * different callers to observe. The first is claimed directly, by raw SQL,
   * so the assertion is on claim_campaign_batch's OWN return value -- present,
   * with `phone_number_id` null -- rather than on anything the drain layers
   * on top. The second is left pending for drainCampaigns' own claim to take,
   * so the assertion is on the CONSEQUENCE: settled `failed`, with the
   * taxonomy code an operator's history screen would read, never left
   * `claimed` for ever.
   *
   * MEASURED, not merely reasoned about: `left join public.integrations` in
   * supabase/migrations/0252_claim_campaign_batch_reads_integration.sql was
   * temporarily changed to `inner join`, the database reset, and this case
   * re-run alone. Both halves failed for the reason this comment predicts --
   * see task-9-report.md for the verbatim output. The join was restored and
   * the database reset again before any other case in this file ran against
   * it.
   */
  it('a WhatsApp campaign at a Station with no integration is claimed with a null phone number id and settles failed -- never silently stranded', async () => {
    const fixture = await createWhatsAppCampaignFixture(`nointegration-${STAMP}`, 2, {
      skipIntegration: true,
    });
    const [rowA, rowB] = fixture.recipientIds as [string, string];

    try {
      const superuser = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await superuser.connect();
      let rawClaimed: { id: string; phone_number_id: string | null }[];
      try {
        const result = await superuser.query<{ id: string; phone_number_id: string | null }>(
          'select id, phone_number_id from public.claim_campaign_batch($1)',
          [1],
        );
        rawClaimed = result.rows;
      } finally {
        await superuser.end();
      }

      // THE ASSERTION THIS CASE EXISTS FOR, first half: claimed and RETURNED,
      // not silently dropped -- exactly what an INNER JOIN to integrations
      // would fail to do, since the row's own status is already flipped to
      // `claimed` by the CTE's UPDATE regardless of whether the final
      // SELECT's join matches anything.
      expect(
        rawClaimed,
        'claim_campaign_batch returned no row at all for a Station with no integration',
      ).toHaveLength(1);
      expect([rowA, rowB]).toContain(rawClaimed[0]!.id);
      expect(rawClaimed[0]!.phone_number_id).toBeNull();

      const claimedViaRawSql = rawClaimed[0]!.id;
      const remaining = claimedViaRawSql === rowA ? rowB : rowA;

      const transport = new FakeTransport();
      const result = await drainCampaigns(service, {
        whatsappProvider: new WhatsAppMessagingProvider(transport),
      });
      expect(result.dbErrors, 'the drain could not settle a recipient row').toBe(0);
      // Never reached the transport -- refused before a send was attempted,
      // the same shape drainOutbox uses for a row with no phone_number_id
      // (services/campaigns.ts's own comment on this exact branch).
      expect(transport.sentTemplates).toHaveLength(0);

      const { data: recipientRow, error: recipientReadError } = await service
        .from('message_campaign_recipients')
        .select('status, error_code, provider_message_id')
        .eq('id', remaining)
        .single();
      expect(recipientReadError, recipientReadError?.message).toBeNull();
      // THE ASSERTION THIS CASE EXISTS FOR, second half: settled `failed`
      // with the taxonomy code an operator's history screen reads -- not
      // left `claimed` for ever, which is what an INNER JOIN would produce:
      // drainCampaigns' own claim call would ALSO return nothing for this
      // row, even though the CTE had already marked it claimed in the table.
      expect(recipientRow?.status).toBe('failed');
      expect(recipientRow?.error_code).toBe('no_whatsapp_integration');
      expect(recipientRow?.provider_message_id).toBeNull();
    } finally {
      // Cleanup, in a finally from the start (fix round 1, Item 1's own
      // lesson): the row claimed by raw SQL above never goes through the
      // drain in this case, so nothing else ever moves it off `claimed` --
      // left there, it is exactly the STALE_CLAIM-reclaimable row cases 6
      // and 7's own comments warn about. Both ids and either idle status,
      // not only the one the happy path expects to still be `claimed`: a
      // failure partway through the try block above could leave either row
      // `pending` or `claimed`, and `cancelled` is the correct rest state
      // for both regardless of which assertion failed.
      const cleanup = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await cleanup.connect();
      try {
        await cleanup.query(
          `update public.message_campaign_recipients set status = 'cancelled'
             where id = any($1) and status in ('pending', 'claimed')`,
          [[rowA, rowB]],
        );
      } finally {
        await cleanup.end();
      }
    }
  }, 60_000);

  /**
   * WHOLE-BRANCH REVIEW C1, ruling R34. A campaign an operator has STOPPED
   * must never resume sending -- spec D1 from the other side, since the
   * operator's Cancel is the listener's "make it stop" arriving through a
   * different door.
   *
   * EVERY STEP OF THE STATE THIS SETS UP IS REACHABLE, and that is the point
   * of proving it here rather than in the unit suite. cancel_campaign (0243)
   * marks only `pending` rows, deliberately: a `claimed` row may be in flight
   * at a provider and cannot be recalled. But `claimed` does not mean in
   * flight. The circuit breaker parks a batch's unprocessed rows `claimed`
   * after three consecutive retryable failures -- which is the ordinary
   * response to exactly the provider trouble that makes an operator reach for
   * Cancel -- and a tick that dies mid-batch leaves them the same way. The
   * drain's own reclaim then returns any row `claimed` longer than
   * STALE_CLAIM to `pending`, unconditionally, and claim_campaign_batch
   * claims on `status = 'pending'` alone.
   *
   * So: a row `claimed` six minutes ago (past STALE_CLAIM's five), a campaign
   * cancelled through the REAL door by an owner holding messaging.send, and
   * then a real drain against a real database.
   *
   * THE ASSERTION IS ON WHAT THE TRANSPORT WAS HANDED, not on the row's
   * resulting status: a fix that settled these rows `cancelled` AFTER sending
   * them would leave the queue looking identical and would still have put
   * marketing in front of a listener who was told it had stopped.
   */
  it('a campaign cancelled while its rows were claimed never sends them, even after the stale-claim reclaim gives them back', async () => {
    const fixture = await createWhatsAppCampaignFixture(`cancelled-resumes-${STAMP}`, 1);
    const recipientId = fixture.recipientIds[0]!;
    const address = fixture.addresses[fixture.memberIds[0]!];

    try {
      // The circuit-breaker/dead-tick state: claimed, and old enough that
      // this drain's own reclaim (STALE_CLAIM, 5 minutes) will hand it back.
      const superuser = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await superuser.connect();
      try {
        await superuser.query(
          `update public.message_campaign_recipients
              set status = 'claimed', claimed_at = now() - interval '6 minutes'
            where id = $1`,
          [recipientId],
        );
      } finally {
        await superuser.end();
      }

      const { data: cancelledCount, error: cancelError } = await fixture.ownerClient.rpc('cancel_campaign', {
        p_campaign_id: fixture.campaignId,
        p_reason: 'the provider started failing',
      });
      expect(cancelError, cancelError?.message).toBeNull();
      // ZERO rows marked: the only recipient of this campaign is `claimed`,
      // which cancel_campaign does not touch. The campaign itself is
      // cancelled all the same, and reports success to the operator -- which
      // is precisely why the drain has to be the one that refuses.
      expect(cancelledCount).toBe(0);

      const transport = new FakeTransport();
      const result = await drainCampaigns(service, {
        whatsappProvider: new WhatsAppMessagingProvider(transport),
      });
      expect(result.dbErrors, 'the drain could not settle a recipient row').toBe(0);

      // THE ASSERTION THIS CASE EXISTS FOR. Scoped to this fixture's own
      // address rather than to an empty array, for the reason case 5's own
      // comment gives: this drain claims the globally-oldest due rows, so
      // another campaign's legitimate send sharing the tick is ordinary.
      expect(transport.sentTemplates.some((call) => call.to === address)).toBe(false);
      expect(transport.sent.some((call) => call.to === address)).toBe(false);
      expect(transport.sentInteractive.some((call) => call.to === address)).toBe(false);

      const { data: recipientRow, error: recipientReadError } = await service
        .from('message_campaign_recipients')
        .select('status, attempts, error_code, provider_message_id')
        .eq('id', recipientId)
        .single();
      expect(recipientReadError, recipientReadError?.message).toBeNull();
      // Settled, not stranded: the row is out of the queue for good rather
      // than left `pending` for the next reclaim to find again -- which is
      // why R34 put this in the drain instead of narrowing the claim.
      expect(recipientRow?.status).toBe('cancelled');
      // Nothing was attempted and nothing went wrong.
      expect(recipientRow?.attempts).toBe(0);
      expect(recipientRow?.error_code).toBeNull();
      expect(recipientRow?.provider_message_id).toBeNull();

      const { data: campaignRow, error: campaignReadError } = await service
        .from('message_campaigns')
        .select('status, sent_count, failed_count, suppressed_count')
        .eq('id', fixture.campaignId)
        .single();
      expect(campaignReadError, campaignReadError?.message).toBeNull();
      // Still cancelled -- the drain's own finish write is guarded on
      // `in ('queued', 'running')`, so settling the last row cannot rewrite
      // the operator's decision as `sent`.
      expect(campaignRow?.status).toBe('cancelled');
      expect(campaignRow?.sent_count).toBe(0);
      expect(campaignRow?.failed_count).toBe(0);
      expect(campaignRow?.suppressed_count).toBe(0);
    } finally {
      const cleanup = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
      await cleanup.connect();
      try {
        await cleanup.query(
          `update public.message_campaign_recipients set status = 'cancelled'
             where id = $1 and status in ('pending', 'claimed')`,
          [recipientId],
        );
      } finally {
        await cleanup.end();
      }
    }
  }, 60_000);
});
