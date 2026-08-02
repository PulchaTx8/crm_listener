import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/supabase/database.types';
import { CONVERSATION_WINDOW_SECONDS, type ConversationStore } from '@/lib/conversation/store';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import { parseInteractive } from '@/lib/integrations/whatsapp/interactive';
import { parseInboundTurn, runConversationTurn } from '@/services/conversation';
import type { WhatsAppTransport } from '@/lib/integrations/whatsapp/transport';

/**
 * Batch caps, so one tick does a bounded amount of work.
 *
 * NOT a serverless function timeout, which an earlier version of this line
 * named: this application is a long-running Next.js server deployed through
 * EasyPanel, and there is no platform execution limit to stay inside. Naming
 * one sends the next reader looking for a constraint that does not exist, and
 * the reclaim in 0063 leaned on the same wrong picture.
 *
 * What the caps really bound is how much a tick that does NOT finish can leave
 * behind — a deploy restarting the container, the proxy cutting the request
 * off, the process killed. A full batch is fifty ingest transactions plus fifty
 * sequential HTTPS calls to Meta; everything it claimed and had not settled
 * waits on `reclaim_stale_whatsapp_claims`' five minutes (0063), so the cap is
 * the size of that exposure. It also keeps a tick inside the request timeout
 * the pg_cron job records its result against (0064), which is what keeps
 * `net._http_response` a usable diagnostic rather than a wall of timeouts.
 *
 * A backlog larger than a cap simply takes more ticks; nothing is dropped,
 * because the selection reads the table rather than being handed a list.
 */
export const EVENT_BATCH = 50;
export const OUTBOX_BATCH = 50;

/**
 * The retry ladder, in seconds. A row waits BACKOFF_SECONDS[n] before attempt
 * n + 2, and is parked once the rungs run out — an outbox that keeps retrying
 * rows nobody looks at is indistinguishable from one that is working.
 */
export const BACKOFF_SECONDS = [1, 4, 16, 64, 256] as const;

/**
 * Where a row stops. Five rungs means one first attempt plus five retries, so
 * six sends spread over 1 + 4 + 16 + 64 + 256 = 341 seconds — the "roughly six
 * minutes per row" graph.ts already promises for a dead credential.
 *
 * DERIVED, on the controller's ruling, rather than written down as a number.
 * The plan's "parked at 5 attempts" counts retries and not sends, and was loose
 * wording rather than a specification; hard-coding either 5 or 6 here would let
 * the constant and the ladder drift apart silently, and the ladder is the thing
 * the design actually fixed.
 */
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/**
 * What a parked event's next_attempt_at becomes.
 *
 * Infinity rather than null, and it is load-bearing. Inbound FAILED stays
 * inside webhook_events_pending on purpose (0058 — inbound FAILED means "try
 * again"), so a null here would make coalesce(next_attempt_at, received_at)
 * fall back to a received_at that is always in the past, and the row would be
 * due on every tick for ever: the "permanently unroutable message gets retried
 * forever" 0058's own type comment warns about. Infinity puts it beyond
 * due_whatsapp_events' index condition permanently, and at the FAR end of that
 * index — where a null would have sorted it FIRST, in front of every real
 * message, on every tick.
 *
 * Verified against PostgREST rather than assumed: the JSON string "infinity"
 * reaches the column as timestamptz infinity.
 */
export const PARKED_AT = 'infinity';

/**
 * How long a claim may stay open before a tick takes it back.
 *
 * The age of the CLAIM, not of the row — webhook_events.claimed_at and
 * outbox_messages.claimed_at exist for this and nothing else. A healthy claim
 * is one ingest call or one send, so five minutes is thirty ticks of headroom
 * and nothing that is working comes near it; a listener is unhappy at five
 * minutes of silence but has not yet phoned the station, so recovering inside
 * that window still counts as recovering.
 *
 * Being wrong is cheap in one direction only, which is why this can be a
 * judgement rather than a measurement: too long merely delays a recovery, and
 * too short cannot corrupt anything, because the reclaim skips locked rows
 * (0063) and a live claim is a locked row.
 */
