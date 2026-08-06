# Block 11b — The CSP, the Routines That Report Themselves, and the Upload Review

**Audience:** whoever deploys this block, whoever gets an e-mail at 04:30 saying
a routine has gone quiet, and whoever is about to edit the security policy.

---

## 0. Deploy

Uneventful, and in this order.

1. `supabase db push` (`0132`–`0134`).
2. `npm run db:test` — **1397/1397**.
3. `npm run test:isolation` — **285/285 in 28 files**.
4. The frontend.

`0133` only makes the routines record their own health and `0134` tightens two
buckets whose current contents already comply, so nothing changes behaviour.

**If the frontend goes first**, `/api/worker/health-alert` answers, fails to find
`job_health`, and logs it. Nobody in the product feels anything. The CSP travels
with the frontend.

### Two settings, or the alert never leaves

On the hosted database, the same way `app.worker_tick_url` is already set
(`docs/block-5a-runbook.md`):

```sql
alter database postgres set app.health_alert_url =
  'https://<host>/api/worker/health-alert';
```

`app.worker_tick_secret` is already set and is reused — the health check
presents the same shared secret the tick does.

And in the EasyPanel **runtime** environment (never a build arg):

```
ALERT_EMAIL=ops@yourdomain
```

**Unset means silence, by design.** The route answers `{"configured": false}`
and sends nothing. A container refusing to boot because an alert address is
missing would be a worse outage than the one it is trying to report — but an
installation that never sets it has no alerting, and that is a decision somebody
has to make on purpose.

---

## 1. The CSP

It is enforced now, minted per request in `src/middleware.ts` from
`src/lib/security/csp.ts`. The five static headers of Block 11a stay in
`next.config.mjs`.

**Two things were wrong in Block 11a, and neither was any of the three fixes it
tried.**

**The nonce reaches the renderer through the `Content-Security-Policy` header on
the REQUEST.** `x-nonce` only lets a Server Component read it. And the forwarded
headers must be rebuilt *inside* Supabase's `setAll`, because that callback
reconstructs the response with a bare `request` and throws away anything set
before it — which is where the nonce was being lost.

**`next build` prerendered the landing page.** Prerendered HTML carries no
request nonce, so its bootstrap scripts shipped unstamped and the policy blocked
every one of them. `src/app/(public)/page.tsx` now carries
`export const dynamic = 'force-dynamic'`. It was the only static route left;
`/_not-found` is still prerendered and has nothing to hydrate.

**`'unsafe-eval'` is in the policy in development only.** `next dev` compiles
with eval, and `playwright.config.ts` runs the dev server locally while CI runs
a production build. Without the keyword the local suite blocks the framework
outright — which is the shape of the 11a failure, and quite possibly a third of
its cause.

### If you edit this policy

**Run the full Playwright suite and read the pass count as a number.** The 11a
failure produced no error message anywhere in the test output, because CSP
violations are raised in the *browser* and nothing there was listening.

`tests/e2e/csp.spec.ts` now holds both halves: the delivered HTML must carry the
nonce on every `<script>` tag (on `/login` and `/`), and the three public pages
must raise no violation. `tests/e2e/csp-violations.ts` installs that listener,
and `dashboards.spec.ts` — the longest signed-in journey, on the screen made of
inline style attributes — uses it too.

**Two directives will break the product if anybody trims them:**
`connect-src` must carry the Supabase origin and its `wss:` form, or every
client-side query dies; and `style-src` carries `'unsafe-inline'` because in CSP
that keyword also covers the `style` attribute, which React emits for every
`style={{…}}` prop.

---

## 2. The health of the five routines

One row each in `job_health`, and **failure is detected by silence** — no
`exception` handler anywhere, because a block with one opens a subtransaction
and `commit` inside it raises. That is how the 11a sweep shipped deleting
nothing with a green suite.

