# Security

**What this answers:** where the boundaries are, what enforces each one, and
which test would notice if it broke.

---

## 1. RLS is the primary mechanism

Every tenant table has row level security enabled, and the application **never**
filters by Company in TypeScript and calls that security. A screen that shows
one Station's data does so because the database answered with one Station's
data.

The five functions every policy leans on are `is_platform_admin`, `is_owner`,
`is_owner_of_company`, `has_company_access` and `has_permission` — see
`docs/PERMISSIONS.md`.

## 2. `SECURITY DEFINER` re-authorises

A definer function runs as its owner, so **it does not inherit the caller's
policies**. Every one of them therefore asks `has_permission` itself before doing
anything. A definer function that trusts its caller is a hole with a
well-formatted signature.

## 3. The isolation suite is the living proof

pgTAP runs as superuser with a null `auth.uid()`, so **it never exercises RLS at
all**. `supabase/tests/*.sql` proves catalogue and logic; it cannot prove a
policy.

`tests/isolation/*.test.ts` — 28 files — issues the real reads and writes over
HTTP as the roles that make them, which is the only place a missing grant or a
wrong policy actually shows up. Its runner (`npm run test:isolation`) fails the
run if a single file goes unreported, because a file that did not run is a
boundary nobody checked.

Anything that **commits** — the sweeps, the retention procedure — is called over
a direct Postgres connection instead, because pgTAP wraps each file in a
transaction it rolls back and PostgREST cannot reach a procedure at all. The rule
that came out of Block 11a: **if a scheduled routine commits, write a test that
calls it.**

## 4. Headers, and the Content-Security-Policy

Five static headers in `next.config.mjs`, reaching every route including the two
machine endpoints: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy`
refusing camera/microphone/geolocation/payment/USB, and HSTS for two years
(**not** preloaded — that is a one-way door belonging to whoever owns DNS).

The **CSP** is minted per request in `src/middleware.ts` from
`src/lib/security/csp.ts`. It carries a nonce and `'strict-dynamic'`, and
`'unsafe-eval'` in development only.

**If you edit the policy, run the whole Playwright suite and read the pass count
as a number.** Block 11a shipped a broken CSP that produced *no error message
anywhere in the test output*, because violations are raised in the browser and
nothing was listening. `tests/e2e/csp-violations.ts` now listens;
`tests/e2e/csp.spec.ts` also asserts that every `<script>` in the delivered HTML
carries the nonce, which is the check that would have found it in minutes.

Two directives are load-bearing and easy to "tidy" into an outage: `connect-src`
must carry the Supabase origin and its `wss:` form, and `style-src` carries
`'unsafe-inline'` because in CSP that keyword also governs the `style`
**attribute**, which React emits for every `style={{…}}` prop.

## 5. Framing: `/w/` is the one route that may be embedded

Everything else in this product refuses to be framed — `X-Frame-Options: DENY`
and `frame-ancestors 'none'`, both from Block 11a, both described in §4.
`/w/<publicKey>` (Block 17a, `docs/WIDGET.md`) is the single, deliberate
exception, and it is scoped as narrowly as the mechanism allows.

**The allowlist is per Station, and empty means nowhere.**
`widget_installations.allowed_origins` (`0159`) holds full origins with no
path and no trailing slash; an installation with no origins configured frames
nowhere at all. The database's own column comment states the rule that
`src/lib/widget/origins.ts`'s `frameAncestorsValue` enforces in code: an empty
list becomes `'none'`, never a wildcard. There is no configuration state in
which "unset" means "any site may frame this."

**`X-Frame-Options` is excluded from the route, not overridden on it.** Next
applies every matching entry in `headers()`, and the browser obeys the
strictest of them — so a second, looser entry scoped to `/w/:path*` would not
relax the blanket `DENY`, it would sit beside it, and the widget would still
refuse to be framed while looking, to whoever debugs it, like a browser bug.
The only mechanism that works is taking the path **out of** the entry that
sets `DENY` in the first place: `next.config.mjs`'s global source is
`'/((?!w/).*)'` rather than `'/:path*'`, and the widget route is handed back
the other four static headers (`X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, HSTS) by a second entry that carries only those four and
must never carry `X-Frame-Options` in any value — doing so would re-impose the
refusal on the one route this product allows to be framed, with a blank iframe
on a customer's site as the only symptom.

