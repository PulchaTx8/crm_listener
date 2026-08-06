# Handover — the project as it stands

**Date:** 2026-08-06. **Blocks 0 through 11 are delivered, merged and applied.**

This is the closing note. `docs/bloco-0-handoff.md` opened the project; this one
closes it. For how anything works, start at `README.md` and the five documents it
links.

---

## 1. Where everything is

| | |
| --- | --- |
| `main` | `f2778fd` — clean, pushed, nothing open |
| Hosted database | `djbkdyesubkedxjwcohq`, migration **`0134`**, zero pending |
| Migrations in the repo | 134 |
| Last two PRs | #31 (Block 11b), #32 (Block 11c) — both merged with CI green |

**The gate at close:** 882 unit, 1397 pgTAP, 285 isolation in 28 files, 44
Playwright journeys in series — including `acceptance.spec.ts`, which walks the
master spec's §35 from an empty database to an audited delivery.

## 2. Three things the owner still has to do

None of them can be done from this repository, and none of them is blocking
anything that is running today.

**Do them in the order below.** Wiring the alerting before redeploying would work
exactly as designed and be thoroughly annoying: the worker tick stamps its own
health from application code that is not deployed yet, so fifteen minutes later
the first alert to arrive would be `whatsapp-worker-tick has gone quiet` — about
a queue that is draining perfectly well.

**1. Redeploy the frontend.** The database is ahead of it. Everything Block 11b
put in the frontend — the Content-Security-Policy and the upload validation — is
in `main` and not yet in the running container.

**2. Set the three database settings.** Not one — three. Checking the first on
2026-08-06 returned `null`, which means **the worker tick has been scheduled
since Block 5a and has never done anything**: WhatsApp sending, storage erasures
and report generation have never run in production. Nothing was lost, because the
installation held no listeners and no winners; but it must be true before anybody
uses it for real.

```sql
alter database postgres set app.worker_tick_url    = 'https://<production-host>/api/worker/tick';
alter database postgres set app.health_alert_url   = 'https://<production-host>/api/worker/health-alert';
alter database postgres set app.worker_tick_secret = '<the exact value of WORKER_TICK_SECRET>';
```

The production host is not recorded anywhere in this repository, and the secret
must match the runtime environment variable **exactly** — a mismatch answers
every tick with 401 and nothing else reports it.

Until they are set, both jobs fire on schedule and leave immediately: each is
guarded by `where nullif(current_setting(…), '') is not null`, so the state is
inert rather than broken. Never set them to an empty string, which is equally
inert and looks configured.

**3. Set `ALERT_EMAIL`** in the EasyPanel **runtime** environment, never as a
build arg. Unset, `/api/worker/health-alert` answers `{"configured": false}` and
sends nothing, deliberately: a container refusing to boot over a missing alert
address would be a worse outage than the one it reports.

## 3. One consequence of the database being ahead, and it is safe

`0134` put a 10 MB ceiling and a MIME allow-list on `delivery-receipts`, and that
is **live now**, while the container still runs the pre-11b code.

A photograph or a PDF uploads exactly as before. A file that is too large, or of
a type the list does not carry, is now refused by the bucket — and the old
frontend shows the raw Storage error rather than the sentence Block 11b wrote for
it ("That file is 40 MB. A receipt may be at most 10 MB."). Nothing crashes, no
screen is broken, and the failure is in the safe direction.

The redeploy in §2 replaces the raw error with the sentence.

## 4. What was deliberately not built

- **Block 9, the legacy ETL.** The owner has neither the SQL Server, nor a dump,
  nor a schema. It cannot be written against something nobody can see.
- **Block 10b, `entitlements` and the `pending` state.** Nothing in the product
  asks whether a feature is switched on, and the admin provisions each customer
  by hand, so a Company is born enabled. Building flags nobody reads is what
  `audit.view` did for nine blocks before Block 10a gave it a reader.
- **A screen for `job_health`.** It would be a new admin page, with its own
  permission and tests, to show five rows that an e-mail already pushes to the
  person who can act on them.
- **External uptime monitoring and error tracking.** Neither is repository code.
  Note the honest limit this leaves: the alert e-mail is sent *by the
  application*, so **if the application is down, no alert leaves**. Something
  outside it has to watch `/api/health`.

## 5. The backup story, now that the plan is known

**The hosted project was on the Free plan on 2026-08-06.** No point-in-time
recovery, and minimal backup retention. `docs/DEPLOYMENT.md` §6 carries the
detail, along with a restore that was actually performed on the same day with row
counts compared table by table.

**Before this installation holds a real audience's personal data, the plan is a
decision to take.** On Free, the manual dump is close to the whole recovery
story, and it only exists if somebody runs it.
