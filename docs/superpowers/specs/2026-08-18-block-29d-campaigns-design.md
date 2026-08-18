# Block 29d — campaigns, lists and the send

**Date:** 2026-08-18
**Depends on:** 29b-1 (merged), 29c (merged), the gender block (merged).
**Does not depend on:** 29b-2, which automates creating templates at Meta. A
template transcribed by hand through 29b-1's registry is enough to send.
**Blocks:** 29e (schedules) and 29f (history and delivery events).
**Parent brief:** `docs/superpowers/specs/2026-08-17-block-29-messaging-brief.md`,
§6, §7, §10, §11, §12.

---

## 1. What this delivers

Bulk messaging: send lists built from the screens that already know how to
filter, campaigns that are their own history, a queue drained by the existing
worker, and a send that respects a listener's consent at the moment it goes out.

## 2. What this deliberately does not deliver

- **Schedules.** Send Now only. Fixed dates and birthday triggers are 29e.
- **Delivery events and webhook correlation.** 29f.
- **Template creation at Meta.** 29b-2. A campaign uses a template already
  registered through 29b-1.
- **A filter panel of its own.** See D5 — that is the block's central decision.

---

## 3. Decisions, all settled with the owner on 2026-08-18

**D1 — Consent is re-verified at send time, not only at snapshot.**
The snapshot fixes *who* entered and *with what data*; each row is re-checked
against consent in the instant before it goes out. Somebody who withdrew while
the queue drained is not sent to. A large campaign takes hours to empty, and
receiving a message after clicking "descadastrar" is indistinguishable, from the
listener's side, from the button not working — and it is the complaint that
costs a WhatsApp number its quality rating.

**D2 — A list is fixed or living, and the operator chooses per list.**
*Fixed* stores the listener ids of that moment. *Living* stores the filter
payload and is resolved again on each send. "Todos os ouvintes" and slices by
gender or age want to be living; "who requested a song between 18:00 and 20:00
yesterday" is historical and wants to be fixed.

**Living means re-resolved at each send, not continuously updating.** The worker
runs as `service_role` with no `auth.uid()`, and since 29c's final fix
`members_marketing_eligible_bulk` **refuses** an identity-less caller rather than
returning nothing. So a living list is resolved when the campaign is created, as
the operator. In practice that is what "always current" means here; the
distinction matters the first time somebody asks why a list did not grow
overnight.

**D3 — A list belongs to exactly one Station.**
`member_consents.company_id` is `not null` and a campaign goes out as one
Station, so a list that spanned Stations would show a number that is never the
number sent. If the operator is filtering Members without a Station chosen, the
button asks which before creating. A group wanting to reach three Stations makes
three lists — which is honest, because those are three separate consents.

**D4 — A test send exists and is not mandatory.**
The operator sends the assembled message to a phone or e-mail they type, with
variables filled from a sample listener of the list, so they see what the
listener will see. It creates no recipient row, does not enter the campaign's
history, and does not consume the list. Not mandatory: an obligation that annoys
somebody repeating a campaign they know is correct is an obligation they route
around.

**D5 — The audience is built on the listing screens, not on a filter panel of
this block's own.** *Criar lista de envio* appears beside the filtered result on
**Members**, **Requests** and **Participations**. Each screen already knows how
to filter what only it knows — Requests knows time ranges and programmes,
Participations knows promotions, Members knows demography. A filter panel here
could never express "requested a song between 18:00 and 20:00" without
reimplementing the Requests screen, and the campaign screen therefore manages
lists rather than filters.

---

## 4. Lists

A list stores one of two things (D2): the listener ids, or the filter payload
the screen already posts. Either way it carries a name, a Station (D3), which
screen it came from, and the filters as text a human can read — because a list
called "engajados" says nothing three months later, and the question asked then
is always "what exactly did I filter here".

**Distinct listeners, always.** Requests and Participations are per event:
somebody who requested twelve songs appears twelve times on screen. A list holds
people, and the number it shows is people — otherwise the operator expects a
thousand and reaches eighty.

**A list holds people, not eligibility.** Consent is not applied when the list is
created — it is applied when a campaign snapshots from it (§5), and again at send
(D1). The reason is that eligibility changes and a list should not silently mean
something different from what its filters say: a list built from "requested a
song last night" is that set of people, and how many of them may be written to
is a separate question with a separate answer per channel and per day.

**Reach is shown per channel, before anything is sent** — computed live rather
than stored, for the same reason. A list of 500 is not 500 messages. On e-mail it is nearly that; on WhatsApp today it is close to zero,
because 29c's D1 requires an explicit opt-in and collection only just began.
Both numbers sit side by side on the list. Without them the first WhatsApp
campaign looks like a defect.

## 5. Campaigns

`message_campaigns` copies `report_runs` (0122) — queue and history in one table,
for the reason that table's own header gives: a finished run is a queued run with
an outcome, and "is it ready?" and "what did I send last month?" are one query.
It carries the Station, the list, the channel, the template, status, counters,
who created it, and §10's cancellation fields.

`message_campaign_recipients` is **both** the snapshot and the queue — one row
per recipient with the phone or e-mail **as resolved at snapshot time**, the
variable values used, status, attempts, next attempt, provider message id, and
the error code and description. Splitting them would mean copying every recipient
twice and keeping the copies in agreement.