**The per-Station allowlist is read from the database by the Edge middleware,
before the Supabase client is constructed** (`src/middleware.ts`,
`src/lib/widget/frame-cache.ts`), and cached **60 seconds per instance**. The
cache is what makes that lookup affordable on every anonymous document
request, and it cuts both ways: an origin just added may not frame for up to a
minute, which is harmless lag; an origin just removed — or an installation
just disabled — **may keep framing for up to a minute**, a real, bounded
window, accepted rather than overlooked. Sixty seconds is the number
specifically because it is long enough to make the cache worth having and
short enough that revocation is a wait rather than an incident; lengthening it
trades away the second half of that sentence, not the first. Every path that
is not a successful, authoritative lookup — an unknown key, a disabled or
archived installation, a fetch that throws or times out — answers `'none'`,
the same refusal as a Station with no origins configured. A failure never
falls open.

## 6. Secrets

No secret lives in the database. The WhatsApp app secret, the verify token, the
access token and the worker secret are environment variables, all optional so
that CI and `next build` run without them — the routes refuse to serve rather
than the application refusing to boot.

Both machine endpoints compare their secret in **constant time**. No test fails
if that is swapped for `===`, so it has to be caught in review.

## 7. Uploads

The **bucket** is the barrier: `delivery-receipts` accepts at most 10 MB and only
JPEG, PNG, WebP, HEIC and PDF (`0134`). The check in the Server Action exists so
the operator reads a sentence instead of a Storage error — it is not the
boundary, and the code says so.

The stored extension comes from the validated MIME type, never from the client's
filename. There is deliberately **no magic-byte sniffing**: what makes an object
dangerous is the `Content-Type` it is *served* with, and HTML stored as
`image/jpeg` is inert.

The `reports` bucket carries a size wall and no MIME list, because its content
type comes from a frozen server-side map and an allow-list there could only break
a working export.

## 8. LGPD

- **The audit trail is pseudonymised by construction** — ids, not names — and
  `audit_logs` is **kept for ever**, because it is the proof that erasures
  happened. Deleting the record of a deletion is the worst available outcome in
  an audit.
- **Subject-driven erasure** is `anonymize_member` (`0034`): it scrubs the
  personal data and queues the storage objects that outlive the SQL.
- **Age-driven erasure** is `sweep_retention` (`0131`, rewritten in `0133`,
  extended in `0161`): 90 days on Meta's raw webhook payload, 180 on messages
  and conversations, 365 on public contact requests, 30 on three operational
  tables and on `widget_verifications` (Block 17a — a telephone number typed
  into a Station's own website). Periods are fixed for the installation, in
  the migration. **No business record is ever swept** — a prize delivered in
  2024 and disputed in 2028 needs its row.
- **Documents and receipts** live in private buckets and are served through
  short-lived signed URLs minted server-side.

## 9. Rate limiting

`PostgresRateLimiter` (`src/lib/rate-limit/`) backs the public contact form and
invitation acceptance, keyed by a hash of the caller's IP. Note for anyone
writing tests: **every local test shares `127.0.0.1`**, so a suite that grows
past ten accepted invitations in a window starts failing on a control that is
working correctly.

## 10. API credentials (Block 15)

The two external intake endpoints (`docs/API.md`) authenticate on a per-Station
key presented as `Authorization: Bearer ptx_…`.

- **Only the SHA-256 is stored.** `api_credentials.token_hash` carries a CHECK
  refusing anything that is not 64 lowercase hex characters, so a raw secret
  written into that column is rejected by the database. The plaintext is shown
  once at issue and exists nowhere afterwards.
- **The token is hashed in Node, before it reaches the database** — never passed
  to an RPC in the clear, for the reason the WhatsApp webhook already records for
  the `wamid`: an RPC argument lands in query logs and in backups.
- **No constant-time comparison, and that is correct.** Nothing on this path
  compares a secret to a secret: what arrives is hashed first and what is stored
  is a hash, so the lookup is an indexed equality over the digest of a 256-bit
  value. The `timingSafeEqual` in `/api/worker/tick` exists because that secret
  lives in the environment and is compared byte for byte.
- **`api_credentials` and `api_credential_scopes` have RLS on and no policy**,
  and no table grant. `createServiceClient().from('api_credentials')` fails with
  42501 by design; every reader is inside a `SECURITY DEFINER` body.
- **A key is a bearer token.** Scoping is per Station and per permission code;
  revocation is per key and takes effect immediately; expiry is optional. There
  is **no IP allowlist** in this version — if a key leaks, revoke it.
- **A suspended or deleted Station stops its own keys**, without anyone having to
  remember to revoke them.
- Issuing, revoking and every write the endpoints make are recorded in
  `audit_logs`. For an API caller `actor_id` is null and the credential is named
  in `detail`; a null there does not mean "the system did it".

Rate limiting for these endpoints is per credential rather than per IP — an
automation has one address — and uses the Postgres limiter so the counter is
shared across instances.

## 11. Reporting a problem

There is no public security contact configured. Report privately to the
repository owner rather than in an issue.
