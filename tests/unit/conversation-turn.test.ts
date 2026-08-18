import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONSENT_NO_ID,
  CONSENT_YES_ID,
  MARKETING_NO_ID,
  MARKETING_YES_ID,
} from '@/lib/conversation/engine';
import type { Conversation } from '@/lib/conversation/steps';
import type { ConversationKey, ConversationStore } from '@/lib/conversation/store';
import type { Database } from '@/lib/supabase/database.types';
import {
  parseInboundTurn,
  runConversationTurn,
  type InboundTurn,
  type LinkIntent,
} from '@/services/conversation';

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

/**
 * Block 29c. `.from(table)` reads, alongside the `.rpc()` fake above --
 * `companyIdForPromotion` and `hasWhatsappMarketingConsentRecord`
 * (src/services/conversation.ts) are plain PostgREST reads, not RPCs, the
 * same way `whatsapp.ts` already reads `outbox_messages` directly. Configured
 * per TABLE rather than per exact filter: these two tests care about WHICH
 * table was asked and what it answered, not about re-implementing PostgREST's
 * own query builder.
 */
interface FromCall {
  table: string;
  eqs: Record<string, unknown>;
}

class FakeDb {
  readonly rpcs: RpcCall[] = [];
  readonly fromCalls: FromCall[] = [];
  constructor(
    private readonly replies: Record<string, unknown> = {},
    private readonly errors: Record<string, string> = {},
    private readonly tableReplies: Record<string, unknown> = {},
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

  from(table: string) {
    const call: FromCall = { table, eqs: {} };
    const reply = () => Promise.resolve({ data: this.tableReplies[table] ?? null, error: null });
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        call.eqs[column] = value;
        return builder;
      },
      single: () => {
        this.fromCalls.push(call);
        return reply();
      },
      limit: (_n: number) => {
        this.fromCalls.push(call);
        return reply();
      },
    };
    return builder;
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

/**
 * Fix round 1's Critical. Unlike `FakeStore` above -- which ignores the key
 * entirely and would hide the exact bug this exists to catch -- this one
 * answers with a conversation ONLY when queried under the precise
 * `{integrationId, phone}` it was stored against, and null for anything
 * else. It proves the key `runConversationTurn` actually builds from a
 * parsed turn is the one the store's own contract requires (`src/lib/
 * conversation/store.ts`: "keyed on the phone as WhatsApp delivered it"),
 * rather than merely that a live conversation, once found by any means,
 * wins over a link intent.
 */
class KeyedFakeStore implements ConversationStore {
  constructor(
    private readonly key: ConversationKey,
    private readonly current: Conversation,
  ) {}
  async load(key: ConversationKey): Promise<Conversation | null> {
    return key.integrationId === this.key.integrationId && key.phone === this.key.phone
      ? this.current
      : null;
  }
  async save(): Promise<void> {
    // Reached on this test's happy path (a re-prompt saves the incremented
    // reprompt counter) -- a no-op is correct, since nothing here asserts on
    // the saved value.
  }
  async clear(): Promise<void> {
    // Not reached by this test's scenario; present only so the interface is
    // satisfied.
  }
}

const LEASE_TOKEN = '11111111-1111-1111-1111-111111111111';
const PROMOTION = '22222222-2222-2222-2222-222222222222';
const MEMBER = '33333333-3333-3333-3333-333333333333';
const INTEGRATION = '44444444-4444-4444-4444-444444444444';
const QUESTION = '55555555-5555-5555-5555-555555555555';
const OPTION = '66666666-6666-6666-6666-666666666666';
const EXTERNAL_ID = 'a'.repeat(64);
const COMPANY = '88888888-8888-8888-8888-888888888888';

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

/**
 * The other shape parseInboundTurn produces: a matched hashtag, D3. `phone`
 * is the delivered form and the only phone field this shape carries (fix
 * round 1 retired the second field, `to_phone`, that used to disagree with
 * it -- see linkIntentSchema's own comment in conversation.ts).
 */
function link(overrides: Partial<LinkIntent> = {}): LinkIntent {
  return {
    outcome: 'link',
    event_id: '77777777-7777-7777-7777-777777777777',
    integration_id: INTEGRATION,
    company_id: '99999999-9999-9999-9999-999999999999',
    phone: '5511988887777',
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
   * Fix round 1's Critical, at the layer where the bug actually lived. The
   * test above proves the branch ORDER is right; it cannot see this, because
   * `link()` sets its `phone` by hand and the fake store above ignores the
   * key entirely. Neither is true here: this goes through `parseInboundTurn`
   * exactly as the worker does (src/services/whatsapp.ts), against a raw
   * payload shaped like 0179's (fixed) link outcome -- ONE phone field,
   * carrying the DELIVERED form -- and `KeyedFakeStore`, which answers with
   * the live conversation only when asked under that exact form.
   *
   * Before the fix, 0179 returned the LOCAL form (country code stripped)
   * under this same field for a link intent, while its two sibling intents
   * returned the delivered form -- so `runConversationTurn`'s
   * `{integrationId, phone: turn.phone}` key would have missed this store's
   * conversation for essentially every Brazilian listener, `advanceLive`
   * would never run, and `sendServiceLink` would have minted a link for
   * somebody mid-conversation. This is what fails first if that regresses.
   */
  it('C1: a link turn keys the store lookup on the delivered phone Meta sent, not a local one', async () => {
    const DELIVERED = '5511999998888';
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new KeyedFakeStore(
      { integrationId: INTEGRATION, phone: DELIVERED },
      conversation({ phone: DELIVERED }),
    );

    const rawLinkPayload = {
      outcome: 'link',
      event_id: '77777777-7777-7777-7777-777777777777',
      integration_id: INTEGRATION,
      company_id: '99999999-9999-9999-9999-999999999999',
      // What 0179 now returns for every intent it can produce, link
      // included: the delivered form. A regression to the pre-fix shape
      // would put the LOCAL form ('11999998888') here instead, and this
      // assertion is what would catch it.
      phone: DELIVERED,
      member_id: MEMBER,
      purpose: 'MUSIC',
      promotion_id: null,
      promotion_name: null,
      dedupe_prefix: EXTERNAL_ID,
    };

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      parseInboundTurn(rawLinkPayload),
    );

    expect(outcome).toEqual({ kind: 'prompted' });
    expect(db.rpcs.some((call) => call.fn === 'mint_widget_link')).toBe(false);
  });

  /**
   * The other half of Step 3's wiring: nobody is mid-conversation, so a
   * matched hashtag DOES reach sendServiceLink. Fix round 1, M10: this used
   * to prove that by asserting a rejection caused by an ABSENT
   * NEXT_PUBLIC_SITE_URL -- true only because nothing else in this file sets
   * it, and wrong (a CI failure unrelated to what the test claims to check)
   * on any runner whose environment exports it, which this repo's own `.env`
   * does. Fixed the honest way: set the variable for real and prove routing
   * by the one RPC only `sendServiceLink` ever calls actually firing.
   *
   * Needs a freshly re-imported `@/services/conversation`: `env` (src/lib/
   * env.ts) is computed once, at module import, and this file's own
   * top-level import already ran with no NEXT_PUBLIC_SITE_URL set -- the
   * same reason `whatsapp-link.test.ts` and `whatsapp-route.test.ts` use a
   * dynamic import after setting the variable, rather than a `beforeEach`.
   */
  it('routes a matched hashtag to sendServiceLink when nobody is mid-conversation, and mints a code', async () => {
    const original = process.env.NEXT_PUBLIC_SITE_URL;
    process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.test';
    vi.resetModules();

    try {
      const fresh = await import('@/services/conversation');
      const db = new FakeDb({
        claim_conversation_turn: LEASE_TOKEN,
        mint_widget_link: 'CODE-1',
        widget_link_send_context: { publicKey: 'pw_test', systemMessages: {} },
        enqueue_whatsapp_outbound: 'ob-1',
      });
      const store = new FakeStore(null);

      const outcome = await fresh.runConversationTurn(
        { supabase: asClient(db), store },
        turn({ link: link() }),
      );

      expect(outcome).toEqual({ kind: 'link_sent' });
      expect(db.rpcs.some((call) => call.fn === 'mint_widget_link')).toBe(true);
      expect(db.called('release_conversation_turn')?.args).toMatchObject({ p_token: LEASE_TOKEN });
    } finally {
      process.env.NEXT_PUBLIC_SITE_URL = original;
      vi.resetModules();
    }
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

/**
 * Block 29c. The wiring the brief's Step 4 does not carry on its own:
 * `maybeAskMarketingConsent` (starts the follow-up, and only once per D2),
 * the tap that ends it, and the stop word that ends it early.
 *
 * `whatsapp_prompt_context`'s reply below adds no `systemMessages` key for
 * MARKETING_CONSENT/MARKETING_STOPPED, on purpose: these cases prove the
 * WIRING, and the wording itself -- default vs. a Station's override -- is
 * already `resolveSystemMessage`'s own proof (system-message-resolution
 * tests) and the engine-level prompt cases in conversation-engine.test.ts.
 */
function marketingConsentConversation(overrides: Partial<Conversation> = {}): Conversation {
  return conversation({
    steps: [{ kind: 'marketing_consent' }],
    cursor: 0,
    answers: { fields: {}, questions: [] },
    ...overrides,
  });
}

describe('Block 29c: the marketing consent follow-up', () => {
  it('is asked when the completed participation leaves no whatsapp_marketing row behind', async () => {
    const db = new FakeDb(
      {
        claim_conversation_turn: LEASE_TOKEN,
        whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
        complete_whatsapp_conversation: { status: 'VALID', participation_id: 'p-1' },
      },
      {},
      { promotions: { company_id: COMPANY }, member_consents: [] },
    );
    const store = new FakeStore(
      conversation({ steps: [{ kind: 'field', field: 'cpf' }], cursor: 0 }),
    );

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: '390.533.447-05' }),
    );

    expect(outcome).toEqual({ kind: 'completed', status: 'VALID' });
    // The state before the message, same rule `open()` follows and the same
    // file-header reason: a Sim/Não button with no state behind it is a
    // button nobody is listening for.
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.steps).toEqual([{ kind: 'marketing_consent' }]);
    expect(store.saved[0]?.cursor).toBe(0);

    const enqueued = db.called('enqueue_whatsapp_outbound');
    expect(enqueued?.args.p_dedupe_key).toBe(`${EXTERNAL_ID}:marketing_consent`);
    expect(db.fromCalls.some((c) => c.table === 'member_consents')).toBe(true);
  });

  it('is not asked when a whatsapp_marketing row already exists -- granted true or false, D2', async () => {
    const db = new FakeDb(
      {
        claim_conversation_turn: LEASE_TOKEN,
        whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
        complete_whatsapp_conversation: { status: 'VALID', participation_id: 'p-1' },
      },
      {},
      // A withdrawal (granted: false) is still a row: D2 asks once, not once
      // per answer.
      { promotions: { company_id: COMPANY }, member_consents: [{ id: 'existing-consent' }] },
    );
    const store = new FakeStore(
      conversation({ steps: [{ kind: 'field', field: 'cpf' }], cursor: 0 }),
    );

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: '390.533.447-05' }),
    );

