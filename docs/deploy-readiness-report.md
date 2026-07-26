# Deploy readiness — execution log

Branch `deploy-readiness`, base `main@07c2376`.
Target: **Hostinger VPS + EasyPanel** (self-hosted PaaS on top of Docker + Traefik), with
**hosted Supabase** (project not created yet).

Everything below was verified by actually running it. Output is reproduced verbatim.

> **Note (language migration, 2026-07-26).** The prose of this document was translated to
> English, but everything inside fenced code blocks is preserved **byte-for-byte** as it was
> captured. Those transcripts therefore still show pre-migration artefacts: the old image tag
> and package name `crm-listener`, Portuguese labels printed by the ad-hoc verification
> scripts, and the boot error as it read at the time —
> `Error: Configuração de ambiente inválida — …`, which the code now emits as
> `Error: Invalid environment configuration — …`. They are evidence of a run that happened,
> not current strings; do not grep the codebase for them.

---

## 1. BLOCKER — the server was binding to the container ID, not to `0.0.0.0`

**Diagnosis.** Next's standalone entrypoint is generated with
`const hostname = process.env.HOSTNAME || '0.0.0.0'`, and Docker **always** injects
`HOSTNAME` with the container ID. The `||` never fires: the process listens only on the
IP that hostname resolves to. Never `0.0.0.0`, never `127.0.0.1`.

