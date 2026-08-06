# Block 11b — The nonce that never arrived, the routines nobody watches, and the file nobody checked — Design Spec

**Date:** 2026-08-06
**Status:** approved by the owner
**Splits:** master spec §11 Block 11 — 11a shipped the five static headers and the retention sweep; **this block ships the executable security work**: the CSP that 11a withdrew, alerting for the scheduled routines, and the upload review. **The five documents, the controlled seed, the deploy runbook and backup/PITR move to Block 11c** — the owner split them out so a CSP that turns out to have no solution cannot hold the documentation hostage
**Depends on:** Block 0 (`middleware.ts`, the mailer), Block 5a (`0064`, the pg_cron → pg_net → route pattern this block copies), Block 6b (`delivery-receipts`), Block 8b (`reports`), Block 11a (D2, the CSP brief)
**Branches from:** `main` at `32adc73`. **Not from `block-11a`** — it merged as PR #30, and this project's PRs merge while the next block is in flight, so a `--base` on the previous branch fails with a 404. The migration continues at `0132`

---

## 1. What this block is for

**Three things shipped without the check that was supposed to be on them.**

The **CSP** was implemented in 11a, tested, and withdrawn: the Playwright suite
came back `11 passed, 23 failed` with no CSP error anywhere, because no client
component hydrated. D2 of that spec is the brief and it names the symptom
precisely; what it could not name is the cause. This block finds it.

The **scheduled routines** — five of them now — tell nobody anything. The
retention sweep of 11a spent its whole first version deleting zero rows every
night at 04:11 while `raise notice` wrote its counters to a Postgres log that
has never been read by a human. A sweep failing for a month looks exactly like
one that works.

The **upload path** accepts whatever the browser says it is. `attachReceiptAction`
checks `instanceof File && size > 0`; `attachDeliveryReceipt` stores the object
with `contentType: input.file.type` and builds its storage key from the client's
own filename; and neither `delivery-receipts` (`0086`) nor `reports` (`0123`)
carries a `file_size_limit` or an `allowed_mime_types`. An operator can upload
two gigabytes of HTML and have it served back as HTML from a signed URL.

---

## 2. Decisions

### D1 — The first task is a probe, not a policy

11a wrote the policy first and then spent three measured attempts guessing at
why it did not work. This block inverts that: **before any directive is
written, a test proves where the nonce arrives.** Three candidate causes, all
answerable in minutes, all from Next's own documentation rather than from
inference:

**Cause 1 — the Supabase `setAll` throws the request headers away.** The nonce
reaches the renderer through the **request** `Content-Security-Policy` header;
`x-nonce` exists only so a Server Component can read it. But `src/middleware.ts`
rebuilds the response inside Supabase's `setAll` with a bare
`NextResponse.next({ request })`, and each rebuild discards any request headers
set beforehand. 11a's third attempt — "rebuilding the forwarded headers after
the cookie write" — was one step from this and stopped.

**Cause 2 — statically rendered pages have no nonce.** `next build`
prerenders every route that does not reach for `cookies()` or `headers()`. In
prerendered HTML there is no request nonce at render time, so the inline
bootstrap scripts ship unstamped. `/`, `/contato` and `/login` are the
candidates — and **`/login` is where every Playwright journey begins**, which
matches "23 journeys timed out clicking things that did nothing" exactly. The
evidence is the ○/ƒ legend `next build` already prints. The fix, if it is this,
is `export const dynamic = 'force-dynamic'` on those routes: three public pages
rendered per request, which costs nothing this product will notice.

**Cause 3 — `next dev` needs `'unsafe-eval'`, and the local suite runs against
it.** `playwright.config.ts` runs `npm run build && npm run start` in CI and
`npm run dev` locally. The dev server compiles with eval-based source maps and
React Refresh, so a `script-src` without `'unsafe-eval'` blocks the framework
outright — every screen dead, in exactly the shape 11a described. Next's own
example carries the keyword in development for this reason, and the policy here
does too, gated on `NODE_ENV`. This cause would also explain why the failure was
invisible: an eval violation is reported in the **browser** console, and nothing
in the run was listening to the browser. D3 is what fixes that.

### D2 — The policy, and the two directives that break everything if forgotten

Enforcing, in `middleware.ts` (the per-request nonce can only be minted there;
the five static headers of 11a D1 stay in `next.config.mjs`):

