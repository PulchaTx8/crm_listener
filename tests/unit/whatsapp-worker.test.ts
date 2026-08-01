import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database.types';
import { FakeTransport } from '@/lib/integrations/whatsapp/fake';
import type {
  SendResult,
  SendTextInput,
  WhatsAppTransport,
} from '@/lib/integrations/whatsapp/transport';
import {
  BACKOFF_SECONDS,
  EVENT_BATCH,
  MAX_ATTEMPTS,
  MAX_CONSECUTIVE_SEND_FAILURES,
  OUTBOX_BATCH,
  STALE_PROCESSING,
  nextAttemptDelay,
  runTick,
} from '@/services/whatsapp';

// ---------------------------------------------------------------------------
// A Supabase client that records instead of talking to one.
//
// It records the CALLS, not just their count: which RPCs ran and in what
// order, what the outbox query filtered and ordered by, and the exact patch
// object each update carried. The patches matter more than they look —
// webhook_events_done_shape and outbox_messages_sent_shape (0058, 0059) are
// CHECK constraints on which columns are written TOGETHER, so a patch with one
// key too many is a 23514 in production and nothing at all in a test that only
// asserts on the fields it expected to find. Every update assertion below is a
// whole-object comparison for that reason.
// ---------------------------------------------------------------------------

interface DueEvent {
  id: string;
  attempts: number;
}

interface OutboxRow {
  id: string;
  to_phone: string;
  body: string;
  attempts: number;
  integrations: { phone_number_id: string } | null;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface SelectQuery {
  table: string;
  columns: string;
  filters: [string, string, unknown][];
  order: { column: string; ascending: boolean } | null;
  limit: number | null;
}

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  id: string;
}

interface RpcReply {
  data: unknown;
  error: { message: string } | null;
}

interface Fixture {
  reclaimed?: number;
  events?: DueEvent[];
  outbox?: OutboxRow[];
  ingest?: (id: string) => RpcReply;
}

class FakeDb {
  readonly rpcs: RpcCall[] = [];
  readonly selects: SelectQuery[] = [];
  readonly updates: UpdateCall[] = [];

  constructor(private readonly fixture: Fixture = {}) {}

  rpc(fn: string, args: Record<string, unknown>): Promise<RpcReply> {
    this.rpcs.push({ fn, args });
    if (fn === 'reclaim_stale_whatsapp_events') {
      return Promise.resolve({ data: this.fixture.reclaimed ?? 0, error: null });
    }
    if (fn === 'due_whatsapp_events') {
      return Promise.resolve({ data: this.fixture.events ?? [], error: null });
    }
    if (fn === 'ingest_whatsapp_event') {
      const ingest = this.fixture.ingest ?? (() => recorded);
      return Promise.resolve(ingest(String(args.p_event_id)));
    }
    throw new Error(`unexpected rpc: ${fn}`);
  }

  from(table: string) {
    return {
      select: (columns: string) => this.selectChain(table, columns),
      update: (patch: Record<string, unknown>) => ({
        eq: (_column: string, value: unknown) => {
          this.updates.push({ table, patch, id: String(value) });
          return Promise.resolve({ error: null });
        },
      }),
    };
  }

  private selectChain(table: string, columns: string) {
    const query: SelectQuery = { table, columns, filters: [], order: null, limit: null };
    const rows = this.fixture.outbox ?? [];
    const chain = {
      eq: (column: string, value: unknown) => {
        query.filters.push(['eq', column, value]);
        return chain;
      },
      lte: (column: string, value: unknown) => {
        query.filters.push(['lte', column, value]);
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        query.order = { column, ascending: options?.ascending ?? true };
        return chain;
      },
      limit: (count: number) => {
        query.limit = count;
        return chain;
      },
      then: (
        onfulfilled: (value: { data: OutboxRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        this.selects.push(query);
        return Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
      },
    };
    return chain;
  }
}

const recorded: RpcReply = { data: { outcome: 'recorded' }, error: null };
const skipped: RpcReply = { data: { outcome: 'skipped' }, error: null };

function asClient(db: FakeDb): SupabaseClient<Database> {
  return db as unknown as SupabaseClient<Database>;
}

/** Returns each scripted result in turn, then repeats the last one. */
function scripted(...results: SendResult[]): WhatsAppTransport & { seen: SendTextInput[] } {
  const seen: SendTextInput[] = [];
  let index = 0;
  return {
    seen,
    sendText(input: SendTextInput): Promise<SendResult> {
      seen.push(input);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result ?? { ok: true, externalId: 'wamid.FALLBACK' });
    },
  };
}

const retryableFailure: SendResult = { ok: false, retryable: true, error: 'rate limited' };
const permanentFailure: SendResult = { ok: false, retryable: false, error: 'bad recipient' };

function outboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'ob-1',
    to_phone: '5511988887777',
    body: 'Pronto!',
    attempts: 0,
    integrations: { phone_number_id: '1111' },
    ...overrides,
  };
}

