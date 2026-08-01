# Block 5a runbook — bringing a Station's WhatsApp number online

Read this top to bottom before touching Meta's dashboard. It assumes nothing
about the code — every command below is copy-pasteable — and it exists because
this block was non-functional end to end until the last review pass (see
`docs/block-5a-report.md`, Concerns §1–2): the failure modes here are not
theoretical, they are the exact ones that shipped and were caught.

Design background, if you want it: `docs/superpowers/specs/2026-07-31-block-5a-whatsapp-spine-design.md`.

---

## 1. The four secrets

Four values, and **none of them ever go in a chat message, an issue, or a
file this repository tracks.** `.env*` and `.env*.local` are already
gitignored (`.gitignore:17-18`); keep it that way.

| Secret | Where it comes from | Where it lives |
|---|---|---|
| `WHATSAPP_APP_SECRET` | Meta App dashboard → Settings → Basic → **App Secret** | `.env.local` (dev) / EasyPanel → Environment (runtime), never Build args |
| `WHATSAPP_VERIFY_TOKEN` | Any string you invent. Used exactly once, during callback registration (§4). | same |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business → System User token, scoped to `whatsapp_business_messaging` | same |
| `WORKER_TICK_SECRET` | Any long random string you generate (`openssl rand -hex 32` or similar) | same, **and** as the database setting in §2 — the two must be byte-identical |

All four are optional in `src/lib/env.ts` by design (D6: no secret lives in
the database in 5a) — their absence does not stop the app from booting, so a
misconfigured deployment fails quietly at the one route that needs the
missing value, not at startup. That is why the checks in §5 and §7 exist:
nothing will tell you a secret is missing except a message that never
arrives.

This project deploys through EasyPanel, not Vercel (`.env.example`,
`docs/deploy-readiness-report.md:4` — "Target: Hostinger VPS + EasyPanel").
`NEXT_PUBLIC_*` variables need both the Build args and the Environment tab;
these four are runtime secrets and belong **only** in Environment — never as
a build arg, since build args are baked into image layers.

---

## 2. The database settings the cron job reads

`supabase/migrations/0064_schedule_worker_tick.sql` schedules the job but
deliberately carries no URL and no secret — committing either would put a
secret in the repository and pin the deployment to whichever host was
current the day the migration was written. It reads both from **database
settings**, which is where a value a SQL function needs to see belongs (an
EasyPanel environment variable is not visible inside Postgres).

Run against the target database — Supabase Studio → SQL Editor for the
hosted project, or `psql` for local:

```sql
alter database postgres set app.worker_tick_url = 'https://<your-app-host>/api/worker/tick';
alter database postgres set app.worker_tick_secret = '<the exact same value as WORKER_TICK_SECRET>';
```

**The two `worker_tick_secret` values — the database setting above and the
`WORKER_TICK_SECRET` environment variable from §1 — must match exactly.** If
they do not, `/api/worker/tick` answers every tick with 401 and the queues
never drain; nothing else will tell you this happened.

New sessions pick up an `alter database ... set` immediately; you do not need
to restart Postgres. Read them back to confirm:

```sql
select current_setting('app.worker_tick_url', true), current_setting('app.worker_tick_secret', true);
```

### Before you rely on a ten-second cadence, check the extension version

Second-level schedules (`'10 seconds'`) need `pg_cron >= 1.5`:

```sql
select extversion from pg_extension where extname = 'pg_cron';
```

- **`>= 1.5`** — nothing to do. Confirmed locally at `1.6.4`.
- **`< 1.5`** — edit `0064_schedule_worker_tick.sql` before applying it,
  changing `'10 seconds'` to `'* * * * *'` (one minute), and re-run the
  migration. Nothing else breaks: `due_whatsapp_events` (0063) selects
  whatever is due, not a fixed batch shaped around a ten-second cadence, so
  the backlog simply drains more slowly.

### Verify the job exists

```bash
psql "<connection string>" -c "select jobid, jobname, schedule from cron.job where jobname = 'whatsapp-worker-tick';"
```

