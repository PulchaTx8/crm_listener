# Block 8b — The report engine, and the identity the worker does not have — Design Spec

**Date:** 2026-08-05
**Status:** approved by the owner
**Splits:** master spec §11 Block 8 — Block 8a shipped the three dashboards; this half ships the report engine, the export formats, asynchronous generation and the table §11 calls `saved_reports`
**Depends on:** Block 0 (the rate limiter), Block 3 (members and the LGPD stance), Block 4 (participations), Block 5 (the worker tick), Block 6 (winners, deliveries, and the storage erasure queue), Block 7 (music requests), Block 8a (the three aggregates, the period contract, the `withheld` rule)

---

## 1. What this block is for

Block 8a made the system answer questions on a screen. It cannot yet hand anybody a
file. Every question an operator has that ends in "…and send me the list" — the
listeners who signed up last month, who took part in the anniversary promotion, which
prizes were never collected — still ends with somebody reading a screen and retyping.

This block makes a report a file. Two kinds of file, because there are two kinds of
question:

- **A panel snapshot** — the numbers Block 8a already computes, laid out for printing or
  for a meeting. Three cards, never large.
- **A row listing** — the operational export: listeners, participations, winners and
  deliveries, music requests, inventory movements. Filtered exactly the way the screen
  filters them. Occasionally tens of thousands of rows.

And it makes generation **asynchronous**, which the master spec's own "done when" demands:
*a large report generates asynchronously without blocking the client.*

---

## 2. The constraint that shapes the whole block

**The worker has no identity, and nothing that exists today runs inside it.**

The tick (`src/app/api/worker/tick/route.ts`) is called by `pg_cron` through `pg_net` and
authenticates with a shared secret. It holds a `service_role` client. In that client:

- `auth.uid()` is **null** — there is no `sub` claim on a `service_role` JWT.
- `has_permission` (0010) therefore evaluates `has_company_access(...)` → false and
  `is_platform_admin()` (0005, `where pa.user_id = auth.uid()`) → false, and returns false.
- `get_audience_dashboard` (0118) and its two siblings are `SECURITY INVOKER` and are
  granted **to `authenticated` only**. The worker cannot execute them at all; if it could,
  their permission loop would raise `42501`.
- `list_participations` (0090), `list_pickups` (0095), `list_movements` (0096) and
  `list_music_requests` (0107) are `SECURITY DEFINER` but gate on `has_permission`, and are
  likewise granted to `authenticated` only.

So the thing that generates the file is not the thing that has the right to the data. Every
decision below is downstream of that sentence.

---

## 3. Decisions

### D1 — A report is always a file produced through the queue. There is no synchronous path

Every request — a thirty-row CSV or a forty-thousand-row workbook — becomes a row in
`report_runs`, is picked up by the tick, and appears on the operator's `/reports` screen when
it is ready.

The alternative considered and rejected was a threshold: generate small reports inside the
request and queue the large ones. It buys a better feel in the common case and costs two code
paths that must produce identical bytes, plus a synchronous generator running inside a web
request's time budget — where a misjudged row estimate is not a wait but a timeout. One path
is one set of defects, and the history in `report_runs` is complete by construction rather
than by remembering to write to it from two places.

The cost is real and stated plainly: the tick runs every ten seconds, so a small report can
take up to ten seconds to appear. The screen says "generating" for that time.

### D2 — A panel's numbers are captured at request time, as the caller. The worker only renders

Because of §2, the worker cannot call the three aggregates. It is not merely inconvenient —
they are not granted to it.

The resolution is better than a workaround. When an operator asks for a panel PDF, the
server action **calls the same aggregate the screen calls, as the same user, with the same
arguments**, and stores the returned payload in the run row. The worker's whole job is to
turn that stored JSON into a PDF.

This satisfies Block 8a's instruction to its successor verbatim — *"8b should reuse these
functions rather than write a fourth way to count the same rows"* — and it closes the
revocation window for panels at no cost, since the numbers were computed under the caller's
rights at the moment they were entitled to them. The `withheld` array (8a D13) travels in the
payload and is honoured by the renderer (D8 below).

### D3 — A row listing is generated in the worker, and authorization travels as an explicit user id

`has_permission(p_permission, p_company_id)` is rewritten as a **thin wrapper** over a new

```sql
public.has_permission_for(p_user_id uuid, p_permission text, p_company_id uuid)
```

