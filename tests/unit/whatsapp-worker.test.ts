import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  PARKED_AT,
  STALE_CLAIM,
  nextAttemptDelay,
  runTick,
} from '@/services/whatsapp';

// ---------------------------------------------------------------------------
// A Supabase client that records instead of talking to one.
//
// It records the CALLS, not just their count: which RPCs ran and in what order,
// and the exact patch object each update carried. The patches matter more than
// they look — webhook_events_done_shape and outbox_messages_sent_shape (0058,
// 0059) are CHECK constraints on which columns are written TOGETHER, so a patch
// with one key too many is a 23514 in production and nothing at all in a test
// that only asserts the fields it expected. Every update assertion below is a
// whole-object comparison for that reason.
//
// Two things it models rather than stubs, because a test that cannot see them
// cannot defend them:
//
//  * claim_outbox_batch is STATEFUL. The real one marks its rows SENDING in the
//    statement that selects them, so a second call finds nothing; a fake that
//    returned the same rows twice would let the overlapping-ticks test pass
//    against an implementation that never claimed anything.
//  * from('outbox_messages').select() still works and returns the SAME rows
//    every time — the non-claiming query the worker must NOT use. That is what
//    gives the overlapping-ticks test something to fail against.
// ---------------------------------------------------------------------------

interface DueEvent {
  id: string;
  attempts: number;
}

interface ClaimedRow {
  id: string;
  to_phone: string;
  body: string;
  attempts: number;
  phone_number_id: string | null;
  // Only the discarded PostgREST shape uses this. It exists so a worker mutated
  // back to a plain select finds a usable row and really does send twice,
  // rather than failing for some unrelated reason.
  integrations: { phone_number_id: string } | null;
}

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
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
  reclaimed?: { events: number; messages: number };
  events?: DueEvent[];
  outbox?: ClaimedRow[];
  ingest?: (id: string) => RpcReply;
  /** RPC name -> message, to make that call come back as a failure. */
  rpcErrors?: Record<string, string>;
  /** Returns a message to fail an update, or null to let it through. */
  updateError?: (call: UpdateCall) => string | null;
}

class FakeDb {
  readonly rpcs: RpcCall[] = [];
  readonly selects: string[] = [];
  readonly updates: UpdateCall[] = [];
  private claimable: ClaimedRow[] | null = null;

  constructor(private readonly fixture: Fixture = {}) {}

  rpc(fn: string, args: Record<string, unknown>): Promise<RpcReply> {
    this.rpcs.push({ fn, args });

    const failure = this.fixture.rpcErrors?.[fn];
    if (failure !== undefined) return Promise.resolve({ data: null, error: { message: failure } });

    if (fn === 'reclaim_stale_whatsapp_claims') {
      return Promise.resolve({
        data: [this.fixture.reclaimed ?? { events: 0, messages: 0 }],
        error: null,
      });
    }
    if (fn === 'due_whatsapp_events') {
      return Promise.resolve({ data: this.fixture.events ?? [], error: null });
    }
    if (fn === 'claim_outbox_batch') {
      // Claimed in the act of being selected, exactly as 0063 does it: what one
      // call takes, the next cannot have.
      if (this.claimable === null) this.claimable = [...(this.fixture.outbox ?? [])];
      const batch = this.claimable;
      this.claimable = [];
      return Promise.resolve({ data: batch, error: null });
    }
    if (fn === 'ingest_whatsapp_event') {
      const ingest = this.fixture.ingest ?? (() => recorded);
      return Promise.resolve(ingest(String(args.p_event_id)));
    }
    throw new Error(`unexpected rpc: ${fn}`);
  }

  from(table: string) {
    return {
      // The non-claiming query, kept working so a worker mutated back to it
      // behaves the way that worker really would.
      select: (_columns: string) => this.selectChain(table),
      update: (patch: Record<string, unknown>) => ({
        eq: (_column: string, value: unknown) => {
          const call: UpdateCall = { table, patch, id: String(value) };
          this.updates.push(call);
          const failure = this.fixture.updateError?.(call) ?? null;
          return Promise.resolve({ error: failure === null ? null : { message: failure } });
        },
      }),
    };
  }

  private selectChain(table: string) {
    const rows = this.fixture.outbox ?? [];
    const chain = {
      eq: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (
        onfulfilled: (value: { data: ClaimedRow[]; error: null }) => unknown,
        onrejected?: (reason: unknown) => unknown,
      ) => {
        this.selects.push(table);
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
    // The outbox worker under test here only ever sends text (5a's four
    // reply strings). No test in this file exercises an interactive send, so
    // this double does not model one -- it fails loudly instead of pretending.
    sendInteractive(): Promise<SendResult> {
      throw new Error('scripted() test double does not model sendInteractive');
    },
  };
}

const retryableFailure: SendResult = { ok: false, retryable: true, error: 'rate limited' };
const permanentFailure: SendResult = { ok: false, retryable: false, error: 'bad recipient' };

function outboxRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    id: 'ob-1',
    to_phone: '5511988887777',
    body: 'Pronto!',
    attempts: 0,
    phone_number_id: '1111',
    integrations: { phone_number_id: '1111' },
    ...overrides,
  };
}