Expect exactly one row, `schedule = 10 seconds` (or `* * * * *` on the
fallback). The migration is idempotent — re-running it replaces the job
(a new `jobid`) rather than raising or duplicating it, which was verified
directly against the local stack while writing it.

---

## 3. The `integrations` row

**This insert must run as `postgres` over SQL — the Supabase Studio SQL
Editor, or `psql` — never through the app or the service key.**
`public.integrations` deliberately carries **no `service_role` grant**
(`0057_integrations.sql:82-87`, and confirmed live: every PostgREST privilege
check for `service_role` on this table returns `false`). A PostgREST insert —
`createServiceClient().from('integrations').insert(...)` — fails with
**42501** by design; that is not a bug to route around, it is the same
"privileged tables are reached only from inside a `SECURITY DEFINER` body, or
by `postgres` directly" pattern this project already uses for
`platform_admins`.

Find the Station's ids first:

```sql
select id as company_id, organization_id, name
from public.companies
where name = '<Station name>';
```

Then insert with `enabled = false` — its default — until every other step
below is done:

```sql
insert into public.integrations (organization_id, company_id, provider, phone_number_id, display_phone_number, waba_id)
values (
  '<organization_id>',
  '<company_id>',
  'WHATSAPP',
  '<phone_number_id from Meta -> WhatsApp -> API Setup>',
  '<the dialable number, for your own reference>',
  '<waba_id, optional>'
);
```

Only after §4 and §5 both check out:

```sql
update public.integrations
   set enabled = true
 where company_id = '<company_id>' and provider = 'WHATSAPP' and deleted_at is null;
```

`enabled` starts `false` specifically so a half-configured row cannot start
taking real traffic between this insert and the rest of the runbook
(`0057:93-94`).

---

## 4. Registering the callback

Meta → WhatsApp → Configuration → **Callback URL**:

```
https://<your-app-host>/api/webhooks/whatsapp
```

**Verify token:** the exact `WHATSAPP_VERIFY_TOKEN` value from §1. Subscribe
to the **`messages`** webhook field (nothing else is read in 5a).

For a local test, put a tunnel in front of `next dev` first — any HTTPS
tunnel works (`ngrok http 3000`, `cloudflared tunnel --url http://localhost:3000`,
etc.) — and use the tunnel's `https://` URL as the callback above. Meta
requires HTTPS; it will not call a plain HTTP or a `localhost` URL.

### Do not stop at Meta's "Verified" checkmark

Saving the callback URL triggers Meta's one-time `GET` handshake
(`hub.mode` / `hub.verify_token` / `hub.challenge`) against
`src/app/api/webhooks/whatsapp/route.ts`'s `GET` handler. Meta shows the URL
as verified the moment that handshake succeeds. **That confirms the route is
reachable and the verify token matches — it does not confirm a real message
will ever be stored.** Those are two different facts, checked by two
different mechanisms, and the second one only §5 checks.

**If the callback URL will not verify at all** (Meta reports a failure
immediately), the most likely cause in this codebase is the one that shipped
twice already: `src/middleware.ts`'s `config.matcher` has an explicit
exclusion for `api/webhooks/` and `api/worker/` (see the long comment at the
bottom of that file). If that exclusion is ever lost — a middleware refactor,
a merge that reverts it — every request to either route hits the
session-cookie check first and gets a **307 redirect to `/login`**. Meta's
`GET` handshake cannot follow that and echo `hub.challenge`, so verification
fails outright; a live worker tick would fail the same way, silently, since
`pg_net`/`pg_cron` never reads the response body. Both failures look exactly
like "Meta is broken" from the dashboard. They are not — check the matcher
first.