const tick = (db: FakeDb, transport: WhatsAppTransport = new FakeTransport()) =>
  runTick({ supabase: asClient(db), transport });

// ---------------------------------------------------------------------------

describe('nextAttemptDelay', () => {
  it('follows the ladder the spec fixed', () => {
    expect(BACKOFF_SECONDS).toEqual([1, 4, 16, 64, 256]);
    expect(nextAttemptDelay(0)).toBe(1);
    expect(nextAttemptDelay(3)).toBe(64);
    expect(nextAttemptDelay(4)).toBe(256);
  });

  // Parked, not retried forever. An outbox that keeps rows nobody looks at is
  // indistinguishable from one that is working.
  it('returns null once the attempts are spent', () => {
    expect(nextAttemptDelay(5)).toBeNull();
    expect(nextAttemptDelay(9)).toBeNull();
  });

  // Derived from the ladder rather than written down twice: five rungs are
  // five retries after the first send, so a row stops at six attempts and
  // 1+4+16+64+256 = 341 seconds, which is the "roughly six minutes" graph.ts
  // promises. A hard-coded 5 here would silently truncate the last rung.
  it('parks a row exactly when the ladder runs out', () => {
    expect(MAX_ATTEMPTS).toBe(6);
    expect(nextAttemptDelay(MAX_ATTEMPTS - 2)).not.toBeNull();
    expect(nextAttemptDelay(MAX_ATTEMPTS - 1)).toBeNull();
  });

  it('caps a tick at the batch sizes the design fixed', () => {
    expect(EVENT_BATCH).toBe(50);
    expect(OUTBOX_BATCH).toBe(50);
  });
});