const tick = (db: FakeDb, transport: WhatsAppTransport = new FakeTransport()) =>
  runTick({ supabase: asClient(db), transport });

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorLog.mockRestore();
});

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

  // Controller's ruling (M8): MAX_ATTEMPTS stays DERIVED from the ladder. The
  // plan's "parked at 5 attempts" counts retries and not sends, and was loose
  // wording rather than a specification — five rungs are five retries after the
  // first send, so a row stops at six attempts and 1+4+16+64+256 = 341 seconds,
  // which is the "roughly six minutes" graph.ts promises. A literal here would
  // let the two drift apart, so this asserts the relationship and not the
  // number.
  it('parks a row exactly when the ladder runs out', () => {
    expect(MAX_ATTEMPTS).toBe(BACKOFF_SECONDS.length + 1);
    expect(nextAttemptDelay(MAX_ATTEMPTS - 2)).not.toBeNull();
    expect(nextAttemptDelay(MAX_ATTEMPTS - 1)).toBeNull();
  });

  it('caps a tick at the batch sizes the design fixed', () => {
    expect(EVENT_BATCH).toBe(50);
    expect(OUTBOX_BATCH).toBe(50);
  });
});

describe('runTick: the inbound half', () => {
  // The reclaim is the only thing in the system that looks at an abandoned
  // claim: such a row is outside due_whatsapp_events' and claim_outbox_batch's
  // predicates both. Deleting the call leaves every other assertion in this
  // file green, so this is the one that has to fail.
  //
  // It also pins the ORDER. Reclaiming after the selection means the rows it
  // frees wait a whole extra tick for no reason.
  it('reclaims abandoned claims before it selects anything, and counts both queues', async () => {
    const db = new FakeDb({ reclaimed: { events: 2, messages: 3 } });
    const result = await tick(db);

    // The reclaim ran, and ran FIRST. Asserted as a position rather than by
    // enumerating the whole sequence, so this fails for its own reason only:
    // changing what a tick does AFTER the reclaim must not land here.
    expect(db.rpcs[0]).toEqual({
      fn: 'reclaim_stale_whatsapp_claims',
      args: { p_stale_after: STALE_CLAIM },
    });
    expect(result.reclaimedEvents).toBe(2);
    expect(result.reclaimedMessages).toBe(3);
  });

  // The order this query needs — the expression webhook_events_pending is built
  // on — cannot be written in PostgREST at all, so selection goes through
  // due_whatsapp_events (0063) and the order itself is pinned in
  // supabase/tests/07_whatsapp_worker.test.sql. What is checked here is that
  // the worker still asks the function that has it, and has not been
  // "simplified" back to a .from('webhook_events') that can only order by
  // received_at.
  it('selects due events through the function that owns the ordering', async () => {
    const db = new FakeDb();
    await tick(db);

    expect(db.rpcs.find((call) => call.fn === 'due_whatsapp_events')).toEqual({
      fn: 'due_whatsapp_events',
      args: { p_limit: EVENT_BATCH },
    });
    expect(db.selects).not.toContain('webhook_events');
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
    // outcome "skipped" and no error (0062), so counting it as ingested makes a
    // tick report work it never did.
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
  // catches a key that should not be there; four individual assertions would
  // not.
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

  // Infinity, and NOT null. Inbound FAILED stays inside webhook_events_pending
  // on purpose, so a null next_attempt_at falls back to a received_at in the
  // past: the row would be due on every tick for ever AND would sort ahead of
  // every real message while doing it.
  it('parks an event whose ladder is spent beyond the end of time, not at the front of the queue', async () => {
    const db = new FakeDb({
      events: [{ id: 'e1', attempts: MAX_ATTEMPTS - 1 }],
      ingest: () => ({ data: null, error: { message: 'still broken' } }),
    });

    await tick(db);

    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      attempts: MAX_ATTEMPTS,
      last_error: 'still broken',
      next_attempt_at: PARKED_AT,
    });
    expect(db.updates[0]?.patch.next_attempt_at).not.toBeNull();
  });

  // supabase-js RESOLVES on a database error, so an unchecked call is not a
  // call that succeeded — `data` is null, the loop runs zero times, and the
  // tick reports a clean sweep of an empty queue. A stale PostgREST schema
  // cache or a missing grant produces exactly this, and both have happened in
  // this repository.
  it('reports a failed event query as a failure rather than as an empty queue', async () => {
    const db = new FakeDb({
      rpcErrors: { due_whatsapp_events: 'schema cache is stale' },
      outbox: [outboxRow()],
    });
    const transport = new FakeTransport();

    const result = await tick(db, transport);

    expect(result.dbErrors).toBe(1);
    expect(result.ingested).toBe(0);
    expect(errorLog).toHaveBeenCalled();
    // And the other half still runs: an inbound failure must not stop replies
    // going out.
    expect(transport.sent).toHaveLength(1);
    expect(result.sent).toBe(1);
  });

  it('counts a defer write that itself fails', async () => {
    const db = new FakeDb({
      events: [{ id: 'e1', attempts: 0 }],
      ingest: () => ({ data: null, error: { message: 'boom' } }),
      updateError: (call) => (call.table === 'webhook_events' ? 'permission denied' : null),
    });

    const result = await tick(db);

    expect(result.eventsFailed).toBe(1);
    expect(result.dbErrors).toBe(1);
  });
});