with the entire body moving to the new function and the old signature becoming
`select public.has_permission_for(auth.uid(), $1, $2)`. One body, two doors. This shape is
the point: two independent implementations of "may this user read this" would agree on the
day they were written and drift afterwards, and the drift would look like a number rather
than like a defect.

`has_company_access` (0005) and `is_platform_admin` (0005) need the same treatment for the
same reason, since the wrapper's body calls them.

The run row records `requested_by`. The page function re-checks `has_permission_for(run.requested_by, …)`
**at generation time, on every page** — so a permission revoked between the request and the
generation closes the door mid-file, and the run ends `FAILED` with a permission error rather
than delivering rows the requester is no longer entitled to.

**Rejected:** freezing the authorized plan into the row at request time (does not catch
revocation, and puts the predicates in a place where they get rewritten by hand — the exact
loss `0095_list_pickups.sql`'s header records, where a second required permission went missing
for five commits). **Also rejected:** minting a short-lived JWT so the worker can impersonate
the requester. It removes all duplication and grants the worker the ability to act as any user
in the installation, which is a far worse blast radius than the problem it solves.

### D4 — The page functions mirror the screens' queries, and are `SECURITY DEFINER` for the same reason the list RPCs are

Five functions, one per report type, with one uniform signature:

```sql
public.report_page_<kind>(
  p_user_id uuid, p_company_ids uuid[], p_filters jsonb,
  p_cursor_at timestamptz, p_cursor_id uuid, p_limit integer
) returns table (
  sort_at timestamptz, sort_id uuid, row_data jsonb,
  total_count bigint, withheld text[]
)
```

Each one **carries every permission term its screen's list RPC carries**, not only the obvious
one — `list_participations`'s header is the standing warning here: RLS on `public.promotions`
silently required `promotions.view` alongside `participations.view`, and a `SECURITY DEFINER`
rewrite that gated on one of them would be more permissive than the query it replaced.

**`total_count` and `withheld` come back from the same call as the rows, and that is what stops
this block from repeating 0095's defect.** An earlier draft of this spec gave the page function
a run id and put the row ceiling in a separate `report_run_row_count` — two functions
implementing the same filter predicates, which is precisely the duplication the rest of this
document argues against. 0090 already solved it: *"total_count is computed from the same CTE the
rows come from, so a page and its count cannot narrow differently."* The same reasoning applies
to `withheld`, which is a function of the caller's permissions and must not be computed twice
either.

Taking an explicit `p_user_id` rather than a run id is what lets one function serve both callers:
the request path passes `auth.uid()` before any run row exists, and the worker passes
`run.requested_by`. A thin `report_page(...)` dispatches by report type, so the worker has one
call and no knowledge of report internals.

### D5 — `report_runs`: the queue and the history are one table

| column | meaning |
| --- | --- |
| `id` | |
| `organization_id`, `company_ids` | the Station or the consolidated set |
| `requested_by` | the identity D3 re-checks against |
| `report_type` | one of the eight (five listings, three panels) |
| `format` | `CSV` \| `XLSX` \| `PDF` |
| `filters` | `jsonb not null default '{}'`, with `CHECK (jsonb_typeof(filters) = 'object')` — the shape per report type is enforced by Zod at the boundary, and the page function reads only the keys it knows; a `CHECK` cannot express eight different filter shapes and pretending otherwise would put half a validator in SQL |
| `payload` | `jsonb`, the captured panel numbers (D2); null for listings |
| `status` | `QUEUED` → `RUNNING` → `READY` \| `FAILED` |
| `storage_path`, `row_count`, `byte_size` | filled on success |
| `attempts`, `last_error` | |
| `requested_at`, `started_at`, `finished_at`, `expires_at` | `expires_at` is set on success, seven days from `finished_at` — the clock starts when the file exists, not when it was asked for, so a run that sat in the queue does not arrive already half-expired |

**The name departs from §11's `saved_reports`, deliberately.** A table called "saved reports"
that holds a work queue misleads every future reader about what it is for; the owner asked for
generation history, not for saved filter definitions, and the name should say so. §11's term
maps to this table and nowhere else.

RLS: a row is visible to the user who requested it and to the Organization's owner. Nobody
updates a run from the client — `service_role` alone writes `status`, and the transitions are
RPCs, not table grants.

### D6 — A generated file lives seven days, and then its bytes are actually deleted

The bucket is `reports`, private, in the shape `0086_delivery_receipts.sql` established. No
public URL ever; the client asks for a short-lived signed URL at the moment of the click, and it
is never stored.