Behind EasyPanel the container joins **two** networks (the service's and the Traefik
proxy's). The bind picks one of them; the proxy may hit the other → 502. And a health
check on `localhost` would never work.

**Fix.** `ENV HOSTNAME=0.0.0.0` in the **runner** stage of the `Dockerfile` — the image's
`ENV` takes precedence over the value injected by the daemon.

The full proof is in the [Two-network proof](#two-network-proof) section.

## 2. BLOCKER — `NEXT_PUBLIC_*` are baked in at build time and the Dockerfile wasn't receiving them

**Diagnosis.** They are inlined into the client bundle during `next build`. The builder
stage declared no `ARG`, so setting those variables in EasyPanel's Environment tab
(runtime) **does not reach an already-compiled bundle**. Nothing breaks today because
there is no `'use client'` in the repo, but it breaks the moment Block 1 adds auth.

**Fix.** In the **builder** stage:

```dockerfile
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
```

`SUPABASE_SERVICE_ROLE_KEY` was **not** declared as an `ARG` — build args get recorded
in the image layers.

**Verification — the ARG reaches the `next build` environment:**

```
$ docker build --target builder \
    --build-arg NEXT_PUBLIC_SUPABASE_URL=https://build-arg-proof.supabase.co \
    --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-build-arg-proof -t crm-listener:builderproof .
$ docker run --rm crm-listener:builderproof sh -c 'env | grep -E "NEXT_PUBLIC_|SKIP_ENV" | sort'
NEXT_PUBLIC_SUPABASE_ANON_KEY=anon-key-build-arg-proof
NEXT_PUBLIC_SUPABASE_URL=https://build-arg-proof.supabase.co
SKIP_ENV_VALIDATION=1

# mesmo estágio, sem passar build args — o que acontece se esquecerem no EasyPanel:
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_URL=
SKIP_ENV_VALIDATION=1
```

**Definitive verification — inlining into the client bundle.** Since the repo has no
`'use client'` anywhere, a **throwaway** client component was created
(`src/app/argproof/page.tsx`, removed afterwards) reading
`process.env.NEXT_PUBLIC_SUPABASE_URL`, exactly what Block 1 is going to do:

```
=== A) build COM build args ===
arquivos do bundle CLIENTE com o valor:
.next/static/chunks/app/argproof/page-40e19b3cbe4f142a.js
ocorrencias em .next/static = 1

=== B) build SEM build args (env só em runtime, como a aba Environment do EasyPanel) ===
ocorrencias em .next/static = 0
(env de runtime esta setada: https://build-arg-proof.supabase.co)
```

Case **B** is the bug in its pure form: the runtime variable is set, the server sees it,
and the bundle that goes to the browser still carries no value at all. Without the
`ARG`s, Block 1's auth would come up with a Supabase client that has no URL.

Also confirmed that the secret does not leak into the image:

```
$ docker history --no-trunc crm-listener:argproof | grep -c "SUPABASE_SERVICE_ROLE_KEY"
0
```

## 3. BLOCKER — there was no health check

**Fix.** Created `src/app/api/health/route.ts`:

- Route Handler returning 200 with `{"status":"ok","uptime":<seconds>}`;
- `export const dynamic = 'force-dynamic'` — without it Next would statically optimize
  the route and the check would be measuring a file, not the process;
- **does not touch the database**, on purpose: a health check that queries Supabase
  turns database jitter into container restarts.

And in the runner stage:

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
```

`wget` confirmed present in the base image (BusyBox), so `node -e` was not needed:

```
$ docker run --rm node:22-alpine sh -c 'which wget; wget --help 2>&1 | head -3; node -v'
/usr/bin/wget
BusyBox v1.37.0 (2026-01-10 15:38:28 UTC) multi-call binary.

Usage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]
v22.23.1
```

The `docker build` output confirms the route came out dynamic:

```
Route (app)                                 Size  First Load JS
┌ ○ /                                      127 B         103 kB
├ ○ /_not-found                            991 B         103 kB
└ ƒ /api/health                            127 B         103 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

## 4. Node 20 → 22

Node 20 left LTS in April 2026 (no security patches) and six `@supabase/*` packages
declare `node >= 22`, producing `EBADENGINE`.

| File | Change |
|---|---|
| `Dockerfile` | `node:20-alpine` → `node:22-alpine` in **all three** stages (`deps`, `builder`, `runner`) |
| `package.json` | `engines.node`: `">=20"` → `">=22"` |
| `.github/workflows/ci.yml` | `node-version: 20` → `22` |

About CI: all three jobs were checked one by one. Only **two** set
`node-version` — `build` (line 15) and `e2e` (line 47). The `db` job **does not use Node**:
it runs via `supabase/setup-cli@v1` and does not run `npm ci`, so there was nothing to
change there. Confirmed by search:

```
$ grep -n "node-version" .github/workflows/ci.yml
15:          node-version: 22
47:          node-version: 22
```

The image build confirms the version in use: `v22.23.1`.

## 5. `0001_extensions.sql` was a no-op and `digest()` did not resolve

**Checked against the real database, before the edit:**

```
$ docker exec supabase_db_CRM_-_LISTENER psql -U postgres -At \
    -c "select e.extname, n.nspname from pg_extension e
        join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto';" \
    -c "set search_path = pg_catalog, public;
        select coalesce(to_regprocedure('digest(bytea,text)')::text, 'NULL') as unqualified,
               coalesce(to_regprocedure('extensions.digest(text,text)')::text,'NULL') as qualified;"
pgcrypto|extensions
SET
NULL|extensions.digest(text,text)
```

Both facts from the review confirmed: `pgcrypto` is already in the **`extensions`**
schema (so `create extension if not exists pgcrypto;` did nothing), and `digest()`
**is not resolvable** from inside a function that pins `search_path = pg_catalog,
public` — only the fully qualified form resolves. `rate_limit_hit` pins exactly that
search_path, and Block 1's document hash function would follow the same pattern.

**Fix** (edited in place — the hosted project does not exist, the migration never ran
outside local; no `0003` was created):

```sql
create extension if not exists pgcrypto with schema extensions;
```

On top of that: the old comment attributed `gen_random_uuid()` to pgcrypto — wrong on
PG13+, where the function is a `pg_catalog` builtin. Comment fixed, and it is now
recorded in the file that `digest()` must be called as `extensions.digest(...)` inside
functions with a pinned search_path.

After `db:reset`, the state holds:

```
pgcrypto -> extensions
SET
unqualified=NULL | qualified=extensions.digest(text,text)
```

## 6. Documentation

**`docs/bloco-0-handoff.md`** gained the section "Deploy — EasyPanel (Hostinger VPS) and
hosted Supabase", covering:

- **Binding on `0.0.0.0`** — why a `docker run -p 3000:3000` on a single network does not
  reveal the bug, and why behind Traefik it turns into a 502.
- **Health check** — why the route must not touch the database.
- **Build-time × runtime table** — `NEXT_PUBLIC_*` go in **Build args _and_
  Environment**; `SUPABASE_SERVICE_ROLE_KEY` goes in **Environment only**.
- **Highlighted warning about `SKIP_ENV_VALIDATION`** (see below).
- **`supabase config push` — do not run it.** `config.toml` is a local-dev file.
  Pushing it would overwrite production with `site_url = "http://127.0.0.1:3000"`,
  `additional_redirect_urls = ["https://127.0.0.1:3000"]`,
  `[auth.email] enable_confirmations = false`, `minimum_password_length = 6` and
  `[auth.rate_limit] email_sent = 2` (2 emails/hour across the whole project). Values
  checked in the file. Correct procedure documented:
  `supabase link --project-ref <ref>` followed by `supabase db push`, with Site URL and
  Redirect URLs configured **in the dashboard**. Also recorded that
  `major_version = 17` must match the hosted project and that
  **`supabase db reset --linked` is destructive and must not be used**.
- **GRANT convention.** The same permission defect hit `rate_limit_counters`
  twice in one session (first RLS turned off, then `service_role` without DML). The
  root cause is a platform default: a new table gets no DML GRANT, and
  `BYPASSRLS` does not substitute for a missing GRANT when the function is
  `SECURITY INVOKER`. Rule recorded: **every new table accessed via
  `createServiceClient()` needs an explicit `grant ... to service_role` in the
  migration**; `SECURITY DEFINER` RPCs escape this because they run as the owner.
- **`digest()` lives in `extensions`** — summary of item 5 for Block 1.

**Debt table updated:**

| Row | What was done |
|---|---|
| `register()` covers only `nodejs`; no `HEALTHCHECK` in the Dockerfile | **Amended** — the `HEALTHCHECK` part is resolved; all that's left is the `nodejs` runtime coverage in `instrumentation.ts` |
| `EBADENGINE`: six `@supabase/*` want Node ≥ 22 | **Marked resolved** |
| GitHub deprecated Node 20 in actions | **Marked resolved** |
| `config.toml`: `site_url` http vs `additional_redirect_urls` https | Amended with a pointer to the new deploy section |

The "CI status" section was also updated: it no longer claims the local verification was
done on `node:20-alpine`.

**`.env.example`** reorganized into three explicit blocks — BUILD-TIME,
RUNTIME-ONLY and "NEVER set at runtime" —, the last one covering
`SKIP_ENV_VALIDATION`.

### Operational warning — `SKIP_ENV_VALIDATION`

> **Never set `SKIP_ENV_VALIDATION` in EasyPanel's Environment.**

It exists only inside the `Dockerfile`'s builder stage (scope already correct),
because during `next build` the secrets legitimately do not exist. If it leaks into
runtime, `src/lib/env.ts` falls into the loose branch (`parseLooseEnv`), boot validation
**silently disappears** and the container comes up with no Supabase configuration at
all — failing on the first query, in production, instead of failing at boot. Recorded
prominently in both `.env.example` and the handoff.

---

## Verification

The local `crm-listener:dev` image was **stale** (built before the `process.exit(1)`
fix). It was rebuilt from scratch before drawing any conclusion.

### `npm run lint`

```
> crm-listener@0.1.0 lint
> next lint --dir src --dir tests

`next lint` is deprecated and will be removed in Next.js 16.
For new projects, use create-next-app to choose your preferred linter.
For existing projects, migrate to the ESLint CLI:
npx @next/codemod@canary next-lint-to-eslint-cli .

✔ No ESLint warnings or errors
```

(The `next lint` deprecation warning is pre-existing debt already recorded in the handoff.)

### `npm run typecheck`

```
> crm-listener@0.1.0 typecheck
> tsc --noEmit
```

No output — no errors.

### `npm run test`

```
 RUN  v2.1.9 M:/CRM - LISTENER

 ✓ tests/unit/supabase-config.test.ts (2 tests) 19ms
 ✓ tests/unit/rate-limit.test.ts (4 tests) 2ms
 ✓ tests/unit/errors.test.ts (3 tests) 2ms
 ✓ tests/unit/sanity.test.ts (1 test) 4ms
 ✓ tests/unit/mailer.test.ts (1 test) 2ms
 ✓ tests/unit/env.test.ts (6 tests) 33ms
 ✓ tests/unit/logger.test.ts (5 tests) 6ms

 Test Files  7 passed (7)
      Tests  22 passed (22)
   Duration  655ms
```

**22 tests**, as expected. No new tests were added.

### `npm run test:e2e`

```
Running 1 test using 1 worker

  ok 1 tests\e2e\home.spec.ts:3:5 › home mostra o título da fundação (371ms)

  1 passed (4.0s)
```

### `npm run db:reset`

```
> crm-listener@0.1.0 db:reset
> supabase db reset

Resetting local database...
Recreating database...
Initialising schema...
Seeding globals from roles.sql...
Applying migration 0001_extensions.sql...
NOTICE (42710): extension "pgcrypto" already exists, skipping
Applying migration 0002_rate_limit.sql...
WARN: no files matched pattern: supabase/seed.sql
Restarting containers...
Finished supabase db reset on branch deploy-readiness.
```

The `NOTICE ... already exists, skipping` is direct confirmation of item 5's diagnosis:
even with `with schema extensions`, the statement is still a no-op **because the
extension is already there, in the right schema**. The migration now documents that fact
instead of pretending to install something.

### `npm run db:test`

```
> crm-listener@0.1.0 db:test
> supabase test db

Connecting to local database...
/CRM - LISTENER/supabase/tests/00_smoke.test.sql .. ok
All tests successful.
Files=1, Tests=7,  0 wallclock secs ( 0.01 usr +  0.01 sys =  0.02 CPU)
Result: PASS
```

**7 pgTAP asserts**, as expected — the edited `0001` applies cleanly.

### `docker build -t crm-listener:dev .`

Full build, no errors. Relevant excerpts:

```
#5 [internal] load metadata for docker.io/library/node:22-alpine
#13 [deps 4/4] RUN npm ci
#13 19.96 added 458 packages, and audited 459 packages in 20s
#13 DONE 20.3s
...
#16 [builder 5/5] RUN npm run build
#16 0.915    ▲ Next.js 15.5.22
#16 6.431  ✓ Compiled successfully in 3.9s
#16 6.434    Linting and checking validity of types ...
#16 9.751  ✓ Generating static pages (4/4)
#16 24.68 Route (app)                                 Size  First Load JS
#16 24.68 ┌ ○ /                                      127 B         103 kB
#16 24.68 ├ ○ /_not-found                            991 B         103 kB
#16 24.68 └ ƒ /api/health                            127 B         103 kB
#16 DONE 24.9s
...
#20 naming to docker.io/library/crm-listener:dev done
#20 DONE 1.7s
```

No `EBADENGINE` during `npm ci` — item 4 closes. (The remaining `npm warn deprecated`
messages come from ESLint 8 transitive dependencies, pre-existing debt.)

### Negative case — the boot guard

A container **without** environment variables must exit with a non-zero code:

```
$ docker run --rm --name crm-noenv crm-listener:dev; echo "EXIT_CODE=$?"
   ▲ Next.js 15.5.22
   - Local:        http://localhost:3000
   - Network:      http://0.0.0.0:3000

 ✓ Starting...
Error: Configuração de ambiente inválida — NEXT_PUBLIC_SUPABASE_URL: Required; NEXT_PUBLIC_SUPABASE_ANON_KEY: Required; SUPABASE_SERVICE_ROLE_KEY: Required
    at aE (.next/server/chunks/278.js:1:57015)
    at 7278 (.next/server/chunks/278.js:1:57183)
    at Function.c (.next/server/webpack-runtime.js:1:127)
    at async Module.d (.next/server/instrumentation.js:1:99)
EXIT_CODE=1
```

The guard still holds. And note the banner: `Network: http://0.0.0.0:3000` — before the
item 1 fix it printed the container ID.

---

## Two-network proof

A `docker run -p 3000:3000` on a single network **cannot reveal** the item 1 bug: the
container's IP is precisely the published one, so the test passes either way. EasyPanel's
real topology was reproduced.

### Setup

Two throwaway networks, with the container attached to both **before** the process
binds (`docker create` → `network connect` → `docker start`, to guarantee both
interfaces already exist at bind time):

```
$ docker network create crm-svc-net
$ docker network create crm-proxy-net
crm-proxy-net	bridge	local
crm-svc-net	bridge	local

$ docker create --name crm-app --network crm-svc-net --network-alias crm-app \
    -e NEXT_PUBLIC_SUPABASE_URL=https://dummy.supabase.co \
    -e NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy-anon-key \
    -e SUPABASE_SERVICE_ROLE_KEY=dummy-service-role-key \
    crm-listener:dev
$ docker network connect --alias crm-app crm-proxy-net crm-app
$ docker start crm-app
```

Two networks, two IPs:

```
--- redes anexadas ---
crm-proxy-net=172.20.0.2
crm-svc-net=172.19.0.2

--- HOSTNAME dentro do contêiner ---
HOSTNAME=0.0.0.0
ec99b9dc239d
--- /etc/hosts ---
127.0.0.1	localhost
::1	localhost ip6-localhost ip6-loopback
fe00::	ip6-localnet
ff00::	ip6-mcastprefix
ff02::1	ip6-allnodes
ff02::2	ip6-allrouters
172.20.0.2	ec99b9dc239d
172.19.0.2	ec99b9dc239d
```

Here the whole mechanism is on display: `/etc/hostname` is still the container ID
(`ec99b9dc239d`) and `/etc/hosts` maps it to **two** IPs — the resolver returns only the
first. But `HOSTNAME=0.0.0.0`, because the image's `ENV` beat the value injected by the
daemon. That precedence is exactly what the fix exploits.

### Result with the fix

```
=== 1) Caminho do Traefik: 2º contêiner na crm-proxy-net -> crm-app por nome ===
  HTTP/1.1 200 OK
  vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
  content-type: application/json
  Date: Sun, 26 Jul 2026 18:58:49 GMT
  Connection: close
  Transfer-Encoding: chunked

{"status":"ok","uptime":13}

=== 2) Mesmo teste pela crm-svc-net ===
  HTTP/1.1 200 OK
  vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
  content-type: application/json
  Date: Sun, 26 Jul 2026 18:58:49 GMT
  Connection: close
  Transfer-Encoding: chunked

{"status":"ok","uptime":14}

=== 3) localhost dentro do contêiner (exatamente o que o HEALTHCHECK roda) ===
{"status":"ok","uptime":14}
EXIT=0
```

Listening socket:

```
$ docker exec crm-app sh -c 'cat /proc/net/tcp | awk "NR>1 {print \$2}"'
00000000:0BB8      <- 0.0.0.0:3000
0B00007F:B487
0100007F:D6F0
0100007F:A64A
0100007F:BDDC
```

`00000000:0BB8` = `0.0.0.0:3000`. Bound on every interface.

And Docker's `HEALTHCHECK` converges:

```
$ docker inspect --format '{{.Name}} -> {{.State.Health.Status}}' crm-app
/crm-app -> healthy
```

### Control — the same scenario with the pre-fix behavior

To show the fix is *load-bearing* and not decorative, a second container was brought up
on the same topology with `HOSTNAME` back to what Docker does by default (container
hostname injected into the variable):

```
$ docker create --name crm-app-bug --hostname crmbug \
    --network crm-svc-net --network-alias crm-app-bug -e HOSTNAME=crmbug \
    -e NEXT_PUBLIC_SUPABASE_URL=... -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
    -e SUPABASE_SERVICE_ROLE_KEY=... crm-listener:dev
$ docker network connect --alias crm-app-bug crm-proxy-net crm-app-bug
$ docker start crm-app-bug
```

```
--- IPs ---
crm-proxy-net=172.20.0.3
crm-svc-net=172.19.0.3

--- /etc/hosts do controle ---
172.20.0.3	crmbug
172.19.0.3	crmbug

--- para qual IP crmbug resolve de dentro ---
172.20.0.3        crmbug  crmbug

--- banner do Next ---
   ▲ Next.js 15.5.22
   - Local:        http://crmbug:3000
   - Network:      http://crmbug:3000

 ✓ Starting...
 ✓ Ready in 76ms

--- socket em escuta (controle) ---
030014AC:0BB8      <- 172.20.0.3:3000  (UM único IP)
0B00007F:8A1D
```

The contrast is literal: `00000000:0BB8` (fixed, every interface) against
`030014AC:0BB8` (control, **only** `172.20.0.3`). The hostname resolved to two IPs and
Node bound only to the first.

Consequences, measured:

```
=== alcance a partir da crm-proxy-net (caminho do Traefik) ===
{"status":"ok","uptime":17}
EXIT=0
=== alcance a partir da crm-svc-net ===
wget: can't connect to remote host (172.19.0.3): Connection refused
EXIT=1

--- localhost (o que o HEALTHCHECK roda) ---
wget: can't connect to remote host (127.0.0.1): Connection refused
EXIT=1
```

One network answers, the other gives **Connection refused** — and which of the two wins
is an accident of resolution order, not something you can configure. That is
exactly the intermittent 502 behind Traefik. `localhost` refuses too, so the
`HEALTHCHECK` would never pass:

```
$ docker inspect --format '{{.State.Health.Status}}' crm-app-bug
t+10s crm-app-bug=starting
t+20s crm-app-bug=starting
t+30s crm-app-bug=starting
t+40s crm-app-bug=starting
t+50s crm-app-bug=unhealthy

--- log do health check do controle ---
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
exit=1 out=wget: can't connect to remote host (127.0.0.1): Connection refused
```

**Score: fixed `healthy` + 200 on both networks; control `unhealthy` + Connection
refused on one of the networks and on localhost.** Same image, same topology, one single
variable different: `HOSTNAME`.

### Cleanup

```
$ docker rm -f crm-app crm-app-bug
crm-app
crm-app-bug
$ docker network rm crm-svc-net crm-proxy-net
crm-svc-net
crm-proxy-net
$ docker network ls --filter name=crm- --format '{{.Name}}'
(vazio)
$ docker ps -a --filter name=crm-app --format '{{.Names}}'
(vazio)
$ docker images crm-listener --format '{{.Repository}}:{{.Tag}}'
crm-listener:dev
```

The throwaway tags (`argproof`, `argproof-a`, `argproof-b`, `builderproof`,
`builderproof2`) were removed **one by one, by name** — no `docker prune` was
run. The Supabase stack was not touched beyond the expected `db:reset`/`db:test`;
`supabase stop`/`start` were not used.

---

## Caveats

1. **Item 2 could not be proven against production code**, because the repo still has no
   `'use client'` and no page imports `src/lib/supabase/config.ts` — searching the
   production bundle for the marker returns 0 occurrences simply
   because the module never enters any bundle at all. The proof required a throwaway
   client component, created and removed during verification. The fix is correct and the
   mechanism was demonstrated, but whoever adds auth in Block 1 must **confirm in
   practice** that the `NEXT_PUBLIC_*` values show up in the served bundle.
2. **CI still has never run on GitHub.** The move to Node 22 was
   validated locally inside the container (`node:22-alpine`, clean `npm ci`, no
   `EBADENGINE`), but the workflow's first real run is still pending.
3. **`supabase_vector` is `Restarting`** in the local stack — a state that **predates**
   this task, not caused by it, and with no effect on `db:reset`/`db:test`, which
   passed. Worth a look at some point.
4. **The `HEALTHCHECK` covers liveness, not readiness.** If the hosted Supabase goes down, the
   container stays `healthy` — a deliberate decision (see item 3), but it means that
   monitoring of external dependencies has to come from somewhere else.
5. **None of this was exercised against the hosted Supabase**, which does not exist yet. The
   `link`/`db push` procedure is documented, but not executed.
