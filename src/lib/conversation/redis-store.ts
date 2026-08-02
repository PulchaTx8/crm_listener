/**
 * The optional `ConversationStore` driver (design spec D6).
 *
 * A conversation is exactly what a TTL store holds well: small, short-lived,
 * read and written once per message, and worth nothing once it is over. The
 * expiry here is the key's own, so unlike the Postgres driver there is nothing
 * to sweep and no index to keep.
 *
 * It is a DRIVER AND NOT A DEPENDENCY. The application boots with `REDIS_URL`
 * unset and uses Postgres, which is why this file is reached through the
 * interface and never imported by anything that must work without it.
 *
 * The lease that serialises turns stays in Postgres whichever driver is live
 * (spec §4.3). That is deliberate: a second lock here would be two answers to
 * one question, and the two would eventually disagree.
 */
import { createClient, type RedisClientType } from 'redis';
import type { Conversation } from './steps';
import {
  CONVERSATION_WINDOW_SECONDS,
  parseConversation,
  type ConversationKey,
  type ConversationStore,
} from './store';

export interface RedisConversationStoreOptions {
  /** Overridden only by the contract suite's expiry case. Defaults to D5's thirty minutes. */
  windowSeconds?: number;
}

/**
 * The key, and the reason it is namespaced: a Station's Redis may be shared
 * with a cache, and `conv:` says whose these are. The phone is in the key, in
 * the clear, exactly as it is in `whatsapp_conversations.phone` -- and the TTL
 * is what bounds how long it is there, which is the same thirty minutes the
 * window itself lasts.
 */
export function conversationRedisKey(key: ConversationKey): string {
  return `conv:${key.integrationId}:${key.phone}`;
}

export class RedisConversationStore implements ConversationStore {
  private readonly windowSeconds: number;

  constructor(
    private readonly client: RedisClientType,
    options: RedisConversationStoreOptions = {},
  ) {
    this.windowSeconds = options.windowSeconds ?? CONVERSATION_WINDOW_SECONDS;
  }

  async load(key: ConversationKey): Promise<Conversation | null> {
    const raw = await this.client.get(conversationRedisKey(key));
    if (raw === null) return null;
    // An expired key is simply absent, so there is no expiry check here and no
    // way for one to be forgotten -- the property the Postgres driver has to
    // spell out in a WHERE clause is structural in this one.
    return parseConversation(JSON.parse(raw), `redis, integration ${key.integrationId}`);
  }

  async save(key: ConversationKey, value: Conversation): Promise<void> {
    const expiresAt = new Date(Date.now() + this.windowSeconds * 1000).toISOString();
    // PX rather than EX: the contract suite runs the expiry case on a window of
    // a couple of seconds, and a driver that could only express whole seconds
    // would round a sub-second window to zero -- which Redis refuses outright.
    await this.client.set(conversationRedisKey(key), JSON.stringify({ ...value, expiresAt }), {
      PX: Math.max(1, Math.round(this.windowSeconds * 1000)),
    });
  }

  async clear(key: ConversationKey): Promise<void> {
    await this.client.del(conversationRedisKey(key));
  }
}

/**
 * Connects, and hands back the client so the caller owns closing it.
 *
 * Separate from the store on purpose: a worker holds ONE connection for its
 * lifetime, while a store is cheap and made per turn. Merging the two would
 * open a socket per message.
 */
export async function connectRedis(url: string): Promise<RedisClientType> {
  const client: RedisClientType = createClient({ url });
  // Without a listener, node-redis throws on a connection error and takes the
  // process with it -- a Redis outage must degrade a tick, not end the worker.
  client.on('error', (cause: unknown) => {
    console.error(`redis: ${cause instanceof Error ? cause.message : String(cause)}`);
  });
  await client.connect();
  return client;
}
