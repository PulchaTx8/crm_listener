import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePublicKey } from '@/lib/widget/code';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import type { Json } from '@/lib/supabase/database.types';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import { parseInboundTurn, runConversationTurn } from '@/services/conversation';
import { runTick } from '@/services/whatsapp';
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
  /** Digits-only, no country code — the shape an OPERATOR types into a ficha. */
  localPhone: string;
  /**
   * The same number as WhatsApp delivers it, country code and all — and since
   * Block 30d (D4, 0267) the shape members.phone_normalized holds for a
   * listener the BOT registered. international_phone either leaves the
   * delivered digits alone or puts a '+' in front of them, and
   * phone_normalized strips the plus, so this is that column's value whatever
   * country the Station carries.
   */
  deliveredPhone: string;
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

  // Block 19a. A live widget installation, or `mint_widget_link` (0178) --
  // reached the instant a hashtag matches, whatever it matches -- refuses
  // with "this Station has no live widget installation" (P0002) before the
  // race this fixture exists to provoke is even in play. Through the real
  // door, as the platform admin it is gated on, the same pattern
  // tests/isolation/widget.test.ts's own seedWidgetStation uses.
  const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
    p_company_id: customer.companyId,
    p_public_key: generatePublicKey(),
    p_enabled: true,
    p_allowed_origins: ['https://race.example'],
  });
  if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);

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
    // Block 19a (0179). Rules text is what keeps a first, eligible message
    // finishing as `link` rather than `no_rules` -- without it,
    // ingest_whatsapp_event never reaches the member race this fixture
    // exists to provoke; it returns `no_rules` straight from the rules
    // check, before either concurrent call's outcome matters at all.
    p_rules: `Race rules ${label}`,
    // Block 30d (D8, 0267). A promotion with nothing left to ask of THIS
    // listener is entered the moment the hashtag arrives -- outcome
    // `recorded`, no link intent and no turn for the caller to run. Every case
    // below is about the link path, or about the member race that happens on
    // the way to it, so one requested field is what keeps this fixture on that
    // path. `city` and not `full_name`: apply_member_creation fills full_name
    // from the WhatsApp profile name, so a newcomer would satisfy that one on
    // arrival and the fast path would take the message anyway. The fast path
    // itself is covered by supabase/tests/73_fast_entry.test.sql.
    p_requested_fields: ['city'],
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
    deliveredPhone: waFrom,
    eventA,
    eventB,
    externalIdA,
    externalIdB,
  };
}

interface CrossStationFixture {
  organizationId: string;
  localPhone: string;
  /** See MessageFixture.deliveredPhone: what the bot stores since 0267. */
  deliveredPhone: string;
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

