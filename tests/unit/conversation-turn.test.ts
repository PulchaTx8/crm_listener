import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CONSENT_NO_ID, CONSENT_YES_ID } from '@/lib/conversation/engine';
import type { Conversation } from '@/lib/conversation/steps';
import type { ConversationKey, ConversationStore } from '@/lib/conversation/store';
import type { Database } from '@/lib/supabase/database.types';
import { runConversationTurn, type InboundTurn, type LinkIntent } from '@/services/conversation';

/**
 * The turn, against a fake store and a fake client.
 *
 * What these cases are really about is ORDER and CLEANUP, because those are the
 * two things no pgTAP case can see: the lease is claimed before the state is
 * read and released whatever happens, the database work comes before the state
 * is cleared, and a prompt is stored before it is sent.
 */

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

class FakeDb {
  readonly rpcs: RpcCall[] = [];
  constructor(
    private readonly replies: Record<string, unknown> = {},
    private readonly errors: Record<string, string> = {},
  ) {}

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcs.push({ fn, args });
    const failure = this.errors[fn];
    if (failure !== undefined) return Promise.resolve({ data: null, error: { message: failure } });
    return Promise.resolve({ data: this.replies[fn] ?? null, error: null });
  }

  called(fn: string): RpcCall | undefined {
    return this.rpcs.find((call) => call.fn === fn);
  }
}

class FakeStore implements ConversationStore {
  saved: Conversation[] = [];
  cleared = 0;
  constructor(private current: Conversation | null = null) {}
  async load(_key: ConversationKey): Promise<Conversation | null> {
    return this.current;
  }
  async save(_key: ConversationKey, value: Conversation): Promise<void> {
    this.saved.push(value);
    this.current = value;
  }
  async clear(_key: ConversationKey): Promise<void> {
    this.cleared += 1;
    this.current = null;
  }
}

const LEASE_TOKEN = '11111111-1111-1111-1111-111111111111';
const PROMOTION = '22222222-2222-2222-2222-222222222222';
const MEMBER = '33333333-3333-3333-3333-333333333333';
const INTEGRATION = '44444444-4444-4444-4444-444444444444';
const QUESTION = '55555555-5555-5555-5555-555555555555';
const OPTION = '66666666-6666-6666-6666-666666666666';
const EXTERNAL_ID = 'a'.repeat(64);

const promotionContext = {
  name: 'Disney',
  callToAction: 'Manda a hashtag!',
  useArt: false,
  artUrl: null,
  yesButtonLabel: null,
  noButtonLabel: null,
};

const questionsContext = {
  [QUESTION]: {
    prompt: 'Qual estilo você prefere?',
    menuTitle: 'Estilos',
    buttonLabel: 'Escolher',
    options: [{ id: OPTION, label: 'Sertanejo' }],
  },
};

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    integrationId: INTEGRATION,
    phone: '5511988887777',
    promotionId: PROMOTION,
    memberId: MEMBER,
    steps: [{ kind: 'consent' }, { kind: 'field', field: 'city' }],
    cursor: 0,
    answers: { fields: {}, questions: [] },
    reprompts: 0,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function turn(overrides: Partial<InboundTurn> = {}): InboundTurn {
  return {
    event_id: '77777777-7777-7777-7777-777777777777',
    external_id: EXTERNAL_ID,
    integration_id: INTEGRATION,
    phone: '5511988887777',
    received_at: '2026-06-10T12:00:00Z',
    text: '',
    reply: null,
    start: null,
    // Block 19a. Absent on every no_hashtag turn (parseInboundTurn's own
    // contract) -- present only on the shape `link()` below builds.
    link: null,
    ...overrides,
  };
}

/** The other shape parseInboundTurn produces: a matched hashtag, D3. */
function link(overrides: Partial<LinkIntent> = {}): LinkIntent {
  return {
    outcome: 'link',
    event_id: '77777777-7777-7777-7777-777777777777',
    integration_id: INTEGRATION,
    company_id: '99999999-9999-9999-9999-999999999999',
    phone: '5511988887777',
    to_phone: '5511988887777',
    member_id: MEMBER,
    purpose: 'MUSIC',
    promotion_id: null,
    promotion_name: null,
    dedupe_prefix: EXTERNAL_ID,
    ...overrides,
  };
}

const asClient = (db: FakeDb) => db as unknown as SupabaseClient<Database>;

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

