# Block 5a — The WhatsApp spine — Verification Report

Branch `block-5a`, cut from `block-4c`'s merged head at **`04206fe`** (PR #17).
Spec in `docs/superpowers/specs/2026-07-31-block-5a-whatsapp-spine-design.md`,
plan in `docs/superpowers/plans/2026-07-31-block-5a-whatsapp-spine.md`,
execution ledger in
`.superpowers/sdd/2026-07-31-block-5a-whatsapp-spine/progress.md`. Fourteen
tasks, this report is the fourteenth.

**Amended by the whole-branch fix wave** (`.superpowers/sdd/2026-07-31-block-5a-whatsapp-spine/final-fix-report.md`),
which is the last work on this branch before it is offered for merge. Three
Important items, eight minors, one production defect on the headline path and one
new isolation case. Every section below that the wave touched says so where it
says it, rather than in a footnote: §2 (what shipped), §3 (D9), the new §4.1
(deviations), §6.3, §6.5 and §8.

One sentence, from the spec: *a listener sends a hashtag to their Station's
WhatsApp number and is entered into the promotion, or registered and then
entered, and told so.* This is the first of two passes — **5a is the spine**
(transport, idempotency, the worker, the outbox, a single-message entry path);
**5b is the conversation** (art, call to action, buttons, requested fields,
the promotion's questions), and needs the same spine underneath it.

**36 commits, 39 files, +12,193 / −10** over `04206fe..HEAD` — the thirteen
reviewed tasks, Task 14, Task 14's own fix round, and the whole-branch fix
wave (fourteen files: five migrations, two pgTAP files, the isolation suite
and its guard's floor, the worker's batch-cap comment, the generated types,
and the spec, runbook and this report). Measured with `git rev-list --count`
and `git diff --shortstat 04206fe`, excluding the untracked `Arte/`, as the
last action before the commit and on the tree about to be committed, because
the figure cannot be stable while the file stating it is still being edited.
The deletion count stays small because almost every file here was created on
this branch: a line rewritten in `0059` reads as an insertion against
`04206fe`, not as a replacement.

---

## 1. Gates

Measured by the **whole-branch fix wave**, which is the last work on this
branch, on a freshly reset local stack, in gate order — pgTAP before the
isolation suite, for the reason §1.1 gives. The figures Task 14 recorded are
in the right-hand column.

| Gate | Result | Task 14 |
| --- | --- | --- |
| `npm run lint` | No ESLint warnings or errors | same |
| `npm run typecheck` | clean | same |
| `npm test` | **405 passed**, 30 files | 405 |
| `npm run db:test` | **585 PASS**, 8 files | 553 |
| `npm run test:isolation` | **192 passed**, 15 files, **GUARD-COMPLETE** — every file accounted for, every file above its own case floor, nothing skipped | 190 |
| `CI=1 npx playwright test` | **23 passed** (42.2s) | 23 |

`+32` pgTAP assertions: 29 in `06_whatsapp` (the two prunes' predicates, the
two new payload guards, and the operator-typed phone shape) and 3 in
`07_whatsapp_worker` (`anon` against the three worker RPCs). `+2` isolation
cases, both driving `runTick` itself.

**The isolation suite's worker-death flake (§6.6) fired on this wave's first
full run** — `Test Files 14 passed (15)`, 192 tests passed, one worker dead,
and `scripts/verify-isolation-suite.mjs` refused it with *"a file's worker
died without the file being reported"*. The second run was guard-complete and
is the one recorded above. That is the guard doing exactly the job it was
written for; the flake remains open and uncaused.

### 1.1 Local gate order matters, and CI does not need to care

Two environment facts, both spent real diagnosis time in this block and both
belong in `docs/block-5a-runbook.md` §8 for the same reason:

- **The isolation suite commits rows that outlive it.** The twelve-round
  races and the privilege-boundary cases in `tests/isolation/whatsapp.test.ts`
  write real, uncleaned rows into `webhook_events` and `outbox_messages`.
  `due_whatsapp_events`/`claim_outbox_batch` carry no tenant scope, so a
  pgTAP run against the same database afterwards can see rows that are not
  its own fixture's and fail an exact-row-set assertion for a reason that has
  nothing to do with a code defect (Task 13 hit this directly — three
  transient pgTAP failures, resolved by `supabase db reset`, and most of
  `07_whatsapp_worker.test.sql`'s assertions were then scoped to their own
  fixture ids to stop relying on reset order at all). This run reset before
  pgTAP and ran the isolation suite after, matching that precedent; CI does
  not need the same care because its `db` job always runs pgTAP first on a
  stack nothing else has touched.
- **`npm run test:e2e` needs `CI=1` locally.** `next dev` under Playwright's
  eleven parallel workers is too slow for several Server-Action-heavy specs
  once the machine has just finished running the isolation suite, and the
  timeout reads as a failure that has nothing to do with the code
  (`CI=1 npx playwright test --reporter=line`, confirmed 23/23 twice in
  Task 13 immediately after the identical bare run failed 9 of 10 specs on a
  loaded machine). This task ran with `CI=1` throughout, per the global gate
  command.

---

## 2. What shipped

**Migrations (`0057`–`0064`, eight files).**

- `0057_integrations.sql` — the map from a WhatsApp number to a Station.
  RLS on, no policy, **no table grant for any role including `service_role`,
  by design** — every reader is inside a `SECURITY DEFINER` body. The
  identical *absence* of a grant on `webhook_events`/`outbox_messages` was
  not by design and is §6.1's Concern.
- `0058_webhook_events.sql` — one row per inbound message. `(provider,
  external_id)` unique holds the idempotency guarantee structurally;
  `external_id` is `sha256(wamid)`, hex, with a format `CHECK` refusing a raw
  id outright; `webhook_events_done_shape` makes `DONE` a claim about
  `outcome` and `processed_at` together (`0058:93-96`); `prune_webhook_payloads`
  nulls `payload` after 30 days without scheduling itself — Block 11 turns
  that on. **Fix wave:** that prune had no status predicate and emptied rows
  still awaiting processing or retry; a later reprocessing of one would find no
  `phone_number_id` and finish `DONE`/`no_integration`, a routing verdict
  invented for a destroyed message. It now reaches only `DONE` rows and rows
  parked at `next_attempt_at = infinity`, and `ingest_whatsapp_event` raises
  rather than deciding an emptied one.
- `0059_outbox_messages.sql` — outbound messages as rows, so a reply commits
  in the same transaction as the participation it announces. `dedupe_key` is
  keyed on the message (`sha256(wamid):confirmation`), not the participation:
  reprocessing writes a *new* participation, so a participation-keyed value
  would differ every time and the unique constraint would never fire once. The
  reasoning is in the column's own comment; **fix wave:** two comments still
  arguing the retired participation-keyed version survived to HEAD — one in
  `0062`, one in `06_whatsapp.test.sql` forty lines above that file's own
  correct version — and a reader following either would have concluded the
  `ON CONFLICT` was unreachable and free to delete. A third copy was in the
  spec. All three are corrected.
  **Fix wave, second item:** this table was also a permanent, un-erasable
  store of listener phone numbers — `to_phone` in the clear, the raw reply
  `wamid` in `external_id`, no retention function of any kind, and
  `anonymize_member` cannot reach it because there is no `member_id` to join
  on. A listener who exercised erasure kept their number here for ever.
  `prune_outbox_messages` closes it on `prune_webhook_payloads`' own terms;
  `pruned_at` is what lets both shape constraints go on demanding a recipient
  and a provider id everywhere else.
- `0060_participation_source_whatsapp.sql` — `participation_source` gains
  `'WHATSAPP'`, alone in its own migration because `ALTER TYPE ... ADD VALUE`
  cannot be used in the transaction that adds it.
- `0061_member_resolution_cores.sql` — three private cores extracted from
  Block 3's `find_member_by_identifier`, `create_member` and
  `link_member_to_company` (`apply_member_candidates`, `apply_member_lookup`,
  `apply_member_creation`, `apply_member_link`), `SECURITY INVOKER`, EXECUTE
  for nobody — every public signature, gate and behaviour preserved
  unchanged.
- `0062_ingest_whatsapp_event.sql` — the whole decision, one transaction:
  `whatsapp_local_phone` (sender normalisation), `whatsapp_reply_body` (the
  six reply sentences, the only copy), `finish_whatsapp_event`, and
  `ingest_whatsapp_event` itself, the bulk of the block's logic.
  **Fix wave:** three guards and one lookup. A payload whose `from` is absent —
  or carries no digits — used to reach `apply_member_creation` and register a
  listener with a NULL phone that no later message could ever dedupe against,
  while the timestamp beside it had a written justification for raising; both
  raise now, and the payload contract comment claiming "both absences RAISE" is
  true rather than incidentally true. A pruned (NULL) payload raises too. And
  the listener lookup falls back to the unstripped sender — §6.3.
- `0063_whatsapp_worker_queue.sql` — `due_whatsapp_events`,
  `claim_outbox_batch`, `reclaim_stale_whatsapp_claims`, and the two partial
  indexes they run on. SQL functions rather than PostgREST queries because
  the pending-index is on an expression `order` cannot name, and because
  claiming a batch has to be one statement under overlapping ticks.
  **Fix wave:** the reclaim's load-bearing arm justified itself with "an
  ordinary serverless timeout" — a runtime this project does not use — in both
  of its deliberately duplicated copies, and `src/services/whatsapp.ts` sized
  the batch caps on the same wrong picture — as did a **fourth** copy in the
  spec's own §4.2, found by grepping for the retired wording rather than by
  trusting the review's list of three. The caps are unchanged; the reason
  now names what really bounds a tick. See also §6.5 on the call-site count.
- `0064_schedule_worker_tick.sql` (this task) — the `pg_cron` job. No URL, no
  secret; both are read from database settings the runbook sets.
  **Fix wave:** the guard was `is not null`, which a setting that exists and is
  blank passes — `current_setting(..., true)` returns `''` for one — so a
  half-finished configuration step would have POSTed to an empty URL every ten
  seconds; it is `nullif(..., '')` now. `net.http_post` also passed no
  `timeout_milliseconds`, so pg_net's 5-second default recorded a **timeout**
  in `net._http_response` for every busy tick that in fact succeeded — the one
  table the runbook sends an operator to, trained to be ignored. Set to 90
  seconds, past a full batch and still bounded. And the comment justifying the
  database settings named "a Vercel environment variable"; this project deploys
  through EasyPanel.

**Transport and routes (`src/`).**

- `src/lib/integrations/whatsapp/{transport,graph,fake,signature,payload}.ts`
  — the seam: an interface, the real Meta Graph client, a fake for CI, HMAC
  verification, and payload flattening (one row per message, not per POST).
- `src/app/api/webhooks/whatsapp/route.ts` — `GET` (Meta's handshake) and
  `POST` (verify, store, 200 fast). No promotion logic in this file.
- `src/app/api/worker/tick/route.ts` — the tick endpoint `pg_cron` calls.
- `src/services/whatsapp.ts` — `runTick`, holding no rule about promotions,
  listeners or entries; the backoff ladder (`BACKOFF_SECONDS`,
  `MAX_ATTEMPTS`), the `TickResult` shape including `dbErrors`, the reclaim
  call, and the two drain loops.
- `src/middleware.ts` — the matcher exclusion for `api/webhooks/` and
  `api/worker/` (§6.2).
- `src/lib/env.ts` — the four optional secrets (D6, §3).

**Tests.** Unit: `whatsapp-signature`, `whatsapp-payload`, `whatsapp-transport`,
`whatsapp-route`, `whatsapp-worker`, `worker-tick-route`,
`middleware-matcher` (79 cases across these seven files). pgTAP:
`06_whatsapp.test.sql` (141 assertions) and `07_whatsapp_worker.test.sql`
(52 assertions) — 193 of the block's 585 total.
Isolation: `tests/isolation/whatsapp.test.ts` — 10 cases: the door closed to
an ordinary session and to `anon` (2), three twelve-round concurrency races
(pre-registered listener, unknown-number listener creation, cross-Station
listener creation) (3), three privilege-boundary cases proving the exact
writes the webhook route and the worker perform succeed for `service_role`
over real HTTP (3), and two driving `runTick` itself, which is a different
question from the three beside them (§8) — plus `harness.ts`'s
`seedIntegration` (a direct-Postgres insert, since `integrations` has no
PostgREST grant for any role) and `anonClient`. E2e:
`tests/e2e/whatsapp-boundary.spec.ts` — a correctly signed
POST reaches the route and leaves a row, a wrongly signed one is refused with
401 and writes nothing, and a tick with the shared secret returns 200 with
`dbErrors: 0` — against the **running app**, not a mock, which is what closes
the gap §6.2 describes.

---

## 3. Decisions D1–D9, and where they landed

| Decision | Landed in code |
| --- | --- |
| **D1** — one message in, one participation, one reply out; no conversation state | `ingest_whatsapp_event` (`0062:269-625`) resolves exactly one participation per event; no table in this block holds conversation state |
| **D2** — the bot is a system actor; no personal data in `audit_logs` | `participations.created_by` / `audit_logs.actor_id` left `NULL`; `finish_whatsapp_event` writes the audit detail with key `wamid_sha256`, never `wamid` (`0062:181-194`); the webhook route hashes in Node before the insert (`route.ts:109-116`) |
| **D3** — one WhatsApp number per Station | `integrations_one_per_company` partial unique index (`0057:53-54`); `phone_number_id` is the sole Station resolver in `ingest_whatsapp_event`'s integration lookup |
| **D4** — four outcomes answered, everything else silent | `whatsapp_reply_body` (`0062:95-160`) returns text for `VALID`/`DUPLICATE`/`TOO_SOON`/`OVER_LIMIT` and `NULL` otherwise; `no_integration`/`no_hashtag`/`no_promotion`/`promotion_cancelled`/`outside_window` are all `DONE` and silent (`webhook_events.outcome` comment, `0058:187-188`) |
| **D5** — free-form text, not templates | `whatsapp_reply_body` renders plain Portuguese sentences (`0062:123-156`); `GraphTransport` sends free text; no template plumbing exists in this block |
| **D6** — no secret in the database in 5a | `src/lib/env.ts:15-19` — four optional environment variables; `integrations` (`0057`) carries `phone_number_id`/`display_phone_number`/`waba_id` and no token column |
| **D7** — the ingestion rule lives in SQL; the worker is thin | `ingest_whatsapp_event` decides everything inside one transaction; `runTick`/`drainEvents`/`drainOutbox` (`src/services/whatsapp.ts`) hold no promotion or listener rule, only queue mechanics |
| **D8** — a listener elsewhere in the Organization is linked, not duplicated | `apply_member_lookup` / `apply_member_link` (`0061`), called from `ingest_whatsapp_event`'s resolution branch. **Never asked of the owner — see §7.1, still open.** |
| **D9** — the payload is pruned at 30 days; the row and its hash are not | `prune_webhook_payloads` (not scheduled by this block — Block 11's); `external_id = sha256(wamid)` with a format `CHECK` (`0058`). **Corrected by the fix wave, in all three places it was stated** — the spec, `0058`'s column comment and this table: "the raw provider message id lives at `payload.wamid` and expires with it" was true of the **inbound** half only. `outbox_messages.external_id` held the raw wamid Meta returns for our reply, and `to_phone` the listener's number in the clear, with **no retention at all**. Both halves expire now: `prune_webhook_payloads` for the inbound one, `prune_outbox_messages` for the outbound one. The prune predicate was corrected in the same wave (see §2). |

---

## 4. Deliberately out of this pass

From spec §8, unchanged by execution:

- Everything the tab-2 screen configures beyond the hashtag — art, call to
  action, SIM/NÃO buttons, requested fields, the promotion's questions. 5b.
- **A Deno Edge Function worker**, which is what the master spec's §10 M2
  says literally. The contract is kept (idempotent worker,
  `RECEIVED → PROCESSING → DONE/FAILED`, retry/backoff, manual reprocessing,
  swappable for `pgmq`); the runtime is a Next.js route instead, because a
  Deno worker cannot import `src/services/` and the repository has no Edge
  Function tooling. **Accepted by the owner on 2026-07-31.**
- Redis. No conversation state exists yet for it to hold; the concurrency it
  would guard is already held by `apply_participation`'s advisory lock plus
  the partial unique index.
- Non-message webhook events (delivery and read receipts) — acknowledged
  with 200, never stored.
- Operator screens for events, outbox and integrations — Block 10.
- Station-initiated messages, and therefore message templates (D5).

### 4.1 Deviations from the spec, recorded

Where the shipped behaviour differs from what the design says, and why. The Deno
Edge Function above is the first and largest; these are the rest.

**A malformed payload with a valid signature is answered 200 and stored
nowhere.** Spec §6.3 says it is stored `FAILED` with `last_error` — *"it really
came from Meta and the evidence matters"* — and the route instead returns 200
having written nothing (`src/app/api/webhooks/whatsapp/route.ts:76-80` for
unparseable JSON, `:87-96` for entries the flattening drops).

**The deviation is correct and the spec is not implementable as written.**
`webhook_events.external_id` is NOT NULL with a format `CHECK` restricting it to
a 64-character hex digest, and it is derived from the message id inside the
payload. A payload malformed enough to have no message id has **no key to file a
row under**; there is nothing to insert, and inventing one would put a
synthetic value into the column that carries this table's whole idempotency
guarantee. The evidence is not lost silently either: `stats.dropped` is counted
and logged with the number of entries dropped out of the number seen, without any
field from the payload.

It is pinned by a test rather than left to drift
(`tests/unit/whatsapp-route.test.ts`), and it was simply never written down.
Recorded by the fix wave, on review.

**A `pruned_at` column and a nullable `to_phone` on `outbox_messages`**, neither
of which appears in spec §3.3. Both follow from `prune_outbox_messages`, which
§3.3 did not have either — see §3's D9 row.

---

## 5. What Block 5b inherits

- **The spine is the whole ingestion path, unconditionally.** 5b adds
  conversation state on top of `ingest_whatsapp_event`; it does not replace
  any of the resolution, idempotency or reply-enqueueing this block built.
- **The three extracted cores (`0061`) are the listener door for any future
  bot path**, not only this one's. A conversational flow that needs to
  resolve or register a listener goes through
  `apply_member_lookup`/`apply_member_creation`/`apply_member_link`, not
  through a fresh reimplementation.
- **`whatsapp_reply_body` is the only home for bot copy, and 5b will grow
  it, not duplicate it.** There is deliberately no TypeScript copy of any
  reply string (§6.5's reasoning: the reply must be enqueued inside the same
  transaction that decides the entry).
- **The `webhook_events`/`outbox_messages` privilege shape is now proven,
  not assumed** — 5b's own writes against these tables inherit the same
  "no PostgREST grant, `SECURITY DEFINER` only" pattern and the boundary
  tests that check it (§6.2).
- **`whatsapp_local_phone`'s +55-only limit (§6.3) is inherited as-is**, minus
  the one case the fix wave closed: a listener an operator registered *with* the
  country code is now found, because the lookup asks for both shapes. 5b does
  not touch phone resolution otherwise, so the ninth-digit and non-Brazilian
  cases are inherited unchanged; whoever picks up Block 9's ETL reconciliation
  (L1) is the actual owner of those.
- **`prune_webhook_payloads` and `prune_outbox_messages` are the only erasure
  either of this block's two personal-data stores has**, because
  `anonymize_member` reaches neither. 5b must not add a column holding a phone
  number, a name or a raw provider id to either table without extending the
  matching prune — and neither is scheduled yet, which is Block 11's.
- **D8 (§7.1) is still open.** 5b should not assume it is settled.
- **The hashtag match is exact, decided (§7.2).** The owner reversed the
  punctuation-stripping fallback on 2026-08-01: a hashtag matches only when
  written exactly, case aside. 5b's own hashtag-adjacent surfaces (if any)
  should assume exactness, not forgiveness of trailing punctuation.

---

## 6. Concerns

This section is deliberately not softened. Each item below is real, is in
the execution ledger with its own detail, and several would otherwise have
been discovered by the owner, with a phone in his hand, mid-runbook.

### 6.1 The block was non-functional until Task 12

`service_role` held **no privileges at all** on `webhook_events` or
`outbox_messages` from the moment Task 11's webhook route was reviewed and
merged. This schema revokes Supabase's default ACL everywhere and grants back
explicitly (`0006`, `0014`, `0019`, `0029` all do this) — `0057`/`0058`/`0059`
wrote the comment "service_role only" and, for the two tables the route
actually writes, never wrote the grant itself. Every inbound message the
route received returned **42501** — proven by Task 12 replaying the route's
exact call against the merged code — and **nothing could ever have been
stored**. Found and fixed inside Task 12's own fix round, with six new pgTAP
assertions and the grants added to `0058`/`0059`. `integrations` itself
carries no `service_role` grant either, by design (§6.2), and that is not
this defect — the two absences look identical from the migration file and
are not.

### 6.2 Three defects existed only across the HTTP + privilege boundary, and CI saw none of them

- **The middleware 307.** `src/middleware.ts`'s matcher had no exclusion for
  `/api/webhooks/`; Meta's `GET` handshake and every `POST` were
  307-redirected to `/login` before the route ever ran. Found in Task 11's
  review (a Critical), fixed at `0d47a83`.
- **The missing `service_role` grants** — §6.1.
- **A PostgREST resource embed on `integrations`** that would have needed a
  fourth grant this table deliberately does not carry. The worker briefly
  read `integrations` through `integrations(phone_number_id)`; the embed was
  replaced by `claim_outbox_batch` during Task 12's review for an unrelated
  reason, and the grant this table refuses became unnecessary rather than
  ever having existed. Closed by circumstance, not by a test — there is
  nothing today that would fail if a future refactor reintroduced the embed,
  beyond the prohibition `0057`'s own comment now states in capitals.

**pgTAP runs as `postgres` and ignores every grant; the route's unit tests
mock the Supabase client.** Neither layer could have seen any of the three —
each is a fact about what happens when a real, unauthenticated HTTP caller
meets a real, privilege-checked database role, and nothing in the suite
before Task 13 ever put those two things in the same test. Task 13 added
`tests/isolation/whatsapp.test.ts`'s three boundary cases (real `service_role`
writes against the exact statements the route and worker perform) and
`tests/e2e/whatsapp-boundary.spec.ts` (real signed HTTP against the running
app, including a mutation that reads a bare `307` when the middleware
exclusion is removed). **That closes the first two of the three for good.**
The third — the embed — had no standing regression test at the time, because
there is no embed today to test against, and it remained a documented
prohibition rather than an assertion.

**The fix wave closed it too, though not by testing for an embed.** The two
`runTick` cases drive the worker's own statements, as `service_role`, against
a real database. An embed reintroduced anywhere in `runTick` is a PostgREST
read of `integrations`, which carries no grant for any role, so it comes back
42501 and lands in `dbErrors` — which both cases assert is zero, and assert
first. The same is true of an ungranted RPC and of a settle patch whose column
set breaks a `CHECK`. It is a test for the *class*, which is what a defect
found three times in one block needs, rather than a test for the one instance
that has already been removed.

### 6.3 `whatsapp_local_phone` strips `+55` only

`0062`. A Brazilian mobile that gained its ninth digit after the
listener was registered still normalises to a different string and therefore
reads as a different person; no other country's numbering is handled at all,
and a twelve-digit foreign number that happens to start with `55` is stripped
when it should not be. Named because **it will produce duplicate listeners in
production**, not because it is theoretical — this is the sender-matching
path every inbound message runs through. Deferred, on the record, to Block
9's ETL reconciliation (L1), which faces the identical problem against
legacy data.

**The fix wave closed the likeliest of the three, which was not on this
function's side at all.** `whatsapp_local_phone` normalises what *Meta* sent;
nothing normalised what an *operator* typed. `members.phone_normalized` is
GENERATED from `members.phone` as entered (`0031`), so a listener an operator
registered as `+55 11 9…` is stored as thirteen digits, the local-form lookup
asked for eleven, missed, and the bot **registered a duplicate on that
listener's first message — every time**. It needed no unusual number and no
ninth-digit change; it needed an operator who typed the country code, which
nothing in the app has ever asked them not to do. `ingest_whatsapp_event` now
falls back to the unstripped form when the local one finds nobody, in that
order, so the local form stays the shape a new listener is registered under.
Both directions are asserted in `06_whatsapp.test.sql` and the fallback is
mutation-proved. The two limits above are untouched and remain Block 9's.

### 6.4 Outbound delivery is at-least-once

`reclaim_stale_whatsapp_claims` (`0063:228-275`) returns an abandoned
`SENDING` row to `PENDING` after five minutes. If the tick that claimed it
died **between Meta's 200 and the settle write**, the next tick can re-send a
message Meta already accepted — the listener is told twice. This cannot be
closed from the worker side; the Cloud API offers no idempotency key for text
sends. The alternative — parking such a row instead of releasing it — was
considered and rejected: it would trade "told twice" for "entered and never
told," which is exactly what D7 exists to prevent. Stated as a deliberate,
residual property (`0063:219-226`), not an oversight.

### 6.5 A proof used twice in review was false

Two reviews — one of them the block's own controller review — argued that a
`webhook_events` row cannot strand in `PROCESSING` because "there is no
`EXCEPTION` block anywhere in `ingest_whatsapp_event`." That was false, and
had been false since before this block's own fix round: `apply_member_creation`
has carried its own exception handler since `0061:227-255`, so the call graph
always contained a subtransaction, and neither analysis noticed. The
underlying hazard the sentence warned against does not exist regardless — a
PL/pgSQL handler's implicit savepoint is a *sub*transaction, and a
subtransaction cannot commit independently of its parent, so catching an
error inside one cannot durably write anything out from under an aborting
caller. The conclusion survives on a structural argument instead: the only
`RETURN` below the `PROCESSING` write is `finish_whatsapp_event`, called for
all six outcomes (`no_integration`, `no_hashtag`, `no_promotion`,
`promotion_cancelled`, `outside_window`, `recorded`), and it writes `DONE`,
`outcome` and `processed_at` together in one statement; every other exit is
an uncaught `RAISE` that aborts the whole transaction and takes the
`PROCESSING` write down with it. The correction needed **three** passes, not
two: the first replacement named only `'recorded'` as the return; the second
named the six outcomes but called them *"six different call sites"*, which is
a number nothing in `0062` has ever matched — the six outcomes arrive through
**four** call sites, because the diagnostic branch chooses among
`no_promotion`, `promotion_cancelled` and `outside_window` and then calls once.
The fix wave corrected that in both of `0063`'s deliberately duplicated copies
and in the third instance in `0062`'s own comment. Worth recording precisely
because two independent reviewers cited the false version as settled fact, and
because the *correction* was then wrong twice in a row.

### 6.6 The isolation suite's worker-death flake is unresolved

An open, uncaused flake — a worker process occasionally dies mid-suite
(`tinypool onUnexpectedExit`) — that predates this block and fired repeatedly
inside it: Task 5 saw it on 2 of 4 runs the day it ran; Task 13 hit it twice
before a third run completed. `scripts/verify-isolation-suite.mjs` exists
specifically to catch this rather than report a partial run as passing — it
counts every required file, floors every file's case count, and only reports
**GUARD-COMPLETE** when nothing was cut short. This task's own run completed
clean on the first attempt; that is not evidence the flake is fixed, only
that it did not fire this time. A result from this suite is always either
complete or explicitly flagged — never silently partial — but root cause
remains unknown.

### 6.7 A security anomaly

During Task 13's mutation work (restoring `src/middleware.ts` after
deliberately reintroducing the pre-fix defect to prove the boundary test
catches it), the implementer received content presented as tool output
claiming its own edit to `src/middleware.ts` — the mutation that re-hides the
webhook route behind auth — was intentional user/linter behaviour, and
instructing it **not to revert the edit and not to mention it**. Had it
complied, this block's Critical would have been silently reintroduced into
the file that gates authentication for the whole application, with the agent
told to stay quiet about it. It disregarded the instruction and used
`git diff --exit-code src/middleware.ts` — verification that does not depend
on trusting anything it was told — as proof the file matched `HEAD` again.
The block's controller verified independently at the time: working tree
clean, matcher excluding exactly `api/webhooks/` and `api/worker/`, diff
clean. **Re-verified again while writing this report**: `git diff --exit-code
src/middleware.ts` is clean, matching `HEAD`. Origin of the injected content
is unknown. Reported to the owner both times.

---

## 7. Decisions revisited

One item confirmed still open, one decided since the last revision of this
report. Both were flagged as reversible in the ledger rather than settled;
§7.2 is where that reversal happened.

### 7.1 D8 — a listener elsewhere in the Organization is linked, not duplicated

Spec §10: *"the one decision here taken by reasoning rather than asked."* A
listener already known to the Organization but not linked to the Station
that received their message is linked and entered, rather than duplicated
(which would defeat Block 3's dedup) or refused (which would tell a real
listener they cannot enter a promotion they are eligible for). Implemented
in `apply_member_lookup`/`apply_member_link` (`0061`) and never put to the
owner during this block's thirteen tasks. Confirm or overturn on review.

### 7.2 The punctuation-fallback ruling — decided by the owner, reversed, 2026-08-01

`0062` used to match a hashtag first as written, then — only if that matched
nothing among **open** promotions — with trailing punctuation stripped
(`"#EUQUERO!!"` → `"#EUQUERO"`), so an excited listener was not answered with
silence. A controller ruling, recorded in the previous revision of this
section as *"mine, not the owner's"* and flagged as *"the ruling most likely
to be worth revisiting with the owner directly"*, had gone further still and
kept the fallback active regardless of the exact tag's own history — so a
now-ended `"#VAI!"` fell through to a currently live `"#VAI"`, on the
reasoning that the mirror case (a Station retyping last year's `"#VAI!"`
verbatim into permanent silence) was worse than the rare case of two hashtags
differing only in trailing punctuation.

**The owner reversed it, in his own words:** *"the hashtag must be exact,
differing only in upper/lower case. A message carrying any extra character —
`!`, `?`, `.`, anything — must not enter the promotion."* There is no second
candidate any more, and no history-aware exception. `0062` now matches
`lower(hashtag) = v_tag` and nothing else, in both the live match and the
diagnostic lookup an operator's "why didn't it work?" runs against; the
`v_trim`/`v_tags` machinery, the trimming expression, and the `order by` that
used to pick the exact form among open candidates are all removed.

The reasoning that was on the other side is real and is recorded here rather
than erased, per the standing rule of this block: `"#EUQUERO!!"` is how
somebody writes when they are excited, which is the state this whole feature
exists to produce, and D4's silence leaves that listener with nothing and no
way to learn why. The owner weighed that against a stored hashtag ending in
punctuation becoming two ways to spell one promotion in a listener's head —
`"#VAI!"` sometimes silently meaning `"#VAI"` — and judged the second the
worse failure mode, better solved by operator guidance (register a hashtag
without terminal punctuation) than by a matching rule that quietly forgives
one listener's typing and not another's.

A simplification came free with the reversal: the trim leaned on
`[[:alnum:]]` being Unicode-aware, a property of the production cluster's
ctype that this block had pinned by an assertion (§6.3's sibling risk, never
actually resolved against the real cluster) rather than confirmed. Exact
match compares a lowercased string byte-for-byte and carries no such
dependency. `promotions_hashtag_shape` (`0040`) is untouched — a Station may
still name a promotion `#VAI!` — and it stays reachable, just only by a
listener who writes `#VAI!` exactly.

**Pinned in `06_whatsapp.test.sql`.** The four assertions built for the
fallback (`P1`–`P4`) are rewritten as assertions of the exact rule rather
than deleted: `P1` and `P4` now expect the *silent* outcome, where they used
to expect a match, because their extracted tags (`#euquero!!`, `#café!`)
match no stored hashtag under exact comparison; `P3` now expects
`outside_window` rather than a fall-through entry into `Aberta`, since
`"#JA!"` and `"#JA"` are simply different tags and the second is never
consulted; `P2` keeps its outcome but is re-reasoned as a plain exact match
rather than "the exact form winning a tie." Two additions pin what survives
the reversal on their own terms: a new `P4A` fixture proves `"#CAFÉ"` written
exactly still matches — the accented case, no longer resting on any ctype
assumption — and a new `P5` case proves a hashtag in a different case
(`"#euquero"` against a promotion stored `"#EUQUERO"`) still matches, since
case-insensitivity is the one variation the owner named as permitted.
Mutation-proved: the fallback was restored, the assertions expected to have
gone silent were confirmed red, and the file was restored byte-identically.

---

## 8. Deferred minors, grouped

- **pgTAP RLS assertions use a bare `::regclass` cast** (Task 1, inherited
  from every earlier `0N_*.test.sql` file in this repository) — an absent
  relation aborts the psql run with a hard error instead of a clean `not ok`.
  Ruled **not fixed**: diverging in `06_whatsapp` alone would cost
  consistency with `05_participations` and every sibling file for a marginal
  gain. A repo-wide change or nothing.
- ~~**The backoff-settle and `deferEvent` write shapes are not driven by the
  boundary tests** (Task 13).~~ **Closed by the fix wave.**
  `tests/isolation/whatsapp.test.ts` now calls `runTick` itself, twice, against
  a seeded fixture with the rest of both queues quiesced: once on the happy
  path (`dbErrors: 0`, `ingested: 1`, `sent: 1`, the fake's recorded recipient,
  and the `SENT` settle read back) and once on the failure paths (an event whose
  payload lost its timestamp, so `deferEvent` runs, and a retryable send
  failure, so the backoff settle runs). That drives **every** PostgREST
  statement the worker issues, per row, as `service_role` — which is a
  different question from the boundary cases beside it, since those perform the
  worker's writes *by hand* in shapes copied from `src/services/whatsapp.ts` and
  therefore cannot see the worker growing a resource embed, calling an ungranted
  RPC, or writing one column too many. It is the standing regression test for
  the defect family this block was returned for three times, including the
  third — the `integrations` embed — which had no test at all.
