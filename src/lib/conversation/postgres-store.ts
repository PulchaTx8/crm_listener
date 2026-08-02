/**
 * The default `ConversationStore`: a row in `whatsapp_conversations` (0065).
 *
 * The client MUST be one built by `createServiceClient()`. The table has RLS
 * enabled and no policy at all, with every grant revoked from `anon` and
 * `authenticated` -- it is a system table like `webhook_events`, and the four
 * verbs this file issues (SELECT, INSERT, UPDATE, DELETE) are granted to
 * `service_role` and to nobody else. A user client here reads an empty table and
 * writes nothing, silently.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/supabase/database.types';
import type { Conversation } from './steps';
import {
  CONVERSATION_WINDOW_SECONDS,
  parseConversation,
  type ConversationKey,
  type ConversationStore,
} from './store';

export interface PostgresConversationStoreOptions {
  /** Overridden only by the contract suite's expiry case. Defaults to D5's thirty minutes. */
  windowSeconds?: number;
}

export class PostgresConversationStore implements ConversationStore {
  private readonly windowSeconds: number;

  constructor(
    private readonly client: SupabaseClient<Database>,
    options: PostgresConversationStoreOptions = {},
  ) {
    this.windowSeconds = options.windowSeconds ?? CONVERSATION_WINDOW_SECONDS;
  }

  async load(key: ConversationKey): Promise<Conversation | null> {
    // The expiry is filtered HERE and not left to the sweep. The sweep runs on
    // the worker's tick and only bounds how long a dead row survives; a
    // conversation is over the moment its window passes, and a listener whose
    // next message lands between the two must not be answered as though it had
    // not (D5, and D10's silence depends on it).
    const { data, error } = await this.client
      .from('whatsapp_conversations')
      .select('state, expires_at')
      .eq('integration_id', key.integrationId)
      .eq('phone', key.phone)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const conversation = parseConversation(
      data.state,
      `whatsapp_conversations, integration ${key.integrationId}`,
    );
    // The COLUMN is the expiry, not the copy inside the state: the column is
    // what this query filtered on, what the index covers and what the sweep
    // deletes by, so returning anything else would let a caller reason about a
    // window nothing enforces.
    return { ...conversation, expiresAt: data.expires_at };
  }

  async save(key: ConversationKey, value: Conversation): Promise<void> {
    const expiresAt = new Date(Date.now() + this.windowSeconds * 1000).toISOString();

    // One instant, written to both places, so the state's copy and the column
    // cannot disagree. `updated_at` is set by hand because this table carries no
    // touch trigger and an upsert would otherwise leave it at the insert.
    const { error } = await this.client.from('whatsapp_conversations').upsert(
      {
        integration_id: key.integrationId,
        phone: key.phone,
        state: { ...value, expiresAt } as unknown as Json,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'integration_id,phone' },
    );

    if (error) throw error;
  }

  async clear(key: ConversationKey): Promise<void> {
    // Deleted rather than tombstoned: once the entry is written there is
    // nothing here worth keeping, and the row holds a phone number (0065's
    // comment, and the reason DELETE is granted on this table and no other in
    // the block).
    const { error } = await this.client
      .from('whatsapp_conversations')
      .delete()
      .eq('integration_id', key.integrationId)
      .eq('phone', key.phone);

    if (error) throw error;
  }
}