export const STALE_CLAIM = '5 minutes';

/**
 * A whole batch stops after this many retryable send failures in a row.
 *
 * Task 10's operational note, acted on: `retryable` covers a credential that
 * can be repaired (401, 403), and a credential failure is SYSTEM-WIDE. During a
 * token rotation every row in the batch fails identically, and burning one rung
 * of every row's ladder on the same outage — fifty rows, five rungs, six
 * minutes — can park the entire queue over an incident that fixed itself in
 * ninety seconds. Counting consecutive failures rather than reading the status
 * code keeps this on the near side of cheap: it needs nothing added to
 * SendResult, and it catches a network partition or a Meta outage as well as a
 * bad token, which a 401 test would not.
 *
 * It cannot wedge the queue. The rows already tried carry a future
 * next_attempt_at, and the rows never reached are released by the reclaim once
 * their claim goes stale, so a later tick sees both again.
 */
export const MAX_CONSECUTIVE_SEND_FAILURES = 3;

/** Seconds to wait before attempt number `attempts + 1`, or null when spent. */
export function nextAttemptDelay(attempts: number): number | null {
  return BACKOFF_SECONDS[attempts] ?? null;
}

export interface TickResult {
  /** Events taken back from an abandoned claim. Normally 0. */
  reclaimedEvents: number;
  /** Messages taken back from an abandoned claim. Normally 0. */
  reclaimedMessages: number;
  /** Events this tick decided. */
  ingested: number;
  /** Events another tick already held, or that stopped being eligible. */
  skipped: number;
  /** Conversation turns taken: a conversation opened, advanced, refused or ended. */
  turns: number;
  /** Turns left for the next tick because another worker held the phone's lease. */
  turnsBusy: number;
  /** Events whose ingestion raised, now scheduled or parked. */
  eventsFailed: number;
  /** Conversations and leases the sweep removed. */
  swept: number;
  /** Messages Meta accepted. */
  sent: number;
  sendFailed: number;
  /** True when the outbound batch stopped early on consecutive failures. */
  sendAborted: boolean;
  /**
   * Database calls that came back with an error. Zero is what "nothing to do"
   * looks like; anything else is what "nothing worked" looks like, and without
   * this counter both are the same all-zero response.
   */
  dbErrors: number;
}

type MaybeError = { message: string } | null;

/**
 * supabase-js RESOLVES on a database error rather than throwing, so an
 * unchecked call is not a call that succeeded — it is a call whose failure was
 * discarded. A failed select yields `data: null`, the loop after it iterates
 * zero times, and the tick reports a clean sweep of an empty queue. Every
 * trigger for that is already in this repository's history: a stale PostgREST
 * schema cache after types are regenerated, a missing grant, a transient
 * outage.
 *
 * Returns true when the caller should treat the step as not having happened.
 *
 * Logs `message` only, never `details`: PostgreSQL puts the constraint name in
 * the message and the offending ROW VALUES in the detail, and webhook_events
 * carries a phone number and a WhatsApp profile name (0058).
 */
function failed(result: TickResult, where: string, error: MaybeError): boolean {
  if (error === null) return false;
  result.dbErrors += 1;
  console.error(`whatsapp tick: ${where}: ${error.message}`);
  return true;
}

/**
 * One tick. It holds NO rule about promotions, listeners or entries — those are
 * ingest_whatsapp_event's, in one transaction per event. That is what makes the
 * master spec's promise real: swapping this polling loop for pgmq later changes
 * the trigger and nothing else.
 *
 * Each event is ingested in its own transaction, so one poisonous event cannot
 * roll back a batch. A backlog larger than the cap simply takes more ticks;
 * nothing is dropped, because the selection reads the table rather than being
 * handed a list.
 *
 * The two halves are independent on purpose: an inbound failure must not stop
 * replies going out, and the reverse.
 */
