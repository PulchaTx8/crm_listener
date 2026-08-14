import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePublicKey } from '@/lib/widget/code';
import { PostgresConversationStore } from '@/lib/conversation/postgres-store';
import { parseInboundTurn, runConversationTurn } from '@/services/conversation';
import { LOCAL_SUPABASE_DB_URL } from '../local-supabase';
import { admin, cleanupUsers, provisionCustomer, seedIntegration, signInAs } from './harness';

/**
 * Block 19a, Task 9, Step 2. "Hundreds at once" is the requirement (the
 * spec's own words), and tests/isolation/whatsapp.test.ts's races cannot
 * stand in for it: those fixtures prove exactly two concurrent callers, and
 * two is not enough to catch a code derived from anything the two calls
 * could share -- a counter, a timestamp truncated to the millisecond, a
 * sequence tied to the connection. `mint_widget_link` (0178) generates its
 * code from `extensions.gen_random_bytes(24)`, which SHOULD be immune to
 * that class of bug by construction, and this file is what actually asks the
 * question rather than trusting the construction: two hundred distinct
 * listeners, at one Station, hashtagging in over one overlapping window --
 * twenty-five of them in flight at any instant, which is what the stack
 * actually serves. See IN_FLIGHT below for why that number is the honest one
 * and why "all two hundred at literally the same instant" was never a thing
 * this stack did, only a thing it failed at.
 *
 * THIS IS THE TEST THAT FALLS OVER IF ANYBODY LATER DERIVES A CODE FROM
 * SHARED STATE. A per-process counter, a value seeded from `now()` truncated
 * too coarsely, a pool of pre-generated codes handed out round-robin -- any
 * of those would pass tests/isolation/widget.test.ts's ten-at-once ceiling
 * case (which contests a lock, not a generator) and pass every unit test
 * (which never runs two calls at once), and every one of them would show up
 * here as a duplicate code or a message that reached the wrong phone.
 *
 * TWO HUNDRED DISTINCT PHONES, DELIBERATELY, not one phone sending two
 * hundred messages. D2's two-minute window is keyed on (member, purpose):
 * two messages from the SAME listener inside two minutes are supposed to
 * collapse to one link (mint_widget_link answers null on the second), and a
 * fixture built that way would be testing the window, not the generator.
 * Every phone here is its own listener, so every one of the two hundred
 * calls is a genuinely independent first contact and every one of them must
 * produce a real, distinct, correctly-addressed link.
 *
 * RUN THROUGH runConversationTurn, THE PRODUCTION PATH -- ingest, then
 * (since no live conversation exists for any of these two hundred phones,
 * D7) sendServiceLink -- rather than calling mint_widget_link directly. The
 * generator alone being safe under concurrency would prove nothing about
 * enqueue_whatsapp_outbound addressing the right phone under the same
 * concurrency; driving the whole turn is what proves the pairing holds too.
 */

const STATION_LABEL = `wa-link-load-${Date.now()}`;
const LISTENER_COUNT = 200;

/**
 * How many of the two hundred chains are in flight at any instant.
 *
 * NOT A REDUCTION IN WHAT THIS FILE PROVES, and the measurement is why. The
 * first version issued all two hundred at once through `Promise.all`, and
 * PostgREST answered what its own pool actually allows:
 *
 *     ingest_whatsapp_event failed for 11900000121:
 *     Timed out acquiring connection from connection pool.
 *
 * Roughly one run in seven, measured locally at 2 failures in 14 — and in CI
 * the same exhaustion arrives in its harsher form, the connection dropped
 * before any answer at all, which surfaces as `TypeError: fetch failed` with
 * no cause vitest can render and takes the whole file down as a suite error.
 * (Seen on run 31711257965 of `block-19-whatsapp-entry`, and again on 31753576133.)
 *
 * So the burst never delivered two hundred SIMULTANEOUS database operations —
 * the pool was always the ceiling. What it delivered above that ceiling was
 * queueing, and past the timeout, failure. Twenty-five sits just above what
 * the stack serves, which keeps every bit of contention that was ever real:
 * `mint_widget_link` still generates codes concurrently, and
 * `enqueue_whatsapp_outbound` still addresses rows concurrently, which is the
 * class of bug this file exists to catch. All two hundred listeners still run,
 * still overlap in time, and every assertion below is unchanged.
 *
 * `supabase/config.toml` exposes no PostgREST pool setting — `[db.pooler]` is
 * supavisor, which PostgREST does not use locally — so raising the ceiling
 * instead of respecting it was not available.
 */
