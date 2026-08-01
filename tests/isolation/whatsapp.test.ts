import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  admin,
  anonClient,
  cleanupUsers,
  createMemberAs,
  provisionCustomer,
  seedIntegration,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

const HOUR = 60 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface MessageFixture {
  promotionId: string;
  eventA: string;
  eventB: string;
  /** (provider, external_id) — the SHA-256 hash webhook_events actually stores. */
  externalIdA: string;
  externalIdB: string;
}

/**
 * A Station with a live WhatsApp integration, a listener already registered
 * and linked to it, and a once-only promotion open right now — plus two
 * DIFFERENT inbound messages from that same listener, at the same instant,
 * both naming the promotion's hashtag.
 *
 * The listener is pre-registered rather than left for the bot to create,
 * deliberately: apply_member_creation (0061) has no ON CONFLICT of its own —
 * unlike apply_member_link, it is a plain INSERT wrapped in a handler that
 * turns a unique_violation into a raised 23505 — so two concurrent FIRST
 * messages from an unknown number would race each OTHER, on member creation,
 * before either ever reached apply_participation. That is a real property of
 * ingest_whatsapp_event, but it is not what this file is about: PART ONE of
 * this task names the invariant under test as "same person, same promotion",
 * which only holds when the person already exists before the race starts.
 * With the listener seeded up front, apply_member_lookup (a plain SELECT) and
 * apply_member_link (ON CONFLICT DO NOTHING) are both race-safe, and the only
 * contested resource left is apply_participation's advisory lock over
 * (promotion, member) — which is the one this task exists to prove.
 *
 * The two message ids differ on purpose. Idempotency — (provider,
 * external_id) unique on webhook_events (0058) — would already make a
 * REPEATED id safe, and would prove nothing about the lock; only two
 * DIFFERENT ids reach apply_participation as two genuinely separate attempts.
 */