    expect(outcome).toEqual({ kind: 'completed', status: 'VALID' });
    // Nothing saved: the follow-up never starts, so there is no second state
    // to write and nothing new to send.
    expect(store.saved).toHaveLength(0);
    expect(db.called('enqueue_whatsapp_outbound')).toBeUndefined();
  });

  it('a tap writes the right value through record_member_consent, and ends the turn silently', async () => {
    const db = new FakeDb(
      {
        claim_conversation_turn: LEASE_TOKEN,
        whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
      },
      {},
      { promotions: { company_id: COMPANY } },
    );
    const store = new FakeStore(marketingConsentConversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: MARKETING_YES_ID, title: 'Sim' } }),
    );

    expect(outcome).toEqual({ kind: 'marketing_consent_recorded', granted: true });
    expect(db.called('record_member_consent')?.args).toMatchObject({
      p_member_id: MEMBER,
      p_company_id: COMPANY,
      p_consent_type: 'whatsapp_marketing',
      p_granted: true,
      p_origin: 'conversation',
      p_promotion_id: PROMOTION,
    });
    expect(store.cleared).toBe(1);
    // Silence, not a reply: the tap is its own confirmation, the same way a
    // WhatsApp button stays visibly pressed.
    expect(db.called('enqueue_whatsapp_outbound')).toBeUndefined();
  });

  it('a NO tap writes granted: false the same way', async () => {
    const db = new FakeDb(
      {
        claim_conversation_turn: LEASE_TOKEN,
        whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
      },
      {},
      { promotions: { company_id: COMPANY } },
    );
    const store = new FakeStore(marketingConsentConversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: MARKETING_NO_ID, title: 'Não' } }),
    );

    expect(outcome).toEqual({ kind: 'marketing_consent_recorded', granted: false });
    expect(db.called('record_member_consent')?.args).toMatchObject({ p_granted: false });
  });

  it('an unrecognised tap writes nothing at all and re-prompts instead', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new FakeStore(marketingConsentConversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: 'some-stale-button', title: 'x' } }),
    );

    expect(outcome).toEqual({ kind: 'prompted' });
    expect(db.called('record_member_consent')).toBeUndefined();
    expect(store.saved[0]?.reprompts).toBe(1);
    // Never reached: an unrecognised tap has no company to look up.
    expect(db.fromCalls.some((c) => c.table === 'promotions')).toBe(false);
  });

  it('a stop word typed AT the marketing question withdraws and replies, outside a promotion flow', async () => {
    const db = new FakeDb(
      {
        claim_conversation_turn: LEASE_TOKEN,
        whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
      },
      {},
      { promotions: { company_id: COMPANY } },
    );
    const store = new FakeStore(marketingConsentConversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: 'PARAR' }),
    );

    expect(outcome).toEqual({ kind: 'marketing_consent_recorded', granted: false });
    expect(db.called('record_member_consent')?.args).toMatchObject({
      p_member_id: MEMBER,
      p_company_id: COMPANY,
      p_consent_type: 'whatsapp_marketing',
      p_granted: false,
      p_origin: 'conversation',
    });
    const enqueued = db.called('enqueue_whatsapp_outbound');
    expect(enqueued?.args.p_dedupe_key).toBe(`${EXTERNAL_ID}:marketing_stopped`);
    expect(store.cleared).toBe(1);
  });

  /**
   * The case the brief's own example names: "which city" answered with
   * PARAR is abandoning the FIELD, not withdrawing consent. The fixture is
   * the file's ordinary `conversation()` -- a live consent step, nothing to
   * do with Block 29c -- which is the point: this is what every other turn
   * in this file already looks like, and a stop word must not behave any
   * differently there.
   */
  it('a stop word typed mid the ORIGINAL promotion flow does not withdraw', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      whatsapp_prompt_context: { promotion: promotionContext, questions: questionsContext },
    });
    const store = new FakeStore(conversation());

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: 'PARAR' }),
    );

    // An ordinary re-prompt: consentTurn refuses text of any kind, stop word
    // or not, exactly as it already refuses "sim".
    expect(outcome).toEqual({ kind: 'prompted' });
    expect(db.called('record_member_consent')).toBeUndefined();
    expect(db.fromCalls).toHaveLength(0);
  });
});

