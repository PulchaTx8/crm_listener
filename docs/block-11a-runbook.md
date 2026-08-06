# Block 11a — Security Headers and the Retention Sweep

**Audience:** whoever deploys this block, whoever is asked "how long do you keep
this", and whoever gets paged when a page stops loading.

---

## 0. Deploy

Ordinary. `0131` adds one procedure and one cron entry and changes nothing that
exists; `next.config.mjs` adds five response headers.

1. `supabase db push` (`0131`).
2. `npm run db:test` — 1374/1374.
3. The frontend.

**If the frontend goes first**, nothing breaks: the headers are independent of
the database, and the sweep simply is not scheduled yet.

---

## 1. The headers

Five, on **every** route, set in `next.config.mjs`:

| header | value | what it stops |
| --- | --- | --- |
| `X-Frame-Options` | `DENY` | The product being framed. A clickjacked draw or delivery is a real action by a real operator who did not mean to take it. |
| `X-Content-Type-Options` | `nosniff` | A browser deciding a download proxy's octet-stream is really HTML, and running it. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Every record screen carries a `?record=<uuid>`; without this the full URL travels in the `Referer` of every outbound request. |
| `Permissions-Policy` | camera, microphone, geolocation, payment, USB all `()` | Nothing here uses any of them, so they are refused rather than left to a default that may change. |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Downgrade to HTTP. **Not preloaded** — preload is a one-way door on the apex domain and belongs to whoever owns DNS. |

**They are in `next.config.mjs` and not in the middleware on purpose.** The
middleware's matcher deliberately excludes `/api/webhooks/` and `/api/worker/`
— including them would 307 Meta's verification handshake and stop both queues
in silence — so headers set there would never reach the two endpoints an
outside system actually calls. `tests/e2e/headers.spec.ts` asserts them on
`/api/health` for that reason.

### There is no Content-Security-Policy, and that is a decision

It was implemented, tested and withdrawn. With a nonce and `'strict-dynamic'`
the Playwright suite came back **11 passed, 23 failed** — and not one CSP error
anywhere in the output. The symptom was journeys timing out on clicks that did
nothing, because no client component had hydrated: Next's App Router emits
inline bootstrap scripts, and the nonce is not reaching the renderer in this
application.

**A CSP that breaks the product is worse than no CSP**, because it gets deleted
during an incident by whoever is on call, along with whatever else looks
suspicious. `X-Frame-Options: DENY` covers the framing half meanwhile. Block 11b
owns the policy, with D2 of this block's spec as its brief.

**If somebody adds one:** run the full Playwright suite before merging, and read
the *pass count*, not the console. This failure produced no error message at all.

---

## 2. The retention sweep

`sweep_retention()`, daily at **04:11** through `pg_cron`.

| what | kept for |
| --- | --- |
| `webhook_events` (DONE/FAILED) | 90 days |
| `outbox_messages` (SENT/FAILED) | 180 days |
| `whatsapp_conversations` (past expiry) | 180 days |
| `contact_requests` | 365 days |
| `rate_limit_counters`, `whatsapp_conversation_leases`, `storage_erasure_queue` (processed) | 30 days |

Periods are **fixed for the installation**, in the migration. A radio needing a
different one is a conversation that has not happened; when it does, the policy
table this block did not build is a migration and the sweep reads it instead.

### What it never touches, and why you should not "fix" that

**`audit_logs` is kept for ever.** It is pseudonymised by construction — ids,
not names — and it is the proof that erasures happened. Deleting the record of a
deletion is the worst available outcome in an audit.

**No business record is ever swept**: participations, winners, draws,
promotions, members, prizes, inventory movements. They are what a radio must be
able to prove afterwards — a prize delivered in 2024 and disputed in 2028 needs
its `winners` row and its `inventory_movements` chain. Personal data inside them
is removed by **erasure** (`anonymize_member`), which is driven by a person
asking, not by a clock.

`supabase/tests/24_retention.test.sql` asserts both lists against the
procedure's own source. If you add a table to the sweep and the suite goes red,
read the assertion before changing it.

**Two smaller rules with teeth.** Only *terminal* outbox rows are swept — a
`PENDING` row is work not yet done, however old, and deleting it drops a message
somebody is waiting for. And only *processed* storage erasures — an unprocessed
one is an obligation this installation still owes somebody, which is why that
queue has no give-up threshold at all.

### Reading a sweep

It raises a `notice` per table with a row count, and a `warning` per table that
failed, then a summary line. It **commits per table**, so one failure does not
roll back the other six.

Today that goes to the Postgres log and nowhere else. **Block 11b turns it into
an alert.** Until then, a sweep that has been failing for a month looks exactly
like one that has been working, unless somebody reads the log — so check it
after this block deploys and again in a week.

There is deliberately **no audit row per deleted record**: one per deleted
`webhook_events` row would write more rows than the sweep removed, into the one
table it promises never to touch.