| routine | cadence | quiet for longer than |
| --- | --- | --- |
| `whatsapp-worker-tick` | 10 s | 15 min |
| `pickup-deadline-sweep` | hourly | 3 h |
| `pickup-reminder-sweep` | hourly | 3 h |
| `expire-report-runs` | 03:17 | 26 h |
| `retention-sweep` | 04:11 | 26 h |

The three hourly/daily sweeps run through wrappers (`run_pickup_deadline_sweep`
and siblings) that stamp either side of an untouched call. `sweep_retention`
stamps itself and now records **what it deleted** in `last_counters`, which is
where the counters live instead of a Postgres log. The tick is stamped by
`/api/worker/tick` itself, because pg_cron's statement only enqueues an HTTP
request and would report success with the application in the ground.

`job-health-check` runs at :23 and has **no row of its own**: a checker cannot
report its own silence.

### Reading an alert

The message names the routine, its last success, its last start and what that
run counted. Then:

```sql
select * from cron.job_run_details order by start_time desc limit 20;
```

A **start later than a success** means it began and did not finish. **Silence in
both** means it never ran — check that `cron.job` still holds the entry and that
pg_cron is running.

One e-mail per incident: `alerted_at` is stamped after the send and cleared by
the next success, so recovery re-arms it. Still broken a day later, it reminds
once.

### Silencing one deliberately

```sql
update public.job_health set last_success_at = now() where job_name = '…';
```

That is a lie told to a monitor, and it holds for exactly one window. Tell it
only when you already know why the routine is quiet and are choosing not to be
reminded — never to make a red thing green.

### What this does not cover

**The application being down** (the mailer lives in it) and **`job-health-check`
itself stopping**. Both are external uptime monitoring against `/api/health`,
which is not code in this repository. What this block covers is the case that
motivated it: a database routine failing silently while the app is perfectly
healthy.

---

## 3. Uploads

**The bucket is the barrier.** `delivery-receipts` takes 10 MB and only
`image/jpeg`, `image/png`, `image/webp`, `image/heic` and `application/pdf`.
`reports` takes 100 MB and **deliberately carries no MIME list** — its content
type comes from a frozen server-side map, one of whose values is
`text/csv; charset=utf-8`, and an allow-list of `text/csv` could refuse a
parameterised type and break a working export for nothing.

The check in `attachReceiptAction` is there so the operator reads a sentence
instead of a Storage error. It is not the boundary, and the code says so.

**The stored extension comes from the validated MIME type**, never from the
client's filename — that string used to be pasted straight into a storage key.

**There is no magic-byte sniffing and that is a decision.** What makes an object
dangerous is the `Content-Type` it is *served* with, not its bytes: HTML stored
as `image/jpeg` is inert.

### A trap for anybody writing a test that uploads

`new Blob(['…'])` sends `application/octet-stream` in the multipart part
**whatever `contentType` you pass**, and the bucket refuses it. Type the Blob:
`new Blob(['…'], { type: 'image/jpeg' })`. Two isolation cases in
`draw.test.ts` failed exactly this way. Playwright's `setInputFiles` takes
`mimeType` and does the right thing.

---

## 4. The gate this block ran

- lint, typecheck, build — clean
- unit — **876/876** in 66 files
- pgTAP — **1397/1397** in 28 files, from a fresh `db:reset`
- isolation — **285/285**, 28 of 28 files accounted for
- Playwright — **43/43**, `--workers=1`

**`npm run db:test` needs a freshly reset database.** After an e2e or isolation
run, `15_music_rpcs` fails with "more than one row returned by a subquery" and
that is not a regression.

**`npx supabase db reset` leaves Kong blind.** Every auth call answers
`createUser failed: {}` until `docker restart supabase_kong_<project>`. Block 3c
recorded this; it cost twenty minutes again here.

**The isolation runner drops a worker on this machine about two runs in five.**
`Worker exited unexpectedly`, mechanism unknown, local and Windows only — Block
4b spent eleven tasks on it. A run that reports fewer than 28 files proves
nothing and must be re-run, **never** interpreted as a pass and never "fixed" by
weakening the guard.
