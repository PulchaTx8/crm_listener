# Block 0 → Block 1 — Handoff

Closes out the `bloco-0-fundacao` branch (29 commits, `a8a7109..577ab67`). Everything
below was verified by actual execution, not by inspection. Items marked **(decided)**
have already been through a human decision — do not relitigate them.

## Safe to build on

- **`service_role` isolation** — `src/lib/supabase/service-client.ts` is marked
  `server-only`, and the absence of `SUPABASE_SERVICE_ROLE_KEY`/`createServiceClient`
  from the compiled bundle (`.next/static`) was checked by grep. The guarantee is real.
- **Environment validation at boot** — `src/instrumentation.ts` validates and **exits
  the process with exit 1** if the environment is invalid. Proven on the standalone
  artifact (the same binary the container's `CMD` runs): without env → exit 1; with env → HTTP 200.
- **Rate limiter** — the saturation semantics of the two implementations agree value
  for value, proven by running the RPC against the real database and comparing with the
  unit tests. `rate_limit_hit` is atomic (single-statement upsert).
- **Error taxonomy** — `toSafeJSON` is proven not to leak `cause` or the stack.
- **Migrations pipeline + pgTAP** — `db:reset` and `db:test` (7 asserts) actually run.
  The smoke test executes the RPC and verifies that `anon` still has no DML.

## Must be addressed early in Block 1

1. **`middleware.ts` does not exist.** `src/lib/supabase/user-client.ts` swallows cookie
   write failures by design, assuming the middleware refreshes the session. Without it,
   sessions expire silently. **Item #1 of the auth task.**
2. **Logger redaction vs. Supabase.** The `access_token`/`refresh_token` fields are
   already redacted, but check the real shape of the session object when you integrate
   auth — `MAX_DEPTH = 8` in `src/lib/logger.ts`, and deeper keys pass through unredacted.
3. **The `Database` types do not exist.** Both clients return a raw `SupabaseClient`, so
   `.from()` and `.rpc()` are untyped — that is exactly how a library `any` slipped past
   `noUncheckedIndexedAccess` in Block 0. Run `supabase gen types typescript`
   early and pass the generic to both factories; it is far cheaper before the schema grows.
4. **The validated `env` has no consumers.** `src/lib/supabase/config.ts` reads `process.env`
   directly **(decided — so the test can mutate it)**. Boot validates, but nobody uses the
   typed object. Wiring consumers to `env` is what makes `Env | LooseEnv` worth it.
5. **shadcn/ui** — the token layer (slate CSS vars + `theme.extend.colors`) has already
   shipped, so `npx shadcn add` works. The `.dark` block only makes it into the compiled
   CSS once a `dark` class exists somewhere in `content`.

## Deploy — EasyPanel (Hostinger VPS) and hosted Supabase

Written on the `deploy-readiness` branch. The full record, with the verbatim output of
every check, is in [`deploy-readiness-report.md`](./deploy-readiness-report.md).

### The container must listen on `0.0.0.0` — and it wasn't

Next's standalone entrypoint is generated with
`const hostname = process.env.HOSTNAME || '0.0.0.0'`, and **Docker always injects
`HOSTNAME`** with the container ID. The result: the `||` never fires and the process
listens only on the IP that hostname resolves to. Never `0.0.0.0`, never
`127.0.0.1`.

A `docker run -p 3000:3000` on a single network **does not reveal the bug** — the
container's IP is precisely the published one, so it passes either way. Behind EasyPanel
the container joins **two** networks (the service network and the Traefik proxy network),
and the proxy may hit the interface with no listener → intermittent 502. A health check on
`localhost` would never have worked either.

Fix: `ENV HOSTNAME=0.0.0.0` in the `Dockerfile`'s runner stage — the image's `ENV`
takes precedence over the value injected by the daemon.

### Health check

`src/app/api/health/route.ts` answers 200 with a minimal JSON body and is
`dynamic = 'force-dynamic'` (without it Next would statically optimize the route at
build time and the check would be measuring a file, not the process). The Dockerfile's
`HEALTHCHECK` consumes it via BusyBox's `wget`, present in `node:22-alpine`.

**The route deliberately does not touch the database.** A health check that queries
Supabase turns database flapping into container restarts: the app is still alive and able
to serve pages, so taking it down only amplifies the incident. Invalid configuration
is already caught at boot by `src/instrumentation.ts`, which exits with exit 1 — a
misconfigured container never even gets as far as answering here.

### Variables: what is build-time and what is runtime

EasyPanel has **two** distinct tabs, and the difference is not cosmetic:

| Variable | Where it goes | Why |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Build args** *and* Environment | `NEXT_PUBLIC_*` are inlined into the client bundle during `next build`. Setting it in Environment only does not change an already-compiled bundle — the value never reaches the browser. The `Dockerfile` declares both as `ARG` in the builder stage. They also need to exist at runtime, for the server-side code. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Build args** *and* Environment | same |
| `SUPABASE_SERVICE_ROLE_KEY` | **Environment only (runtime)** | Build args are baked into the image layers. Passing the service role as an `ARG` leaks the secret to anyone who runs `docker history` on the image. |
| `SMTP_URL`, `MAIL_FROM` | Environment (runtime) | optional |

> **`SKIP_ENV_VALIDATION` must NEVER appear in EasyPanel's Environment.**
> It exists only inside the `Dockerfile`'s builder stage, because during
> `next build` the secrets legitimately do not exist. If it leaks into runtime,
> `src/lib/env.ts` falls into the loose branch (`parseLooseEnv`), boot validation
> **silently disappears** and the container comes up with no Supabase configuration
> at all — failing on the first query, in production, instead of failing at boot.
> It is the difference between a deploy that breaks right away and one that breaks in
> front of the customer.

### `supabase config push` — do not run it

`supabase/config.toml` is a **local development** file. Pushing it to the hosted
project overwrites the production configuration with dev values:

- `site_url = "http://127.0.0.1:3000"` — breaks every auth email link;
- `additional_redirect_urls = ["https://127.0.0.1:3000"]` — same;
- `[auth.email] enable_confirmations = false` — starts accepting signup without
  email confirmation;
- `minimum_password_length = 6` — loosens the password policy;
- `[auth.rate_limit] email_sent = 2` — 2 emails per hour **across the whole project**.

**Correct procedure:**

```bash
supabase link --project-ref <ref>
supabase db push                 # applies only the migrations
```

Site URL and Redirect URLs are configured **in the Supabase dashboard**
(Authentication → URL Configuration), not through `config.toml`.

Two details that bite:

- `major_version = 17` in `config.toml` must match the hosted project's version.
  Check it with `SHOW server_version;` on the remote database before the `link`;
  a mismatch makes `db push` and `db diff` behave unpredictably.
- **`supabase db reset --linked` is destructive** — it drops and recreates the
  *hosted* database. Do not use it. The local `db:reset` (`npm run db:reset`) is safe
  because it acts on the Docker stack; the `--linked` flag changes the target.

### GRANT convention — read this before creating a table

The same permission defect caught `rate_limit_counters` **twice in a single
session**: first RLS off, then `service_role` without DML. The root cause is a
platform default, not carelessness: **a new table in the `public` schema gets no DML
GRANT** for the Supabase roles (the default ACL gives only `Dxtm` —
TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). And `BYPASSRLS` **is not a substitute for a
missing GRANT**: the role goes through the policies, but is still blocked at the
table privilege when the function is `SECURITY INVOKER`.

The rule, then:

> **Every new table accessed directly through `createServiceClient()` needs an
> explicit `grant ... to service_role` in the migration itself.**

`SECURITY DEFINER` RPCs escape this because they run with the function owner's
privileges — but then the care shifts to pinning `search_path`. `rate_limit_hit` is
`SECURITY INVOKER` on purpose, and that is exactly why migration `0002`
carries the explicit `grant`. The pgTAP smoke test proves the GRANT by executing the RPC
under the real role (`set local role service_role`); table existence proves nothing.

### `digest()` lives in `extensions`

`pgcrypto` ships already installed in the `extensions` schema (local **and** hosted), so
`create extension if not exists pgcrypto;` was a no-op. `0001` now declares
`with schema extensions` and records what matters in practice: inside a function with
`set search_path = pg_catalog, public`, `digest()` **does not resolve** — it has to be
`extensions.digest(...)`. This applies to Block 1's document hashing function.

## Recorded debt (not blocking, but do not rediscover it)

| Item | Where |
|---|---|
| `register()` covers only the `nodejs` runtime (the edge runtime comes up with no env validation) | `src/instrumentation.ts` |
| The logger's cycle guard returns the original object by reference — real cycles leak one level **(decided: deferred)** | `src/lib/logger.ts:59-63` |
| Playwright artifact upload is inert (no `reporter` configured) **(decided: deferred)** | `.github/workflows/ci.yml`, `playwright.config.ts` |
| `prettier --check .` fails on 6 files, and no CI step runs prettier | repo-wide |
| Root configs are still unlinted — `--dir` **replaces** the defaults; only migrating to the ESLint CLI closes this | `package.json`, `.eslintrc.json` |
| `next lint` is deprecated and disappears in Next 16 | `package.json` |
| ~~`EBADENGINE`: six `@supabase/*` want Node ≥ 22, CI pins 20~~ **resolved on `deploy-readiness`**: Dockerfile (3 stages), `engines.node` and the CI jobs moved to 22 | — |
| ~~GitHub deprecated Node 20 in actions~~ **resolved along with it**: `node-version: 22` in the `build` and `e2e` jobs (the `db` job does not use Node — it runs through `supabase/setup-cli`) | — |
| `SmtpMailer` and `PostgresRateLimiter` have no unit test **(decided)** | `src/lib/mailer`, `src/lib/rate-limit` |
| `PostgresRateLimiter` accepts any client — requiring the service client is documentation only | `src/lib/rate-limit/index.ts` |
| `config.toml`: `site_url` http vs `additional_redirect_urls` https — matters once auth is wired up. Only applies to local dev; on hosted it is configured in the dashboard (see "Deploy" above) | `supabase/config.toml` |
| Migration numbering `0001`/`0002` vs. the timestamp from `supabase migration new` — pick one | `supabase/migrations/` |
| The plan's `package.json` block omits the `supabase` devDep | `docs/superpowers/plans/2026-07-26-bloco-0-fundacao-tecnica.md` |

## Plan defects fixed during execution

The plan document was fixed alongside the code all four times, so it no longer
reproduces any of these. Recorded because the pattern matters: **code written in a
plan is not verified code.**

- `SmtpMailer` built the transport from `undefined` (failed `typecheck`).
- `rate_limit_counters` shipped with RLS off — anyone holding the anon key could wipe
  the counters.
- `service_role` had no DML on the table: `PostgresRateLimiter` threw on **every**
  call. An environment-dependent failure — it would have passed on a permissive hosted project.
- The Dockerfile copied `public/`, which did not exist — `docker build` broke outright.
- `.dockerignore` did not exclude `.env*`, with `.env.example` carrying
  `SUPABASE_SERVICE_ROLE_KEY`.

## CI status

The workflow has **never run on GitHub** — the branch was just published. The
`lint → typecheck → test → build` sequence was verified locally inside the container
(Linux, same as the runner). The `db` and `e2e` jobs are new and were only validated
syntactically. **Watch the first real run** — in particular whether
`supabase/setup-cli` and `@supabase/cli-linux-x64` install cleanly on `ubuntu-latest`.

Since `deploy-readiness` the baseline is **Node 22** everywhere: the `Dockerfile`'s
three stages, `engines.node` and CI's `build`/`e2e` jobs. Node 20 left
LTS in April 2026 (no security patches) and six `@supabase/*` packages
declare `node >= 22`, which produced `EBADENGINE` on every `npm ci`.
