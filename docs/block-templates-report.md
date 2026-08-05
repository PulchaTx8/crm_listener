# Block Templates — A Station's Own Words — Verification Report

**Date:** 2026-08-05
**Branch:** `block-templates` (cut from `main` at `27e0d3d`, the plan commit)
**Spec:** `docs/superpowers/specs/2026-08-04-block-templates-design.md`
**Plan:** `docs/superpowers/plans/2026-08-04-block-templates.md`
**Migrations:** `0109`–`0114` (the plan named four; §3 explains the other two)
**Commits:** `b71cd6a..HEAD` — 14 commits, Tasks 1–10; this report and the
runbook are Task 11, committed separately.

Two things arrive with this block. The ten sentences the bot says on its own
initiative stop being constants shared by every Station and become something
each one can rewrite, one text at a time, with no deploy. And the platform door
Block 5a wrote down and did not build — a Station-initiated message, which
WhatsApp only permits as a Meta-approved template — is now open, with the
pickup reminder Block 6d shipped without as its first user.

---

## 1. Gates

Every gate below was run for this report against the local stack with
`0109`–`0114` applied.

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | clean — `✔ No ESLint warnings or errors` |
| Typecheck | `npm run typecheck` | clean — `tsc --noEmit`, no output |
| Build | `npm run build` | clean; `/templates/messages` 3.68 kB / 116 kB, `/templates/whatsapp` 5.72 kB / 132 kB first load |
| Unit (Vitest) | `npm test` | **755 passed (755)**, 52 files |
| pgTAP | `npm run db:test` | **1176 tests**, 21 files, `Result: PASS` — `18_templates.test.sql` (75 assertions) and `19_pickup_reminders.test.sql` (13) both `ok` |
| Isolation | `npm run test:isolation` | **clean — 23 files, 255 cases**, "every one accounted for, 23 of them required by name and each above its own case floor, nothing skipped" |
| E2E serial | `npx playwright test --workers=1` | **30 passed (3.0m)** — the whole suite, including `templates.spec.ts` |
| E2E default parallelism | `npx playwright test` | **13 passed, 15 failed, 2 did not run** — the documented contention, §1.2 |

### 1.1 Isolation — green this time, and that is worth saying plainly

`npm run test:isolation` has been intermittently crashing since
`docs/block-4b-report.md` §1.2 with an uncaused `Worker exited unexpectedly`
after a file's own tests have already passed. **It did not crash for this
report:** one run, 23 of 23 files, 255 of 255 cases, the guard script's own
"suite complete" line. That is one clean observation, not evidence the
intermittent fault is gone — it has been clean before and crashed the next
day. Reported as observed.

`tests/isolation/templates.test.ts` contributes 13 cases and is registered in
`scripts/verify-isolation-suite.mjs` with its own `minTests` floor, so a future
edit that quietly deletes cases fails the guard rather than passing quietly.

### 1.2 E2E — both parallelisms, reported honestly

**Serial (`--workers=1`): 30 passed, 3.0 minutes.** Every spec in the suite,
including the new `tests/e2e/templates.spec.ts` (11.2s).

**Default parallelism: 13 passed, 15 failed, 2 did not run (40.3s).** Run
twice, with the identical 15/2/13 split both times. This is exactly the
contention `docs/block-7b-report.md` §1.1 documents and that CI does not
reproduce: every failure is the same one — `expect(page).toHaveURL(/\/app$/)`
timing out at sign-in, the local Supabase auth endpoint under fifteen
simultaneous provisioning journeys — and none of them is a failure of anything
this block changed.

**`tests/e2e/templates.spec.ts` passed at default parallelism** (`ok 22`,
15.1s) in the second run, where the full output was captured; in the first,
the captured tail showed only that it was not among the fifteen named
failures. Reported at that resolution rather than rounded up: it passes
serially, every time, which is the claim this block stands behind.

---

## 2. What shipped

**`station_message_templates`** (`0109`) — one row per *overridden* text, never
one per Station. Three consequences, each of them the reason: overriding one
prompt does not freeze the other nine at whatever the code said that day; a new
Station speaks before anybody configures it, with no backfill and no seed; and
the bot cannot go mute, because an absent row is a valid state resolving to the
constant in `engine.ts`. Ten keys, matching exactly the ten texts that exist
(`system_message_key`).

**`message_templates`** (`0110`) — what Meta approved, transcribed. One live
row per (Station, purpose), which is what lets code reference a template *by
purpose* and skips the environment variable the original design had planned for
the name and language.

