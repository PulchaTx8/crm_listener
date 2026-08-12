import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePublicKey } from '@/lib/widget/code';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import type { Conversation } from '@/lib/conversation/steps';
import type { ConversationKey } from '@/lib/conversation/store';
import { parseInboundTurn, runConversationTurn } from '@/services/conversation';
import { updateMember } from '@/services/members';
import {
  admin,
  cleanupUsers,
  createMemberAs,
  provisionCustomer,
  seedIntegration,
  signInAs,
} from './harness';

afterAll(cleanupUsers);

/**
 * The conversation, against a real database, over real HTTP, as the role the
 * worker actually holds.
 *
 * Two questions live here and nowhere else:
 *
 *  1. **Does the lease actually serialise a turn?** It replaced
 *     `pg_advisory_xact_lock` because the engine runs in Node between the load
 *     and the write, and nothing but two genuinely concurrent turns can say
 *     whether the replacement works. Twelve rounds, because one green run does
 *     not prove a probabilistic detector — 4c's lesson.
 *  2. **Do the new grants exist?** Block 5a shipped three tables whose
 *     `service_role` grants did not exist and was non-functional end to end
 *     while every suite passed: pgTAP runs as `postgres` and ignores ACL, and
 *     the route tests mock the client. Every write below crosses that seam.
 *
 * A THIRD QUESTION USED TO LIVE HERE TOO -- "does a whole conversation work,
 * from the hashtag to the entry" -- and Block 19a's design spec D1 retired
 * the contract it was proving, in as many words: "nothing about a song, a
 * promotion or a listener's data is collected over WhatsApp messages any
 * more, full stop." `ingest_whatsapp_event` (0179) never returns a `start`
 * outcome again, so there is no caller, real or synthetic-through-a-real-
 * door, that can put a fresh Q&A conversation into `whatsapp_conversations`
 * any more. Ported forward rather than kept: the two tests that drove a
 * hashtag through consent, a field answer and an entry are GONE (not
 * skipped -- `scripts/verify-isolation-suite.mjs` fails the build on a
 * skip, on purpose, and a green skip is exactly the "faking it green" this
 * repository's own precedent for the identical retirement in pgTAP
 * (`supabase/tests/06_whatsapp.test.sql`, commit 7eb172e) explicitly
 * refused). What that guarantee became lives elsewhere now: a listener
 * answering a promotion's questions happens on the WEB WIDGET
 * (`tests/e2e/widget.spec.ts`'s own Block 17c journey, and
 * `participations.test.ts`), reached from WhatsApp only by way of the LINK
 * this block sends (`tests/e2e/whatsapp-entry.spec.ts`).
 *
 * WHAT THE LEASE STILL PROTECTS, THOUGH, IS UNCHANGED, and the race below is
 * rewritten rather than deleted alongside its old fixture: `runConversationTurn`
 * claims `claim_conversation_turn` for EVERY turn -- link-sending ones
 * included -- before it ever looks at `turn.link` (src/services/conversation.ts).
 * Two hashtag messages from the SAME phone, arriving at the same instant,
 * still race for that one lease exactly as two mid-conversation answers used
 * to, and exactly one of them must win it.
 *
 * TASK 9, FIX ROUND 1 (I1/I2). Deleting the two "whole conversation" tests
 * left a real gap the hashtag race above does not close: nothing any more
 * drove a message against an ALREADY-LIVE conversation at all, so D7's
 * bridge ("a live conversation wins over a new hashtag", the one line the
 * phone-form mismatch of this block's Task 5 briefing broke) was attested
 * only by a unit test with a fake store on one side and a pgTAP assertion on
 * the other -- never their joint, over real HTTP, as the worker actually
 * runs it. And the hashtag race, proving mutual exclusion between two
 * link-sending turns, stopped proving what mutual exclusion is FOR: that
 * serialising a turn is what stops one listener's answer silently
 * overwriting another's, a hazard that survives for every conversation
 * still in flight regardless of how it was opened.
 *
 * Both gaps close through the SAME fixture, `seedLiveConversation`: a
 * conversation written directly through `PostgresConversationStore.save()`,
 * sitting on a FIELD step exactly where a real one would be moments after
 * consent -- because `open()`, the door that used to produce this state, is
 * the retired mechanism this file's header already explains, and writing
 * the row directly is what `advanceLive` itself does not care how it got
 * there, only that it finds one.
 */

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Fixture {
  integrationId: string;
  phoneNumberId: string;
  waFrom: string;
}

