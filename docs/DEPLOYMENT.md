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

## 8. What a deploy does to somebody who is using the app

**The symptom, reported on 2026-08-07:** an operator presses Save and gets

```
Failed to find Server Action "40495d…". This request might be from an
older or newer deployment.
```

**Why.** Every Server Action carries an id minted during `next build`, and a new
build mints new ones. A browser holding a page from the previous image posts an
id the running image has never heard of. It is not a bug in the action, and
nothing about the form is wrong — the page is simply older than the server.

**The two halves of the fix, and only one of them lives in this repository.**

**1. `NEXT_DEPLOYMENT_ID` — a build arg, wired (`next.config.mjs`, `Dockerfile`).**
Pass **the commit sha** in EasyPanel's *Build args* tab, beside the two
`NEXT_PUBLIC_*` ones:

```
NEXT_DEPLOYMENT_ID=<commit sha of what is being built>
```

It must **change on every build** or it means nothing — skew is detected by the
value differing. With it set, Next compares the client's id against the
server's and answers a mismatch with a **hard navigation**: the screen reloads
onto the running build instead of failing. The Save is still lost; what is
gained is that the screen recovers itself.

Measured on Next 15.1, not assumed: with it set, every asset URL gains
`?dpl=<id>` and the generated `BUILD_ID` is left alone.

**2. `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` — a runtime secret, NOT wired here.**
Next encrypts the variables a Server Action closes over, with a key generated
**per build** unless this is set. While two images serve traffic at once — which
is what a rolling deploy is — a request encrypted by one and decrypted by the
other fails. Set it in EasyPanel's **Environment** tab, never as a build arg:

```
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=<32 random bytes, base64>
```

Generate it once and keep it: `openssl rand -base64 32`. It is a **secret**, and
a build arg is baked into the image layers — the same rule this document already
states for `SUPABASE_SERVICE_ROLE_KEY`.

**What neither half fixes.** A deploy still interrupts whoever was mid-form.
Rolling the new container up before the old one goes down shortens the window;
nothing closes it. If interrupting an operator mid-form is unacceptable, deploys
belong outside the hours the station uses the system.

**If the error persists rather than appearing once after a deploy**, this is not
skew: it means two containers from **different images** are serving traffic at
the same time and the proxy is alternating between them. Check the service's
replica count and that no container from the previous deploy is still running.

## 9. Rollback

Redeploying the previous image rolls back **the application** and nothing else.
**A migration is not rolled back by a redeploy** — the schema stays where it is,
and the older image may not understand it. If a migration has to be undone, that
is a new migration, written deliberately, with the same care as the one that
caused the problem.

## 10. The picture on the sign-in screen

The panel beside the sign-in form shows one image, and it is meant to be
replaced periodically without a deploy.

**Where it lives:** Supabase Storage, bucket `branding`, object `login-hero.png`.

| | |
|---|---|
| Bucket | `branding` (public) |
| Object | `login-hero.png` — one fixed key, always this name |
| Public address | `<SUPABASE_URL>/storage/v1/object/public/branding/login-hero.png` |
| Recommended size | **912 × 456** (2:1) |
| Accepted formats | PNG, JPEG, WebP — max 5 MB |

**How to replace it:** Supabase dashboard → **Storage** → bucket `branding` →
select `login-hero.png` → **Replace file** (or delete it and upload a new file
with exactly that name). The change is live on the next page load.

**It is deliberately NOT in `public/`.** The Dockerfile copies `public/` into the
image, so a file there can only be changed by a commit and a rebuild — which is
the opposite of what this image is for.

**No screen in the application uploads it, and that is on purpose.** Migration
`0146_branding_bucket.sql` gives the bucket no write policy at all, so no
signed-in member of any Station can replace it. The dashboard acts as
`service_role` and is not subject to those policies, which makes it the only
door. Locally, `npm run seed:branding` uploads
`supabase/seed-assets/login-hero.png` through the same door; it refuses to run
against anything but a local stack.

**Why the address carries `?v=`.** Storage serves this object with
`cache-control: max-age=3600`, so a browser holding the old picture would keep
showing it for an hour after a replacement. `src/lib/branding/login-hero.ts`
reads the object's `updated_at` and appends it to the URL, which makes every
replacement a new address and therefore a new cache entry.

**If the bucket is empty**, the panel renders its text and button with no
picture. That is the state of a brand-new environment, not a fault.

**A note on transparency:** the image is drawn on the panel's light grey
surface. A PNG with an opaque background renders as a rectangle of that colour;
one with real transparency blends into the panel.