```
default-src 'self';
script-src 'self' 'nonce-<n>' 'strict-dynamic' [+ 'unsafe-eval' in development];
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: <supabase-url>;
font-src 'self' data:;
connect-src 'self' <supabase-url> wss://<supabase-url>;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

**`connect-src` must carry the Supabase origin.** supabase-js talks to it from
the browser; without it every client-side query dies and the failure looks like
a broken product, not a policy.

**`style-src` carries `'unsafe-inline'` deliberately.** In CSP that keyword
covers the `style` *attribute* as well as `<style>` elements, and React emits a
style attribute for every `style={{…}}` prop — which is what the Block 8a charts
are made of. Inline style is a far smaller class of risk than inline script, and
pretending otherwise would cost a rewrite of working screens to buy very little.

The middleware matcher already excludes `/api/webhooks/` and `/api/worker/` and
that is correct here: a CSP governs what a *document* may load, and both routes
return JSON to a non-browser caller.

### D3 — The test that 11a did not have: a violation fixture

The 11a failure produced **no error message at all**, which is why three
attempts could be measured and still learn nothing. This block adds a Playwright
fixture that listens for the page's `securitypolicyviolation` event and fails
the test on any violation, naming the directive and the blocked URI. A silent
failure becomes a loud one.

Alongside it: a unit test of the pure policy builder (`src/lib/security/csp.ts`)
asserting the directive set and that `script-src` never contains
`'unsafe-inline'`, and — as the runbook of 11a already instructs — **the
Playwright pass count read as a number**, not the console skimmed for red.

### D4 — If the nonce does not yield, everything that does not depend on it still ships

Decided by the owner. Should the probe and the fixture leave the nonce still not
reaching the renderer, the block does **not** withdraw the policy a second time.
It ships enforcing for every directive that needs no nonce — `default-src`,
`object-src`, `base-uri`, `form-action`, `frame-ancestors`, `img-src`,
`font-src`, `connect-src` — and puts `script-src` alone into
`Content-Security-Policy-Report-Only`.

That is a real gain at no risk to a screen: base-uri and form-action shut down
injected-base and form-hijack attacks, object-src kills plugin embedding, and
frame-ancestors duplicates the `X-Frame-Options: DENY` already shipped. What is
lost is exactly the part that could not be made to work.

### D5 — Health is one row per routine, and failure is detected by silence

`job_health`, primary key on the pg_cron job name, seeded by the migration with
the five routines that exist today. Columns: `last_started_at`,
`last_success_at`, `last_counters jsonb`, `consecutive_failures`, `alerted_at`,
and `max_silence` — how long without a success counts as broken, per routine.
RLS enabled with **no policies**: this is operations data and nothing in the
product reads it.

`job-health-check`, the sixth job `0133` schedules, gets no row: a checker
cannot report its own silence.

**Nothing in this design uses an `exception` handler, and that is the lesson of
11a.** A `begin … exception when others … end` block opens a subtransaction, and
`commit` inside one raises `cannot commit while a subtransaction is active` —
which is how the retention sweep shipped deleting nothing while its pgTAP file
stayed green. So each routine does two plain things: stamp `last_started_at` on
entry, and write `last_success_at` with its counters on exit. **A failure is
`last_started_at > last_success_at` past the deadline, or silence beyond
`max_silence`.** No handler, no subtransaction, no repeat of the defect.

| routine | cadence | silence tolerated |
| --- | --- | --- |
| `whatsapp-worker-tick` | 10 s | 15 min |
| `pickup-deadline-sweep` | hourly | 3 h |
| `pickup-reminder-sweep` | hourly | 3 h |
| `expire-report-runs` | 03:17 daily | 26 h |
| `retention-sweep` | 04:11 daily | 26 h |

The tick is stamped by the route (`/api/worker/tick`) rather than by SQL,
because its cron statement only enqueues an HTTP request. That is also why
`cron.job_run_details` is **not** the detection source: `net.http_post` reports
success the moment the request is queued, so pg_cron would call the tick healthy
with the app in the ground. Its `return_message` is read only to decorate the
alert e-mail with an error string when one happens to exist, and the alert must
work without it.

### D6 — One e-mail per incident, to a fixed address, sent by the app

The alert path copies `0064` exactly: a sixth cron job, `job-health-check`,
hourly, `pg_net` posting to `/api/worker/health-alert` with the `x-worker-secret`
header. The route reads `check_job_health()` and, for each unhealthy routine
whose `alerted_at` is null, sends **one** message to `ALERT_EMAIL` and stamps
it. The next success clears the stamp. Still broken twenty-four hours later, it
sends one reminder. So: one e-mail per incident, not one per hour, and recovery
re-arms it.

`ALERT_EMAIL` is **optional**, like `SMTP_URL` already is. Without it the route
sends nothing and logs why — a container refusing to boot because an alert
address is missing would be a worse outage than the one it is trying to report.

The recipient is a fixed operations address rather than the platform admins:
whoever runs the platform is not necessarily whoever happens to hold an admin
row, and an env var changes without a migration.

**Two things this does not cover, stated rather than implied:** the app being
down (the mailer lives in it) and `job-health-check` itself stopping. Both are
external uptime monitoring, which is not code in this repository.

### D7 — The bucket is the barrier; the action is the message

`file_size_limit` and `allowed_mime_types` go on `storage.buckets`, because that
is the one check no client can go around. `delivery-receipts`: 10 MB, and
`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf` — a
handover photo taken on a phone, or a scan.

**`reports` gets the size limit and deliberately no MIME list.** Its content
type comes from `FORMAT_CONTENT_TYPES` (`src/lib/reports/types.ts:166`), a
frozen server-side map no client can influence, so an allow-list would add
nothing — and one of its three values is `text/csv; charset=utf-8`, a
parameterised type an allow-list of `text/csv` may well refuse. Adding a check
that can only break a working path buys the opposite of safety. The cap is
100 MB: the row ceiling is 50 000 (`REPORT_ROW_CEILING`), so nothing legitimate
comes near it and a runaway still has a wall.

The check in `attachReceiptAction` exists so the operator reads "that file is
40 MB" instead of a raw Storage error. It is not the security boundary and the
spec says so out loud, because a validation nobody can explain the purpose of is
a validation somebody deletes.

### D8 — The stored extension comes from the MIME type, not the filename

Today the storage key is built from `file.name.slice(file.name.lastIndexOf('.'))`
— a client-supplied string pasted into a path. Deriving the extension from the
already-validated content type ends the entire class of question without anyone
having to reason about which strange filename does what.

### D9 — No magic-byte sniffing, deliberately

What makes a stored object dangerous is not its bytes but the `Content-Type` it
is served with: HTML stored as `image/jpeg` is inert in a browser. Since the
stored content type now comes from a closed list, a lying file is junk rather
than script. Reading each file's header would cost code and tests to buy
nothing.

### D10 — The CSV import is capped, and nothing more

`import-form.tsx` reads the chosen file into an `ArrayBuffer` in the browser and
never stores an object, so it has no MIME question. It gets a size cap with a
clear message before the read, so a two-gigabyte file kills a dialog rather than
the tab.

---

## 3. Migrations

| # | what |
| --- | --- |
| `0132` | `job_health` (one row per routine, seeded), `check_job_health()`, RLS on with no policies |
| `0133` | The four SQL routines stamp start and success with counters; `job-health-check` scheduled hourly |
| `0134` | `file_size_limit` on both buckets; `allowed_mime_types` on `delivery-receipts` only (D7) |

---

## 4. Order of work

**The CSP goes first.** It is the only item that may turn out to have no
solution, and finding that out after three days of tables and uploads would be
finding out late.

1. The probe (D1) — what does the rendered HTML actually carry.
2. The policy and the violation fixture (D2, D3), with D4 as the fallback.
3. `job_health`, the routines, the check function, the route, the e-mail (D5, D6).
4. The buckets, the action, the extension, the CSV cap (D7–D10).

---

## 5. Verification

**The house gates:** lint, typecheck, build, unit, pgTAP, isolation, e2e in
series.

**Specific to this block:**

- The Playwright **pass count read as a number**. 11a's failure produced no
  error output whatsoever; a skimmed console is how it got as far as it did.
- The `securitypolicyviolation` fixture failing on any violation (D3).
- **The isolation suite over a direct Postgres connection** for the routines
  that commit: `tests/isolation/retention.test.ts` is the only place in the
  repository that can call one, because a procedure is unreachable through
  `supabase.rpc()` (`PGRST202`) and pgTAP wraps its file in a transaction that
  rolls back. `call sweep_retention()` must leave `job_health` holding a success
  and its counters. **Any scheduled routine that commits gets a test that calls
  it** — the rule 11a paid for.
- pgTAP that both `storage.buckets` rows really carry their limit, and that
  `delivery-receipts` carries the MIME list. Configuration nobody asserts is
  configuration that returns to its default on the next `db reset`.
- Unit tests: the policy builder; the alert route sending one message per
  unhealthy routine, respecting `alerted_at`, and refusing without the secret;
  the upload validator.

---

## 6. Deploy

**Database first**, and for once it is uneventful: `0133` only makes routines
record their own health, and `0134` tightens two buckets whose current contents
already comply. Nothing changes behaviour.

If the frontend goes first, `/api/worker/health-alert` answers, fails to find
`job_health`, and logs it. Nobody in the product feels anything. The CSP travels
with the frontend.

---

## 7. Out of scope

**Block 11c**, the last one: the five documents (ARCHITECTURE, SECURITY,
DATABASE, PERMISSIONS, DEPLOYMENT), the controlled seed, the deploy runbook and
documented backup/PITR.

**Still deferred:** Block 9 (the legacy ETL — the owner has neither the SQL
Server, nor a dump, nor a schema) and Block 10b (`entitlements` and the `pending`
state — no consumer asks whether a feature is on, and the admin provisions each
customer by hand, so a Company is born enabled).

**Not in this block either:** external uptime monitoring, an error-tracking
service, and a screen for `job_health`. The first two are not repository code;
the third would be a new admin page with its own permission and tests to show
five rows that an e-mail already pushes to the person who can act on them.
