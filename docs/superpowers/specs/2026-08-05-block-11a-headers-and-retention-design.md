# Block 11a — The headers that were never sent, and the data that was never let go — Design Spec

**Date:** 2026-08-05
**Status:** approved by the owner
**Splits:** master spec §11 Block 11 — this half ships the security headers, the nonce CSP and the retention cron (N7); observability, alerting, the five documents, the controlled seed and the deploy runbook are **Block 11b**
**Depends on:** Block 0 (`middleware.ts`), Block 5a (`webhook_events`, `outbox_messages`, `whatsapp_conversations`), Block 6b (`storage_erasure_queue`), Block 10a (the audit trail this block deliberately does not touch)
**Branches from:** `block-10a` — the migration continues at `0131`

---

## 1. What this block is for

**This application sends no security headers at all.** Neither `middleware.ts`
nor `next.config.mjs` sets one: no CSP, no `X-Frame-Options`, no
`Referrer-Policy`, no `X-Content-Type-Options`, no HSTS. Eighteen blocks have
shipped a product that can be framed by any site on the internet and that leaks
its full URL — including a `?record=<uuid>` — in the `Referer` of every outbound
request.

**And nothing is ever deleted for age.** Requirement N7 has been on the list
since the master spec: a retention sweep that walks data whose deadline has
expired and removes it. The raw Meta payload of every WhatsApp message this
installation has ever received is still in `webhook_events`, in full, with the
listener's phone number and message text — kept for ever because no code ever
said otherwise.

---

## 2. Decisions

### D1 — Static headers in `next.config.mjs`, the nonce CSP in `middleware.ts`

The split is not stylistic. `middleware.ts`'s matcher **deliberately excludes**
`/api/webhooks/` and `/api/worker/` — its header explains at length that
including them would 307 Meta's verification handshake and silently stop both
queues. Anything set only in the middleware therefore never reaches those two
routes.

So the headers that must apply everywhere — `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Strict-Transport-Security` — go in `next.config.mjs`'s `headers()`, which
applies to every route regardless of the matcher.

The **CSP carries a per-request nonce**, which only the middleware can generate,
so it lives there. That it does not reach the two machine routes costs nothing:
both return JSON to a non-browser caller, and a CSP governs what a *document*
may load.

### D2 — The CSP is nonce-based with `strict-dynamic`, and it starts in report-only

`script-src 'self' 'nonce-<n>' 'strict-dynamic'`. Next.js reads the nonce from
the CSP header on the request and stamps it onto its own scripts, so no
`'unsafe-inline'` is needed for the framework — which is the entire point of
doing it with a nonce rather than a hash list that rots on every build.

`style-src` keeps `'unsafe-inline'`, stated rather than hidden: Tailwind ships a
stylesheet, but React's inline `style` attributes and the `@react-pdf` renderer's
own injections do not carry a nonce, and a CSP that breaks the product on deploy
is a CSP that gets removed on deploy.

**It ships enforcing, not report-only**, and the reason is that this codebase has
a full Playwright suite: thirty-six journeys across every screen, run before
merge, which is a better CSP test than a week of report-only telemetry nobody
reads. If the suite passes, the policy does not break the product.

### D3 — Retention periods are fixed for the installation, not per Company

§9's N7 says "according to the per-Company policy". That costs a
`retention_policies` table, a screen to edit it, permissions for that screen, and
twice the tests — all starting with every radio on the same default value. The
owner ruled for fixed periods in code:

| what | kept for | why |
| --- | --- | --- |
| `webhook_events` | **90 days** | Meta's raw payload: phone number and message text, in full. Its only use is reprocessing a failed ingestion, which happens within hours. |
| `whatsapp_conversations` (closed) | **180 days** | Conversation state after it has ended. |
| `outbox_messages` (terminal) | **180 days** | What was sent to a listener, and when. |
| `contact_requests` | **365 days** | A visitor's e-mail from the public form. |
| `rate_limit_counters` (reset) · `whatsapp_conversation_leases` (expired) · `storage_erasure_queue` (processed) | **30 days** | Operational leftovers holding no personal data. Swept for size, not for law. |

A radio needing a different period is a conversation that has not happened. When
it does, the table this block did not build is a migration, and the sweep reads
it instead of the constant.

### D4 — Business records are never swept, and the list is explicit

Participations, winners, draws, inventory movements, promotions, members,
prizes: **none of these has a retention period**, because they are what the radio
must be able to prove afterwards. A prize delivered in 2024 and disputed in 2028
needs its `winners` row and its `inventory_movements` chain.

Personal data inside them is removed by **erasure** (`anonymize_member`, Block
3), which is subject-driven and already built, not by age. The two mechanisms
are different and this block adds nothing to the second.

### D5 — `audit_logs` is kept for ever, and the sweep passes it by deliberately

Block 10a's runbook flagged this as open; it is now closed the other way.

The trail is **pseudonymised by construction** since Block 3 — it holds ids, not
names — and it is the proof that erasures happened. **Deleting the record of a
deletion is the worst available outcome in an audit**, and it is precisely the
kind of event somebody asks about years later.

So the sweep does not name `audit_logs`, and both the migration header and the
runbook say so *positively* rather than by omission — an absence in a retention
sweep reads as an oversight unless it is written down as a decision.

### D6 — A procedure, committing per table, in `sweep_pickup_deadlines`' shape

`0094`'s header proved it and `0128` restated it: a procedure that commits may
carry **neither** `security definer` **nor** `set search_path`, because Postgres
refuses transaction control inside either. Every reference is schema-qualified by
hand.

It commits **per table**, so one table that cannot be swept — a lock, a
constraint added later — does not roll back the other six, every night, for ever.

### D7 — It counts what it deleted, and says so

Every sweep raises a `notice` naming each table and its row count, and a
`warning` per table that failed. Block 11b will turn that into an alert; until
then it is in the Postgres log, which is where the other three sweeps in this
schema already report.

**No audit row per deleted record**, deliberately: a sweep that writes one audit
row per deleted `webhook_events` row would write more rows than it removed, into
the one table this block promises never to sweep.

---

## 3. Migrations

| # | contents |
| --- | --- |
| `0131` | `sweep_retention()` procedure and its `cron.schedule` (daily, 04:11) |

---

## 4. Verification

**pgTAP** — the procedure exists and is a `procedure`; it carries neither
`security definer` nor a `set` clause (D6, and the assertion that stops a future
"hardening" from breaking every sweep at 04:11 where nobody is watching); its
body **does not name `audit_logs`, `participations`, `winners`, `draws`,
`members` or `inventory_movements`** (D4/D5 — asserted on the source, because a
sweep that gained a table would otherwise be found by its damage); a row older
than its period is deleted and one inside it is not, per table; the cron entry
exists.

**Vitest** — the CSP builder emits one `nonce-` per call and never repeats it;
the header list in `next.config.mjs` contains each of the five names.

**Playwright** — the whole existing suite, which is the CSP test: thirty-six
journeys across every screen, and a violation breaks them. Plus one assertion
that the response actually carries the headers, because a suite that passes
proves the policy is not too strict and says nothing about whether it was sent.

**The gate is the usual one:** `lint`, `typecheck`, `test`, `db:test`,
`test:isolation`, `build`, `test:e2e`.

---

## 5. Out of scope

Observability, error monitoring and the alert Block 11b will hang off D7's
counters; the five documents; the controlled seed; the deploy and backup/PITR
runbook; upload/MIME hardening (there is one upload path, delivery receipts, and
it is Block 11b's to review); per-Company retention policy (D3).
