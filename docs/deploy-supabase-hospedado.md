# Hosted Supabase — applying and verifying the migrations

Record of the first deploy of the Block 0 schema to a hosted Supabase project.
Date: 2026-07-26.

## Project

| | |
|---|---|
| Ref | `djbkdyesubkedxjwcohq` |
| Name | CRMPulchatX |
| Region | `sa-east-1` (São Paulo) |
| Postgres | 17.6.1 — matches `major_version = 17` in `config.toml` |

> **Warning — two projects with nearly identical names.** `CRMPulchatX_Old`
> (`aewffpmguhqweznfrruu`) hosts **another application in production**: a WhatsApp
> CRM with AI agents, 29 tables and live data. **Always check the ref, never
> the name.** This project's ref ends in `...wcohq`; the other one's, in `...nfrruu`.

## Incident avoided

The first `db push` was run with `--dry-run` and refused to apply: it found 52
remote migrations missing from the repository. The CLI suggested two ways out, **both
destructive in this context**, and neither was executed:

- `supabase migration repair --status reverted <52 versions>` — would mark the other
  application's migrations as reverted, corrupting its history.
- `supabase db pull` — would dump someone else's schema into this repository.

The right fix was to unlink and create a dedicated project. **Always run
`--dry-run` before pushing to a database you did not create in this session.**

## Applying

```
supabase link --project-ref djbkdyesubkedxjwcohq
supabase db push --dry-run     # confirmed only 0001 and 0002 pending
supabase db push
```

`0001` emitted `NOTICE: extension "pgcrypto" already exists, skipping` — confirming
in practice the premise behind the fix made before the deploy: `pgcrypto` ships
already installed in the `extensions` schema, and the original version of the migration was a no-op.

`supabase migration list --linked` confirmed `0001` and `0002` both locally and remotely.

## Security verification — tested through REST, not by catalog inspection

The assertions were made from the outside, against the public API, with the real keys — that is,
against the surface an attacker would have.

| Test | Result |
|---|---|
| `anon` SELECT on `rate_limit_counters` | HTTP 401 · `42501 permission denied` |
| `anon` DELETE on `rate_limit_counters` | HTTP 401 · `42501 permission denied` |
| `anon` RPC `rate_limit_hit` | HTTP 401 · `42501 permission denied` |
| `service_role` RPC `rate_limit_hit` | HTTP 200 · `allowed: true` |

The second row is the one that matters: this was exactly the **critical** defect found
in review — with RLS off, anyone holding the public key could wipe the
counters and nullify the rate limiter. It is closed in the hosted environment.

The third row confirms the function fails closed: `rate_limit_hit` is
`SECURITY INVOKER` and still has `EXECUTE` for `PUBLIC`, but an `anon` caller
hits the missing DML on the table and never reaches data.

### Rate limiter semantics

Sequence executed against the hosted database, fresh key, 60s window:

| Call | `limit` | Result |
|---|---|---|
| 1 | 2 | `allowed=true, remaining=1` |
| 2 | 2 | `allowed=true, remaining=0` |
| 3 | 2 | `allowed=false, remaining=0` |
| 4 | 2 | `allowed=false, remaining=0` |
| 5 | **5** | `allowed=true, remaining=1` |

Identical, value for value, to what `tests/unit/rate-limit.test.ts` asserts for the
in-memory implementation — including call 5, the varying-limit case that
exposed the original divergence between the two implementations. The counter saturated at
`limit+1 = 3`; with `limit=5`, `3 <= 5`, so it increments to 4 and returns
`remaining = 5-4 = 1`.

The probe rows were removed at the end; the table was left empty.

### RLS

The tests above prove the **effect** (`anon` is blocked), but they do not distinguish
"RLS on + grants revoked" from "RLS off + grants revoked", because
PostgREST does not expose `pg_catalog`.

Confirmation by another route: `supabase db diff --linked --schema public` returned
**`No schema changes found`**. The remote schema is identical to the local one, and the local one has
`enable row level security` — verified by pgTAP (7 assertions).

## What was NOT run, and why

- **`supabase config push`** — `config.toml` is a local development file.
  Pushing it would set, on the hosted project, `site_url = http://127.0.0.1:3000`,
  `enable_confirmations = false`, `minimum_password_length = 6` and a limit of 2
  emails per hour. Site URL and Redirect URLs are configured through the dashboard.
- **`supabase db reset --linked`** — destructive.
- **pgTAP on the remote** — the extension is not provisioned on a hosted project the way it is
  locally. The same properties were assured by the REST tests above, which
  are in fact closer to the real risk.