**The outbox learns templates** (`0111`) — three nullable columns,
`claim_outbox_batch`'s third definition, and `enqueue_whatsapp_outbound`
recreated with a template purpose it resolves itself. The rendered audit body
and the variables actually sent are produced by **one function from one
source**, so they cannot drift; a body that disagreed with the variables would
make the audit trail confidently wrong, which is worse than absent because
somebody would believe it.

**The sweep** (`0112`) — hourly, per-winner commits, both bounds on the
two-day window, and five exclusions each earning its own pgTAP assertion
(cancelled draw, already delivered, deadline already passed, no registered
template, anonymised listener).

**The four doors** (`0113`) and **the engine reading the overrides** (`0114`) —
see §3.

**Two screens** — Templates → Messages and Templates → WhatsApp, in a new
sidebar section, with `templates.view` / `templates.manage`.

---

## 3. Where the implementation departed from the plan

Three departures, all of them recorded here rather than smoothed over.

**3.1 Two migrations the plan's file list did not have.**

`0113_template_doors.sql` — `0109` and `0110` each opened their table for
reading and each said in a comment that the write door would be `SECURITY
DEFINER`. Neither wrote one, and the plan's file list stopped at `0112`. As
planned, an operator holding `templates.manage` could not change a word, and
Task 5's isolation suite had no write to be refused. Four doors, not one body
discriminated on a kind: the two tables share a permission code and nothing
else.

`0114_prompt_context_overrides.sql` — `0109` granted `service_role` SELECT and
said in a comment that this is "how the engine resolves them", and nothing read
the table. The screens would have written rows that changed nothing a listener
ever saw. **Both context builders changed**, because there are two:
`start_whatsapp_conversation` (`0070`) assembles the first message's context
and `whatsapp_prompt_context` (`0071`) every turn after it. Changing one and
not the other would give a Station its own wording from the second message
onward and the code's default on the first — the hardest possible version of
this bug to notice.

Both are gaps in the plan, not scope added to it: without either, the block
ships two screens that write rows nothing reads.

**3.2 The sweep is scheduled by `pg_cron`, not called from the worker tick.**

Plan Task 4, Step 3 said to wire it into `src/app/api/worker/tick/route.ts`
beside `sweep_pickup_deadlines`. `sweep_pickup_deadlines` is **not** called
from that route either — `0094` schedules it directly with `cron.schedule`,
and the route's own header says so. `0112` follows its sibling: no HTTP, no
application code in the path. The tick route's header now names both sweeps
and explains where they actually run, because a reader following the plan would
look there first. The tick still does the sending — `sweep_pickup_reminders`
only *enqueues*, and `drainOutbox` claims the row on its ordinary ten-second
cadence like any other message.

**3.3 The contract mismatch is a warning, not a refusal.**

`enqueue_whatsapp_outbound` compares the variables *sent* against the
registered body's own highest `{{n}}`, and the sweep always sends this
purpose's full set of three. So a body registered with two placeholders passes
every check at registration time and fails at *send* time, with a `22023` that
lands in a server-log `WARNING`, hourly, for as long as the wrong registration
stands. The WhatsApp screen counts placeholders as the operator types and says
so in red — but does not block the save, because a hard refusal that lives only
in the browser is not a rule, and putting it in the door would mean the door
knowing what each purpose sends. **Named here as a residual risk**: the cheapest
real fix is a `variable_count` on `template_purpose`'s own metadata, which is
one small migration whenever a second purpose arrives.

---

## 4. The four behaviours this block deliberately did not build (D3)

The legacy screen the owner showed has four things this system has no
equivalent of — not the text, and not the behaviour underneath it. A key here
for a message nothing sends would be a field that configures nothing. They are
priced instead.

**One cost is shared by all four and should be priced once:** none of them is
only a *text*. Inactivity needs a timeout in minutes; the legacy screen's two
auto-reply toggles are booleans. `station_message_templates` stores text keyed
by an enum, and **this system has no per-Station settings table at all**.
Whoever buys any of these buys that table first — one migration, its RLS, its
door, and a section on a screen.

**4.1 Inactivity ("Inatividade") — a message when a listener goes quiet.**

Today a conversation simply expires: `CONVERSATION_WINDOW_SECONDS` is 30
minutes, the Postgres driver holds it in `expires_at` and the Redis driver in
the key's TTL. When the window passes the state is gone and **nothing notices**
— there is no event, no sweep and no log line.

