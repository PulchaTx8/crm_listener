# Architecture

**What this answers:** how the system is put together, and where you change a
given thing. It describes the state of the code. The **history** — why each
decision was taken, in the week it was taken — is in the forty-odd block reports
and runbooks beside this file, and this document points into them rather than
retelling them.

---

## 1. What the product is

A CRM for radio stations. It holds the audience (listeners), the promotions they
enter, the prizes those promotions draw from, the draws themselves, the
deliveries afterwards, the WhatsApp conversation that runs much of it, music
requests, dashboards and exportable reports.

It is multi-tenant on two levels: an **Organization** owns one or more
**Companies**, which the product calls **Stations**. A listener belongs to the
Organization and is *linked* to the Stations they have entered at — one person,
not one row per Station.

---

## 2. The layers, and what may call what

```
Server Component  ──reads──▶  service  ──▶  RPC (SECURITY DEFINER)  ──▶  tables (RLS)
Server Action     ──writes─▶  service  ──▶  RPC
```

- **Screens** (`src/app/(app)/…`) read through a service and never issue an RPC
  themselves.
- **Server Actions** (`actions.ts` beside each screen) are the only writers. They
  take a `FormData`, validate it, call a service, and return a message — never a
  thrown error to the client.
- **Services** (`src/services/*.ts`) own the Supabase call and the error
  translation. One file per subject: `members.ts`, `promotions.ts`, `draws.ts`,
  `winners.ts`, `inventory.ts`, `reports.ts` and so on.
- **RPCs** own the rules. A screen that could not call the RPC is a courtesy
  gate; the RPC re-checks the permission itself, because that is the only check
  an attacker cannot skip.

## 3. Two Supabase clients, and the rule between them

- `src/lib/supabase/user-client.ts` — bound to the caller's JWT. Everything a
  signed-in person does goes through this, so RLS applies.
- `src/lib/supabase/service-client.ts` — the service key. It bypasses RLS
  entirely and is therefore **never** used to answer a request on a user's
  behalf. Its legitimate uses are the machine endpoints, the queue drains, and
  the two or three operations no client may perform (creating an auth user;
  writing `platform_admins`).

A `SECURITY DEFINER` function does **not** inherit the caller's policies, so it
re-authorises with `has_permission` itself. `docs/SECURITY.md` covers this; it is
mentioned here because it is the reason services can be thin.

## 4. The machine endpoints

Two, and both authenticate themselves:

- `POST /api/webhooks/whatsapp` — Meta's HMAC over the **raw** body.
- `POST /api/worker/tick` and `POST /api/worker/health-alert` — a shared secret
  header, compared in constant time.

**Both prefixes are excluded from the middleware matcher** (`src/middleware.ts`),
and the comment there is long on purpose: matched, every call would be
307-redirected to `/login` before the handler ran. Meta's verification handshake
could never echo `hub.challenge`, and pg_cron reads no response body — so both
queues would stop draining in complete silence. A unit test cannot see this,
because it imports the handler and calls it directly.

## 5. The outbox and the tick

Outbound WhatsApp is never sent inside the request that decided to send it. The
decision writes a `PENDING` row to `outbox_messages`; a worker tick claims and
sends it. `pg_cron` calls `/api/worker/tick` every ten seconds through `pg_net`
(migration `0064`).

The same tick drains two other queues: `storage_erasure_queue` (LGPD erasures
whose objects outlive the SQL) and `report_runs` (Block 8b). Each is wrapped so a
failure in one cannot lose the others' counters.

## 6. The scheduled routines

Six `pg_cron` jobs:

| job | what it does |
| --- | --- |
| `whatsapp-worker-tick` | the tick above, every 10s |
| `pickup-deadline-sweep` | moves winners past their collection deadline, hourly |
| `pickup-reminder-sweep` | the reminder message, hourly |
| `expire-report-runs` | sends report files past seven days to the erasure queue, 03:17 |
| `retention-sweep` | requirement N7, 04:11 |
| `job-health-check` | reads `job_health` and e-mails what has gone quiet, :23 |

Each of the first five records its own health in `public.job_health`; failure is
detected by **silence** rather than by a caught exception, because a routine that
commits cannot carry an exception handler. `docs/block-11b-runbook.md` is the
operating manual.

## 7. Where the history lives

`docs/block-*-report.md` and `docs/block-*-runbook.md` — one pair per block,
twenty blocks. When this document says "because", the long version is there. When
you are about to argue with a decision, read its block first: several of them
record the thing that was tried, measured and abandoned.

The specs and plans behind each block are in `docs/superpowers/specs/` and
`docs/superpowers/plans/`.

## 8. Where to change things

| you want to change | start at |
| --- | --- |
| a screen | `src/app/(app)/<subject>/page.tsx` and its `actions.ts` |
| a rule | the RPC in `supabase/migrations/`, then the pgTAP file that asserts it |
| what a caller may do | `docs/PERMISSIONS.md` |
| how something is stored | `docs/DATABASE.md` |
| a boundary or a header | `docs/SECURITY.md` |
| how it is deployed | `docs/DEPLOYMENT.md` |
