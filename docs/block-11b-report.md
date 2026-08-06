# Block 11b — The Nonce That Never Arrived, the Routines Nobody Watches, and the File Nobody Checked — Verification Report

**Branched from `main` at `32adc73`**, not from `block-11a` — that branch merged
as PR #30 while this block was being planned, and this project's PRs merge while
the next block is in flight, so a `--base` on the previous branch fails with a
404.

**Spec:** `docs/superpowers/specs/2026-08-06-block-11b-csp-alerting-uploads-design.md`
**Plan:** `docs/superpowers/plans/2026-08-06-block-11b-csp-alerting-uploads.md`
**Runbook:** `docs/block-11b-runbook.md`
**Migrations:** `0132`, `0133`, `0134`

---

## 1. What shipped

**The CSP Block 11a withdrew**, enforcing, with the nonce reaching the renderer.
**Health for all five scheduled routines**, with one e-mail per incident to a
fixed operations address. **Bounds on both storage buckets**, an allow-list on
the one a client writes to, and a stored extension that no longer comes from a
filename the client chose.

The five documents, the controlled seed, the deploy runbook and backup/PITR move
to **Block 11c**. The owner split them out of the original Block 11b so that a
CSP which might have had no solution could not hold the documentation hostage.

---

## 2. The CSP: two causes, and neither was one of Block 11a's three fixes

Block 11a spent three measured attempts on a symptom it could not see —
`11 passed, 23 failed`, no error message anywhere, journeys timing out clicking
things that did nothing. This block wrote a probe before it wrote a directive,
which is the whole difference.

**Cause one: the forwarded request headers were being thrown away.** The nonce
reaches Next's renderer through the `Content-Security-Policy` header **on the
request** — `x-nonce` only lets a Server Component read it. But Supabase's
`setAll` callback rebuilds the response with a bare `request`, discarding
anything set before it. 11a's third attempt was one step from this and stopped.
The fix is a `forwarded()` helper that re-snapshots on every rebuild.

**Cause two: `next build` prerendered the landing page.** Prerendered HTML has no
request nonce at render time, so its bootstrap scripts ship unstamped and the
policy blocks all of them. `/` was the **only** static route left in the
application; it now renders per request. `/_not-found` is still prerendered and
has nothing to hydrate.

**A third suspect, found while writing the plan and probably a real contributor.**
`playwright.config.ts` runs `next dev` locally and a production build only in CI.
The dev server compiles with eval, so a `script-src` without `'unsafe-eval'`
blocks the framework outright — the exact shape 11a described. The policy now
carries the keyword in development only. This also explains the silence: an eval
violation is reported in the *browser* console, and nothing in that run was
listening.

**The probe is now a permanent test.** `tests/e2e/csp.spec.ts` reads the
delivered HTML and fails naming any `<script>` tag without the nonce, on
`/login` and on `/`, and it was run against both the dev server and a production
build. `tests/e2e/csp-violations.ts` installs a `securitypolicyviolation`
listener; the three public pages and the dashboard journey assert it stays
empty.

**D4 was not needed.** The fallback the owner approved — everything enforcing
except `script-src`, which would have gone to report-only — was not used, because
the full policy passes.

---

## 3. Two defects the suites found that review would not have

**`service_role` does not inherit table privileges on a new table here.** Every
read of `job_health` answered `42501`, so the alert route would have reported a
healthy installation because it could not see the rows saying otherwise — the
monitor failing in exactly the silent way this block exists to abolish. It was
found by *running* the isolation test, not by reading the migration. Three pgTAP
assertions now hold the grants down, including one that `authenticated` still
cannot read it.

**A `Blob` built without a type sends `application/octet-stream`** in the
multipart part regardless of the `contentType` option, so `0134`'s allow-list
refused it and two `draw.test.ts` cases failed. The fixtures now type the Blob.
The plan had already caught the equivalent problem in `delivery-flow.spec.ts`
(a `text/plain` `receipt.txt`) before it broke anything — the isolation pair was
the one it missed.

---

## 4. What the routines report now

`job_health`, one row each, **failure detected by silence** — no `exception`
handler anywhere in the block, because a block with one opens a subtransaction
and `commit` inside it raises, which is precisely how the 11a sweep shipped
deleting nothing with 1375 green assertions.

`sweep_retention` is restated in full so it can record **what it deleted**;
the other three get a wrapper that stamps around an untouched call, because
restating three long working procedures to add two lines each is three chances
to break one. The tick stamps itself, since pg_cron's statement only enqueues an
HTTP request and would call it healthy with the app in the ground.

`ALERT_EMAIL` is optional, like `SMTP_URL`: a container refusing to boot over a
missing alert address would be a worse outage than the one it reports. The
consequence is stated rather than discovered — **the app being down means no
alert leaves**, and that belongs to external uptime monitoring.

---

## 5. The gate

Every number read as a number, on a freshly reset database.

| gate | result |
| --- | --- |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean; `/` now dynamic, `/_not-found` the only prerendered route |
| `npm run test` | **876/876** in 66 files |
| `npm run db:test` | **1397/1397** in 28 files |
| `npm run test:isolation` | **285/285**, 28 of 28 files accounted for |
| `npx playwright test --workers=1` | **43/43** |

Two things worth recording about the run itself:

**A full Playwright run failed once, at `music-requests`, and the cause was the
author.** Files were being written into `src/` while the suite ran, and the dev
server recompiles on each one. Re-run untouched, the suite is 43/43. Nothing was
changed to make that pass.

**The isolation runner dropped a worker on one run** — `Worker exited
unexpectedly`, 285/285 cases passing but only 27 of 28 files reported. That is
the flake Block 4b spent eleven tasks on: local, Windows, mechanism unknown,
about two runs in five. The run was repeated until it came back complete rather
than interpreted, which is what that block's guard exists to force.

---

## 6. What Block 11c inherits

The five documents (ARCHITECTURE, SECURITY, DATABASE, PERMISSIONS, DEPLOYMENT),
the controlled seed, the deploy runbook and documented backup/PITR. It is the
last block.

**Still deferred:** Block 9 (the legacy ETL — the owner has neither the SQL
Server, nor a dump, nor a schema) and Block 10b (`entitlements` and the
`pending` state — nothing in the product asks whether a feature is on, and the
admin provisions each customer by hand).

**Deliberately not built here:** a screen for `job_health`, an error-tracking
service, and external uptime monitoring. The first would be a new admin page
with its own permission and tests to show five rows that an e-mail already
pushes to the person who can act on them; the other two are not repository code.

---

## 7. After the merge

**Push `0132`–`0134` to the hosted project the same day** — `npx supabase
migration list --linked`, then `supabase db push`. Nothing in CI applies
migrations, and this project has drifted 41 migrations behind once and 10 behind
twice.

Then set `app.health_alert_url` on the hosted database and `ALERT_EMAIL` in the
runtime environment, or the sixth cron job runs hourly and posts nowhere.
