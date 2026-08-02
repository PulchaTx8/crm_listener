import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CONSENT_YES_ID } from '@/lib/conversation/engine';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import { parseInboundTurn, runConversationTurn } from '@/services/conversation';
import { runTick } from '@/services/whatsapp';
import type { Enums } from '@/lib/supabase/database.types';
import { admin, cleanupUsers, provisionCustomer, seedIntegration, signInAs } from './harness';

afterAll(cleanupUsers);

/**
 * The conversation, against a real database, over real HTTP, as the role the
 * worker actually holds.
 *
 * Three questions live here and nowhere else:
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
 *  3. **Does a whole conversation work?** From the hashtag to the entry,
 *     through the real tick, with the answers on the record and the
 *     confirmations behind them.
 */

const HOUR = 60 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Fixture {
  promotionId: string;
  organizationId: string;
  integrationId: string;
  phoneNumberId: string;
  hashtag: string;
  waFrom: string;
}

/**
 * A Station with a live integration and an open promotion that asks for one
 * field, so the shortest complete conversation is three messages: the hashtag,
 * the consent button, and the answer.
 */
async function seedStation(
  label: string,
  requestedFields: Array<Enums<'promotion_requested_field'>> = ['city'],
): Promise<Fixture> {
  const customer = await provisionCustomer(label);
  const phoneNumberId = `pnid-${label}`;
  const integrationId = await seedIntegration(customer, phoneNumberId);
  const hashtag = `#${label.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 40);

  const owner = await signInAs(customer.email, customer.password);
  const { data: promotionId, error } = await owner.rpc('create_promotion', {
    p_company_id: customer.companyId,
    p_name: `Conversa ${label}`,
    p_starts_at: new Date(Date.now() - HOUR).toISOString(),
    p_ends_at: new Date(Date.now() + HOUR).toISOString(),
    p_whatsapp_enabled: true,
    p_hashtag: hashtag,
    p_requested_fields: requestedFields,
  });
  if (error || !promotionId) throw new Error(`create_promotion failed: ${error?.message}`);

  return {
    promotionId: promotionId as string,
    organizationId: customer.organizationId,
    integrationId,
    phoneNumberId,
    hashtag,
    waFrom: `55119${String(Date.now()).slice(-8)}`,
  };
}

/** One inbound message, stored exactly as the webhook route stores it. */
async function deliver(
  fixture: Fixture,
  wamid: string,
  message: { text?: string; reply?: { kind: 'button' | 'list'; id: string; title: string } },
): Promise<{ eventId: string; externalId: string }> {
  const externalId = sha256Hex(wamid);
  const { data, error } = await admin
    .from('webhook_events')
    .insert({
      provider: 'WHATSAPP',
      external_id: externalId,
      payload: {
        wamid,
        metadata: { phone_number_id: fixture.phoneNumberId },
        from: fixture.waFrom,
        profile_name: null,
        text: message.text ?? '',
        timestamp: String(Math.floor(Date.now() / 1000)),
        reply: message.reply ?? null,
      },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`could not deliver a message: ${error?.message}`);
  return { eventId: data.id, externalId };
}

/** The door, then the turn: the two halves the worker runs for one message. */
async function decide(eventId: string): Promise<void> {
  const opened = await admin.rpc('ingest_whatsapp_event', {
    p_event_id: eventId,
    p_window_seconds: 1800,
  });
  if (opened.error) throw new Error(`ingest failed: ${opened.error.message}`);
  await runConversationTurn(
    { supabase: admin, store: new PostgresConversationStore(admin) },
    parseInboundTurn(opened.data),
  );
}

describe('a whole conversation, end to end', () => {
  it(
    'takes a hashtag to an entry, with the answers and the confirmations behind it',
    async () => {
      const fixture = await seedStation(`conv-e2e-${Date.now()}`);

      // 1. The hashtag. Opens the conversation and sends the consent message.
      const first = await deliver(fixture, `wamid.e2e-1-${Date.now()}`, {
        text: `quero participar ${fixture.hashtag}`,
      });
      await decide(first.eventId);

      const { count: earlyEntries } = await admin
        .from('participations')
        .select('id', { count: 'exact', head: true })
        .eq('promotion_id', fixture.promotionId);
      expect(earlyEntries, 'nobody is entered by a question nobody has answered').toBe(0);

      // 2. The button. Advances to the one field the promotion asks for.
      const second = await deliver(fixture, `wamid.e2e-2-${Date.now()}`, {
        reply: { kind: 'button', id: CONSENT_YES_ID, title: 'Quero!' },
      });
      await decide(second.eventId);

      // 3. The answer. The last step, so this is the message that writes
      //    everything -- and the timestamp it is judged by.
      const third = await deliver(fixture, `wamid.e2e-3-${Date.now()}`, { text: 'Canoas' });
      await decide(third.eventId);

      const { data: entries, error: entriesError } = await admin
        .from('participations')
        .select('id, member_id, status')
        .eq('promotion_id', fixture.promotionId);
      expect(entriesError).toBeNull();
      expect(entries).toHaveLength(1);
      expect(entries?.[0]?.status).toBe('VALID');

      const memberId = entries?.[0]?.member_id as string;
      const { data: member } = await admin
        .from('members')
        .select('city')
        .eq('id', memberId)
        .single();
      expect(member?.city, 'the answer is on the record').toBe('Canoas');

      const { data: confirmations } = await admin
        .from('member_field_confirmations')
        .select('field, confirmed_at')
        .eq('member_id', memberId);
      // 'city' was answered in this conversation; the backfill (0065) gave the
      // record nothing else, because the bot registered it a moment ago with
      // only a phone.
      expect(confirmations?.map((row) => row.field)).toContain('city');

      // The conversation is gone: there is nothing left in it worth keeping,
      // and the row holds a phone number.
      const { count: leftOver } = await admin
        .from('whatsapp_conversations')
        .select('phone', { count: 'exact', head: true })
        .eq('integration_id', fixture.integrationId);
      expect(leftOver, 'a finished conversation is deleted, not tombstoned').toBe(0);

      // And every message is closed, none left claimed.
      const { data: events } = await admin
        .from('webhook_events')
        .select('status, outcome')
        .in('id', [first.eventId, second.eventId, third.eventId]);
      expect(events?.map((row) => row.status).sort()).toEqual(['DONE', 'DONE', 'DONE']);
      expect(events?.map((row) => row.outcome).sort()).toEqual([
        'conversation',
        'conversation_turn',
        'recorded',
      ]);
    },
    120_000,
  );

  it(
    'sends the consent message through a real tick, as buttons',
    async () => {
      const fixture = await seedStation(`conv-tick-${Date.now()}`);
      const delivered = await deliver(fixture, `wamid.tick-${Date.now()}`, {
        text: fixture.hashtag,
      });

      // Everything else in the queues is put beyond this tick's reach, so the
      // counts below are about this fixture and not about whatever the local
      // stack is holding.
      await admin
        .from('webhook_events')
        .update({ next_attempt_at: 'infinity' })
        .in('status', ['RECEIVED', 'FAILED', 'PROCESSING'])
        .neq('id', delivered.eventId);
      await admin
        .from('outbox_messages')
        .update({ status: 'FAILED', last_error: 'quiesced by the conversation isolation case' })
        .in('status', ['PENDING', 'SENDING']);

      const transport = new FakeTransport();
      const result = await runTick({ supabase: admin, transport });

      expect(result.dbErrors, 'every database call the tick made succeeded').toBe(0);
      expect(result.turns).toBe(1);
      expect(transport.sentInteractive).toHaveLength(1);
      expect(transport.sentInteractive[0]?.interactive.kind).toBe('buttons');
    },
    120_000,
  );
});

/**
 * TWELVE ROUNDS, and the number is the assertion. A lock that is right nine
 * times out of ten passes a single run, and 4c settled that a probabilistic
 * detector run once proves nothing.
 */
const RACE_ROUNDS = 12;

describe('two answers at once', () => {
  it(
    'advances the cursor exactly once when a listener double-sends',
    async () => {
      const stamp = Date.now();
      for (let round = 0; round < RACE_ROUNDS; round += 1) {
        const fixture = await seedStation(`conv-race-${stamp}-${round}`, ['city', 'neighbourhood']);

        // Open the conversation and get past consent, so the two racing
        // messages meet a live conversation sitting on a FIELD step -- the
        // case where an answer can actually be lost.
        const opener = await deliver(fixture, `wamid.race-${stamp}-${round}-0`, {
          text: fixture.hashtag,
        });
        await decide(opener.eventId);
        const consent = await deliver(fixture, `wamid.race-${stamp}-${round}-1`, {
          reply: { kind: 'button', id: CONSENT_YES_ID, title: 'Quero!' },
        });
        await decide(consent.eventId);

        const a = await deliver(fixture, `wamid.race-${stamp}-${round}-a`, { text: 'Canoas' });
        const b = await deliver(fixture, `wamid.race-${stamp}-${round}-b`, { text: 'Gravatai' });

        // Both ingested first, so the contested resource is the TURN and not
        // the event row's own FOR UPDATE SKIP LOCKED -- which would serialise
        // them for a different reason and prove nothing about the lease.
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

        // EXACTLY ONE of the two runs the turn. The other finds the lease held
        // and leaves its message for the next tick -- not dropped, and not
        // waited on.
        const busy = outcomes.filter((outcome) => outcome.kind === 'busy');
        expect(busy, `round ${round}: ${JSON.stringify(outcomes)}`).toHaveLength(1);

        // And the state moved exactly one step: one answer stored, cursor on
        // the second field. Without the lease both turns read cursor 1, both
        // write cursor 2, and one listener's answer is lost in silence.
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
