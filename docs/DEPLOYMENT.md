# Deployment

**What this answers:** how to put this in production and how to get it back if
it burns. It replaces nothing — `docs/deploy-readiness-report.md` and
`docs/bloco-0-handoff.md` still hold the blow-by-blow of how each of these was
found — but it is the one place that has all of it at once.

---

## 1. The shape

- **The application**: Next 15 in `output: 'standalone'`, in Docker, on EasyPanel
  (Hostinger VPS).
- **The database, auth and storage**: hosted Supabase, project
  `djbkdyesubkedxjwcohq`.
- **The scheduled work**: `pg_cron` inside that project, reaching the application
  over HTTP through `pg_net`.

## 2. Build time versus runtime, and the three ways to get it wrong

**`NEXT_PUBLIC_*` are inlined into the client bundle by `next build`.** They must
be set in **both** the Build args and the Environment tabs. Setting them only at
runtime does not change a bundle that was already compiled — the screens come up
and every browser query fails.

**`SUPABASE_SERVICE_ROLE_KEY` is runtime only, never a build arg.** A build arg
ends up in the image.

**`SKIP_ENV_VALIDATION=1` is for `next build` and must never be set at runtime.**
`src/lib/env.ts` falls into its loose branch and the container boots happily with
no configuration at all — which is discovered later, by a user.

**`NEXT_PUBLIC_SUPABASE_URL` is the bare project URL**, not
`https://<ref>.supabase.co/rest/v1/`. supabase-js appends the path itself, and
`z.string().url()` accepts the wrong one without complaint, so the failure
arrives at the first query rather than at boot.

## 3. The container

It must listen on **`0.0.0.0`**, not on the container hostname, or the EasyPanel
proxy cannot reach it. It answers `GET /api/health` with `{"status":"ok"}` — a
liveness probe that deliberately **does not touch the database**, because a
health check that queries Supabase turns a database blip into a restart loop.

## 4. The three database settings

Without these the scheduled work is silently inert. On the hosted database:

```sql
alter database postgres set app.worker_tick_url   = 'https://<host>/api/worker/tick';
alter database postgres set app.health_alert_url  = 'https://<host>/api/worker/health-alert';
alter database postgres set app.worker_tick_secret = '<the same value as WORKER_TICK_SECRET>';
```

| unset | what silently stops |
| --- | --- |
| `app.worker_tick_url` | WhatsApp sending, storage erasures, report generation |
| `app.health_alert_url` | every alert about a routine that has gone quiet |
| `app.worker_tick_secret` | both of the above, answered 401 |

**Observed on 2026-08-06: none of the three was set on `djbkdyesubkedxjwcohq`.**
`select current_setting('app.worker_tick_url', true)` returned `null`, which
means the tick has been scheduled since Block 5a and has never done anything —
firing every ten seconds and leaving immediately, exactly as its guard intends.
Nothing was lost, because the installation held no listeners and no winners at
the time; but **this is the first thing to fix before anybody uses it for real**,
and it is invisible until you go looking. Read all three back after setting them:

```sql
select current_setting('app.worker_tick_url', true),
       current_setting('app.health_alert_url', true),
       current_setting('app.worker_tick_secret', true);
```

**Set them or leave them unset — never blank.** Every guard tests
`nullif(current_setting(…), '') is not null`, so an empty string is as inert as
an absent one and looks configured to whoever reads it next.

And in the runtime environment, `ALERT_EMAIL` — optional, and unset means no
alerting at all, by design (`docs/block-11b-runbook.md`).

## 5. Deploy order: the database first, always

```bash
npx supabase migration list --linked   # what is missing
npx supabase db push
npm run db:test                        # on a database with the migrations applied
npm run test:isolation
# then the frontend
```

**Nothing in CI applies migrations.** The hosted database has drifted 41
migrations behind once and 10 behind twice, and each time it was found by a
screen failing with `PGRST202` — a message that names neither a migration nor a
deploy.

If the frontend goes first, the failure is loud in one place and quiet in
another: every Export button fails with `PGRST202`, and `/reports` renders an
empty table that looks like a working screen with nothing in it.

## 6. Backup and restore

### What the hosted project provides

**On 2026-08-06 the project was on the Free plan.** That is the answer to the
question this section used to leave open, and it is not a comfortable one: on
Free, Supabase offers **no point-in-time recovery**, and its backup retention is
minimal — this is not a tier to hold a real audience's personal data on.

**Before this installation carries live listener data, the plan is a decision to
take.** Everything else in this document assumes a database somebody can restore;
on Free, §6's manual dump is close to the whole of the recovery story, and it
only exists if somebody runs it.

Re-read it from the dashboard → Database → Backups when the plan changes, and
record the plan, the retention window and the PITR state **with the date you read
them**. A number nobody re-checks is worse than a pointer.

### Restoring

1. **A Supabase-managed restore** (dashboard → Backups → Restore) is the normal
   path, and it restores the whole project — `auth` and `storage` included.
2. **A manual restore** from a dump, when you need the data somewhere else:

```bash
npx supabase db dump --linked -f schema.sql
npx supabase db dump --linked --data-only -f data.sql
# into the target project, in that order
psql "$TARGET_URL" -f schema.sql
psql "$TARGET_URL" -f data.sql
```

### The proof, run on 2026-08-06

Both dumps were taken from `djbkdyesubkedxjwcohq` and restored into a throwaway
local database. **Production was not touched.** Row counts, hosted versus
restored:

| table | hosted | restored |
| --- | --- | --- |
| `audit_logs` | 12 | 12 |
| `permissions` | 40 | 40 |
| `promotions` | 1 | 1 |
| `companies` | 1 | 1 |
| `members` | 0 | 0 |
| `winners` | 0 | 0 |

**What did not restore, and why it is not a finding:** eight statements failed,
every one of them against `auth.*` or `storage.buckets`. Those schemas belong to
GoTrue and Storage, which a bare Postgres does not have — a real restore targets
a Supabase project, where they already exist. The **application** schema and all
of its data restored clean.

The dumps were deleted afterwards. A copy of a customer's database on a laptop is
a second place to lose it from.

## 7. The image builds from cold

`docker build --no-cache -t pulchatx:probe .` was run on **2026-08-06** and
succeeded, producing a **330 MB** image. It is the cheapest possible answer to
"is the deploy reproducible", and it fails loudly if a dependency, the Node
version or a build arg has drifted.

## 8. Rollback

Redeploying the previous image rolls back **the application** and nothing else.
**A migration is not rolled back by a redeploy** — the schema stays where it is,
and the older image may not understand it. If a migration has to be undone, that
is a new migration, written deliberately, with the same care as the one that
caused the problem.