const IN_FLIGHT = 25;

/**
 * `items` through `run`, at most `limit` at a time, results in input order.
 *
 * Every worker's promise goes into one `Promise.all`, so a second failure
 * after the first still has a handler attached and cannot escape as an
 * unhandled rejection — which is the shape that made the original failure
 * unreadable.
 */
async function mapWithBoundedConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ListenerFixture {
  /** Digits only, no country code -- what members.phone_normalized stores. */
  localPhone: string;
  /** What WhatsApp delivers as `from` -- the country code prefixed on. */
  deliveredPhone: string;
  eventId: string;
  externalId: string;
}

let companyId: string;
let organizationId: string;
let listeners: ListenerFixture[];
/** One turn outcome per listener, same order as `listeners`. */
let outcomes: Awaited<ReturnType<typeof runConversationTurn>>[];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * `widget_link_tokens` grants NOTHING to `service_role` -- 0178's own
 * comment states the design: RLS on with no policy AND the ACL revoked, so
 * even the admin client this file uses everywhere else answers "permission
 * denied for table widget_link_tokens", by construction, the same wall every
 * listener-bearing table in this schema puts up. The pairing proof below
 * needs to read the table directly rather than through a SECURITY DEFINER
 * door (consuming the code through one would burn it, and burning two
 * hundred codes here has nothing to do with what this test is proving), so
 * it reaches Postgres directly as the local superuser -- the same
 * `LOCAL_SUPABASE_DB_URL` connection `tests/isolation/retention.test.ts` and
 * `job-health.test.ts` already use for the identical reason: a table or a
 * procedure no API role can reach.
 */
