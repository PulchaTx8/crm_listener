# Block 8b — The Report Engine, and the Identity the Worker Does Not Have

**Audience:** whoever deploys this block, whoever operates a Station once it is
live, and whoever answers the phone when a report does not arrive.

---

## 0. Read this first: this block rewrites `has_permission`

Every other block's deploy note says the database should go first. **This one
means it differently.**

`0121` replaces `is_platform_admin`, `is_owner`, `is_owner_of_company`,
`has_company_access` and `has_permission` with one-line wrappers over new
`_for` siblings that take a user id. Every RLS policy in the installation
depends on those five functions. The bodies are unchanged — every one is the
body that stood after `0024` with `auth.uid()` replaced by a parameter — but
the blast radius of getting it wrong is the whole product, not one screen.

**So the order is not negotiable, and the evidence for going ahead is not "it
built":**

1. `supabase db push` (migrations `0121`–`0128`).
2. `npm run db:test` — **1336/1336**, on a database with those migrations
   applied. `21_permission_for.test.sql` is the file that matters: it asserts
   the wrappers keep **no body of their own** and that both doors agree across
   the whole permission catalogue.
3. `npm run test:isolation` — **269/269**. This is the one that can actually
   see a permission regression: pgTAP runs as superuser with a null
   `auth.uid()`, so it never exercises RLS at all.
4. Only then, the frontend.

### If the frontend goes first anyway

The failure is loud in one place and quiet in another, and the quiet one is
what will waste the on-call hour:

- **Loud:** every Export button fails with `PGRST202` — "Could not find the
  function `public.request_report` in the schema cache". Nothing in that
  message names a migration or a deploy order.
- **Quiet:** `/reports` renders an empty table and looks like a working screen
  with nothing in it, because `report_runs` does not exist and the query
  errors into the page's own empty state.

### If the database goes first (the safe direction)

Nothing happens. `0121` is behaviour-preserving, the new tables are unread, and
the `expire_report_runs` cron job finds nothing to expire. This is the correct
order and it costs nothing.

---

## 1. What ships

**Eight migrations, `0121`–`0128`.** The permission siblings; `report_runs` and
its three enums; the private `reports` bucket; five page functions and a
dispatcher; the run lifecycle; the expiry procedure and its cron entry.

**One new cron job:** `expire-report-runs`, daily at **03:17**. It sends every
report file past its seven days to `storage_erasure_queue`, which the existing
worker tick drains through the storage API.

**One new drain on the existing worker tick.** The tick's response gains a
`reports` key: `{ requeued, claimed, ready, failed }`, or `{ error }` if the
drain threw. **A report drain that fails does not take the WhatsApp outbox with
it** — that is asserted in `tests/unit/worker-tick-route.test.ts`.

**Two new dependencies:** `exceljs@4.4.0` and `@react-pdf/renderer@4.5.1`. Both
were named in the Block 0 spec and never installed.

---

## 2. Operating it

### What an operator sees

Every listing screen (Members, Participations, Pickups, Music requests, Stock
movements) and every dashboard has an **Export** button. It takes the filters
already on the screen. Listings offer XLSX and CSV; dashboards offer PDF.

The file appears under **Reports → My reports**. A run is `Queued…`, then
`Generating…`, then a Download button. The screen refreshes itself while
anything is pending and stops when nothing is.

### Timing

`pg_cron` fires the tick every ten seconds and **one run is generated per
tick**. So a report takes up to ten seconds to start, plus however long it
takes to generate. That ceiling is deliberate: the tick's first duty is the
WhatsApp outbox, and a forty-thousand-row workbook must not hold it.

Ten queued reports therefore take about a hundred seconds to clear. This is the
expected behaviour, not a stall.

### The seven days

A file is erased seven days after it was **generated** (not requested). The
history row survives: what was exported, by whom, when, and how many rows. An
expired run shows "expired" rather than a Download button.

**The erasure is real.** Deleting a row in SQL removes the metadata and leaves
the file in the backing store, so the expiry queues the object and the worker
deletes it through the storage API. If `storage_erasure_queue` stops draining,
files outlive their seven days silently — watch the tick's `erasures.failed`.

### The 50 000-row ceiling

A request above it is refused **in the dialog**, with the count, before a run
exists. Nothing is ever truncated: a partial export looks complete and is used
as if it were.

### Rate limit

Twenty reports per user per hour.

---

## 3. When something goes wrong

**A run says FAILED with an error.** It was tried three times. The error is on
the operator's own screen. Three attempts and then it stops, deliberately
unlike `storage_erasure_queue`, which never gives up — a report only needs
asking for again, and a queue that retries for ever hides the defect behind a
row that is always about to succeed.

**A run is stuck RUNNING.** After fifteen minutes the next tick returns it to
the queue (or fails it, if its attempts are spent). A container that died
mid-file is the case this exists for.

**A run failed with a permission error.** This is by design and worth reading
before treating it as a bug: the requester's permission is re-checked **on
every page**, against the person who asked. A role changed between the request
and the generation closes the door mid-file.

**Every run is in `audit_logs`** with `action = 'request_report'`. There is no
`reports.export` permission by design — somebody who can page through forty
thousand listeners on screen can already extract them — so the trail is the
control. That is the query to run when asked who exported what.

---

## 4. Two things the product cannot do, so nobody has to find out the hard way

**No export carries a full CPF.** `0031` stores a SHA-256 and the last three
digits, and says the raw number "is stored nowhere and appears in no query
log". The three digits are what ships. This is not a scope decision that can be
revisited without changing how listeners are stored.

**A withheld column is absent, never blank.** A caller with
`participations.view` but not `members.view` gets every row and no name, phone
or document — and the file's provenance block names what was withheld and which
permission would have carried it. An empty column would read as "these
listeners have no phone", which is a false statement about real people.

The provenance block is the first thing in every file: a CSV opens with comment
lines, an XLSX carries a "Provenance" sheet, a PDF carries a footer. When
nothing was withheld it says so explicitly, because a file silent about it is
indistinguishable from one that quietly dropped a column.

---

## 5. A note for whoever runs the test suites

`npm run db:test` must run against a **freshly reset** database. This is not
new and not this block's doing, but it cost time during this block's
verification and is written down here for the next person: after the e2e or
isolation suites have run, `15_music_rpcs.test.sql` (Block 7a) fails with "more
than one row returned by a subquery used as an expression", because its
fixtures assume music rows they did not create do not exist. `supabase db
reset` first, and the suite is 1336/1336.