describe('runTick: the inbound half', () => {
  // M4. The reclaim is the only thing in the entire system that looks at a row
  // left in PROCESSING: it is outside webhook_events_pending's predicate and
  // outside due_whatsapp_events'. Deleting the call leaves every other
  // assertion in this file green, so this is the one that has to fail.
  //
  // It also pins the ORDER. Reclaiming after the selection means the rows it
  // frees wait a whole extra tick for no reason.
  it('reclaims abandoned events before it selects anything', async () => {
    const db = new FakeDb({ reclaimed: 2 });
    const result = await tick(db);

    expect(db.rpcs.map((call) => call.fn)).toEqual([
      'reclaim_stale_whatsapp_events',
      'due_whatsapp_events',
    ]);
    expect(db.rpcs[0]?.args).toEqual({ p_stale_after: STALE_PROCESSING });
    expect(result.reclaimed).toBe(2);
  });

  // M3's TypeScript half. The order this query needs — the expression
  // webhook_events_pending is built on — cannot be written in PostgREST at
  // all, so selection goes through due_whatsapp_events (0063) and the order
  // itself is pinned in supabase/tests/07_whatsapp_worker.test.sql. What is
  // checked here is that the worker still asks the function that has it, and
  // does not "simplify" back to a .from('webhook_events') that can only order
  // by received_at.
  it('selects due events through the function that owns the ordering, capped and bounded', async () => {
    const db = new FakeDb();
    await tick(db);

    // Found by name and not by position, so this fails for its own reason
    // only: changing what else a tick does first must not land here.
    expect(db.rpcs.find((call) => call.fn === 'due_whatsapp_events')).toEqual({
      fn: 'due_whatsapp_events',
      args: { p_limit: EVENT_BATCH, p_max_attempts: MAX_ATTEMPTS },
    });
    expect(db.selects.some((query) => query.table === 'webhook_events')).toBe(false);
  });

  it('ingests each due event in its own call and counts what came back', async () => {
    const db = new FakeDb({
      events: [
        { id: 'e1', attempts: 0 },
        { id: 'e2', attempts: 0 },
        { id: 'e3', attempts: 0 },
      ],
      ingest: (id) => (id === 'e2' ? skipped : recorded),
    });

    const result = await tick(db);

    expect(db.rpcs.filter((call) => call.fn === 'ingest_whatsapp_event')).toHaveLength(3);
    expect(result.ingested).toBe(2);
    // Counted apart. An event another tick already holds comes back with
    // outcome "skipped" and no error (0062), so counting it as ingested makes
    // a tick report work it never did.
    expect(result.skipped).toBe(1);
    expect(result.eventsFailed).toBe(0);
  });

  it('keeps a poisonous event from taking the batch down with it', async () => {
    const db = new FakeDb({
      events: [
        { id: 'e1', attempts: 0 },
        { id: 'e2', attempts: 0 },
        { id: 'e3', attempts: 0 },
      ],
      ingest: (id) => (id === 'e2' ? { data: null, error: { message: 'boom' } } : recorded),
    });

    const result = await tick(db);

    expect(result.ingested).toBe(2);
    expect(result.eventsFailed).toBe(1);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]?.id).toBe('e2');
  });

  // webhook_events_done_shape (0058): outcome and processed_at belong to DONE
  // and to nothing else, so a FAILED patch carrying either is a 23514 the
  // moment it reaches a real database. A whole-object comparison is what
  // catches a key that should not be there; asserting the four fields
  // individually would not.
  it('writes a failed event as FAILED with a reason and a next attempt, and nothing else', async () => {
    const db = new FakeDb({
      events: [{ id: 'e1', attempts: 2 }],
      ingest: () => ({ data: null, error: { message: 'ingest exploded' } }),
    });

    await tick(db);

    const update = db.updates[0];
    expect(update?.table).toBe('webhook_events');
    expect(update?.patch).toEqual({
      status: 'FAILED',
      attempts: 3,
      last_error: 'ingest exploded',
      next_attempt_at: expect.any(String),
    });
    const wait = Date.parse(String(update?.patch.next_attempt_at)) - Date.now();
    expect(wait).toBeGreaterThan(14_000);
    expect(wait).toBeLessThanOrEqual(16_000);
  });

  // The other half of parking is due_whatsapp_events' attempts cap (0063).
  // Null here alone would leave the row due on every tick for ever, because
  // coalesce(next_attempt_at, received_at) falls back to a received_at in the
  // past — the "retried forever" 0058's type comment warns about.
  it('parks an event whose ladder is spent, with no next attempt at all', async () => {
    const db = new FakeDb({
      events: [{ id: 'e1', attempts: MAX_ATTEMPTS - 1 }],
      ingest: () => ({ data: null, error: { message: 'still broken' } }),
    });

    await tick(db);

    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      attempts: MAX_ATTEMPTS,
      last_error: 'still broken',
      next_attempt_at: null,
    });
  });
});