async function superuserRows<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const client = new Client({ connectionString: LOCAL_SUPABASE_DB_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params as unknown[]);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

afterAll(cleanupUsers);

beforeAll(async () => {
  const customer = await provisionCustomer(STATION_LABEL);
  organizationId = customer.organizationId;
  companyId = customer.companyId;

  const phoneNumberId = `pnid-${STATION_LABEL}`;
  await seedIntegration(customer, phoneNumberId);

  // A live widget installation -- mint_widget_link (0178) refuses with
  // "this Station has no live widget installation" (P0002) without one, the
  // same requirement tests/isolation/whatsapp.test.ts's own fixtures carry.
  const { error: installError } = await customer.adminClient.rpc('upsert_widget_installation', {
    p_company_id: companyId,
    p_public_key: generatePublicKey(),
    p_enabled: true,
    p_allowed_origins: ['https://link-load.example'],
  });
  if (installError) throw new Error(`upsert_widget_installation failed: ${installError.message}`);

  // The music hashtag (D6/0177), through the real door as the owner --
  // templates.manage passes on the owner bypass, the createPrizeAs
  // convention every isolation fixture in this suite follows.
  const owner = await signInAs(customer.email, customer.password);
  const HASHTAG = '#LOADTEST';
  const { error: hashtagError } = await owner.rpc('set_service_hashtags', {
    p_company_id: companyId,
    p_music: HASHTAG,
    // '' rather than null -- see tests/e2e/whatsapp-entry.spec.ts's own
    // comment on the identical call: the door folds '' to NULL itself, and
    // the generated Args type does not accept a bare null here.
    p_service: '',
  });
  if (hashtagError) throw new Error(`set_service_hashtags failed: ${hashtagError.message}`);

  // TWO HUNDRED DISTINCT PHONES. '11' + nine digits keeps every local number
  // the shape members.phone_normalized already holds elsewhere in this
  // suite (tests/isolation/whatsapp.test.ts's own '11999990000'); the
  // trailing counter, zero-padded, is what keeps all two hundred distinct
  // from each other and from any fixture another file in this run may have
  // left behind.
  listeners = Array.from({ length: LISTENER_COUNT }, (_, index) => {
    const localPhone = `11${String(900_000_000 + index)}`;
    return {
      localPhone,
      deliveredPhone: `55${localPhone}`,
      eventId: '',
      externalId: '',
    };
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const rows = listeners.map((listener, index) => {
    const wamid = `wamid.link-load-${STATION_LABEL}-${index}`;
    const externalId = sha256Hex(wamid);
    listener.externalId = externalId;
    return {
      provider: 'WHATSAPP' as const,
      external_id: externalId,
      payload: {
        wamid,
        metadata: { phone_number_id: phoneNumberId },
        from: listener.deliveredPhone,
        profile_name: `Load Listener ${index}`,
        text: `quero uma musica ${HASHTAG}`,
        timestamp,
      },
    };
  });

  // ONE INSERT, batching all two hundred rows: the ingest+send race below is
  // what this file exists to run concurrently, not the seed write.
  const { data: inserted, error: insertError } = await admin
    .from('webhook_events')
    .insert(rows)
    .select('id, external_id');
  if (insertError || !inserted) {
    throw new Error(`could not seed webhook_events: ${insertError?.message}`);
  }
  const idByExternalId = new Map(inserted.map((row) => [row.external_id, row.id]));
  for (const listener of listeners) {
    const eventId = idByExternalId.get(listener.externalId);
    if (!eventId) {
      throw new Error(`no inserted webhook_events row for external_id ${listener.externalId}`);
    }
    listener.eventId = eventId;
  }

  // THE RACE ITSELF. One PostgresConversationStore, shared across all two
  // hundred chains -- it wraps the same admin client and carries no
  // per-call state of its own, so sharing it is not a shortcut, it is what
  // a real worker tick does too (src/services/whatsapp.ts's own drainEvents
  // constructs exactly one store per tick and reuses it across the whole
  // batch). Every phone in `listeners` is distinct, so claim_conversation_turn
  // never contends across the two hundred -- what IS contended, genuinely,
  // is the one thing this file exists to test: mint_widget_link generating
  // two hundred codes and enqueue_whatsapp_outbound addressing two hundred
  // rows, with twenty-five of those calls live against the database at any
  // instant and every one of the two hundred inside one overlapping window.
  // IN_FLIGHT's own comment records why twenty-five is the number, and what
  // the unbounded version actually bought (failures, not contention).
  const store = new PostgresConversationStore(admin);
  outcomes = await mapWithBoundedConcurrency(listeners, IN_FLIGHT, async (listener) => {
    const { data, error } = await admin.rpc('ingest_whatsapp_event', {
      p_event_id: listener.eventId,
    });
    if (error) {
      throw new Error(`ingest_whatsapp_event failed for ${listener.localPhone}: ${error.message}`);
    }
    return runConversationTurn({ supabase: admin, store }, parseInboundTurn(data));
  });
}, 300_000);

/**
 * Every ':link' row this fixture's Station produced, read back by
 * `company_id` rather than by `.in('dedupe_key', <two hundred 69-character
 * keys>)`. The `IN` list was the first draft and it PostgREST-round-trips as
 * a GET whose query string carries all two hundred keys at once -- measured
 * against this stack, that came back "URI too long" before a single
 * assertion ran. `company_id` is unique to this fixture (a fresh
 * provisionCustomer call, Task 9's own Station), so scoping by it is exactly
 * as precise for this file's purposes and costs one short query instead of
 * one enormous one.
 */
async function fetchLoadOutboxRows(): Promise<
  { id: string; to_phone: string | null; body: string; dedupe_key: string }[]
> {
  const { data: rows, error } = await admin
    .from('outbox_messages')
    .select('id, to_phone, body, dedupe_key')
    .eq('company_id', companyId)
    .like('dedupe_key', '%:link');
  if (error) throw new Error(`could not read the outbox: ${error.message}`);
  return rows ?? [];
}

describe('Block 19a — two hundred listeners hashtagging in at once', () => {
  it('finishes every one of the two hundred concurrent turns as link_sent', () => {
    // Not 'busy' (every phone is distinct, so no lease ever contends) and
    // not 'already_answered' (D2's window is per-listener, and none of
    // these two hundred has asked twice) -- either would mean this run
    // silently sent fewer than two hundred links, and the counts below
    // would then be trivially satisfied by proving nothing.
    const kinds = outcomes.map((outcome) => outcome.kind);
    const notLinkSent = kinds.filter((kind) => kind !== 'link_sent');
    expect(notLinkSent, `every turn should finish link_sent; saw: ${JSON.stringify(kinds)}`).toEqual(
      [],
    );
    expect(kinds).toHaveLength(LISTENER_COUNT);
  });

  it('leaves exactly two hundred outbox rows, one per listener, each dedupe key its own', async () => {
    const rows = await fetchLoadOutboxRows();

    expect(rows, 'one outbox row per listener, no fewer').toHaveLength(LISTENER_COUNT);
    // Every dedupe key this run expected is present exactly once -- catches
    // a collision (two listeners settling on the same key) as surely as a
    // shortfall (a listener answered by nobody), neither of which the bare
    // length check above can tell apart from the other.
    const expectedKeys = new Set(listeners.map((listener) => `${listener.externalId}:link`));
    const seenKeys = new Set(rows.map((row) => row.dedupe_key));
    expect(seenKeys.size).toBe(LISTENER_COUNT);
    expect(seenKeys).toEqual(expectedKeys);
  });

  it('addresses each row to the exact phone that asked, none doubled and none crossed', async () => {
    const rows = await fetchLoadOutboxRows();

    const phoneByDedupeKey = new Map(
      listeners.map((listener) => [`${listener.externalId}:link`, listener.deliveredPhone]),
    );
    for (const row of rows) {
      expect(row.to_phone, `row ${row.dedupe_key} addressed correctly`).toBe(
        phoneByDedupeKey.get(row.dedupe_key),
      );
    }

    // NO LISTENER ANSWERED TWICE. Every phone appears in the outbox exactly
    // once -- a generator that occasionally produced the SAME row twice (a
    // retried insert with no idempotency, say) would still pass the count
    // assertion above if it also silently dropped a different listener; this
    // is the one that would catch that trade directly, phone by phone.
    const phones = rows.map((row) => row.to_phone);
    const distinctPhones = new Set(phones);
    expect(distinctPhones.size, 'every phone appears at most once in the outbox').toBe(
      phones.length,
    );
  });

  it('resolves each code back to the SAME listener whose message actually carried it', async () => {
    // Every assertion above proves a COUNT: two hundred codes, two hundred
    // outbox rows, two hundred members. None of them proves the PAIRING the
    // spec actually asks for -- "the right listener". A concurrency bug that
    // crossed member_id between two mints (two mint_widget_link calls racing
    // and each writing the other's member_id into its own token row) would
    // leave every assertion above green while handing one listener a session
    // as another -- the worst outcome this block can produce -- and nothing
    // until now would catch it.
    //
    // The chain read back, per listener: the code in THAT listener's own
    // outbox row -> sha256(code) -> widget_link_tokens.token_hash -> its
    // member_id -> members.phone_normalized -> compared against the LOCAL
    // phone that listener was seeded with. Keying by localPhone throughout
    // (rather than re-deriving it from deliveredPhone) is deliberate: it is
    // the one value this file already trusts as ground truth for "which
    // listener this is", seeded before any of the concurrency below ran.
    const rows = await fetchLoadOutboxRows();
    expect(rows).toHaveLength(LISTENER_COUNT);

    const rowByDedupeKey = new Map(rows.map((row) => [row.dedupe_key, row]));

    const hashByLocalPhone = new Map<string, string>();
    for (const listener of listeners) {
      const row = rowByDedupeKey.get(`${listener.externalId}:link`);
      if (!row) throw new Error(`no outbox row for listener ${listener.localPhone}`);
      const match = row.body.match(/[?&]k=([^&\s]+)/);
      const code = match?.[1];
      if (!code) throw new Error(`outbox row carries no widget link code: ${row.body}`);
      hashByLocalPhone.set(listener.localPhone, sha256Hex(code));
    }

    // Scoped by company_id and organization_id -- the same fix
    // fetchLoadOutboxRows above already applies to its own query, and for a
    // related reason: two hundred 64-character token_hash values (or two
    // hundred uuids) in an `.in()` filter is the "URI too long" trap that
    // comment already names, and widget_link_tokens answers service_role
    // with 42501 regardless (see superuserRows's own comment) -- so this
    // reads through the superuser connection, scoped by the ids unique to
    // THIS fixture's Station/Organization (a fresh provisionCustomer call),
    // which is exactly as precise as a two-hundred-item list and reachable
    // in the one way this table actually allows.
    const tokens = await superuserRows<{ token_hash: string; member_id: string }>(
      'select token_hash, member_id from public.widget_link_tokens where company_id = $1',
      [companyId],
    );
    expect(tokens, 'one minted token row per listener').toHaveLength(LISTENER_COUNT);

    const memberIdByHash = new Map(tokens.map((row) => [row.token_hash, row.member_id]));

    const members = await superuserRows<{ id: string; phone_normalized: string | null }>(
      'select id, phone_normalized from public.members where organization_id = $1',
      [organizationId],
    );
    const phoneByMemberId = new Map(members.map((row) => [row.id, row.phone_normalized]));

    for (const listener of listeners) {
      const hash = hashByLocalPhone.get(listener.localPhone);
      const memberId = hash ? memberIdByHash.get(hash) : undefined;
      expect(
        memberId,
        `the code sent to ${listener.deliveredPhone} resolves to a minted widget_link_tokens row`,
      ).toBeDefined();
      expect(
        phoneByMemberId.get(memberId as string),
        `the code sent to ${listener.deliveredPhone} resolves to THAT listener's own member row, never another listener's`,
      ).toBe(listener.localPhone);
    }
  });

  it('mints two hundred distinct codes -- no code repeated across any two listeners', async () => {
    const rows = await fetchLoadOutboxRows();
    expect(rows).toHaveLength(LISTENER_COUNT);

    // The code travels only inside the link's `k=` query parameter
    // (buildServiceLink, src/lib/widget/service-link.ts) -- there is no
    // other column to read it from, by design (0178's own comment: only the
    // SHA-256 is stored, the raw value exists in the message and nowhere
    // else).
    const codes = (rows ?? []).map((row) => {
      const match = row.body?.match(/[?&]k=([^&\s]+)/);
      if (!match) throw new Error(`outbox row carries no widget link code: ${row.body}`);
      return match[1];
    });

    expect(new Set(codes).size, 'every one of the two hundred codes is distinct').toBe(
      LISTENER_COUNT,
    );
  });

  it('registers two hundred distinct listeners, none merged and none missing', async () => {
    const { count, error } = await admin
      .from('members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .in(
        'phone_normalized',
        listeners.map((listener) => listener.localPhone),
      );
    if (error) throw new Error(`could not count members: ${error.message}`);
    expect(count, 'exactly one members row per phone -- none collapsed together').toBe(
      LISTENER_COUNT,
    );
  });
});
