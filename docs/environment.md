# Environment variables

The authoritative list is `src/lib/env.ts` — it validates at boot and refuses to
start on an invalid configuration. This page explains *where* each value has to
be set, which the schema cannot express.

There is no committed `.env.example`. That file is gitignored on purpose: it is a
private scratch file for real values, and a file whose purpose is to hold
credentials must never be tracked, however harmless its name sounds. This page is
the template instead, and it carries no secrets.

## The variables

| Variable | Required | Where it must be set |
|---|---|---|
| `NODE_ENV` | defaulted | `development` locally; the image sets `production` |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | **Build args _and_ Environment** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | **Build args _and_ Environment** |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **Environment only — never a build arg** |
| `NEXT_PUBLIC_SITE_URL` | for invitations and password reset | Environment only (see below) |
| `SMTP_URL` | for invitations and contact notifications | Environment |
| `MAIL_FROM` | with `SMTP_URL` | Environment |
| `SKIP_ENV_VALIDATION` | never | Dockerfile builder stage only |

## Local development

```bash
NODE_ENV=development
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the fixed key `npx supabase status` prints>
SUPABASE_SERVICE_ROLE_KEY=<the fixed key `npx supabase status` prints>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
MAIL_FROM=crm@example.com
```

Point local development at the **local stack**, not at the hosted project. With
production credentials in `.env`, `npm run dev` writes to production: one click
on "Provision" in the local admin console creates a real customer. To reach the
hosted project deliberately, override per command rather than editing the file:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co npm run dev
```

`MAIL_FROM` must be a valid address even locally — the boot check rejects
`crm@localhost` for want of a TLD. `example.com` is reserved for exactly this
(RFC 2606).

## Traps that have actually cost time here

**No `/rest/v1` suffix on the Supabase URL.** `supabase-js` appends its own
paths, so a URL ending in `/rest/v1/` sends every call to `/rest/v1/rest/v1/...`
and `/rest/v1/auth/v1/...` — all 404. It still passes boot validation, because it
is a perfectly valid URL. Correct form:

```
https://<ref>.supabase.co
```

**`NEXT_PUBLIC_SITE_URL` does not need a build arg, despite the prefix.** It is
read only in server code, so it survives to runtime as a live `process.env`
lookup instead of being inlined. Verified against the compiled output: it appears
in no client chunk. Treating it as a build arg would force a rebuild on every
domain change for nothing.

The two Supabase `NEXT_PUBLIC_*` values genuinely are inlined and genuinely do
need both places — setting them only at runtime cannot change an already
compiled bundle.

**`SKIP_ENV_VALIDATION=1` must never reach runtime.** It exists only inside the
Dockerfile builder stage, where the secrets legitimately do not exist. If it
leaks into a deployed environment, `env.ts` falls into the loose branch, boot
validation disappears silently, and the container starts with no Supabase
configuration at all — failing on the first query, in production, instead of
failing at boot.

**Two separate mail configurations exist, and they are easy to confuse.**

| | Covers | Configured in |
|---|---|---|
| Supabase SMTP | password reset, confirmation — anything from Auth | Supabase dashboard |
| `SMTP_URL` + `MAIL_FROM` | **invitations** and contact-form notifications | app environment |

Invitations are sent by the application's own mailer, not by Supabase Auth.
Configuring the dashboard SMTP does not make invitations arrive. Without
`SMTP_URL`, the Block 0 mailer falls back to `DevMailer`, which records instead
of sending: the invitation is created, the link works, and nobody receives
anything.