/**
 * A Station with a live integration -- nothing about a promotion or a
 * hashtag, because the two tests left that still call this (the privilege
 * boundary describe, below) claim and release a lease and enqueue a message
 * directly, never through `ingest_whatsapp_event`.
 */
async function seedStation(label: string): Promise<Fixture> {
  const customer = await provisionCustomer(label);
  const phoneNumberId = `pnid-${label}`;
  const integrationId = await seedIntegration(customer, phoneNumberId);

  return {
    integrationId,
    phoneNumberId,
    waFrom: `55119${String(Date.now()).slice(-8)}`,
  };
}

interface HashtagFixture {
  companyId: string;
  integrationId: string;
  phoneNumberId: string;
  waFrom: string;
}

const HASHTAG = '#RACEMUSICA';

/**
 * A Station with a live integration, a live widget installation
 * (`mint_widget_link` refuses without one, 0178) and its music hashtag set
 * (0177) -- everything a hashtag needs to reach `sendServiceLink` rather
 * than stall on a fixture gap, so the race below is a race on the LEASE and
 * nothing else.
 */
async function seedHashtagStation(label: string): Promise<HashtagFixture> {
  const customer = await provisionCustomer(label);
  const phoneNumberId = `pnid-${label}`;
  const integrationId = await seedIntegration(customer, phoneNumberId);

  const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
    p_company_id: customer.companyId,
    p_public_key: generatePublicKey(),
    p_enabled: true,
    p_allowed_origins: ['https://conv-lease-race.example'],
  });
  if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);

  const owner = await signInAs(customer.email, customer.password);
  const { error: hashtagError } = await owner.rpc('set_service_hashtags', {
    p_company_id: customer.companyId,
    p_music: HASHTAG,
    p_service: '',
  });
  if (hashtagError) throw new Error(`set_service_hashtags failed: ${hashtagError.message}`);

  return {
    companyId: customer.companyId,
    integrationId,
    phoneNumberId,
    waFrom: `55119${String(Date.now()).slice(-8)}`,
  };
}

/**
 * One inbound hashtag message, stored exactly as the webhook route stores
 * it. Takes only the two fields it ever reads, rather than a specific
 * fixture's full shape, and the hashtag itself as an argument: two
 * different callers below carry two different hashtags (the Station's own
 * music hashtag for the lease race; a promotion's for the D7 fixture), and
 * hard-coding either one would silently send the wrong tag to the other.
 */