**Where it departs from 0086, and why the departure is stronger.** A delivery receipt has no row
of its own, so 0086 must prove the Station from the object path (`storage.foldername(name)[1]`)
and then ask `has_permission` about it. A report object *does* have a row — exactly one
`report_runs` row names it in `storage_path` — so the read policy matches on that and inherits
`report_runs`' own RLS through the subquery. The rule "may this caller see this run" is then
written once, and an object cannot be reached through any run except the one that produced it.
The path keeps the `{company_id}/{run_id}.{ext}` shape for legibility during an incident, not as
a permission check.

At expiry a sweep writes the object into `storage_erasure_queue` (0087) and clears
`storage_path`. The queue is drained by the tick through the storage API, because — as 0087's
header puts it — deleting a row in SQL removes the metadata and leaves the file in the backing
store. The history row survives with `row_count` and `expires_at` intact: **what was exported,
by whom, when** is the audit record and does not expire. Only the file does.

### D7 — A column the caller may not read is omitted, and the omission is written into the file

Block 8a's rule (D13 there) is that a figure the caller's permissions do not support is
withheld and named, never zeroed, because zero and "you may not see this" must not look alike.

**In a file the same rule is more dangerous, not less.** A missing column is indistinguishable
from a column nobody asked for, and a present-but-empty column looks like data — an empty
`phone` column reads as "these listeners have no phone", which is a false statement about
people.

So: withheld columns are **absent**, and every file carries a **provenance block** naming the
report, the period, the Stations, who generated it, when, the row count — and explicitly which
columns were withheld and which permission would have carried them. In CSV it is a run of
comment lines above the header; in XLSX a "Provenance" sheet; in PDF the footer.

The concrete cases are the ones the list RPCs already carry: `list_pickups`,
`list_participations` and `list_music_requests` all resolve `v_names := has_permission('members.view', …)`
and serve the listing without the listener's name, phone and document to a caller who lacks it.

### D8 — No new export permission. Each report inherits its screen's permission

| report | permission | source of the rule |
| --- | --- | --- |
| Listeners | `members.view` | 0035 |
| Participations | `participations.view` **and** `promotions.view` | 0090 |
| Winners and deliveries | `promotions.view` (+ `members.view` for names) | 0095 |
| Music requests | `music.view` (+ `members.view` for names) | 0107 |
| Inventory movements | `inventory.view` | 0096 |
| Audience / Music / Promotions panels | as Block 8a D2 | 0118–0120 |

A consolidated run over more than one Station additionally requires `reports.consolidated`
in **every** Station named, exactly as 8a D3 has it.

A separate `reports.export` code was considered and rejected: someone who can page through
forty thousand listeners on screen can already extract them, so the permission would add role
management burden without adding a boundary. The control that does work is the trail — **every
run is a `report_runs` row and an `audit_logs` entry** (`action = 'request_report'`), which is
the same stance Block 3 took with `document_access_logs`: the export is not forbidden, it is
recorded.

### D9 — Fifty thousand rows is the ceiling, and above it the run is refused, not truncated

The count costs nothing extra: it rides back on the page call itself (D4), so asking for the
count is asking for the first page with `p_limit => 1`.

**It is checked twice, and the two refusals look different on purpose.** At request time it runs
as the caller, and a request over the ceiling is **refused there, with no run row created**, so
the operator learns immediately and is told the count and to narrow the filter. It is checked
again in the worker — on the first page, from the same `total_count` — because rows keep
arriving between the request and the generation; a run that crosses the ceiling in that window
ends `FAILED` with the same message.

This does not contradict D1. D1 is about where a file is *produced*; nothing about it requires
that an impossible request be accepted, queued and failed ten seconds later when it could be
answered in the dialog the operator is still looking at.

A silently truncated export is the worst available outcome: it looks complete, it is used as
if it were complete, and nothing in the file says otherwise.

### D10 — Failure gives up after three attempts, and this is deliberately unlike the erasure queue

`storage_erasure_queue` has **no** give-up threshold, on purpose — 0087's header calls a
silently abandoned erasure "the single failure this table exists to prevent", because it is a
legal obligation.

A report is the opposite. After three attempts the run is `FAILED` with the error visible on
the operator's own screen, and they request it again. A queue that retries for ever hides the
defect that is causing the failure behind a row that is always about to succeed.

A run left `RUNNING` for more than fifteen minutes — the container died mid-file — returns to
`QUEUED` and counts an attempt.

### D11 — One run per tick, claimed with `for update skip locked`