export async function runTick(deps: {
  supabase: SupabaseClient<Database>;
  transport: WhatsAppTransport;
  /**
   * Where conversations live. Defaults to the Postgres driver; the Redis one is
   * selected by environment (design spec D6) and is passed in here rather than
   * chosen in this file, so the worker holds no opinion about which is live.
   */
  store?: ConversationStore;
}): Promise<TickResult> {
  const { supabase, transport } = deps;
  const store = deps.store ?? new PostgresConversationStore(supabase);
  const result: TickResult = {
    reclaimedEvents: 0,
    reclaimedMessages: 0,
    ingested: 0,
    skipped: 0,
    turns: 0,
    turnsBusy: 0,
    swept: 0,
    eventsFailed: 0,
    sent: 0,
    sendFailed: 0,
    sendAborted: false,
    dbErrors: 0,
  };

  // First, and before anything is claimed: a row abandoned mid-claim is in no
  // other query's answer, so if this does not look for it nothing will.
  const { data: reclaimed, error } = await supabase.rpc('reclaim_stale_whatsapp_claims', {
    p_stale_after: STALE_CLAIM,
  });
  if (!failed(result, 'reclaim stale claims', error)) {
    const counts = reclaimed?.[0];
    result.reclaimedEvents = counts?.events ?? 0;
    result.reclaimedMessages = counts?.messages ?? 0;
  }

  // Beside the reclaim and before the queues, because both are cleanup of the
  // same kind: what a tick that did not finish left behind. A conversation is
  // already over the moment its window passes -- the store filters on load --
  // so this bounds how long the dead row, which holds a phone number, survives.
  const { data: swept, error: sweepError } = await supabase.rpc('sweep_expired_conversations');
  if (!failed(result, 'sweep expired conversations', sweepError)) {
    const counts = swept?.[0];
    result.swept = (counts?.conversations ?? 0) + (counts?.leases ?? 0);
  }

  await drainEvents(supabase, store, result);
  await drainOutbox(supabase, transport, result);

  return result;
}

/**
 * The inbound half. Selection is an RPC and not a PostgREST query:
 * webhook_events_pending (0058) is an index on an EXPRESSION and `order` cannot
 * name one, so the query lives in SQL where it can be ordered the way the index
 * is — which is also the order that does not starve new messages behind old
 * failures (0063).
 *
 * No claim here, and none needed: ingest_whatsapp_event takes the row FOR
 * UPDATE SKIP LOCKED inside the transaction that decides it, so an overlapping
 * tick gets outcome "skipped" and writes nothing.
 */
async function drainEvents(
  supabase: SupabaseClient<Database>,
  store: ConversationStore,
  result: TickResult,
): Promise<void> {
  const { data: events, error } = await supabase.rpc('due_whatsapp_events', {
    p_limit: EVENT_BATCH,
  });
  if (failed(result, 'select due events', error)) return;

  for (const event of events ?? []) {
    const { data, error: ingestError } = await supabase.rpc('ingest_whatsapp_event', {
      p_event_id: event.id,
      p_window_seconds: CONVERSATION_WINDOW_SECONDS,
    });

    const outcome = outcomeOf(data);

    if (ingestError) {
      await deferEvent(supabase, result, event.id, event.attempts, ingestError.message);
      result.eventsFailed += 1;
    } else if (outcome === 'conversation' || outcome === 'no_hashtag') {
      // The door resolved the message and left the event PROCESSING, because
      // whether this is an answer depends on a conversation store this database
      // may not hold (Block 5b). The turn decides, and closes the event.
      await runTurn(supabase, store, result, event, data);
    } else if (outcome === 'skipped') {
      // The door declined it: another tick holds it, or it stopped being
      // RECEIVED or FAILED between the selection and the call (0062). Counted
      // apart from ingested, because a tick that reports fifty ingestions it
      // did not perform is a tick whose numbers cannot be used to find
      // anything.
      result.skipped += 1;
    } else {
      result.ingested += 1;
    }
  }
}

