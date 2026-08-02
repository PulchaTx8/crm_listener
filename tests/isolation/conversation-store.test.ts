import { afterAll, describe } from 'vitest';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import { admin, cleanupUsers, provisionCustomer, seedIntegration } from './harness';
import { conversationStoreContract } from '../unit/conversation-store-contract';

afterAll(cleanupUsers);

/**
 * The default `ConversationStore` driver, held to the shared contract and
 * driven through the SAME service-role construction the application uses.
 *
 * That last part is the whole reason this file is here rather than in pgTAP.
 * Block 5a shipped three tables whose `service_role` grants did not exist and
 * the block was non-functional end to end — pgTAP could not see it, because
 * pgTAP runs as `postgres` and ignores ACL, and the route tests could not see it
 * either, because they mock the client. `whatsapp_conversations` is granted
 * `select, insert, update, delete` in 0065 and this suite is what proves all
 * four verbs actually work for the role that issues them: `load` needs SELECT,
 * `save` needs INSERT and UPDATE (it upserts), `clear` needs DELETE.
 */

/**
 * One Station with one live integration, provisioned once for the file. The
 * integration is what the store's key points at — `integration_id` is a foreign
 * key, so an invented uuid would be refused before any behaviour was tested.
 */
let integration: Promise<string> | null = null;

function integrationId(): Promise<string> {
  integration ??= (async () => {
    // The label is unique per RUN, not per file. `cleanupUsers` cannot always
    // delete the users it made -- several columns reference auth.users with no
    // cascade, and the harness says so -- and `createUser` refuses an email
    // that already exists. With a fixed label this file passes once after a
    // `db:reset` and then fails on the fixture until the next one, which is
    // exactly the wrong behaviour for a suite meant to be re-run while a driver
    // is being written.
    const label = `conv-store-${Date.now()}`;
    const customer = await provisionCustomer(label);
    return seedIntegration(customer, `pnid-${label}`);
  })();
  return integration;
}

let phoneCounter = 0;

describe('PostgresConversationStore', () => {
  conversationStoreContract({
    make: async (options) => new PostgresConversationStore(admin, options),
    nextKey: async () => {
      phoneCounter += 1;
      // Unique within the run AND across runs: this table is not swept between
      // suites, and a key reused from an earlier run would start a case with a
      // row already in it.
      return { integrationId: await integrationId(), phone: `55${Date.now()}${phoneCounter}` };
    },
  });
});