describe('runConversationTurn', () => {
  it('leaves the message alone when another worker holds the phone', async () => {
    const db = new FakeDb({ claim_conversation_turn: null });
    const store = new FakeStore(conversation());

    const outcome = await runConversationTurn({ supabase: asClient(db), store }, turn());

    expect(outcome).toEqual({ kind: 'busy' });
    // Nothing read, nothing written, and the event NOT finished: it stays
    // PROCESSING and the worker that holds the lease is about to decide it.
    expect(store.saved).toHaveLength(0);
    expect(db.called('finish_whatsapp_turn')).toBeUndefined();
    expect(db.called('release_conversation_turn')).toBeUndefined();
  });

  it('opens a conversation: the state is stored BEFORE the question goes out', async () => {
    const db = new FakeDb({ claim_conversation_turn: LEASE_TOKEN });
    const store = new FakeStore(null);

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({
        text: '#EUQUERO',
        start: {
          conversation: conversation() as unknown,
          promotion: promotionContext,
          questions: questionsContext,
          // A Station that has overridden nothing, which is every Station
          // until somebody opens the Messages screen.
          systemMessages: {},
        },
      }),
    );

    expect(outcome).toEqual({ kind: 'started' });
    expect(store.saved).toHaveLength(1);

    // The order is the assertion. A consent message with no state behind it
    // leaves the listener pressing a button nobody is listening for.
    const order = db.rpcs.map((call) => call.fn);
    expect(order.indexOf('enqueue_whatsapp_outbound')).toBeGreaterThan(0);
    expect(order).toEqual([
      'claim_conversation_turn',
      'enqueue_whatsapp_outbound',
      'finish_whatsapp_turn',
      'release_conversation_turn',
    ]);

    const enqueued = db.called('enqueue_whatsapp_outbound');
    expect(enqueued?.args.p_dedupe_key).toBe(`${EXTERNAL_ID}:consent`);
    // Interactive, and its words are in the body too, so an operator can read
    // what was sent without rendering anything.
    expect(enqueued?.args.p_interactive).toMatchObject({ kind: 'buttons' });
    expect(String(enqueued?.args.p_body)).toContain('Disney');
    expect(db.called('finish_whatsapp_turn')?.args.p_outcome).toBe('conversation');
  });

  it('advances a live conversation and asks the next question', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new FakeStore(conversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: CONSENT_YES_ID, title: 'Quero!' } }),
    );

    expect(outcome).toEqual({ kind: 'prompted' });
    expect(store.saved[0]?.cursor).toBe(1);
    // No overrides in this fixture, so this is the constant in engine.ts
    // reaching the listener — the fallback half of D2, at the turn level.
    expect(String(db.called('enqueue_whatsapp_outbound')?.args.p_body)).toContain('cidade');
    expect(db.called('finish_whatsapp_turn')?.args.p_outcome).toBe('conversation_turn');
  });

  /**
   * The Templates block's own proof, and the one the spec asks for by name: a
   * Station's override REACHES THE LISTENER. Everything else about the
   * resolution is held in tests/unit/system-message-resolution.test.ts, which
   * cannot see this — that the map survives the jsonb boundary, the Zod
   * schema, the narrowing and the engine, and comes out as the body actually
   * enqueued.
   *
   * The case above is its other half: the same turn, with no overrides,
   * enqueues the constant.
   */
  it("speaks the Station's own words when it has given the engine any", async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: {
        promotion: promotionContext,
        questions: questionsContext,
        systemMessages: { CITY: 'De qual cidade você fala com a gente?' },
      },
    });
    const store = new FakeStore(conversation());

    await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: CONSENT_YES_ID, title: 'Quero!' } }),
    );

    expect(String(db.called('enqueue_whatsapp_outbound')?.args.p_body)).toBe(
      'De qual cidade você fala com a gente?',
    );
  });

  it('records a refusal through its own door and only then forgets the conversation', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new FakeStore(conversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: CONSENT_NO_ID, title: 'Agora não' } }),
    );

    expect(outcome).toEqual({ kind: 'refused' });
    const refusal = db.called('record_whatsapp_refusal');
    expect(refusal?.args).toMatchObject({
      p_promotion_id: PROMOTION,
      p_member_id: MEMBER,
      p_refused_at: '2026-06-10T12:00:00Z',
      p_dedupe_key: `${EXTERNAL_ID}:goodbye`,
    });
    expect(store.cleared).toBe(1);
    // The write first, the forgetting after (spec §4.3): a state cleared first
    // and a write that then failed would lose the refusal and the conversation.
    expect(db.rpcs.map((c) => c.fn)).not.toContain('finish_whatsapp_turn');
  });

  it('completes: the CPF is hashed before it is ever an argument', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
      complete_whatsapp_conversation: { status: 'VALID', participation_id: 'p-1' },
    });
    const store = new FakeStore(
      conversation({
        steps: [{ kind: 'field', field: 'cpf' }],
        cursor: 0,
        answers: { fields: { city: 'Canoas' }, questions: [] },
      }),
    );

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: '390.533.447-05' }),
    );

    expect(outcome).toEqual({ kind: 'completed', status: 'VALID' });
    const fields = db.called('complete_whatsapp_conversation')?.args.p_fields as Record<
      string,
      string
    >;
    // 0031's rule: the raw number never appears in an argument, because
    // arguments land in query logs and backups.
    expect(fields.cpf).toBe(createHash('sha256').update('39053344705').digest('hex'));
    expect(fields.cpf).not.toContain('390');
    expect(fields.city).toBe('Canoas');
    expect(db.called('complete_whatsapp_conversation')?.args.p_completed_at).toBe(
      '2026-06-10T12:00:00Z',
    );
    expect(store.cleared).toBe(1);
  });

  it('says nothing to somebody who is not mid-conversation', async () => {
    const db = new FakeDb({ claim_conversation_turn: LEASE_TOKEN });
    const store = new FakeStore(null);

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: 'bom dia' }),
    );

    expect(outcome).toEqual({ kind: 'ignored' });
    expect(db.called('enqueue_whatsapp_outbound')).toBeUndefined();
    expect(db.called('finish_whatsapp_turn')?.args.p_outcome).toBe('no_conversation');
  });

  /**
   * Block 19a, D7. The bridge this task exists for: a live conversation
   * outranks a matched hashtag, exactly as it already outranked `turn.start`
   * before this task. Both `reply` (an answer to the live question) AND
   * `link` (the ingest also resolved this same message as a hashtag match)
   * are set on the same turn -- an edge case rather than the ordinary shape
   * (parseInboundTurn never produces both at once), but it is the one
   * arrangement that actually exercises the ORDER the two `if` statements are
   * written in, which is the whole guarantee D7 asks for.
   */
  it('D7: a live conversation wins over a matched hashtag, and mints no link', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new FakeStore(conversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({
        reply: { kind: 'button', id: CONSENT_YES_ID, title: 'Quero!' },
        link: link(),
      }),
    );

    expect(outcome).toEqual({ kind: 'prompted' });
    // The whole point of D7: the branch below the live check is never
    // reached, so sendServiceLink never mints anything.
    expect(db.rpcs.some((call) => call.fn === 'mint_widget_link')).toBe(false);
  });

  /**
   * The other half of Step 3's wiring: nobody is mid-conversation, so a
   * matched hashtag DOES reach sendServiceLink -- proven here by the shape of
   * the failure. This process has no NEXT_PUBLIC_SITE_URL configured (no test
   * in this file sets one), so sendServiceLink refuses to mint or send
   * (src/services/whatsapp-link.ts) and that specific refusal, not "ignored"
   * or some other outcome, is what must come back -- which is only possible
   * if `turn.link` was actually checked and routed.
   */
  it('routes a matched hashtag to sendServiceLink when nobody is mid-conversation, and still releases the lease', async () => {
    const db = new FakeDb({ claim_conversation_turn: LEASE_TOKEN });
    const store = new FakeStore(null);

    await expect(
      runConversationTurn({ supabase: asClient(db), store }, turn({ link: link() })),
    ).rejects.toThrow(/NEXT_PUBLIC_SITE_URL/);

    expect(db.rpcs.some((call) => call.fn === 'mint_widget_link')).toBe(false);
    expect(db.called('release_conversation_turn')?.args).toMatchObject({ p_token: LEASE_TOKEN });
  });

  /**
   * The case with the longest tail. A turn that throws while holding the lease
   * would, without the finally, keep that phone unanswerable for five minutes —
   * and the listener would send another message into the same silence.
   */
  it('releases the lease even when the turn fails', async () => {
    const db = new FakeDb(
      { claim_conversation_turn: LEASE_TOKEN },
      { finish_whatsapp_turn: 'permission denied' },
    );
    const store = new FakeStore(null);

    await expect(
      runConversationTurn({ supabase: asClient(db), store }, turn({ text: 'bom dia' })),
    ).rejects.toMatchObject({ message: 'permission denied' });

    expect(db.called('release_conversation_turn')?.args).toMatchObject({ p_token: LEASE_TOKEN });
  });
});