/**
 * One conversation turn, run against the state store rather than inside a
 * transaction — the engine is a pure function in TypeScript, which is what
 * makes every branch of the conversation testable with nothing running.
 *
 * FAILURES ARE DEFERRED, NOT SWALLOWED. The event is still PROCESSING when this
 * is called, so a throw that was merely logged would leave it claimed until the
 * reclaim released it five minutes later. deferEvent puts it back on the ladder
 * where the next tick sees it in a second, and the message is not lost.
 *
 * A `busy` turn is NOT a failure and is not deferred: another worker holds this
 * phone's lease and is about to finish it. The event is left exactly as it is
 * and the reclaim brings it back if that worker dies.
 */
async function runTurn(
  supabase: SupabaseClient<Database>,
  store: ConversationStore,
  result: TickResult,
  event: { id: string; attempts: number },
  data: Json,
): Promise<void> {
  try {
    const outcome = await runConversationTurn({ supabase, store }, parseInboundTurn(data));
    if (outcome.kind === 'busy') {
      result.turnsBusy += 1;
      return;
    }
    result.turns += 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await deferEvent(supabase, result, event.id, event.attempts, message);
    result.eventsFailed += 1;
  }
}

/**
 * The outbound half. The batch is CLAIMED by the statement that selects it
 * (0063), which is what stops two overlapping ticks sending the same reply
 * twice — and they do overlap: pg_cron fires every ten seconds whether or not
 * the previous tick returned, and fifty sequential calls to Meta take longer
 * than that.
 */