describe('runTick: the outbound half', () => {
  it('claims its batch through the function that marks the rows in the same statement', async () => {
    const db = new FakeDb();
    await tick(db);

    expect(db.rpcs.find((call) => call.fn === 'claim_outbox_batch')).toEqual({
      fn: 'claim_outbox_batch',
      args: { p_limit: OUTBOX_BATCH },
    });
    expect(db.selects).not.toContain('outbox_messages');
  });

  // THE ONE THIS SECTION EXISTS FOR. pg_net is fire-and-forget and pg_cron
  // fires on schedule whether or not the last tick returned, while a full batch
  // is fifty ingest calls plus fifty HTTPS calls to Meta — so two ticks overlap
  // under ordinary load. With a plain select both see the same PENDING rows in
  // the same order and both send, and dedupe_key cannot help: it stops a second
  // ROW being enqueued, not one row being SENT twice.
  it('sends a message once even when two ticks overlap', async () => {
    const db = new FakeDb({ outbox: [outboxRow()] });
    const transport = scripted({ ok: true, externalId: 'wamid.ONCE' });

    const [first, second] = await Promise.all([tick(db, transport), tick(db, transport)]);

    expect(transport.seen).toHaveLength(1);
    expect(first.sent + second.sent).toBe(1);
    // And exactly one settle write, so it is the claim that stopped it rather
    // than the send being deduplicated somewhere downstream.
    expect(db.updates.filter((update) => update.patch.status === 'SENT')).toHaveLength(1);
  });

  // outbox_messages_sent_shape (0059) makes SENT a claim about sent_at and
  // external_id: all three go together or the write is a 23514. attempts is
  // there too — without it a message that succeeded on its fourth try records
  // three.
  it('records a send with the id Meta returned, the moment it happened, and the try it took', async () => {
    const db = new FakeDb({ outbox: [outboxRow({ attempts: 3 })] });
    const transport = new FakeTransport();

    const result = await tick(db, transport);

    expect(transport.sent).toEqual([
      { phoneNumberId: '1111', to: '5511988887777', body: 'Pronto!' },
    ]);
    expect(db.updates[0]?.patch).toEqual({
      status: 'SENT',
      external_id: 'wamid.FAKE1',
      sent_at: expect.any(String),
      attempts: 4,
    });
    expect(result.sent).toBe(1);
    expect(result.sendFailed).toBe(0);
  });

  // A number Meta rejected never becomes a good one. If a permanent failure is
  // written back as PENDING with a delay, this row is retried for six minutes
  // and then parked anyway — the ladder spent on an answer that could not
  // change, and `retryable` reduced to decoration.
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

  // Unreachable through the schema, and parked rather than skipped anyway.
  it('parks a row whose integration cannot say which number to send from', async () => {
    const db = new FakeDb({
      outbox: [outboxRow({ phone_number_id: null, integrations: null })],
    });
    const transport = scripted(retryableFailure);

    const result = await tick(db, transport);

    expect(transport.seen).toHaveLength(0);
    expect(db.updates[0]?.patch).toEqual({
      status: 'FAILED',
      last_error: 'integration has no phone_number_id',
    });
    expect(result.sendFailed).toBe(1);
  });

  // The mirror case, and the worst failure in the file: Meta accepted the
  // message and the write recording it did not land. `sent` still counts it,
  // because it really did go out; dbErrors says the books do not agree.
  it('counts a send Meta accepted even when recording it fails, and says so loudly', async () => {
    const db = new FakeDb({
      outbox: [outboxRow({ id: 'ob-lost' })],
      updateError: () => 'could not serialize access',
    });

    const result = await tick(db, new FakeTransport());

    expect(result.sent).toBe(1);
    expect(result.dbErrors).toBe(1);

    const logged = errorLog.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('ob-lost');
    // NEVER the wamid: it decodes to bytes containing the counterparty's phone
    // number (0058), which is why external_id is a hash everywhere it outlives
    // the payload. A log line is not an exception to that.
    expect(logged).not.toContain('wamid.FAKE1');
  });

  it('reports a failed claim as a failure and sends nothing', async () => {
    const db = new FakeDb({
      outbox: [outboxRow()],
      rpcErrors: { claim_outbox_batch: 'permission denied for table outbox_messages' },
    });
    const transport = new FakeTransport();

    const result = await tick(db, transport);

    expect(result.dbErrors).toBe(1);
    expect(transport.sent).toHaveLength(0);
    expect(result.sent).toBe(0);
  });
});

describe('FakeTransport wiring', () => {
  it('is the transport a tick uses when no token is configured', async () => {
    const transport = new FakeTransport();
    const result = await transport.sendText({ phoneNumberId: '1', to: '2', body: 'x' });
    expect(result).toMatchObject({ ok: true });
  });
});