**Smoke-test the matcher whenever `src/middleware.ts` changes, before doing
anything else in this runbook** — with no session cookie (an incognito
window, or `curl` with no auth):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/promotions      # expect 307/302 -> /login
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/health      # expect 200, no redirect
```

Both directions matter, and they are opposite failures: if `/promotions`
comes back `200` with no redirect, the matcher has grown too wide and a real
screen is no longer gated. If `/api/health` starts redirecting, `PUBLIC_PATHS`
or the matcher has been narrowed and the Docker `HEALTHCHECK` / EasyPanel
proxy — which call this route with no session by design — will start failing
and the container will be seen as unhealthy. `/api/health` is meant to stay
reachable without a session; `/promotions` is meant never to be.

---

## 5. The end-to-end check

Do this once, for real, before telling anyone the Station is live.

1. From a real phone, text the Station's WhatsApp number a live promotion's
   hashtag, e.g. `#EUQUERO`.
2. Expect a reply within a few worker ticks (each tick runs every 10 seconds,
   or every minute on the pg_cron < 1.5 fallback).
3. **Confirm with the database, not with Meta's dashboard.** A "Delivered" or
   "Read" mark in Meta's own interface only proves Meta thinks it handed the
   message to your callback URL — it says nothing about whether your server
   verified the signature, stored the row, or ever ran `ingest_whatsapp_event`.
   Run all three queries:

```sql
-- 1. The inbound message was received and decided.
select id, status, outcome, processed_at
from public.webhook_events
order by received_at desc
limit 1;
-- expect: status = 'DONE', outcome = 'recorded'

-- 2. The entry was recorded, by the bot, with no operator attached.
select id, status, source, created_by, participated_at
from public.participations
order by participated_at desc
limit 1;
-- expect: status = 'VALID' (or DUPLICATE/TOO_SOON/OVER_LIMIT if you are
-- re-testing), source = 'WHATSAPP', created_by IS NULL

-- 3. The reply actually went out.
select id, status, external_id, sent_at
from public.outbox_messages
order by created_at desc
limit 1;
-- expect: status = 'SENT', external_id not null (Meta's wamid for the reply)
```

If all three check out and the phone received a reply, flip `enabled = true`
on the `integrations` row (§3) if you had not already, and the Station is
live.

---

## 6. What to do when nothing happens

Start with `webhook_events`, ordered by `received_at desc` — it is written
before anything is decided, so it exists even when nothing downstream fired.