/**
 * Block 29c, fix round 1, F7. The cold path: no live conversation, no
 * hashtag, nothing but a phone and a stop word. `withdraw_marketing_by_phone`
 * (0231) resolves the listener IN SQL, so this file's own job is only the
 * wiring -- call it, and reply only when it says it matched somebody.
 */
describe("Block 29c, F7: the cold-path stop word", () => {
  it('withdraws and replies when the door finds a listener', async () => {
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      withdraw_marketing_by_phone: true,
    });
    const store = new FakeStore(null);

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: 'PARAR' }),
    );

    expect(outcome).toEqual({ kind: 'marketing_consent_recorded', granted: false });
    expect(db.called('withdraw_marketing_by_phone')?.args).toMatchObject({
      p_integration_id: INTEGRATION,
      p_phone: '5511988887777',
    });
    const enqueued = db.called('enqueue_whatsapp_outbound');
    expect(enqueued?.args.p_dedupe_key).toBe(`${EXTERNAL_ID}:marketing_stopped`);
    expect(db.called('finish_whatsapp_turn')?.args.p_outcome).toBe('no_conversation');
  });

  it('stays silent -- and sends nothing -- when the door finds no match', async () => {
    // A stranger, or a listener some OTHER Station knows: withdraw_marketing_by_phone
    // answers false for both (its own comment), and a reply here would tell
    // either one "removed" for something that never happened at this Station.
    const db = new FakeDb({
      claim_conversation_turn: LEASE_TOKEN,
      withdraw_marketing_by_phone: false,
    });
    const store = new FakeStore(null);

    const outcome = await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ text: 'cancelar' }),
    );

    expect(outcome).toEqual({ kind: 'ignored' });
    expect(db.called('enqueue_whatsapp_outbound')).toBeUndefined();
    expect(db.called('finish_whatsapp_turn')?.args.p_outcome).toBe('no_conversation');
  });

  it('does not call the door for an ordinary message that is not a stop word', async () => {
    const db = new FakeDb({ claim_conversation_turn: LEASE_TOKEN });
    const store = new FakeStore(null);

    await runConversationTurn({ supabase: asClient(db), store }, turn({ text: 'bom dia' }));

    expect(db.called('withdraw_marketing_by_phone')).toBeUndefined();
  });

  it('does not call the door for a button/list reply, even if its title happens to read as a stop word', async () => {
    const db = new FakeDb({ claim_conversation_turn: LEASE_TOKEN });
    const store = new FakeStore(null);

    await runConversationTurn(
      { supabase: asClient(db), store },
      turn({ reply: { kind: 'button', id: 'stale', title: 'parar' } }),
    );

    expect(db.called('withdraw_marketing_by_phone')).toBeUndefined();
  });
});
