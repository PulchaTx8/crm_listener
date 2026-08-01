import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addCompany,
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
  organizationId: string;
  /** Digits-only, no country code — the shape members.phone_normalized stores. */
  localPhone: string;
  eventA: string;
  eventB: string;
  /** (provider, external_id) — the SHA-256 hash webhook_events actually stores. */
  externalIdA: string;
  externalIdB: string;
}

/**
 * A Station with a live WhatsApp integration and a once-only promotion open
 * right now, plus two DIFFERENT inbound messages from the same phone, at the
 * same instant, both naming the promotion's hashtag.
 *
 * `preRegisterListener` (default true) decides whether the listener already
 * exists before the two messages arrive:
 *
 * - true — the pair this file's advisory-lock race uses. The listener is
 *   registered up front so that apply_member_lookup (a plain SELECT) and
 *   apply_member_link (ON CONFLICT DO NOTHING) are both race-safe on the way
 *   in, leaving apply_participation's advisory lock over (promotion, member)
 *   as the only contested resource — which is what PART ONE names as the
 *   invariant under test ("same person, same promotion" only holds when the
 *   person already exists before the race starts).
 * - false — the pair the NEW-listener race below uses, exercising the window
 *   apply_member_creation (0061) itself opens: two concurrent FIRST messages
 *   from an unknown number, both reaching `INSERT ... members`, is the "two
 *   overlapping ticks" case 0063 calls the ordinary case under load. Fixed at
 *   the call site in ingest_whatsapp_event (0062): the loser's 23505 is caught
 *   and re-resolved through apply_member_lookup rather than raised.
 *
 * The two message ids differ on purpose either way. Idempotency — (provider,
 * external_id) unique on webhook_events (0058) — would already make a
 * REPEATED id safe, and would prove nothing about either race; only two
 * DIFFERENT ids reach the contested code as two genuinely separate attempts.
 */
async function seedPromotionWithIntegration(
  label: string,
  options: { preRegisterListener?: boolean } = {},
): Promise<MessageFixture> {
  const { preRegisterListener = true } = options;
  const customer = await provisionCustomer(label);

  const phoneNumberId = `pnid-${label}`;
  await seedIntegration(customer, phoneNumberId);

  // Members store phones digits-only with no country code (an operator types
  // (11) 99999-0000, stored as 11999990000); WhatsApp delivers the sender
  // WITH the country code. whatsapp_local_phone (0062) strips it, so the two
  // must be the same number in the two different shapes for apply_member_lookup
  // to find (or apply_member_creation to register) the listener this label
  // stands in for.
  const localPhone = '11999990000';
  if (preRegisterListener) {
    await createMemberAs(customer, customer.companyId, {
      fullName: `Race Listener ${label}`,
      phone: localPhone,
    });
  }

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

  return {
    promotionId: promotionId as string,
    organizationId: customer.organizationId,
    localPhone,
    eventA,
    eventB,
    externalIdA,
    externalIdB,
  };
}

interface CrossStationFixture {
  organizationId: string;
  localPhone: string;
  eventA: string;
  eventB: string;
}

/**
 * The race neither fixture above can see: one phone, TWO Stations of the
 * same Organization, each with its own integration, both meeting the number
 * for the first time at once. Fix round 2's own item 1 -- the catch path in
 * ingest_whatsapp_event (0062) resolves the member through apply_member_lookup
 * but, before that fix, never linked it to the LOSER's Station; the winner's
 * apply_member_creation had linked only its own. Unlike the same-Station race,
 * this one is not self-healing within a single admin.rpc call: there is no
 * retry wrapper here the way there is inside the worker, so a missing link
 * surfaces directly as apply_participation's P0002 ("listener not found in
 * this station").
 *
 * Two DIFFERENT promotions, one per Station, sharing a hashtag -- not the same
 * (promotion, member) pair apply_participation's lock arbitrates, so both
 * entries are first entries and both must resolve VALID, not one VALID and
 * one DUPLICATE.
 */
