import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/supabase/database.types';
import type { WhatsAppTransport } from '@/lib/integrations/whatsapp/transport';

/** Batch caps, so one tick stays inside a serverless function timeout. */
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
 * minutes per row" graph.ts already promises for a dead credential. The spec
 * sentence says "parked at 5 attempts", which counts the retries and not the
 * first send; the ladder is the fixed thing and this is derived from it, so
 * the two cannot drift apart.
 */
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/**
 * How long a row may sit in PROCESSING before a tick takes it back.
 *
 * Chosen against both ends. A healthy claim is one ingest_whatsapp_event call
 * — one transaction, one message, milliseconds — so five minutes is thirty
 * ticks and some three orders of magnitude of headroom; nothing that is
 * working is ever near it. At the other end a listener who texted a hashtag is
 * already unhappy at five minutes of silence but has not yet phoned the
 * station, so it is inside the window where recovering by itself still counts
 * as recovering.
 *
 * Being wrong about it is cheap in one direction only, which is why the number
 * can be a judgement rather than a measurement: too long merely delays a
 * recovery, and too short cannot corrupt anything, because the reclaim skips
 * locked rows (0063) and a live claim is a locked row.
 */
export const STALE_PROCESSING = '5 minutes';

/**
 * A whole batch stops after this many retryable send failures in a row.
 *
 * Task 10's operational note, acted on: `retryable` covers a credential that
 * can be repaired (401, 403), and a credential failure is SYSTEM-WIDE. During
 * a token rotation every row in the batch fails identically, and burning one
 * rung of every row's ladder on the same outage — fifty rows, five rungs, six
 * minutes — can park the entire queue over an incident that fixed itself in
 * ninety seconds. Counting consecutive failures rather than reading the status
 * code keeps this on the near side of cheap: it needs nothing added to
 * SendResult, and it catches a network partition or a Meta outage as well as a
 * bad token, which a 401 test would not.
 *
 * It cannot wedge the queue. The rows already tried carry a future
 * next_attempt_at, so the next tick starts below them, and the untried rows
 * kept their attempts and are simply tried ten seconds later.
 */
export const MAX_CONSECUTIVE_SEND_FAILURES = 3;

/** Seconds to wait before attempt number `attempts + 1`, or null when spent. */
export function nextAttemptDelay(attempts: number): number | null {
  return BACKOFF_SECONDS[attempts] ?? null;
}