The claim follows `claim_outbox_batch` (0111). One run per tick, because the tick's first duty
is the WhatsApp outbox and a forty-thousand-row workbook must not hold it. Report generation is
a third drain beside `runTick` and `drainStorageErasures`, and — like the second — its failure
is caught and reported in the tick's counters rather than thrown, so a broken report engine
cannot stop messages going out.

### D12 — PDF renders panels; XLSX and CSV render listings

A PDF of forty thousand participations is not a report. Panels get PDF, where the artefact is
a page somebody prints. Listings get XLSX and CSV, which is what row data is actually used in.

`exceljs` and `@react-pdf/renderer` are both **named in the Block 0 spec and never installed**;
this block adds them. `@react-pdf/renderer` has a history of lagging new React majors and this
project is on **React 19**, so the risk was checked before the plan was written rather than
assumed: `@react-pdf/renderer@4.5.1` declares `react: ^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0`,
and `exceljs` is at `4.4.0`. The declaration is not the proof, so rendering a page to a buffer
in Node is still the plan's first task, before anything depends on it — but the fallback (the
panel PDF through the browser's print pipeline) is now unlikely to be needed.

XLSX is written through `ExcelJS.stream.xlsx.WorkbookWriter`, not the in-memory workbook, so a
report at the D9 ceiling does not hold fifty thousand rows in the worker's heap.

### D13 — The period contract is Block 8a's, unchanged

Local dates on the wire, presets resolved in SQL per Station through `resolve_dashboard_period`
(0117), every bound half-open. A report and the panel it was exported from must not disagree
about what "last month" means, and the only way to guarantee that is to not have a second
implementation. Listings that carry a date filter use the same resolver.

### D14 — The request is rate limited through the counters Block 0 built

`rate_limit_hit` (0002) is granted to `service_role` and is `SECURITY INVOKER`, so it is called
with the service client — the pattern `services/invitations.ts` already uses. Keyed by user,
it bounds how many runs one operator can queue in an hour. A report is the cheapest way in this
system to ask the database for a great deal of work.

---

## 4. The catalogue

### 4.1 Listeners — `members.view`

Filters: Station(s), registration period, situation (active / blocked / archived), consent
state, age band. These mirror `listOrganizationMembers`' own parameters
(`src/services/members.ts`), which is where the report's page function takes its predicates
from.

**There is no CPF column, and this will surprise whoever asks for one.** `0031_members.sql`
stores `cpf_hash` (SHA-256, hashed in Node) and `cpf_last_digits` (three digits) and says so:
*"The raw number is stored nowhere and appears in no query log."* The report can carry the last
three digits, which is what a person confirms out loud, and nothing more. No export can undo
that, and none should.

Columns: name, phone, e-mail, CPF last digits, birth date, city, state, registered at,
situation.

**This is the one report with no withheld set**, and the provenance block says so rather than
staying silent: `members.view` gates the whole listing, so a caller either gets every column or
gets a `42501`. The withheld machinery of D7 exists for the four reports below, where identity
columns ride alongside data the caller may read without being entitled to the identity.

### 4.2 Participations — `participations.view` and `promotions.view`

Mirrors `list_participations` (0090) filter for filter: promotion, status, source, date range,
listener search, answered correctly, chose a given option. Columns: promotion, listener (name,
phone, CPF last digits — withheld together without `members.view`), status, source,
participated at, already won.

A search term without `members.view` returns nothing at all, exactly as 0090 has it: searching
a field you may not read is an oracle.

### 4.3 Winners and deliveries — `promotions.view`

Mirrors `list_pickups` (0095): draw, prize, pickup status, deadline. Columns include the
deadline and whether it was met, which is the question this report exists to answer. Listener
identity is the `members.view` withheld set.

A cancelled draw awards nothing (0097), and its winners appear here in no other guise —
the same rule Block 8a's D12 states for the panels.

### 4.4 Music requests — `music.view`

Mirrors `list_music_requests` (0107): period, song, artist, status. Requester identity is the
`members.view` withheld set.

### 4.5 Inventory movements — `inventory.view`

Mirrors `list_movements` (0096): period, prize, movement type. Columns: moved at, prize, type,
quantity, bucket, actor, note.

### 4.6 The three panels — Block 8a's permissions

`AUDIENCE_PANEL`, `MUSIC_PANEL`, `PROMOTIONS_PANEL`, format `PDF` only. The payload is captured
per D2; the renderer lays out the cards, the comparison window and the breakdowns, and honours
`withheld` per D7 — a withheld figure is absent from the page and named in the footer, never
printed as zero.

---

## 5. The screens