async function drainOutbox(
  supabase: SupabaseClient<Database>,
  transport: WhatsAppTransport,
  result: TickResult,
): Promise<void> {
  const { data: claimed, error } = await supabase.rpc('claim_outbox_batch', {
    p_limit: OUTBOX_BATCH,
  });
  if (failed(result, 'claim an outbound batch', error)) return;

  let consecutiveFailures = 0;

  for (const row of claimed ?? []) {
    if (!row.phone_number_id) {
      // Unreachable through the schema — integration_id is NOT NULL with a
      // foreign key and phone_number_id is NOT NULL (0057, 0059) — and parked
      // rather than skipped anyway. Left claimed it would sit until the
      // reclaim released it and then repeat; left PENDING it would head every
      // future batch for ever while looking like ordinary backlog.
      const { error: parkError } = await supabase
        .from('outbox_messages')
        .update({ status: 'FAILED', last_error: 'integration has no phone_number_id' })
        .eq('id', row.id);
      failed(result, 'park a row with no sender number', parkError);
      result.sendFailed += 1;
      continue;
    }

    // Block 5b: one queue, two shapes. A null `interactive` is every reply 5a
    // writes and goes out as text; anything else is a message of the
    // conversation, and its body column carries the same words for the operator
    // rather than for Meta.
    const interactive = row.interactive === null ? null : parseInteractive(row.interactive);
    if (row.interactive !== null && interactive === null) {
      // Stored, but not a shape the API would take — a payload written by an
      // older deploy, or a promotion configured past a Cloud API limit. Meta
      // answers a 400 to it every time, so the ladder would spend six paid
      // attempts arriving at the same answer. Parked with the reason on the
      // row, where the operator asking "why did nobody get it?" will look.
      const { error: parkError } = await supabase
        .from('outbox_messages')
        .update({ status: 'FAILED', last_error: 'stored interactive payload is not sendable' })
        .eq('id', row.id);
      failed(result, 'park a row with an unsendable interactive payload', parkError);
      result.sendFailed += 1;
      continue;
    }

    const send = interactive
      ? await transport.sendInteractive({
          phoneNumberId: row.phone_number_id,
          to: row.to_phone,
          interactive,
        })
      : await transport.sendText({
          phoneNumberId: row.phone_number_id,
          to: row.to_phone,
          body: row.body,
        });

    if (send.ok) {
      // Meta has accepted it. `sent` counts that fact, and is incremented even
      // when the write below fails, because the message really did go out.
      result.sent += 1;

      // status, sent_at and external_id together: outbox_messages_sent_shape
      // (0059) makes SENT a claim about the other two, and writing the status
      // alone raises 23514. attempts goes with them so a message that
      // succeeded on its fourth try does not record three.
      const { error: sentError } = await supabase
        .from('outbox_messages')
        .update({
          status: 'SENT',
          external_id: send.externalId,
          sent_at: new Date().toISOString(),
          attempts: row.attempts + 1,
        })
        .eq('id', row.id);

      // THE WORST FAILURE IN THIS FILE, called out rather than folded in with
      // the others: Meta has the message and we could not record it. The row
      // stays SENDING, which is already better than the PENDING it would have
      // been without the claim — invisible to the next tick until the reclaim's
      // stale threshold, rather than re-sent ten seconds later. When the
      // reclaim does release it, the listener is told twice.
      //
      // The row id is ours and safe to log. The external id is NOT: a wamid
      // decodes to bytes containing the counterparty's phone number (0058), so
      // it is deliberately absent from this line.
      if (failed(result, `record an accepted send for row ${row.id}`, sentError)) {
        console.error(
          `whatsapp tick: row ${row.id} was accepted by Meta and not recorded; it will be re-sent when its claim goes stale`,
        );
      }

      consecutiveFailures = 0;
      continue;
    }

    const attempts = row.attempts + 1;
    // A permanent failure gets no delay at all, whatever the ladder has left:
    // a number Meta rejected never becomes a good one, and retrying it spends
    // six minutes of queue on an answer that cannot change.
    const delay = send.retryable ? nextAttemptDelay(row.attempts) : null;

    // sent_at and external_id are untouched on both branches. This row is not
    // SENT, and 0059 requires both to be null on any status that is not.
    const { error: settleError } = await supabase
      .from('outbox_messages')
      .update(
        delay === null
          ? { status: 'FAILED', attempts, last_error: send.error }
          : {
              status: 'PENDING',
              attempts,
              last_error: send.error,
              next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
            },
      )
      .eq('id', row.id);
    failed(result, 'settle a failed send', settleError);
    result.sendFailed += 1;

    consecutiveFailures = send.retryable ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
      result.sendAborted = true;
      break;
    }
  }
}

/**
 * An event whose ingestion raised. FAILED and never DONE: FAILED means "try
 * again" (0058), and webhook_events_done_shape forbids outcome and processed_at
 * on anything but DONE, so writing either here is 23514.
 *
 * `attempts` comes from the selection rather than from a second read. It is
 * this tick's own value, and the only thing that could have changed it in
 * between is another tick taking the row — which would have made this call
 * return "skipped" instead of raising.
 */
async function deferEvent(
  supabase: SupabaseClient<Database>,
  result: TickResult,
  id: string,
  attemptsBefore: number,
  message: string,
): Promise<void> {
  const delay = nextAttemptDelay(attemptsBefore);

  const { error } = await supabase
    .from('webhook_events')
    .update({
      status: 'FAILED',
      attempts: attemptsBefore + 1,
      last_error: message,
      next_attempt_at:
        delay === null ? PARKED_AT : new Date(Date.now() + delay * 1000).toISOString(),
    })
    .eq('id', id);

  failed(result, 'defer a failed event', error);
}

/** The outcome ingest_whatsapp_event reported, or null if it reported none. */
function outcomeOf(data: Json): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const outcome = data.outcome;
  return typeof outcome === 'string' ? outcome : null;
}
