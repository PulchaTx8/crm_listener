/**
 * ONE contract, run against every `ConversationStore` driver.
 *
 * Not a test file — the name has no `.test.ts` on purpose, so neither vitest
 * config collects it. It is a factory that REGISTERS cases, called from each
 * driver's own test file. Spec §6: "the Postgres and Redis implementations pass
 * the same tests. This is what stops them diverging quietly." An optional driver
 * nobody exercises is worse than no driver at all, because it looks like a
 * choice.
 *
 * Two deliberate departures from the plan's sketched signature
 * (`make: () => Promise<ConversationStore>`), both forced by cases the plan
 * itself requires:
 *
 *  - **`make` takes a window.** The expiry case is the one the plan calls the
 *    most important, and it cannot be written against the real thirty-minute
 *    window without either waiting thirty minutes or reaching past the interface
 *    into one driver's storage — which is precisely what a shared contract must
 *    never do. A short window is the only lever both drivers actually have:
 *    Postgres writes it into `expires_at`, Redis into the key's own TTL, and the
 *    case then exercises each driver's real expiry mechanism rather than a
 *    simulation of it.
 *  - **`nextKey` comes from the fixture.** `whatsapp_conversations.integration_id`
 *    is a foreign key, so the Postgres driver needs a key naming a real
 *    `integrations` row; Redis needs nothing of the sort. A key hard-coded here
 *    would either break the foreign key or force the Redis test to seed
 *    Postgres.
 */
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_WINDOW_SECONDS,
  type ConversationKey,
  type ConversationStore,
} from '@/lib/conversation/store';
import type { Conversation } from '@/lib/conversation/steps';

export interface ConversationStoreFixture {
  /** A store. `windowSeconds` shortens the window; omitted means the real one. */
  make(options?: { windowSeconds?: number }): Promise<ConversationStore>;
  /** A key no other case in this run uses. */
  nextKey(): Promise<ConversationKey>;
}

/**
 * The window used by the expiry case: long enough that the save and the first
 * load cannot lose a race with it on a loaded machine, short enough that the
 * case costs a couple of seconds.
 */
const SHORT_WINDOW_SECONDS = 2;

/** How long the expiry case waits for the value to go before calling it a failure. */
const EXPIRY_DEADLINE_MS = 15_000;

/**
 * A state with something in every field, including both nested shapes — a
 * driver that round-trips the scalars and flattens `answers` passes a thinner
 * fixture and loses a listener's answers in production.
 *
 * `expiresAt` is set to an instant in 1970 deliberately. It is the ONE field the
 * store owns rather than carries (see `Conversation` in steps.ts): a driver that
 * wrote the state's own value into its expiry would store something already
 * expired, and the round-trip case below would fail rather than the defect
 * surfacing later as conversations that vanish between two messages.
 */
function conversationFor(key: ConversationKey): Conversation {
  return {
    integrationId: key.integrationId,
    phone: key.phone,
    promotionId: '00000000-0000-0000-0000-0000000008a1',
    memberId: '00000000-0000-0000-0000-0000000008a2',
    steps: [
      { kind: 'consent' },
      { kind: 'field', field: 'city' },
      {
        kind: 'question',
        questionId: '00000000-0000-0000-0000-0000000008a3',
        questionKind: 'QUIZ',
      },
    ],
    cursor: 2,
    answers: {
      fields: { city: 'Porto Alegre', full_name: 'Maria da Silva' },
      questions: [
        {
          questionId: '00000000-0000-0000-0000-0000000008a4',
          optionId: '00000000-0000-0000-0000-0000000008a5',
          answerText: null,
        },
      ],
    },
    reprompts: 1,
    expiresAt: new Date(0).toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function conversationStoreContract(fixture: ConversationStoreFixture): void {
  describe('ConversationStore contract', () => {
    it('loads null when nothing has been stored', async () => {
      const store = await fixture.make();
      const key = await fixture.nextKey();

      expect(await store.load(key)).toBeNull();
    });

    it('round-trips every field, including the nested answers', async () => {
      const store = await fixture.make();
      const key = await fixture.nextKey();
      const conversation = conversationFor(key);
      const before = Date.now();

      await store.save(key, conversation);
      const loaded = await store.load(key);

      expect(loaded).not.toBeNull();
      // Compared field by field rather than by object identity so a failure
      // names what was lost. `toEqual` on the whole object would too, but the
      // nested shapes are the ones that get flattened, and they are named here.
      expect(loaded?.integrationId).toBe(conversation.integrationId);
      expect(loaded?.phone).toBe(conversation.phone);
      expect(loaded?.promotionId).toBe(conversation.promotionId);
      expect(loaded?.memberId).toBe(conversation.memberId);
      expect(loaded?.steps).toEqual(conversation.steps);
      expect(loaded?.cursor).toBe(conversation.cursor);
      expect(loaded?.answers.fields).toEqual(conversation.answers.fields);
      expect(loaded?.answers.questions).toEqual(conversation.answers.questions);
      expect(loaded?.reprompts).toBe(conversation.reprompts);

      // The store owns the expiry: what came back is the window from the save,
      // not the 1970 instant the caller handed in.
      const expiresAt = Date.parse(loaded?.expiresAt ?? '');
      expect(Number.isNaN(expiresAt)).toBe(false);
      expect(expiresAt).toBeGreaterThanOrEqual(before);
      expect(expiresAt).toBeLessThanOrEqual(before + (CONVERSATION_WINDOW_SECONDS + 60) * 1000);
    });

    it('clears what was stored', async () => {
      const store = await fixture.make();
      const key = await fixture.nextKey();

      await store.save(key, conversationFor(key));
      expect(await store.load(key)).not.toBeNull();

      await store.clear(key);
      expect(await store.load(key)).toBeNull();
    });

    it('replaces on a second save rather than appending', async () => {
      const store = await fixture.make();
      const key = await fixture.nextKey();
      const first = conversationFor(key);

      await store.save(key, first);
      await store.save(key, {
        ...first,
        cursor: first.cursor + 1,
        reprompts: 0,
        answers: { fields: { city: 'Canoas' }, questions: [] },
      });
      const loaded = await store.load(key);

      expect(loaded?.cursor).toBe(first.cursor + 1);
      expect(loaded?.reprompts).toBe(0);
      // The whole point: the answers are the second save's, not the two sets
      // merged. A driver that merged would keep `full_name` here.
      expect(loaded?.answers.fields).toEqual({ city: 'Canoas' });
      expect(loaded?.answers.questions).toEqual([]);
    });

    it('loads null once the window has passed', async () => {
      const store = await fixture.make({ windowSeconds: SHORT_WINDOW_SECONDS });
      const key = await fixture.nextKey();

      await store.save(key, conversationFor(key));
      // Asserted BEFORE the wait: without it, a save that silently wrote
      // nothing would make this case pass for the wrong reason — the strongest
      // failure mode a store has, and the one an expiry test hides best.
      expect(await store.load(key)).not.toBeNull();

      const deadline = Date.now() + EXPIRY_DEADLINE_MS;
      let loaded = await store.load(key);
      while (loaded !== null && Date.now() < deadline) {
        await sleep(100);
        loaded = await store.load(key);
      }

      expect(loaded).toBeNull();
    });
  });
}
