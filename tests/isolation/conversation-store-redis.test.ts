import { afterAll, describe, expect, it } from 'vitest';
import type { RedisClientType } from 'redis';
import { RedisConversationStore, connectRedis } from '@/lib/conversation/redis-store';
import { conversationStoreContract } from '../unit/conversation-store-contract';

/**
 * The optional driver, held to the SAME contract as the default one.
 *
 * That is the whole point of the contract existing (spec §6): an optional
 * driver nobody exercises is worse than no driver at all, because it looks like
 * a choice. Two implementations that pass different tests are two
 * implementations that will eventually behave differently on the property that
 * matters most -- what happens when the window has passed.
 *
 * SKIPPED, LOUDLY, when `REDIS_URL` is unset, so CI and every developer without
 * Redis stay green with no new service to install. The skip reports a case of
 * its own rather than reporting nothing: a file that quietly collects zero
 * tests is indistinguishable from one that failed to load, and the isolation
 * guard (scripts/verify-isolation-suite.mjs) exists precisely because a file
 * that did not report once passed for a whole run unnoticed.
 */
const url = process.env.REDIS_URL;

let client: RedisClientType | null = null;

afterAll(async () => {
  if (client) await client.quit();
});

if (!url) {
  describe('RedisConversationStore', () => {
    it('is skipped: REDIS_URL is not set, so the default driver is the live one', () => {
      console.log(
        'RedisConversationStore: SKIPPED — set REDIS_URL (e.g. redis://127.0.0.1:6379) and ' +
          're-run to hold the optional driver to the same contract as the default one.',
      );
      expect(url).toBeUndefined();
    });
  });
} else {
  describe('RedisConversationStore', () => {
    let phoneCounter = 0;

    conversationStoreContract({
      make: async (options) => {
        client ??= await connectRedis(url);
        return new RedisConversationStore(client, options);
      },
      // No foreign key here and none needed: Redis knows nothing about
      // integrations, which is exactly why the contract takes the key from the
      // fixture rather than inventing one.
      nextKey: async () => {
        phoneCounter += 1;
        return {
          integrationId: '00000000-0000-0000-0000-0000000009re',
          phone: `55${Date.now()}${phoneCounter}`,
        };
      },
    });
  });
}