Cost: something must notice an expiry *before* deleting it. Against the default
Postgres driver that is a cheap sweep over `expires_at`. Against the Redis
driver there is nothing to sweep — the key vanishes and the driver keeps no
index — so it needs keyspace notifications or a parallel index, which means
`ConversationStore` gains a method **both** drivers must implement. Add the
eleventh `system_message_key` (free on the screen: `SYSTEM_MESSAGE_DEFAULTS` is
total, so the compiler enrols it), the settings table above for the timeout,
and a decision on whether the message ends the conversation or re-prompts.
Roughly Task 4's size here, plus the store change. **No Meta template needed** —
the listener wrote within the last half hour, so it is inside the 24-hour
window.

**4.2 "Aguarde" — an acknowledgement while something is processed.**

Cheapest in code and the one worth buying last: nothing in the turn path is
slow. A turn is computed and its reply enqueued in one transaction. There is no
moment for this message to fill, and adding it would double a Station's
outbound volume with messages nobody asked for. Cost is one key and one send —
*after* something in the path becomes slow enough to need it.

**4.3 "Rejeita Áudio" — telling a listener the bot cannot hear a voice note.**

The only one of the four whose absence a listener experiences **today**, and
the state is worse than the legacy screen's: an audio message matches neither
`textMessageSchema` nor `interactiveMessageSchema` in `payload.ts` and is
**dropped before the engine ever sees it**. The listener gets no reply at all —
not a rejection, not even a re-prompt.

Cost, and contained: `payload.ts` gains a third inbound shape (realistically
image, video and document too, or the same silence just moves one message type
over), the webhook route gains a branch that asks whether this sender is
mid-conversation, one new key, and a rule about whether it consumes one of the
three re-prompts. No Meta dependency. **Of the four, this is the one to buy
first.**

**4.4 "Rejeita Ligação" — refusing a WhatsApp call.**

Largest, and least under this system's control. WhatsApp Business calling has
to be enabled on the WABA at Meta's end before a call event exists to answer;
the webhook subscribes to `messages` and a call arrives as a different
`changes` field, which today parses to nothing. Cost: a Meta-side capability
first, then a webhook field, then a reply path — and the Meta-side half cannot
be scheduled from here.

---

## 5. The Interaction Templates screen, and why it is not here (D1)

The 2026-08-03 decision named three screens. Two shipped. This is not half a
delivery — the third has, today, almost nothing to put on it.

**Half of Interaction Templates already exists and is already editable, per
promotion:** `promotion_questions.prompt`, menu titles, button labels, the call
to action and the art all live on the Promotions screen, where the promotion
they belong to is. Moving them under Templates would be a second editor for
rows that already have one.

**The other half does not exist at all.** The music-request conversation — the
hashtag, "Achei algumas músicas", the attempt counter, giving up, the
confirmation — was expected to arrive with Block 7. It did not: `music_requests`
has a `channel` enum whose only values are **`MANUAL` and `IMPORT`**. Block 7
built a screen where an operator records a request by hand and an import path;
there is no WhatsApp request flow, so there is no wording for a screen to
configure.

Building Interaction Templates now would produce a page that either duplicates
the promotion editor or shows one empty section. The decision is: it arrives
with the conversational request flow, in the block that builds it.

---

## 6. `message_templates` has no `status` column, and that is the design

The obvious column to add, and the reason not to is not obvious — so it is
asserted in pgTAP (`18_templates.test.sql`, assertion 21, against
`information_schema.columns`) rather than only commented, and a later reader
adding one has to argue with a test.

This system records **what an operator was told at registration**. It has no
route to Meta at all — it cannot ask whether an approval still stands, and
nothing refreshes it. A `status` column here would look like live truth and be
a memory: an operator would read "Approved" on a screen while Meta had revoked
it that morning, and would trust the screen over the silence.

**A revoked approval is discovered by the first refused send.** The outbox row
is parked with Meta's own reason on it, which is the only statement about
approval this system can make that is true at the moment it is read. The
runbook (§5.6) says so, with the query.

---

## 7. What other blocks inherit

**A template send path, already general.** `enqueue_whatsapp_outbound` takes a
purpose and resolves the Station's registered template itself.
`claim_outbox_batch` returns the three columns; `drainOutbox` has its third
branch; `sendTemplate` is on the transport interface and implemented by both
`graph.ts` and `fake.ts`. The draw result (Block 6) and the delivery
confirmation add **a `template_purpose` value and a registry row** — not a
mechanism.

**A per-Station copy layer with an escape hatch.** Any listener-facing constant
can join `system_message_key` and `SYSTEM_MESSAGE_DEFAULTS`, and the screen
enrols it automatically because both are total records over the generated enum.

**And one thing that must not be forgotten:** the Station-initiated path is
open, but a Station cannot use it until somebody registers an approved
template, and that takes days at Meta. Any future block whose feature depends on
speaking first inherits that lead time — it is not a deploy step, and no amount
of code here shortens it.