async function seedCrossStationRace(label: string): Promise<CrossStationFixture> {
  const customer = await provisionCustomer(label);
  const companyIdB = await addCompany(customer, `Station B ${label}`);

  const phoneNumberIdA = `pnid-xa-${label}`;
  const phoneNumberIdB = `pnid-xb-${label}`;
  await seedIntegration(customer, phoneNumberIdA);
  await seedIntegration(customer, phoneNumberIdB, companyIdB);

  const localPhone = '11999990003';
  const hashtag = `#${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);

  const owner = await signInAs(customer.email, customer.password);

  const { data: promotionIdA, error: promoAError } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Cross A ${label}`,
    p_starts_at: new Date(Date.now() - HOUR).toISOString(),
    p_ends_at: new Date(Date.now() + HOUR).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: hashtag,
  });
  if (promoAError || !promotionIdA) {
    throw new Error(`create_promotion (Station A) failed: ${promoAError?.message}`);
  }

  const { data: promotionIdB, error: promoBError } = await owner.rpc('create_promotion', {
    p_company_id: companyIdB,
    p_name: `Cross B ${label}`,
    p_starts_at: new Date(Date.now() - HOUR).toISOString(),
    p_ends_at: new Date(Date.now() + HOUR).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: hashtag,
  });
  if (promoBError || !promotionIdB) {
    throw new Error(`create_promotion (Station B) failed: ${promoBError?.message}`);
  }

  const waFrom = `55${localPhone}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const wamidA = `wamid.${label}-crossA`;
  const wamidB = `wamid.${label}-crossB`;

  const payloadFor = (wamid: string, phoneNumberId: string) => ({
    wamid,
    metadata: { phone_number_id: phoneNumberId },
    from: waFrom,
    profile_name: null,
    text: `quero participar ${hashtag}`,
    timestamp,
  });

  const externalIdA = sha256Hex(wamidA);
  const externalIdB = sha256Hex(wamidB);

  const { data: rows, error: eventsError } = await admin
    .from('webhook_events')
    .insert([
      { provider: 'WHATSAPP', external_id: externalIdA, payload: payloadFor(wamidA, phoneNumberIdA) },
      { provider: 'WHATSAPP', external_id: externalIdB, payload: payloadFor(wamidB, phoneNumberIdB) },
    ])
    .select('id, external_id');
  if (eventsError || !rows) {
    throw new Error(`could not seed webhook_events: ${eventsError?.message}`);
  }

  const eventA = rows.find((row) => row.external_id === externalIdA)?.id;
  const eventB = rows.find((row) => row.external_id === externalIdB)?.id;
  if (!eventA || !eventB) {
    throw new Error('seedCrossStationRace: could not resolve both inserted event ids');
  }

  return { organizationId: customer.organizationId, localPhone, eventA, eventB };
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
   * Twelve. Inherited from participations.test.ts:661 as a starting point,
   * then RE-MEASURED here rather than trusted, because that file's own number
   * came from the detection rate of a DIFFERENT path (record_participation)
   * and its own comment insists the number moves from a measurement, never
   * the other way round. This path runs an integration lookup, a hashtag
   * regex, a member lookup and a link before ever reaching the lock, so nine
   * is not the same nine.
   *
   * Measured against this stack, with the lock removed (the same mutation
   * fix round 1's review verifies below): three independent runs, each
   * recording the FIRST round it went red — round 1, round 0, round 1.
   * Never later than round 1 across three runs, so twelve rounds is not
   * merely inherited here either; it is roughly six times what was ever
   * observed needed on this path, and stays at twelve rather than lowered.
   *
   * Do NOT re-run a red result. A round reporting anything other than one
   * VALID and one DUPLICATE is the exact failure the twelve rounds exist to
   * catch.
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

        // Asserted on outcome and status, not a bare count. A count cannot
        // tell the invariant apart from the one failure mode it exists to
        // catch: without the lock, both calls read "no VALID row", both
        // insert, and participations_one_per_member (0052) refuses the loser
        // with a raw 23505 -- which surfaces as a.error/b.error, not as a
        // count of 2, so a count-only assertion would still have passed.
        // participations.test.ts:717-721 settled this same point for the
        // manual door and gives the reason in those words: only the status
        // pair can tell "the lock worked" apart from "the index caught a
        // race the lock should have prevented".
        //
        // Both outcomes must also be 'recorded': ingest_whatsapp_event
        // returns error: null for six non-participating outcomes too
        // (no_integration, no_hashtag, no_promotion, promotion_cancelled,
        // outside_window, and the door's own "skipped"), so a fixture that
        // drifted -- a hashtag regex miss, a window judged against the wrong
        // clock, whatsapp_local_phone's country-code stripping, a
        // phone_number_id typo -- would leave one or both messages exiting
        // through one of those with error: null, and the count below would
        // read 1 from event A alone: a non-race staying green for ever.
        // Asserting outcome is what stops that.
        const results = [a.data, b.data] as Array<{ outcome: string; status: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('recorded');
        }
        expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual([
          'DUPLICATE',
          'VALID',
        ]);

        // Belt-and-braces: the row count agrees with the status pair above.
        const { count, error: countError } = await admin
          .from('participations')
          .select('id', { count: 'exact', head: true })
          .eq('promotion_id', fixture.promotionId)
          .eq('status', 'VALID');
        expect(countError, `round ${round} count query`).toBeNull();
        expect(count, `round ${round} produced ${count} valid entries`).toBe(1);
      }
    },
    180_000,
  );

  /**
   * The race the first fixture deliberately avoids: two concurrent FIRST
   * messages from an UNKNOWN phone. Before the fix in 0062 (Fix round 1),
   * apply_member_creation had no ON CONFLICT of its own -- unlike
   * apply_member_link, a plain INSERT wrapped in a handler that turned a
   * unique_violation into a raised 23505 -- so the loser's admin.rpc call came
   * back with an error unrelated to the lock this file is otherwise about.
   * Two overlapping ticks meeting the same new number at once is not a
   * contrived case: 0063 calls exactly this "the NORMAL case under load".
   *
   * With the fix in place both calls succeed, exactly one members row exists
   * for the phone afterward, and the pair still resolves to one VALID and one
   * DUPLICATE -- the SAME invariant as the race above, now proven reachable
   * from an unknown number too. Same round count as the pre-registered race;
   * mutation-proved by reverting the catch in 0062 (task-13-report.md carries
   * the output).
   */
  it(
    'lets exactly one of two simultaneous messages from an unknown number register the listener once',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedPromotionWithIntegration(`wa-newlistener-${stamp}-${round}`, {
          preRegisterListener: false,
        });

        const [a, b] = await Promise.all([
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventA }),
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventB }),
        ]);

        expect(a.error, `round ${round}, event A`).toBeNull();
        expect(b.error, `round ${round}, event B`).toBeNull();

        const results = [a.data, b.data] as Array<{ outcome: string; status: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('recorded');
        }
        expect(results.map((result) => result.status).sort(), `round ${round}`).toEqual([
          'DUPLICATE',
          'VALID',
        ]);

        // Exactly one members row for this phone, in this Organization —
        // the assertion the fix in 0062 makes true rather than a
        // characterization of the race it used to lose.
        const { count, error: countError } = await admin
          .from('members')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', fixture.organizationId)
          .eq('phone_normalized', fixture.localPhone);
        expect(countError, `round ${round} member count query`).toBeNull();
        expect(count, `round ${round} produced ${count} members`).toBe(1);
      }
    },
    180_000,
  );

  /**
   * Fix round 2, item 1: the catch path resolves the member but, before this
   * fix, never linked them to a Station reached only through the LOSER's
   * event. Two Stations of one Organization racing on the same unknown phone
   * is that exact shape -- the winner's apply_member_creation links only its
   * own Station, so without an explicit link here the loser holds a member id
   * apply_participation refuses with P0002 for its own Station. There is no
   * retry wrapper in this test (unlike the worker), so that refusal surfaces
   * directly as an error rather than self-healing on a second attempt.
   * Mutation-proved by removing the perform apply_member_link call inside the
   * catch (task-13-report.md carries the output).
   */
  it(
    'links the same phone to both Stations when they race on it at once',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedCrossStationRace(`wa-crossstation-${stamp}-${round}`);

        const [a, b] = await Promise.all([
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventA }),
          admin.rpc('ingest_whatsapp_event', { p_event_id: fixture.eventB }),
        ]);

        expect(a.error, `round ${round}, event A`).toBeNull();
        expect(b.error, `round ${round}, event B`).toBeNull();

        // Two DIFFERENT promotions, not a shared (promotion, member) pair, so
        // both are first entries: both VALID, never one DUPLICATE.
        const results = [a.data, b.data] as Array<{ outcome: string; status: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('recorded');
          expect(result.status, `round ${round}`).toBe('VALID');
        }

        // Still one members row: cross-Station is still one Organization, and
        // apply_member_lookup's dedup is Organization-scoped.
        const { count, error: countError } = await admin
          .from('members')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', fixture.organizationId)
          .eq('phone_normalized', fixture.localPhone);
        expect(countError, `round ${round} member count query`).toBeNull();
        expect(count, `round ${round} produced ${count} members`).toBe(1);
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
