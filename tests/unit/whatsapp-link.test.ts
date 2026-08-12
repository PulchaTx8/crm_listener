import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConversationStore } from '@/lib/conversation/store';
import { DEFAULT_MUSIC_LINK_TEXT, DEFAULT_PROMOTION_LINK_TEXT } from '@/lib/conversation/engine';
import type { Database } from '@/lib/supabase/database.types';
import type { LinkIntent } from '@/services/conversation';

/**
 * Task 5. `env` (src/lib/env.ts) is computed once, at module import, from
 * `process.env` -- so the happy-path client is imported here, AFTER the one
 * line that gives it something to read, and the "no site URL" cases at the
 * bottom of this file import a SEPARATE, freshly-reset copy of the module
 * once that line is undone. A static top-level `import` cannot see an env
 * var set later, which is why `whatsapp-route.test.ts` uses the same
 * set-then-dynamic-import shape for the same reason.
 */
process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.test';

const { sendServiceLink, SendServiceLinkError } = await import('@/services/whatsapp-link');

// ---------------------------------------------------------------------------
// A Supabase client that records instead of talking to one, in the shape
// tests/unit/whatsapp-worker.test.ts's own FakeDb uses: the CALLS are
// recorded structurally (fn + args), and assertions compare whole argument
// objects rather than single fields, so a patch carrying one field too many
// or too few fails here rather than in production.
// ---------------------------------------------------------------------------

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface Fixture {
  /** undefined means "answer CODE-1"; null models D2's window (say nothing). */
  mintCode?: string | null;
  publicKey?: string;
  /** Applied to every LINK_* key alike -- which one resolves depends on `purpose`, not on this fixture. */
  systemMessage?: string;
  mintError?: string;
  contextError?: string;
  enqueueError?: string;
}

class FakeDb {
  readonly rpcs: RpcCall[] = [];
  constructor(private readonly fixture: Fixture = {}) {}

  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> {
    this.rpcs.push({ fn, args });

    if (fn === 'mint_widget_link') {
      if (this.fixture.mintError !== undefined) {
        return Promise.resolve({ data: null, error: { message: this.fixture.mintError } });
      }
      const code = this.fixture.mintCode === undefined ? 'CODE-1' : this.fixture.mintCode;
      return Promise.resolve({ data: code, error: null });
    }

    if (fn === 'widget_link_send_context') {
      if (this.fixture.contextError !== undefined) {
        return Promise.resolve({ data: null, error: { message: this.fixture.contextError } });
      }
      const publicKey = this.fixture.publicKey ?? 'pw_test';
      const systemMessages =
        this.fixture.systemMessage === undefined
          ? {}
          : {
              LINK_MUSIC: this.fixture.systemMessage,
              LINK_MENU: this.fixture.systemMessage,
              LINK_PROMOTION: this.fixture.systemMessage,
            };
      return Promise.resolve({ data: { publicKey, systemMessages }, error: null });
    }

    if (fn === 'enqueue_whatsapp_outbound') {
      if (this.fixture.enqueueError !== undefined) {
        return Promise.resolve({ data: null, error: { message: this.fixture.enqueueError } });
      }
      return Promise.resolve({ data: 'ob-1', error: null });
    }

    if (fn === 'finish_whatsapp_turn') {
      return Promise.resolve({ data: { outcome: args.p_outcome }, error: null });
    }

    throw new Error(`unexpected rpc: ${fn}`);
  }

  called(fn: string): RpcCall[] {
    return this.rpcs.filter((call) => call.fn === fn);
  }

  enqueueArgs(): Record<string, unknown> | undefined {
    return this.called('enqueue_whatsapp_outbound')[0]?.args;
  }
}

const asClient = (db: FakeDb) => db as unknown as SupabaseClient<Database>;

/**
 * D7's other half, enforced by construction: `sendServiceLink` is reached
 * only after `runConversationTurn` has already decided no live conversation
 * exists (conversation.ts), and this file owns none of that state. Every
 * method throws, so a call here -- meaning this function read or wrote the
 * conversation store at all -- fails every single test in this file rather
 * than passing silently.
 */
const untouchedStore: ConversationStore = {
  load: () => {
    throw new Error('sendServiceLink must not read the conversation store');
  },
  save: () => {
    throw new Error('sendServiceLink must not write the conversation store');
  },
  clear: () => {
    throw new Error('sendServiceLink must not clear the conversation store');
  },
};

const intent: LinkIntent = {
  outcome: 'link',
  event_id: 'e1',
  integration_id: 'i1',
  company_id: 'c1',
  phone: '11999998888',
  to_phone: '5511999998888',
  member_id: 'm1',
  purpose: 'MUSIC',
  promotion_id: null,
  promotion_name: null,
  dedupe_prefix: 'a'.repeat(64),
};