async function seedPromotionWithIntegration(label: string): Promise<MessageFixture> {
  const customer = await provisionCustomer(label);

  const phoneNumberId = `pnid-${label}`;
  await seedIntegration(customer, phoneNumberId);

  // Members store phones digits-only with no country code (an operator types
  // (11) 99999-0000, stored as 11999990000); WhatsApp delivers the sender
  // WITH the country code. whatsapp_local_phone (0062) strips it, so the two
  // must be the same number in the two different shapes for apply_member_lookup
  // to find the listener seeded here.
  const localPhone = '11999990000';
  await createMemberAs(customer, customer.companyId, {
    fullName: `Race Listener ${label}`,
    phone: localPhone,
  });

  // A hashtag unique to this label — stripped to what promotions_hashtag_shape
  // (0040) accepts (`^#[^[:space:]#]{1,39}$`) — so the message text below
  // matches this round's promotion and no other.
  const hashtag = `#${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);

  const owner = await signInAs(customer.email, customer.password);
  const { data: promotionId, error: promotionError } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Race ${label}`,
    // A window containing now(), which is what v_when (the MESSAGE's own
    // timestamp, below) is judged against inside ingest_whatsapp_event.
    p_starts_at: new Date(Date.now() - HOUR).toISOString(),
    p_ends_at: new Date(Date.now() + HOUR).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: hashtag,
  });
  if (promotionError || !promotionId) {
    throw new Error(`create_promotion failed: ${promotionError?.message}`);
  }

  const waFrom = `55${localPhone}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  // The raw ids. Different by construction (label is unique per round and the
  // A/B suffix separates the two within it), which is the whole point.
  const wamidA = `wamid.${label}-A`;
  const wamidB = `wamid.${label}-B`;

  const payloadFor = (wamid: string) => ({
    // The RAW id, stored ONLY here — never in external_id, which the CHECK on
    // webhook_events (0058) restricts to a lowercase hex SHA-256 digest.
    wamid,
    metadata: { phone_number_id: phoneNumberId },
    from: waFrom,
    profile_name: null,
    text: `quero participar ${hashtag}`,
    timestamp,
  });

  const externalIdA = sha256Hex(wamidA);
  const externalIdB = sha256Hex(wamidB);

  // Hashed here, in Node, the same way the webhook route hashes it (0058's own
  // reasoning: an argument passed to an RPC lands in query logs and backups).
  const { data: rows, error: eventsError } = await admin
    .from('webhook_events')
    .insert([
      { provider: 'WHATSAPP', external_id: externalIdA, payload: payloadFor(wamidA) },
      { provider: 'WHATSAPP', external_id: externalIdB, payload: payloadFor(wamidB) },
    ])
    .select('id, external_id');
  if (eventsError || !rows) {
    throw new Error(`could not seed webhook_events: ${eventsError?.message}`);
  }

  const eventA = rows.find((row) => row.external_id === externalIdA)?.id;
  const eventB = rows.find((row) => row.external_id === externalIdB)?.id;
  if (!eventA || !eventB) {
    throw new Error('seedPromotionWithIntegration: could not resolve both inserted event ids');
  }

  return { promotionId: promotionId as string, eventA, eventB, externalIdA, externalIdB };
}

describe('the WhatsApp door', () => {
  it('is closed to an ordinary signed-in user', async () => {
    const customer = await provisionCustomer(`wa-gate-${Date.now()}`);
    const client = await signInAs(customer.email, customer.password);

    const { error } = await client.rpc('ingest_whatsapp_event', {
      p_event_id: '00000000-0000-0000-0000-000000000000',
    });

    // The grant is the defence; this is what proves the defence is there.
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied|does not exist/i);
  });

  it('is closed to an anonymous caller', async () => {
    const { error } = await anonClient.rpc('ingest_whatsapp_event', {
      p_event_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/permission denied|does not exist/i);
  });

  /**
   * Twelve, matching participations.test.ts:661 exactly, and for the reason
   * given there: one green round is a weak detector of a missing lock — 4c
   * measured about one miss in three from a single round — so twelve rounds
   * bring the miss probability under one run in a hundred while five would
   * leave one run in eight. If this number ever drifts, re-measure it there,
   * never here in isolation.
   *
   * Do NOT re-run a red result. A round reporting 2 VALID rows is the exact
   * failure the twelve rounds exist to catch.
   */
  const RACE_ROUNDS = 12;

  it(
    'lets exactly one of two simultaneous messages become the entry',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedPromotionWithIntegration(`wa-race-${stamp}-${round}`);

        const [a, b] = await Promise.all([
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventA }),
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventB }),
        ]);

        expect(a.error, `round ${round}, event A`).toBeNull();
        expect(b.error, `round ${round}, event B`).toBeNull();

        const { count } = await admin
          .from('participations')
          .select('id', { count: 'exact', head: true })
          .eq('promotion_id', fixture.promotionId)
          .eq('status', 'VALID');

        expect(count, `round ${round} produced ${count} valid entries`).toBe(1);
      }
    },
    180_000,
  );
});

/**
 * The HTTP-and-privilege boundary pgTAP cannot see, because pgTAP runs as
 * postgres and ignores ACLs, and the vitest route suites mock the Supabase
 * client. Three defects in this block existed only here: the webhook route
 * once answered 42501 on every message because service_role held no grant on
 * webhook_events or outbox_messages, and an earlier worker read integrations
 * through a PostgREST resource embed that needed a grant which never existed
 * either (replaced by claim_outbox_batch's own internal join instead — see
 * 0057's comment). Every one of those was invisible to every test that ran
 * before this file existed. These cases drive the exact writes the route and
 * the worker perform, through the same client and the same shapes, rather
 * than asserting the grant as data — a missing grant fails these the same way
 * it failed the route in production.
 */
describe('the privilege boundary pgTAP cannot see', () => {
  it("lets the webhook route's exact upsert into webhook_events succeed for service_role", async () => {
    const wamid = `wamid.priv-${Date.now()}`;
    const { error } = await admin.from('webhook_events').upsert(
      [
        {
          provider: 'WHATSAPP' as const,
          external_id: sha256Hex(wamid),
          payload: {
            wamid,
            metadata: { phone_number_id: 'priv-boundary-test' },
            from: '5511999990000',
            profile_name: null,
            text: '#PRIV',
            timestamp: String(Math.floor(Date.now() / 1000)),
          },
        },
      ],
      { onConflict: 'provider,external_id', ignoreDuplicates: true },
    );

    // Had 0058's grant been missing, this would come back 42501 — exactly
    // what the merged webhook route answered to every inbound message while
    // every pgTAP and vitest run in the repository stayed green.
    expect(error).toBeNull();
  });

  it("lets the worker's exact writes against outbox_messages succeed for service_role", async () => {
    // outbox_messages holds NO insert grant for service_role — confirmed
    // live: has_table_privilege('service_role', 'public.outbox_messages',
    // 'INSERT') is false. ingest_whatsapp_event (SECURITY DEFINER) is the
    // table's only writer of a new row (0059's own comment), so the two real
    // rows this case needs are produced by actually ingesting two messages
    // from the same listener against a promotion that does not allow repeat
    // entries: the first is recorded VALID, the second DUPLICATE, and both
    // statuses carry a non-null reply (whatsapp_reply_body), so both enqueue
    // a row. Sequential, not concurrent — this case is not the race, it only
    // needs two real rows to update.
    const fixture = await seedPromotionWithIntegration(`wa-outbox-priv-${Date.now()}`);

    const first = await admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventA });
    if (first.error) throw new Error(`seed ingestion (A) failed: ${first.error.message}`);
    const second = await admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventB });
    if (second.error) throw new Error(`seed ingestion (B) failed: ${second.error.message}`);

    const dedupeKeyA = `${fixture.externalIdA}:confirmation`;
    const dedupeKeyB = `${fixture.externalIdB}:confirmation`;
    const { data: outboxRows, error: outboxSelectError } = await admin
      .from('outbox_messages')
      .select('id, dedupe_key')
      .in('dedupe_key', [dedupeKeyA, dedupeKeyB]);
    if (outboxSelectError || !outboxRows || outboxRows.length !== 2) {
      throw new Error(
        `expected two seeded outbox rows, got ${outboxRows?.length ?? 0}: ${outboxSelectError?.message}`,
      );
    }
    const sentRow = outboxRows.find((row) => row.dedupe_key === dedupeKeyA);
    const settleRow = outboxRows.find((row) => row.dedupe_key === dedupeKeyB);
    if (!sentRow || !settleRow) {
      throw new Error('expected one outbox row per seeded message');
    }

    // The exact shape drainOutbox writes on an accepted send:
    // outbox_messages_sent_shape (0059) makes SENT a claim about external_id
    // and sent_at together, so all four columns move in one statement.
    const sent = await admin
      .from('outbox_messages')
      .update({
        status: 'SENT',
        external_id: 'wamid.settled-ok',
        sent_at: new Date().toISOString(),
        attempts: 1,
      })
      .eq('id', sentRow.id);
    expect(sent.error).toBeNull();

    // The exact shape drainOutbox writes settling a permanent failure.
    const settled = await admin
      .from('outbox_messages')
      .update({ status: 'FAILED', attempts: 1, last_error: 'simulated permanent failure' })
      .eq('id', settleRow.id);
    expect(settled.error).toBeNull();
  });

  it('lets service_role execute the queue RPCs the worker calls every tick', async () => {
    // ingest_whatsapp_event's own service_role executability is already
    // proven, positively, by the race above (twelve rounds of admin.rpc
    // succeeding) and by the seed ingestions just above. These three are the
    // rest of runTick's RPC surface: selecting due inbound events, claiming an
    // outbound batch, and reclaiming abandoned claims on both sides.
    const due = await admin.rpc('due_whatsapp_events', { p_limit: 1 });
    expect(due.error).toBeNull();

    const claimed = await admin.rpc('claim_outbox_batch', { p_limit: 1 });
    expect(claimed.error).toBeNull();

    const reclaimed = await admin.rpc('reclaim_stale_whatsapp_claims', {
      p_stale_after: '5 minutes',
    });
    expect(reclaimed.error).toBeNull();
  });
});