export interface TickResult {
  /** Events taken back from an abandoned claim. Normally 0. */
  reclaimed: number;
  /** Events this tick decided. */
  ingested: number;
  /** Events another tick already held, or that stopped being eligible. */
  skipped: number;
  /** Events whose ingestion raised, now scheduled or parked. */
  eventsFailed: number;
  sent: number;
  sendFailed: number;
  /** True when the outbound batch stopped early on consecutive failures. */
  sendAborted: boolean;
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
 */
export async function runTick(deps: {
  supabase: SupabaseClient<Database>;
  transport: WhatsAppTransport;
}): Promise<TickResult> {
  const { supabase, transport } = deps;
  const result: TickResult = {
    reclaimed: 0,
    ingested: 0,
    skipped: 0,
    eventsFailed: 0,
    sent: 0,
    sendFailed: 0,
    sendAborted: false,
  };

  // First, and before anything is selected: a row abandoned in PROCESSING is
  // in no other query's answer, so if this does not look for it nothing ever
  // will. See 0063 for how little it can currently find and why it is here
  // anyway.
  const { data: reclaimed } = await supabase.rpc('reclaim_stale_whatsapp_events', {
    p_stale_after: STALE_PROCESSING,
  });
  result.reclaimed = reclaimed ?? 0;

  // Not a PostgREST select. webhook_events_pending (0058) is an index on an
  // EXPRESSION and `order` cannot name one, so the query lives in SQL where it
  // can be ordered the way the index is — which is also the order that does
  // not starve new messages behind old failures (0063).
  const { data: events } = await supabase.rpc('due_whatsapp_events', {
    p_limit: EVENT_BATCH,
    p_max_attempts: MAX_ATTEMPTS,
  });

  for (const event of events ?? []) {
    const { data, error } = await supabase.rpc('ingest_whatsapp_event', {
      p_event_id: event.id,
    });

    if (error) {
      await scheduleEventRetry(supabase, event.id, event.attempts, error.message);
      result.eventsFailed += 1;
    } else if (outcomeOf(data) === 'skipped') {
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

  // This one IS a PostgREST select: outbox_messages_sendable (0059) is an
  // index on the plain next_attempt_at column, so the filter and the order can
  // both be written here and both are served by it. SENDING is in that index
  // and is deliberately not asked for — nothing in this system writes it, and
  // claiming a row into it before calling the transport would recreate, on the
  // outbound side, exactly the abandoned-claim problem the reclaim above
  // exists to answer on the inbound side.
  const { data: pending } = await supabase
    .from('outbox_messages')
    .select('id, to_phone, body, attempts, integrations(phone_number_id)')
    .eq('status', 'PENDING')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(OUTBOX_BATCH);

  let consecutiveFailures = 0;

  for (const row of pending ?? []) {
    const phoneNumberId = row.integrations?.phone_number_id;

    if (!phoneNumberId) {
      // Unreachable through the schema — integration_id is NOT NULL with a
      // foreign key and phone_number_id is NOT NULL (0057, 0059) — and parked
      // rather than skipped anyway. A `continue` here would leave a row
      // PENDING with a next_attempt_at in the past, which means it is selected
      // at the head of every tick from now on and occupies a slot in each of
      // them, for ever, while looking like an ordinary backlog.
      await supabase
        .from('outbox_messages')
        .update({ status: 'FAILED', last_error: 'integration has no phone_number_id' })
        .eq('id', row.id);
      result.sendFailed += 1;
      continue;
    }

    const send = await transport.sendText({
      phoneNumberId,
      to: row.to_phone,
      body: row.body,
    });

    if (send.ok) {
      // All three together: outbox_messages_sent_shape (0059) makes SENT a
      // claim about sent_at and external_id, and writing the status without
      // them raises 23514.
      await supabase
        .from('outbox_messages')
        .update({
          status: 'SENT',
          external_id: send.externalId,
          sent_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      result.sent += 1;
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
    await supabase
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
    result.sendFailed += 1;

    consecutiveFailures = send.retryable ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
      result.sendAborted = true;
      break;
    }
  }

  return result;
}

/**
 * An event whose ingestion raised. FAILED and never DONE: FAILED means "try
 * again" (0058), and webhook_events_done_shape forbids outcome and
 * processed_at on anything but DONE, so writing either here is 23514.
 *
 * `attempts` comes from the selection rather than from a second read. It is
 * this tick's own value, and the only thing that could have changed it in
 * between is another tick taking the row — which would have made this call
 * return "skipped" instead of raising.
 *
 * When the ladder is spent, next_attempt_at goes to null because there is no
 * next attempt. That is only half of parking: coalesce(next_attempt_at,
 * received_at) then falls back to a received_at in the past, so the row stays
 * due for ever unless something also refuses it on attempts. That something is
 * due_whatsapp_events' p_max_attempts (0063), and the two are one mechanism
 * written in two files.
 */
async function scheduleEventRetry(
  supabase: SupabaseClient<Database>,
  id: string,
  attemptsBefore: number,
  message: string,
): Promise<void> {
  const delay = nextAttemptDelay(attemptsBefore);

  await supabase
    .from('webhook_events')
    .update({
      status: 'FAILED',
      attempts: attemptsBefore + 1,
      last_error: message,
      next_attempt_at: delay === null ? null : new Date(Date.now() + delay * 1000).toISOString(),
    })
    .eq('id', id);
}

/** The outcome ingest_whatsapp_event reported, or null if it reported none. */
function outcomeOf(data: Json): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const outcome = data.outcome;
  return typeof outcome === 'string' ? outcome : null;
}