describe('sendServiceLink', () => {
  it('mints a code, enqueues one message carrying the link, and closes the event', async () => {
    const db = new FakeDb();

    const outcome = await sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent);

    expect(outcome).toEqual({ kind: 'link_sent' });
    expect(db.called('mint_widget_link')).toEqual([
      {
        fn: 'mint_widget_link',
        // undefined, not null: the generated Args type carries the SQL
        // DEFAULT as an optional field, so a MUSIC/MENU intent's null
        // promotion_id is passed through as an omission, matching every
        // other nullable-to-optional RPC argument in this codebase.
        args: { p_company_id: 'c1', p_member_id: 'm1', p_purpose: 'MUSIC', p_promotion_id: undefined },
      },
    ]);
    expect(db.enqueueArgs()).toEqual({
      p_integration_id: 'i1',
      // Meta's own delivered form, never the local one (`phone`).
      p_to_phone: '5511999998888',
      p_interactive: null,
      p_dedupe_key: `${'a'.repeat(64)}:link`,
      p_body: `${DEFAULT_MUSIC_LINK_TEXT}\n\nhttps://app.example.test/w/pw_test/enter?k=CODE-1&open=music`,
    });
    expect(db.called('finish_whatsapp_turn')).toEqual([
      { fn: 'finish_whatsapp_turn', args: { p_event_id: 'e1', p_outcome: 'link_sent' } },
    ]);
  });

  it('addresses a PROMOTION link with the promotion id, and finds the wording under LINK_PROMOTION', async () => {
    const db = new FakeDb();
    const promotionIntent: LinkIntent = {
      ...intent,
      purpose: 'PROMOTION',
      promotion_id: 'p1',
      promotion_name: 'Disney',
    };

    await sendServiceLink({ supabase: asClient(db), store: untouchedStore }, promotionIntent);

    expect(db.enqueueArgs()).toMatchObject({
      p_body: `${DEFAULT_PROMOTION_LINK_TEXT}\n\nhttps://app.example.test/w/pw_test/enter?k=CODE-1&open=promotion&id=p1`,
    });
  });

  /**
   * D2's window: the door answers null when this listener already has a
   * working link, and null means SAY NOTHING. A second message here is the
   * whole defect the window exists to prevent.
   */
  it('sends nothing when the door says the listener was already answered', async () => {
    const db = new FakeDb({ mintCode: null });

    const outcome = await sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent);

    expect(outcome).toEqual({ kind: 'already_answered' });
    expect(db.called('enqueue_whatsapp_outbound')).toHaveLength(0);
    // The window answers before the public key / wording round trip is ever
    // needed -- nothing to build a message for, so nothing fetched for it.
    expect(db.called('widget_link_send_context')).toHaveLength(0);
    expect(db.called('finish_whatsapp_turn')).toEqual([
      { fn: 'finish_whatsapp_turn', args: { p_event_id: 'e1', p_outcome: 'already_answered' } },
    ]);
  });

  it("uses the Station's own wording when it has one", async () => {
    const db = new FakeDb({ systemMessage: 'Bora pedir!' });

    await sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent);

    const body = String(db.enqueueArgs()?.p_body);
    expect(body.startsWith('Bora pedir!\n\n')).toBe(true);
  });

  it('propagates a mint failure rather than finishing the event as anything', async () => {
    const db = new FakeDb({ mintError: 'db is down' });

    await expect(
      sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent),
    ).rejects.toThrow('db is down');
    expect(db.called('finish_whatsapp_turn')).toHaveLength(0);
    expect(db.called('enqueue_whatsapp_outbound')).toHaveLength(0);
  });

  it('propagates a failure to resolve the public key rather than sending an unaddressed link', async () => {
    const db = new FakeDb({ contextError: 'no live installation' });

    await expect(
      sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent),
    ).rejects.toThrow('no live installation');
    expect(db.called('enqueue_whatsapp_outbound')).toHaveLength(0);
    expect(db.called('finish_whatsapp_turn')).toHaveLength(0);
  });

  it('propagates an enqueue failure rather than closing the event as sent', async () => {
    const db = new FakeDb({ enqueueError: 'constraint violation' });

    await expect(
      sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent),
    ).rejects.toThrow('constraint violation');
    expect(db.called('finish_whatsapp_turn')).toHaveLength(0);
  });

  /**
   * The decision this task calls out explicitly: NEXT_PUBLIC_SITE_URL is
   * optional in the environment schema (local stack, a build), and the
   * worst outcome available here is a listener tapping a link that resolves
   * to nothing. So this refuses to mint or send at all rather than guess a
   * host -- checked BEFORE the mint, so D2's two-minute window is never
   * spent on a message that was never going anywhere.
   */
  describe('when NEXT_PUBLIC_SITE_URL is not configured', () => {
    it('mints nothing, sends nothing, and throws rather than sending a broken link', async () => {
      const original = process.env.NEXT_PUBLIC_SITE_URL;
      delete process.env.NEXT_PUBLIC_SITE_URL;
      vi.resetModules();

      try {
        const unconfigured = await import('@/services/whatsapp-link');
        const db = new FakeDb();

        await expect(
          unconfigured.sendServiceLink({ supabase: asClient(db), store: untouchedStore }, intent),
        ).rejects.toThrow(unconfigured.SendServiceLinkError);
        // Not one RPC call -- the door is never even asked, so the window
        // D2 relies on is never spent on a message that could not be sent.
        expect(db.rpcs).toHaveLength(0);
      } finally {
        process.env.NEXT_PUBLIC_SITE_URL = original;
        vi.resetModules();
      }
    });
  });
});

describe('SendServiceLinkError', () => {
  it('is exported for a caller to narrow on, and carries the class name in .name', () => {
    const error = new SendServiceLinkError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SendServiceLinkError');
  });
});