**`/reports`** — a new top-level entry, because the catalogue crosses every domain and hanging
it under one of them would be a lie about where it belongs. It lists the caller's own runs,
newest first: type, Stations, period, format, status, and a download button once `READY`. The
button calls a server action that mints the signed URL at click time. An expired run shows its
history with the file gone and says so.

Refresh: a client component that calls `router.refresh()` on an interval **only while a run is
`QUEUED` or `RUNNING`**, and stops when none is. TanStack Query is not in this project, and
this does not justify adding it.

**"Export" on the five listing screens**, carrying the filters that are already on screen. This
is where the block earns its ergonomics: the operator has already expressed the question by
filtering, and the export must not make them express it a second time in a different dialog.
The dialog asks for the format and nothing else.

**"Export PDF" on the three panels**, carrying the period and Station selection.

---

## 6. Migrations

| # | contents |
| --- | --- |
| 0121 | `has_permission_for`, `has_company_access_for`, `is_platform_admin_for`; the three existing signatures become wrappers (D3) |
| 0122 | `report_status` enum, `report_type` enum, `report_runs`, its indexes, RLS |
| 0123 | the `reports` bucket and its `storage.objects` policies (0086's shape) |
| 0124 | `report_page_listeners`, `report_page_participations` |
| 0125 | `report_page_winners`, `report_page_music_requests`, `report_page_movements` |
| 0126 | the `report_page` dispatcher |
| 0127 | `request_report` (which preflights through 0126), `claim_report_run`, `finish_report_run`, `fail_report_run`, `requeue_stalled_report_runs` |
| 0128 | `expire_report_runs` procedure and its `cron.schedule`, writing into `storage_erasure_queue` |

**The order has no forward references, and that is deliberate rather than incidental.** The
lifecycle RPCs come *after* the page functions because `request_report` calls the dispatcher for
its preflight (D9); plpgsql would resolve a forward call at run time and let the wrong order pass
migration, then fail on the first request in whatever environment ran it first.

0121 is first and alone for a different reason: it touches four functions
(`is_platform_admin`, `is_owner`, `has_company_access`, `has_permission`) that every policy in
the installation depends on. It goes in as a pure refactor with the full pgTAP suite green
behind it, before anything is built on top of it.

---

## 7. Verification

**pgTAP** — `has_permission_for(u, p, c)` and `has_permission(p, c)` return the same answer for
the same user across the whole permission matrix, which is the entire reason one is a wrapper
over the other; a permission revoked between `request_report` and `report_page` makes the next
page raise `42501`; each page function refuses a caller missing *either* of its two codes where
it has two; a withheld column is absent from the returned `jsonb` rather than null; the row
ceiling refuses rather than truncates; `claim_report_run` under two concurrent claimants hands
the run to exactly one; a run stuck `RUNNING` past the threshold requeues and counts an attempt;
an expired run's object reaches `storage_erasure_queue` and its `storage_path` is cleared.

**Isolation suite** (real JWTs, never `service_role`) — a run requested by a user of Station A
yields no row of Station B, including through a consolidated request naming B; a user without
`reports.consolidated` cannot request a consolidated run; a user cannot read another user's run
row or obtain a signed URL for their file; a caller with `participations.view` but not
`members.view` receives a participations export with the identity columns **absent and named in
the provenance block**, not blank.

**Vitest** — the Zod filter schemas reject a malformed `jsonb` per report type; the CSV writer
escapes a value containing the delimiter, a quote and a newline; the provenance block names
every withheld column; the panel renderer omits a `withheld` figure rather than printing zero;
the tick's report drain failing does not lose the outbox counters.

**Playwright** — filter a listing, export it, run the tick, and download the file from
`/reports`; a panel PDF end to end.

**The gate is the usual one:** `lint`, `typecheck`, `test`, `db:test`, `test:isolation`,
`build`, `test:e2e`.

---

## 8. Out of scope

Saved filter definitions with names, re-runnable in a click — the owner ruled the history alone
is what `saved_reports` means here. Scheduled reports and reports delivered by e-mail. Reports
over the audit trail itself (Block 10 owns the audit viewer). Any export carrying a full CPF,
which is not out of scope so much as impossible: the number is not stored.

**What the deploy inherits, and the runbook must open with it** — the same trap Block 7a paid
for once and Block 8a restated: a frontend deployed ahead of `supabase db push` offers the
export buttons and fails behind them. Worse here than there, because 0121 rewrites
`has_permission`: the database must go first, and the pgTAP suite is what says it may.