  // Block 19a -- see seedPromotionWithIntegration's own comment. Both
  // Stations need a live installation: each carries its own promotion and
  // its own hashtag match, so each reaches mint_widget_link independently.
  for (const companyId of [customer.companyId, companyIdB]) {
    const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
      p_company_id: companyId,
      p_public_key: generatePublicKey(),
      p_enabled: true,
      p_allowed_origins: ['https://race.example'],
    });
    if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);
  }

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
    // Block 19a (0179) -- see seedPromotionWithIntegration's own comment.
    p_rules: `Cross A rules ${label}`,
    // Block 30d (D8, 0267) -- likewise, and for the same reason: without a
    // requested field both messages are entries rather than link intents.
    p_requested_fields: ['city'],
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
    p_rules: `Cross B rules ${label}`,
    p_requested_fields: ['city'],
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

  return { organizationId: customer.organizationId, localPhone, deliveredPhone: waFrom, eventA, eventB };
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
    'lets two simultaneous messages open the conversation and enter nobody',
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
        // CONVERTED FOR BLOCK 5b, not weakened, and CONVERTED AGAIN FOR BLOCK
        // 19a (0179). The door no longer writes an entry, so "one VALID and
        // one DUPLICATE" was never a fact about this path from Block 5b
        // onward -- the entry is written at the END of a conversation, and the
        // double-send race that used to live here is a race between two
        // TURNS, serialised by the lease and proved in the conversation
        // suite. 0179 then retired the door opening a conversation AT ALL: a
        // matched hashtag now returns an INTENTION to send a link, decided by
        // the caller, and 'link' is what a first, eligible message reaches --
        // reachable only because the fixture carries rules text
        // (seedPromotionWithIntegration's own comment); without it every
        // round would finish 'no_rules' before either call's outcome could
        // tell a race from a non-race apart.
        //
        // What this fixture still proves, and what still fails loudly if the
        // fixture drifts: both messages are decided, both on the link path
        // rather than by one of the six silent outcomes that also return
        // error: null, and NOBODY is entered by a message nobody has answered
        // yet. That last one is the block's central promise, and it is
        // unmoved by which outcome carries it.
        const results = [a.data, b.data] as Array<{ outcome: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('link');
        }

        const { count, error: countError } = await admin
          .from('participations')
          .select('id', { count: 'exact', head: true })
          .eq('promotion_id', fixture.promotionId);
        expect(countError, `round ${round} count query`).toBeNull();
        expect(count, `round ${round} wrote ${count} entries for an unanswered question`).toBe(0);
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
    'registers an unknown listener exactly once when two of their messages arrive at once',
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

        // The registration is what this fixture is for, and it is untouched
        // by Block 5b or by 19a's 0179: the listener is resolved or created
        // BEFORE either a conversation or a link intent is assembled, so two
        // first messages from one stranger still meet inside
        // apply_member_creation. 'link' rather than 'conversation' for the
        // same reason the fixture above gives -- 0179 retired the outcome
        // this assertion used to name.
        const results = [a.data, b.data] as Array<{ outcome: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('link');
        }

        // Exactly one members row for this phone, in this Organization —
        // the assertion the fix in 0062 makes true rather than a
        // characterization of the race it used to lose.
        //
        // ON THE DELIVERED FORM since Block 30d (D4, 0267): this listener is
        // registered by the door itself, and the door writes
        // international_phone's answer now instead of whatsapp_local_phone's.
        // The exact stored spelling is pinned in
        // supabase/tests/73_fast_entry.test.sql; what matters here is that one
        // number is one row.
        const { count, error: countError } = await admin
          .from('members')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', fixture.organizationId)
          .eq('phone_normalized', fixture.deliveredPhone);
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

        // Two DIFFERENT promotions at two Stations of one Organization, so
        // both messages return a link intent of their own -- 'link' rather
        // than 'conversation' since 0179 (Block 19a) retired the latter.
        const results = [a.data, b.data] as Array<{ outcome: string }>;
        for (const result of results) {
          expect(result.outcome, `round ${round}`).toBe('link');
        }

        // Still one members row: cross-Station is still one Organization, and
        // apply_member_lookup's dedup is Organization-scoped. On the delivered
        // form for the reason the race above gives (Block 30d, D4).
        const { count, error: countError } = await admin
          .from('members')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', fixture.organizationId)
          .eq('phone_normalized', fixture.deliveredPhone);
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
    // 'INSERT') is false. Every row in it is written from inside a SECURITY
    // DEFINER body, so the two real rows this case needs are produced by
    // driving two real link sends through enqueue_whatsapp_outbound — a door
    // added in Block 5b with a grant of its own, and therefore exactly the
    // kind of thing that was missing three times in 5a. Sequential, not
    // concurrent; this case is not the race, it only needs two real rows to
    // update.
    //
    // TWO SEPARATE FIXTURES, not one fixture's two messages. Since 0179
    // (Block 19a) the door no longer opens a conversation for a second
    // message from the same phone — it re-matches the SAME promotion's
    // hashtag and mints a SECOND link, which mint_widget_link's own D2
    // window (member, purpose, promotion) would answer with `null` ("say
    // nothing, this listener already has a working link") for a message
    // arriving this close behind the first. Two independent listeners is
    // what still produces two real rows.
    const fixtureA = await seedPromotionWithIntegration(`wa-outbox-priv-a-${Date.now()}`);
    const fixtureB = await seedPromotionWithIntegration(`wa-outbox-priv-b-${Date.now()}`);

    // The door, then the turn — the two halves of the real path, driven
    // directly rather than through runTick so that these fixtures' own
    // messages are the ones that produce the rows, whatever else the local
    // stack happens to be holding. Only the first event of each fixture is
    // needed; the second is left untouched.
    const store = new PostgresConversationStore(admin);
    for (const fixture of [fixtureA, fixtureB]) {
      const opened = await admin.rpc('ingest_whatsapp_event', {
        p_event_id: fixture.eventA,
        p_window_seconds: 1800,
      });
      if (opened.error) throw new Error(`seed ingestion failed: ${opened.error.message}`);
      await runConversationTurn({ supabase: admin, store }, parseInboundTurn(opened.data));
    }

    // ':link', on both — one row per listener, addressed by the phone that
    // asked (src/services/whatsapp-link.ts's own dedupe key).
    const dedupeKeyA = `${fixtureA.externalIdA}:link`;
    const dedupeKeyB = `${fixtureB.externalIdA}:link`;
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
    // Kept for the RPC surface alone. The two `runTick` cases below drive the
    // same three calls plus every PostgREST WRITE the worker performs, per row,
    // which these three cannot: an RPC that returns an empty set exercises the
    // grant on the function and nothing beyond it.
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