describe('runTick: the outbound half', () => {
  it('asks for sendable rows the way outbox_messages_sendable is built', async () => {
    const db = new FakeDb();
    await tick(db);

    const query = db.selects[0];
    expect(query?.table).toBe('outbox_messages');
    expect(query?.filters[0]).toEqual(['eq', 'status', 'PENDING']);
    expect(query?.filters[1]?.[0]).toBe('lte');
    expect(query?.filters[1]?.[1]).toBe('next_attempt_at');
    expect(query?.order).toEqual({ column: 'next_attempt_at', ascending: true });
    expect(query?.limit).toBe(OUTBOX_BATCH);
  });

  // outbox_messages_sent_shape (0059) makes SENT a claim about sent_at and
  // external_id: all three go together or the write is a 23514.
  it('records a send with the id Meta returned and the moment it happened', async () => {
    const db = new FakeDb({ outbox: [outboxRow()] });
    const transport = new FakeTransport();

    const result = await tick(db, transport);

    expect(transport.sent).toEqual([
      { phoneNumberId: '1111', to: '5511988887777', body: 'Pronto!' },
    ]);
    expect(db.updates[0]?.patch).toEqual({
      status: 'SENT',
      external_id: 'wamid.FAKE1',
      sent_at: expect.any(String),
    });
    expect(result.sent).toBe(1);
    expect(result.sendFailed).toBe(0);
  });

  // M2. A number Meta rejected never becomes a good one. If a permanent
  // failure is written back as PENDING with a delay, this row is retried for
  // six minutes and then parked anyway — the ladder spent on an answer that
  // could not change, and `retryable` reduced to decoration.
  it('parks a permanent failure at once instead of putting it back on the ladder', async () => {
    const db = new FakeDb({ outbox: [outboxRow({ attempts: 0 })] });

    const result = await tick(db, scripted(permanentFailure));

    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      attempts: 1,
      last_error: 'bad recipient',
    });
    expect(result.sendFailed).toBe(1);
    expect(result.sent).toBe(0);
  });

  it('puts a retryable failure back on the ladder at the rung its attempts have reached', async () => {
    const db = new FakeDb({ outbox: [outboxRow({ attempts: 2 })] });

    await tick(db, scripted(retryableFailure));

    const patch = db.updates[0]?.patch;
    expect(patch).toEqual({
      status: 'PENDING',
      attempts: 3,
      last_error: 'rate limited',
      next_attempt_at: expect.any(String),
    });
    const wait = Date.parse(String(patch?.next_attempt_at)) - Date.now();
    expect(wait).toBeGreaterThan(14_000);
    expect(wait).toBeLessThanOrEqual(16_000);
  });

  // FAILED is terminal on the outbound side — outbox_messages_sendable (0059)
  // excludes it — so this is where a row stops rather than where it waits.
  it('parks a retryable failure once the ladder is spent', async () => {
    const db = new FakeDb({ outbox: [outboxRow({ attempts: BACKOFF_SECONDS.length })] });

    await tick(db, scripted(retryableFailure));

    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      attempts: MAX_ATTEMPTS,
      last_error: 'rate limited',
    });
  });

  // Task 10's operational note. A credential failure is system-wide: every row
  // in the batch fails identically, and letting the whole batch burn a rung on
  // one outage is how a rotation that lasted ninety seconds parks a queue.
  it('stops a batch that is failing systematically instead of burning every ladder', async () => {
    const rows = Array.from({ length: 6 }, (_, index) => outboxRow({ id: `ob-${index}` }));
    const db = new FakeDb({ outbox: rows });
    const transport = scripted(retryableFailure);

    const result = await tick(db, transport);

    expect(transport.seen).toHaveLength(MAX_CONSECUTIVE_SEND_FAILURES);
    expect(db.updates).toHaveLength(MAX_CONSECUTIVE_SEND_FAILURES);
    expect(result.sendAborted).toBe(true);
    // The rows it did not reach keep their attempts and their PENDING status,
    // so the next tick tries them ten seconds later having lost nothing.
    expect(db.updates.map((update) => update.id)).toEqual(['ob-0', 'ob-1', 'ob-2']);
  });

  // The counter is about an outage, not about failures in general. Rejected
  // recipients scattered through a batch are ordinary traffic, and stopping on
  // them would leave good rows unsent behind bad ones.
  it('does not stop on failures that are merely frequent', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => outboxRow({ id: `ob-${index}` }));
    const db = new FakeDb({ outbox: rows });
    const transport = scripted(
      retryableFailure,
      retryableFailure,
      permanentFailure,
      retryableFailure,
      retryableFailure,
    );

    const result = await tick(db, transport);

    expect(transport.seen).toHaveLength(5);
    expect(result.sendAborted).toBe(false);
    expect(result.sendFailed).toBe(5);
  });

  // Unreachable through the schema, and parked rather than skipped anyway: a
  // `continue` would leave the row PENDING with a next_attempt_at in the past,
  // which means it heads every future batch and occupies a slot in each of
  // them for ever while looking like an ordinary backlog.
  it('parks a row whose integration cannot say which number to send from', async () => {
    const db = new FakeDb({ outbox: [outboxRow({ integrations: null })] });
    const transport = scripted(retryableFailure);

    const result = await tick(db, transport);

    expect(transport.seen).toHaveLength(0);
    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      last_error: 'integration has no phone_number_id',
    });
    expect(result.sendFailed).toBe(1);
  });
});

describe('FakeTransport wiring', () => {
  it('is the transport a tick uses when no token is configured', async () => {
    const transport = new FakeTransport();
    const result = await transport.sendText({ phoneNumberId: '1', to: '2', body: 'x' });
    expect(result).toMatchObject({ ok: true });
  });
});