**The snapshot happens at campaign creation, as the operator.** That is where a
living list is resolved and where eligibility is asked, because it is the only
moment an identity exists to ask with.

**`suppressed` is not `failed`.** A recipient who withdrew between snapshot and
send is `suppressed`, with the reason. `failed` is our problem and earns a
retry; `suppressed` is the listener's choice and must never be retried. A counter
that adds them together hides the one fact the operator needs.

Recipient states: `pending` → `claimed` → `sent`, or `failed`, `suppressed`,
`cancelled`. Cancellation marks the pending; rows already claimed and in flight
do not come back, which §10 already says.

## 6. The send

A **fifth drain** on `src/app/api/worker/tick/route.ts`, after the four already
there, in its own `try/catch` so a failure is a stalled counter rather than a 500
that loses the other four, and reported into `job_succeeded`'s counters. It
drains **after** the conversation outbox, by the tick's own stated principle: a
listener waiting on a WhatsApp reply must not wait because somebody exported a
spreadsheet.

The claim is `for update skip locked` over a partial index on the sendable
status, with `claim_outbox_batch` (0063/0111) as the template — including its
warning about which statuses may appear in the index condition. `OUTBOX_BATCH`,
`BACKOFF_SECONDS = [1, 4, 16, 64, 256]`, `MAX_ATTEMPTS`, `STALE_CLAIM` of five
minutes, `PARKED_AT = 'infinity'` and the consecutive-retryable circuit breaker
are reused from `src/services/whatsapp.ts` with their reasoning intact.

**What earlier blocks already built, which this one consumes:**

| piece | from |
|---|---|
| the e-mail frame, and the escaping that dispenses with a sanitiser | 29b-1 |
| the Station's sender identity | 29b-1 |
| the registered template | 29b-1 |
| `MailMessage.headers`, for `List-Unsubscribe` | 29c |
| `members_marketing_eligible_bulk` | 29c |
| `issue_unsubscribe_token`, granted to `service_role` alone | 29c |

That last grant was narrowed in 29c to close a cross-tenant hole; the effect is
that the only thing in the system able to mint a token is the thing that sends.
Each e-mail recipient gets one, carried in the `List-Unsubscribe` header.

**The two channels differ.** WhatsApp marketing requires a Meta-approved
template — that is what permits speaking outside the 24-hour window — so a
campaign is refused before it starts if the template is not registered, rather
than discovering it message by message. E-mail's body is free within the frame.

Error taxonomy is the one `graph.ts` already draws: retryable returns to the
queue with backoff, permanent marks the row and is not retried. Consecutive
retryable failures park the whole drain, because twenty thousand attempts against
a provider that is down is how a WhatsApp number is lost.

## 7. Screens and permissions

MENSAGENS gains *Listas* and *Disparo em massa*; the three listing screens gain
the button.

Permissions are §11's three, the shape every module since Block 2 uses:
`messaging.view`, `messaging.manage`, and **`messaging.send` separately** —
approving a send to twenty thousand people is not the act of drafting one.
Creating a list requires `messaging.manage` **and** the ability to see the source
listing, or the button becomes a side door to data the caller could not reach
head-on. Every door is `SECURITY DEFINER` with `set search_path`, re-checking the
permission in its own body.

## 8. Retention and erasure

`message_campaign_recipients` holds a real person's phone number and e-mail.
Two obligations follow, neither in the original request: `anonymize_member` must
reach these rows, or erasing a listener leaves their number in an old queue; and
the retention sweep must remove them after a period, as it already removes
`outbox_messages` and, since 29c, unsubscribe tokens.

## 9. Tests

| Proof | Where | What it catches that the others cannot |
|---|---|---|
| Every door's permission gate, including `messaging.send` apart from `manage` | pgTAP | The boundary is the database's |
| `suppressed` distinguished from `failed`, and never retried | pgTAP | D1's whole point, at the layer that stores it |
| Cancellation marks pending and not in-flight | pgTAP | §10's stated limit |
| `anonymize_member` reaches recipient rows; the sweep removes them | pgTAP + isolation | §8, and the sweep cannot run inside pgTAP's transaction |
| A list of Station A cannot be sent by Station B | isolation | Real sessions, two tenants |
| A drain does not claim another Station's recipients | isolation | The queue's tenancy |
| **A listener who withdrew after the snapshot is suppressed, not sent to** | isolation | Where 29c meets 29d; provable only with real sessions |
| The whole journey: filter, list, campaign, test send, send, history | e2e | That the parts connect |

**A trap this project has already paid for:** `FakeTransport` answers `SENT`
without sending anything. A test that only checks the status became `sent` passes
against the fake and proves no message existed. Assertions look at what was
handed to the transport, not at what the queue says about itself.

## 10. Traps carried in

- The worker has no `auth.uid()`. Anything it calls must be `SECURITY DEFINER`
  and re-check permissions itself, or be resolved earlier as the operator.
- `create or replace` preserves a function's ACL; `drop` + `create` destroys it.
  A recreated function is rebuilt from its **live** definition, never from the
  migration that first created it. `psql` is not installed here.
- A migration adding an enum value ships alone.
- pgTAP `plan(N)` is a file's running total, recounted rather than adjusted.
- Hand-written counts that no compiler holds move when an enum or a list grows.