**No row at all.** The message never reached the route, or was rejected
before storage. Check: the callback URL and verify token (§4); the signature
check (`WHATSAPP_APP_SECRET` — a 401 with nothing written is what a wrong or
missing app secret produces); the middleware matcher (§4's smoke test).

**A row exists. Read `status` and `outcome` together** — `outcome` is only
ever set alongside `status = 'DONE'`; everything else leaves it `null`
(`webhook_events_done_shape`, `0058`). Meanings, taken from the column's own
comment (`0058_webhook_events.sql:187-188`):

| `status` | `outcome` | Meaning |
|---|---|---|
| `DONE` | `recorded` | Decided and stored. Check `participations` (query 2 above) for what actually happened — `recorded` covers all four statuses (`VALID`/`DUPLICATE`/`TOO_SOON`/`OVER_LIMIT`), not only a successful entry. |
| `DONE` | `no_integration` | The sending number's `phone_number_id` matches no enabled row in `integrations`. Check the row from §3 is inserted, `enabled = true`, and `phone_number_id` matches Meta → WhatsApp → API Setup exactly. |
| `DONE` | `no_hashtag` | No `#tag` (1–39 chars, no spaces or `#`) anywhere in the message text. The listener texted something with no hashtag in it — by design (D4), nothing is sent back. |
| `DONE` | `no_promotion` | A hashtag was found but matches no promotion at this Station, at the message's own timestamp. |
| `DONE` | `promotion_cancelled` | The hashtag matches a promotion, but it has been cancelled. |
| `DONE` | `outside_window` | The hashtag matches a promotion, but the message's timestamp falls outside `[starts_at, ends_at)`. |
| `FAILED` | *(always null)* | The ingestion attempt raised — a transient fault, not a routing decision. Read `last_error` and `attempts`. Retried on the backoff ladder (1s, 4s, 16s, 64s, 256s) and parked (`next_attempt_at = infinity`) after five retries. |

**All five `DONE`/silent outcomes are deliberate (D4).** The bot never
replies to an unmatched, cancelled, or out-of-window hashtag — replying to
everything would turn the Station's number into a paid loudspeaker for
whoever texts it. A listener who mistypes a hashtag gets nothing back; that
is the accepted cost, not a bug to chase.

**The row is stuck at `RECEIVED` or `PROCESSING` for more than a few
minutes.** The worker tick is not running. Check §2's job exists and its
`schedule`; check `WORKER_TICK_SECRET` matches on both sides (§2); hit the
tick directly and read what it reports (next section).

### Reading a tick's own result

`POST /api/worker/tick` (with the correct `x-worker-secret` header) returns a
JSON body — this is the only account of what a tick did, since `pg_net`
stores its response where nothing else reads it (`net._http_response`).

```bash
curl -s -X POST https://<host>/api/worker/tick \
  -H "x-worker-secret: $WORKER_TICK_SECRET" | jq .
```

**A healthy tick returns `200` with `dbErrors: 0`.** Read that literally: a
tick where every single database call failed *also* returns `200` with an
all-zero body (`ingested: 0, sent: 0, ...`) — the response code alone cannot
tell "nothing to do" from "nothing worked". `dbErrors` is the field that
distinguishes them; anything above `0` means look at the server logs for the
`whatsapp tick: <step>: <message>` lines the failing step wrote.

**Watch `outbox_messages.status = 'SENDING'` over time — a count that grows
and never falls is the alarm, not a data point to note in passing.** A
`SENDING` row is one a tick claimed and has not yet resolved to `SENT` or
back to `PENDING`/`FAILED`. A few, briefly, is normal — a batch mid-flight.
A count that keeps climbing means ticks are dying mid-batch (a timeout, a
crash) before they can settle what they claimed. Those rows are not lost —
`reclaim_stale_whatsapp_claims` returns anything claimed for more than five
minutes back to `PENDING` automatically, and the next tick will pick it up —
but a listener whose reply was already accepted by Meta when the tick died
will be told twice when that happens (`0063`'s own comment names this: it is
at-least-once delivery by deliberate choice, not an oversight — see
`docs/block-5a-report.md` Concerns §4). Rising `SENDING` with no matching
rise in `SENT` over several minutes means something is killing ticks before
they finish, and that is worth investigating directly rather than waiting for
the reclaim to paper over it.

---

## 7. Local verification, before you touch any of the above

Three things that cost real diagnosis time while this block was built, kept
here so nobody re-discovers them:

- **`npm run test:e2e` needs `CI=1` locally.** `next dev` under Playwright's
  parallel workers is too slow for several Server-Action-heavy specs under
  load and times out — not a real failure, a machine-speed artifact. Run
  `CI=1 npx playwright test` (forces a production build first) instead of
  trusting a bare `npm run test:e2e` run on a loaded machine. CI itself
  already builds first, so this is a local-only note.
- **Run `npm run test:isolation` before `npm run db:test` if you need both,
  or reset in between.** The isolation suite commits real rows against the
  local database (fixtures for the twelve-round race, the privilege-boundary
  cases, and more) and does not clean them up. Left in place, later pgTAP
  runs can see rows that are not their own fixture's and fail assertions that
  expect an exact set. `npx supabase db reset` between the two is the fix —
  gate order matters locally in a way it does not in CI, where the `db` job
  always runs pgTAP first on a stack nothing else has touched.
- **A short isolation run is not a green one.** `npm run test:isolation`
  (`scripts/verify-isolation-suite.mjs`) has an open, unresolved flake — a
  worker occasionally dies mid-suite (`tinypool onUnexpectedExit`) — and the
  script exists specifically to catch that rather than report a partial run
  as passing. Its output says outright whether a run was **guard-complete**
  or was caught short; if it was caught short, re-run rather than trust the
  partial numbers. See `docs/block-5a-report.md` Concerns §6.