/**
 * `runTick` itself, against the real database, over real HTTP, as `service_role`
 * — and this is a different question from every case above it.
 *
 * The cases above call `ingest_whatsapp_event` directly and then perform the
 * worker's writes by hand, in shapes copied from `src/services/whatsapp.ts`.
 * That proves the shapes were legal when they were copied. It cannot notice the
 * worker growing a resource embed on a table with no grant (the third of this
 * block's three boundary defects, closed only by circumstance), a call to an RPC
 * nobody granted, or a settle patch that writes one column too many for a CHECK.
 * Driving the function itself is what asks the question the three defects were
 * all answers to: does what the worker ACTUALLY sends work, as the role it
 * actually holds?
 *
 * These two cases between them execute every statement a tick issues: the three
 * RPCs, the SENT settle, the failure settle onto the backoff ladder, and
 * `deferEvent`'s write. The last two run only when a queue is non-empty and are
 * the deferred minor Task 13 left open.
 */
describe('a whole tick, over the wire', () => {
  /**
   * Everything in the queues except the named events is put beyond this tick's
   * reach, and without it `ingested` and `sent` are counts of whatever the
   * database happens to be holding.
   *
   * `due_whatsapp_events` and `claim_outbox_batch` carry NO tenant scope, by
   * design — the worker drains the installation, not a Station — and this suite
   * commits rows that outlive it (report §1.1): every race above leaves DONE
   * events and un-drained PENDING replies behind, and so does every previous
   * run against the same local stack. Parking them is not cleanup for its own
   * sake; it is what makes an exact count mean something.
   *
   * Both statements are writes `service_role` is granted (0058, 0059). Nothing
   * here reaches for the superuser connection: a quiesce that needed privileges
   * the worker does not hold would be a fixture the worker could not have
   * produced.
   */
  async function quiesceQueues(keepEventIds: string[]): Promise<void> {
    const events = await admin
      .from('webhook_events')
      .update({ next_attempt_at: 'infinity' })
      .in('status', ['RECEIVED', 'FAILED', 'PROCESSING'])
      .not('id', 'in', `(${keepEventIds.join(',')})`);
    if (events.error) {
      throw new Error(`could not quiesce webhook_events: ${events.error.message}`);
    }

    // PENDING *and* SENDING: the tick reclaims abandoned claims before it
    // drains anything, so a stale SENDING row left by an earlier run would come
    // back as PENDING inside the very tick under test and be sent.
    const outbox = await admin
      .from('outbox_messages')
      .update({ status: 'FAILED', last_error: 'quiesced by the runTick isolation case' })
      .in('status', ['PENDING', 'SENDING']);
    if (outbox.error) {
      throw new Error(`could not quiesce outbox_messages: ${outbox.error.message}`);
    }
  }

  it('decides one event and sends its reply, as the role and over the transport it really uses', async () => {
    const fixture = await seedPromotionWithIntegration(`wa-tick-${Date.now()}`);
    await quiesceQueues([fixture.eventA]);

    const transport = new FakeTransport();
    const result = await runTick({ supabase: admin, transport });

    // FIRST, and not as a footnote: a tick in which every database call failed
    // returns 200 with an all-zero body, so `dbErrors` is the only field that
    // tells "nothing to do" from "nothing worked" (src/services/whatsapp.ts).
    // Asserting it before the counts means a missing grant reads as itself
    // rather than as "ingested 0".
    expect(result.dbErrors, 'every database call the tick made succeeded').toBe(0);

    // `turns`, not `ingested`: since Block 5b the door hands a matched
    // hashtag back to the caller and the TURN decides it, so a tick that
    // reported an ingestion here would be reporting a decision nobody made.
    // Since 0179 (Block 19a) that decision is never "open a conversation" --
    // it is `sendServiceLink`, reached because `turn.link` is set and no
    // live conversation exists for this phone (D7).
    expect(result.turns).toBe(1);
    expect(result.turnsBusy).toBe(0);
    expect(result.eventsFailed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.sent).toBe(1);
    expect(result.sendFailed).toBe(0);

    // AND IT WENT OUT AS PLAIN TEXT CARRYING THE LINK. This is the one
    // assertion in the repository that crosses the whole Block 19a send path
    // end to end: `sendServiceLink` minted a code, built the URL
    // (src/lib/widget/service-link.ts), the enqueue door stored it with
    // `p_interactive: null`, `claim_outbox_batch` handed the payload back,
    // and the transport sent it as a text body rather than as buttons --
    // unlike the consent message this path replaced, a link needs no reply
    // Meta could turn into an interactive answer.
    expect(transport.sentInteractive).toHaveLength(0);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.to).toBe(`55${fixture.localPhone}`);
    expect(transport.sent[0]?.body).toMatch(/\/enter\?k=/);

    // The settle write, read back. outbox_messages_sent_shape (0059) makes SENT
    // a claim about sent_at and external_id together, so this is the assertion
    // that a patch which moved one of the three without the others — a 23514 in
    // production — did not happen. ':link', not ':consent': 0179 retired the
    // conversation this dedupe suffix used to name (src/services/whatsapp-link.ts).
    const { data: row, error } = await admin
      .from('outbox_messages')
      .select('status, external_id, sent_at, attempts')
      .eq('dedupe_key', `${fixture.externalIdA}:link`)
      .single();
    expect(error).toBeNull();
    expect(row?.status).toBe('SENT');
    expect(row?.external_id).toBe('wamid.FAKE1');
    expect(row?.sent_at).not.toBeNull();
    expect(row?.attempts).toBe(1);
  });

  it('defers an event that raised and puts a failed send back on the ladder', async () => {
    const fixture = await seedPromotionWithIntegration(`wa-tick-fail-${Date.now()}`);

    // Event A loses its `timestamp`, which makes ingest_whatsapp_event RAISE
    // (0062) rather than file a malformed message under a plausible outcome.
    // That is the only way to reach deferEvent, and deferEvent's patch is the
    // one webhook_events_done_shape refuses if it carries an outcome or a
    // processed_at — a 23514 that no test in this repository could see before,
    // because nothing drove the worker against a real database.
    const { data: seeded, error: readError } = await admin
      .from('webhook_events')
      .select('payload')
      .eq('id', fixture.eventA)
      .single();
    if (readError || !seeded?.payload) {
      throw new Error(`could not read the seeded payload: ${readError?.message}`);
    }
    const withoutTimestamp = Object.fromEntries(
      Object.entries(seeded.payload as Record<string, unknown>).filter(
        ([key]) => key !== 'timestamp',
      ),
    ) as Json;
    const corrupted = await admin
      .from('webhook_events')
      .update({ payload: withoutTimestamp })
      .eq('id', fixture.eventA);
    if (corrupted.error) {
      throw new Error(`could not corrupt the seeded payload: ${corrupted.error.message}`);
    }

    await quiesceQueues([fixture.eventA, fixture.eventB]);

    const transport = new FakeTransport();
    transport.failNext(true);
    const result = await runTick({ supabase: admin, transport });

    expect(result.dbErrors, 'every database call the tick made succeeded').toBe(0);
    // The good message is a link-send turn now, not an ingestion (0179).
    expect(result.turns).toBe(1);
    expect(result.eventsFailed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.sendFailed).toBe(1);
    expect(result.sendAborted).toBe(false);

    const { data: deferred, error: deferredError } = await admin
      .from('webhook_events')
      .select('status, attempts, last_error, next_attempt_at, outcome, processed_at')
      .eq('id', fixture.eventA)
      .single();
    expect(deferredError).toBeNull();
    expect(deferred?.status).toBe('FAILED');
    expect(deferred?.attempts).toBe(1);
    expect(deferred?.last_error).toMatch(/timestamp/i);
    // Scheduled, not parked: one rung of the ladder, with four left.
    expect(deferred?.next_attempt_at).not.toBe('infinity');
    // FAILED means "try again" (0058), so neither of these may be written.
    expect(deferred?.outcome).toBeNull();
    expect(deferred?.processed_at).toBeNull();

    const { data: settled, error: settledError } = await admin
      .from('outbox_messages')
      .select('status, attempts, last_error, external_id, sent_at')
      // ':link', because what event B produced is the message that carries
      // the widget link (0179 retired ':consent' along with the conversation
      // it opened). The ladder does not care which kind of message it is
      // retrying, and that is the point of asserting it on this one.
      .eq('dedupe_key', `${fixture.externalIdB}:link`)
      .single();
    expect(settledError).toBeNull();
    // Retryable, so PENDING with a future next_attempt_at — never FAILED, which
    // on this side is terminal and outside the sendable scan (0059).
    expect(settled?.status).toBe('PENDING');
    expect(settled?.attempts).toBe(1);
    expect(settled?.last_error).toBe('fake failure');
    // Untouched on a row that is not SENT, which outbox_messages_sent_shape
    // requires of every status but that one.
    expect(settled?.external_id).toBeNull();
    expect(settled?.sent_at).toBeNull();
  });
});