async function deliverHashtag(
  fixture: { phoneNumberId: string; waFrom: string },
  wamid: string,
  hashtag: string,
): Promise<{ eventId: string }> {
  const { data, error } = await admin
    .from('webhook_events')
    .insert({
      provider: 'WHATSAPP',
      external_id: sha256Hex(wamid),
      payload: {
        wamid,
        metadata: { phone_number_id: fixture.phoneNumberId },
        from: fixture.waFrom,
        profile_name: null,
        text: `quero uma musica ${hashtag}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`could not deliver a message: ${error?.message}`);
  return { eventId: data.id };
}

const HOUR = 60 * 60 * 1000;

interface LiveConversationFixture {
  integrationId: string;
  phoneNumberId: string;
  /** The phone AS WHATSAPP DELIVERED IT -- what the store is keyed on (D7). */
  waFrom: string;
  promotionId: string;
  memberId: string;
  hashtag: string;
}

/**
 * Task 9, fix round 1 (I1/I2). A live conversation, sitting on the FIRST
 * field step -- [consent, field:city, field:neighbourhood], cursor 1 --
 * exactly where a real one sits moments after the listener presses "yes".
 * Written directly through `PostgresConversationStore.save()` rather than
 * through `open()`, which no caller can reach any more (this file's own
 * header). `advanceLive` does not care how a conversation got into
 * `whatsapp_conversations`, only that one is there when it looks -- the
 * same property that makes writing the row directly a faithful fixture and
 * not a shortcut around what is actually under test.
 *
 * The promotion still carries a hashtag and rules text, and the Station
 * still gets a widget installation, even though neither test using this
 * fixture ever expects a link to be sent -- I1 is exactly the assertion
 * that one is NOT sent, and proving that means the hashtag has to be one
 * that WOULD have produced a link had no conversation been live.
 */
async function seedLiveConversation(label: string): Promise<LiveConversationFixture> {
  const customer = await provisionCustomer(label);
  const phoneNumberId = `pnid-${label}`;
  const integrationId = await seedIntegration(customer, phoneNumberId);

  const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
    p_company_id: customer.companyId,
    p_public_key: generatePublicKey(),
    p_enabled: true,
    p_allowed_origins: ['https://conv-live.example'],
  });
  if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);

  const hashtag = `#${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);
  const owner = await signInAs(customer.email, customer.password);
  const { data: promotionId, error: promoError } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Live ${label}`,
    p_starts_at: new Date(Date.now() - HOUR).toISOString(),
    p_ends_at: new Date(Date.now() + HOUR).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: hashtag,
    p_requested_fields: ['city', 'neighbourhood'],
    p_rules: `Live rules ${label}`,
  });
  if (promoError || !promotionId) throw new Error(`create_promotion failed: ${promoError?.message}`);

  const localPhone = '11999990066';
  const waFrom = `55${localPhone}`;
  const memberId = await createMemberAs(customer, customer.companyId, {
    fullName: `Live Listener ${label}`,
    phone: localPhone,
  });

  const key: ConversationKey = { integrationId, phone: waFrom };
  const conversation: Conversation = {
    integrationId,
    phone: waFrom,
    promotionId: promotionId as string,
    memberId,
    steps: [
      { kind: 'consent' },
      { kind: 'field', field: 'city' },
      { kind: 'field', field: 'neighbourhood' },
    ],
    cursor: 1,
    answers: { fields: {}, questions: [] },
    reprompts: 0,
    // Overwritten by the store's own save() (store.ts: "the expiresAt on
    // the value handed in is ignored and replaced"), so this value is
    // never actually trusted -- present only because the type requires it.
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  await new PostgresConversationStore(admin).save(key, conversation);

  return {
    integrationId,
    phoneNumberId,
    waFrom,
    promotionId: promotionId as string,
    memberId,
    hashtag,
  };
}

/** One inbound message carrying plain text -- an answer, never a hashtag. */
async function deliverText(
  fixture: LiveConversationFixture,
  wamid: string,
  text: string,
): Promise<{ eventId: string }> {
  const { data, error } = await admin
    .from('webhook_events')
    .insert({
      provider: 'WHATSAPP',
      external_id: sha256Hex(wamid),
      payload: {
        wamid,
        metadata: { phone_number_id: fixture.phoneNumberId },
        from: fixture.waFrom,
        profile_name: null,
        text,
        timestamp: String(Math.floor(Date.now() / 1000)),
      },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`could not deliver a message: ${error?.message}`);
  return { eventId: data.id };
}

describe('D7 — a live conversation wins over a new hashtag', () => {
  it('a hashtag arriving mid-conversation re-prompts instead of sending a link', async () => {
    const fixture = await seedLiveConversation(`conv-d7-${Date.now()}`);

    // The SAME hashtag ingest_whatsapp_event would otherwise turn into a
    // link intent -- proving D7 means proving THIS message, unresolved any
    // other way, still does not reach sendServiceLink.
    const delivered = await deliverHashtag(
      fixture,
      `wamid.d7-${Date.now()}`,
      fixture.hashtag,
    );

    const opened = await admin.rpc('ingest_whatsapp_event', {
      p_event_id: delivered.eventId,
      p_window_seconds: 1800,
    });
    if (opened.error) throw new Error(`ingest failed: ${opened.error.message}`);
    // The DOOR still has no idea a conversation is live -- D7's bridge lives
    // entirely in Node (runConversationTurn), so ingest_whatsapp_event
    // matches the hashtag exactly as it would for any other listener and
    // hands back a link intent.
    expect((opened.data as { outcome: string }).outcome).toBe('link');

    const store = new PostgresConversationStore(admin);
    const outcome = await runConversationTurn({ supabase: admin, store }, parseInboundTurn(opened.data));

    // NOT 'link_sent'. `store.load(key)` finds the live conversation FIRST
    // (runConversationTurn's own branch order) and calls advanceLive
    // instead of sendServiceLink. The hashtag text reaches the engine as an
    // (empty, since a link intent carries no text) answer to the 'city'
    // field, which validateField refuses, and the engine re-prompts --
    // 'prompted' is the one outcome that could only be produced by the live
    // conversation actually being read and advanced.
    expect(outcome.kind).toBe('prompted');

    // AND NO LINK WAS SENT. This is the other half of the same guarantee:
    // a listener mid-conversation must never be handed a link that would
    // abandon what they already typed.
    const { count, error: countError } = await admin
      .from('outbox_messages')
      .select('id', { count: 'exact', head: true })
      .eq('to_phone', fixture.waFrom)
      .like('dedupe_key', '%:link');
    expect(countError).toBeNull();
    expect(count, 'no link was sent while a conversation is live').toBe(0);

    // The conversation is still there, still on the city step -- a
    // re-prompt does not advance the cursor and does not clear the state.
    const { data: live } = await admin
      .from('whatsapp_conversations')
      .select('state')
      .eq('integration_id', fixture.integrationId)
      .eq('phone', fixture.waFrom)
      .single();
    const state = live?.state as { cursor: number };
    expect(state?.cursor, 'still waiting on the same field').toBe(1);
  });
});

/**
 * TWELVE ROUNDS, and the number is the assertion. A lock that is right nine
 * times out of ten passes a single run, and 4c settled that a probabilistic
 * detector run once proves nothing.
 */
const RACE_ROUNDS = 12;

describe('two answers at once, on a live conversation', () => {
  it(
    'advances the cursor exactly once when a listener double-sends -- the lost-update hazard the lease exists for',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedLiveConversation(`conv-lostupdate-${stamp}-${round}`);

        const a = await deliverText(fixture, `wamid.lostupdate-${stamp}-${round}-a`, 'Canoas');
        const b = await deliverText(fixture, `wamid.lostupdate-${stamp}-${round}-b`, 'Gravatai');

        // Both ingested first, so the contested resource is the TURN's
        // lease and not the event row's own FOR UPDATE SKIP LOCKED --
        // which would serialise them for a different reason and prove
        // nothing about the lease.
        const [openedA, openedB] = await Promise.all([
          admin.rpc('ingest_whatsapp_event', { p_event_id: a.eventId, p_window_seconds: 1800 }),
          admin.rpc('ingest_whatsapp_event', { p_event_id: b.eventId, p_window_seconds: 1800 }),
        ]);
        expect(openedA.error, `round ${round}, message A`).toBeNull();
        expect(openedB.error, `round ${round}, message B`).toBeNull();

        const store = new PostgresConversationStore(admin);
        const outcomes = await Promise.all([
          runConversationTurn({ supabase: admin, store }, parseInboundTurn(openedA.data)),
          runConversationTurn({ supabase: admin, store }, parseInboundTurn(openedB.data)),
        ]);

        // EXACTLY ONE of the two runs the turn. The other finds the lease
        // held and leaves its message for the next tick -- not dropped,
        // and not waited on.
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy');
        expect(busy, `round ${round}: ${JSON.stringify(outcomes)}`).toHaveLength(1);

        // THE HAZARD ITSELF: the state moved exactly one step, one answer
        // stored, cursor on the second field. Without the lease both turns
        // read cursor 1, both write cursor 2, and one listener's answer --
        // 'Canoas' or 'Gravatai', whichever lost -- is overwritten in
        // silence, with nothing on any screen saying so.
        const { data: live } = await admin
          .from('whatsapp_conversations')
          .select('state')
          .eq('integration_id', fixture.integrationId)
          .eq('phone', fixture.waFrom)
          .single();
        const state = live?.state as { cursor: number; answers: { fields: Record<string, string> } };
        expect(state?.cursor, `round ${round} cursor`).toBe(2);
        expect(Object.keys(state?.answers.fields ?? {}), `round ${round} answers`).toEqual(['city']);
      }
    },
    300_000,
  );
});

describe('two hashtag messages at once', () => {
  it(
    'lets exactly one of two simultaneous messages from the same phone send the link',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedHashtagStation(`conv-lease-race-${stamp}-${round}`);

        const a = await deliverHashtag(fixture, `wamid.lease-race-${stamp}-${round}-a`, HASHTAG);
        const b = await deliverHashtag(fixture, `wamid.lease-race-${stamp}-${round}-b`, HASHTAG);

        // Both ingested first, so the contested resource is the TURN's lease
        // and not the event row's own FOR UPDATE SKIP LOCKED -- which would
        // serialise them for a different reason and prove nothing about the
        // lease `runConversationTurn` claims before it ever looks at
        // `turn.link`.
        const [openedA, openedB] = await Promise.all([
          admin.rpc('ingest_whatsapp_event', { p_event_id: a.eventId, p_window_seconds: 1800 }),
          admin.rpc('ingest_whatsapp_event', { p_event_id: b.eventId, p_window_seconds: 1800 }),
        ]);
        expect(openedA.error, `round ${round}, message A`).toBeNull();
        expect(openedB.error, `round ${round}, message B`).toBeNull();

        const store = new PostgresConversationStore(admin);
        const outcomes = await Promise.all([
          runConversationTurn({ supabase: admin, store }, parseInboundTurn(openedA.data)),
          runConversationTurn({ supabase: admin, store }, parseInboundTurn(openedB.data)),
        ]);

        // EXACTLY ONE of the two runs the turn and sends the link. The other
        // finds the lease held and leaves its message for the next tick --
        // not dropped, and not waited on. This is the lease's own guarantee,
        // not D2's two-minute window: two turns racing for the SAME lease
        // never both reach `mint_widget_link` at all, so the loser here is
        // 'busy', never 'already_answered' (which is what a SEQUENTIAL
        // repeat inside two minutes would answer instead -- a different
        // guard, proved in tests/isolation/widget.test.ts and 44_service_
        // hashtags.test.sql, not this one).
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy');
        const sent = outcomes.filter((outcome) => outcome.kind === 'link_sent');
        expect(busy, `round ${round}: ${JSON.stringify(outcomes)}`).toHaveLength(1);
        expect(sent, `round ${round}: ${JSON.stringify(outcomes)}`).toHaveLength(1);

        // And only ONE message actually reached the outbox. Without the
        // lease both turns would read "no live link" and both mint and
        // enqueue their own, and this count would read 2 -- a listener
        // charged their Station twice for one hashtag.
        const { count, error: countError } = await admin
          .from('outbox_messages')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', fixture.companyId)
          .eq('to_phone', fixture.waFrom)
          .like('dedupe_key', '%:link');
        expect(countError, `round ${round} count query`).toBeNull();
        expect(count, `round ${round} sent ${count} link(s) for one race`).toBe(1);
      }
    },
    300_000,
  );
});

describe('the privilege boundary pgTAP cannot see', () => {
  it('lets the worker take, hold and release a turn lease as service_role', async () => {
    const fixture = await seedStation(`conv-lease-${Date.now()}`);

    const first = await admin.rpc('claim_conversation_turn', {
      p_integration_id: fixture.integrationId,
      p_phone: fixture.waFrom,
      p_stale_after: '5 minutes',
    });
    expect(first.error).toBeNull();
    expect(first.data).not.toBeNull();

    const second = await admin.rpc('claim_conversation_turn', {
      p_integration_id: fixture.integrationId,
      p_phone: fixture.waFrom,
      p_stale_after: '5 minutes',
    });
    expect(second.error).toBeNull();
    expect(second.data, 'a live lease is not handed to a second worker').toBeNull();

    const released = await admin.rpc('release_conversation_turn', {
      p_integration_id: fixture.integrationId,
      p_phone: fixture.waFrom,
      p_token: first.data as string,
    });
    expect(released.error).toBeNull();
  });

  it('lets the worker enqueue and sweep as service_role', async () => {
    const fixture = await seedStation(`conv-enqueue-${Date.now()}`);

    const enqueued = await admin.rpc('enqueue_whatsapp_outbound', {
      p_integration_id: fixture.integrationId,
      p_to_phone: fixture.waFrom,
      p_body: 'Quer participar?',
      p_interactive: {
        kind: 'buttons',
        body: 'Quer participar?',
        imageUrl: null,
        buttons: [{ id: 'consent_yes', title: 'Quero!' }],
      },
      p_dedupe_key: `${sha256Hex(`boundary-${Date.now()}`)}:consent`,
    });
    // outbox_messages holds no INSERT grant for service_role: every row in it
    // is written from inside a SECURITY DEFINER body, and this door is the
    // conversation's. A missing grant here is 5a's defect exactly.
    expect(enqueued.error).toBeNull();
    expect(enqueued.data).not.toBeNull();

    const swept = await admin.rpc('sweep_expired_conversations');
    expect(swept.error).toBeNull();
  });
});

describe("an operator's save, and the freshness record behind it", () => {
  /**
   * Spec §9, through the real RPC as a real signed-in user.
   *
   * The actor here is the OWNER, which this suite otherwise avoids for the
   * reason Block 1c's report gives — an owner's bypass hides a delegate's
   * failure. It is right here because what is under test is the comparison
   * inside update_member and not who may reach it: record.test.ts already
   * drives this same RPC as a non-owner delegate, and that is where the
   * permission question lives.
   */
  /**
   * D3, at the door that types a NEW listener.
   *
   * The gap this closes was found by the case below it: the backfill covered
   * every record that existed, update_member covers every save, and
   * create_member wrote nothing — so a record typed today had the bot asking
   * that listener for data the operator had entered an hour earlier.
   */
  it('confirms what an operator typed when the record is created', async () => {
    const customer = await provisionCustomer(`conv-create-${Date.now()}`);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Recem Digitado',
      passport: `PS${String(Date.now()).slice(-8)}`,
    });

    const { data: rows, error } = await admin
      .from('member_field_confirmations')
      .select('field, confirmed_at')
      .eq('member_id', memberId);
    expect(error).toBeNull();

    const fields = rows?.map((row) => row.field).sort();
    expect(fields, 'the two fields the operator filled are confirmed').toEqual([
      'full_name',
      'passport',
    ]);
    // Nothing else: a field nobody typed is not confirmed by the act of saving
    // a form that had a box for it.
    expect(fields).not.toContain('city');
    expect(Date.parse(rows?.[0]?.confirmed_at ?? ''), 'as of now').toBeGreaterThan(
      Date.now() - 60_000,
    );
  });

  it('refreshes only the fields whose value actually moved', async () => {
    const customer = await provisionCustomer(`conv-save-${Date.now()}`);
    const memberId = await createMemberAs(customer, customer.companyId, {
      fullName: 'Ouvinte Operador',
    });

    // The three fields this case is about. createMemberAs takes only the
    // identifying ones, so they are written the way an earlier save would have
    // left them -- which is also the state a conversation leaves behind.
    await admin
      .from('members')
      .update({ city: 'Canoas', neighbourhood: 'Centro' })
      .eq('id', memberId);
    await admin.from('member_field_confirmations').insert([
      { member_id: memberId, organization_id: customer.organizationId, field: 'full_name' },
      { member_id: memberId, organization_id: customer.organizationId, field: 'city' },
      { member_id: memberId, organization_id: customer.organizationId, field: 'neighbourhood' },
    ]);

    // Ages every confirmation the creation left behind, so a refresh is
    // visible as a change of date rather than as a row appearing.
    await admin
      .from('member_field_confirmations')
      .update({ confirmed_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() })
      .eq('member_id', memberId);

    const owner = await signInAs(customer.email, customer.password);
    const {
      data: { session },
    } = await owner.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('could not read the owner access token');

    // The city moves, the neighbourhood is cleared, the name is retyped exactly
    // as it was — which is what most saves look like.
    await updateMember(
      {
        memberId,
        fullName: 'Ouvinte Operador',
        city: 'Gravatai',
      },
      token,
    );

    const { data: rows, error } = await admin
      .from('member_field_confirmations')
      .select('field, confirmed_at')
      .eq('member_id', memberId);
    expect(error).toBeNull();

    const byField = new Map(rows?.map((row) => [row.field, Date.parse(row.confirmed_at)]));
    const aMinuteAgo = Date.now() - 60_000;

    expect(byField.get('city'), 'the changed field is confirmed again').toBeGreaterThan(aMinuteAgo);
    // THE ONE THIS CASE EXISTS FOR. Retyping a value identically is not
    // confirming it: refresh everything on every save and the bot stops asking
    // exactly the listeners staff handle most.
    expect(byField.get('full_name'), 'an unchanged field keeps its own date').toBeLessThan(
      aMinuteAgo,
    );
    expect(byField.has('neighbourhood'), 'a field cleared to blank loses its confirmation').toBe(
      false,
    );
  });
});
