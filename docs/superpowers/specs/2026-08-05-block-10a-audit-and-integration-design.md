# Block 10a — The trail nobody could read, and the integration nobody could configure — Design Spec

**Date:** 2026-08-05
**Status:** approved by the owner
**Splits:** master spec §11 Block 10 — this half ships the audit viewer and the WhatsApp integration screen; `entitlements` and the Company `pending` lifecycle are **Block 10b**, if the owner wants them at all
**Depends on:** Block 1b (`audit_logs`, `audit.view`), Block 5a (`integrations`), Block 8b (`has_permission_for` and the deploy order it established)
**Branches from:** `block-8b` — the migrations continue at `0129` and require `0121`–`0128`

---

## 1. What this block is for

Two things in this system have been written and never read.

**`audit_logs` has been collecting rows since Block 1b** — nine blocks of member
edits, role changes, prize movements, deliveries, erasures, and now every report
export — and **nothing in the product can display one**. The `audit.view`
permission has existed just as long and grants access to a screen that does not
exist. Block 8b sharpened this into a real gap rather than a tidy one: it
deliberately shipped no `reports.export` permission on the argument that *the
trail is the control*, which is only true if somebody can read the trail.

**`integrations` has no write path at all.** Block 5a created the table, gave it
RLS with **no policies**, and left `service_role` as the only thing that can
touch it. Connecting a new radio to WhatsApp today means writing SQL by hand
against production. There is no screen, no RPC, and no way for the person
operating the platform to see why a Station receives no messages.

---

## 2. What was found before the block was scoped, and what it changed

Half of §11's Block 10 is already built, and saying so is what makes this block
small enough to review:

| §11 asks for | state |
| --- | --- |
| Enable/block Companies and users | **partly built** — `/admin/customers` provisions and suspends |
| Company `pending` → enabled | **does not exist**; `company_status` is `('active','suspended')` and `provision_customer` creates an active Company |
| `entitlements` | **does not exist** |
| WhatsApp webhook configuration | **table exists, nothing writes it** |
| Audit viewer | **does not exist** |
| Org admin: Companies, invitations, roles/permissions | **shipped in Blocks 1b/1c** (`/team`, `/roles`) |

The owner's ruling: this block takes **the audit viewer and the integration
screen** — the two with real accumulated debt. `entitlements` and the `pending`
lifecycle are deferred, and the `pending` state may turn out to be unnecessary
rather than missing: an administrator provisions every customer by hand, so the
Company is enabled by an admin action at birth, and a separate pending state
would only earn its keep if customers could self-register.

---

## 3. Decisions

### D1 — The audit listing is `SECURITY INVOKER`, so the two policies that already exist keep applying

`audit_logs` carries exactly the right rule already:

```sql
audit_logs_select_admin  →  is_platform_admin()
audit_logs_select_org    →  organization_id is not null
                            and has_org_permission('audit.view', organization_id)
```

A `SECURITY DEFINER` listing would have to restate both by hand, and this is the
one table in the schema where restating them wrong is least likely to be
noticed: the screen would still render, still paginate, and still look like an
audit trail. `0095_list_pickups.sql`'s header records a second permission term
lost for five commits in exactly that way, and Block 8a's D4 settled the general
rule — **in a count, including a row the caller could not read looks like a
number, not like a leak.** An audit viewer is a count of what happened.

So the listing runs as the caller and the policies do the work. This is a
departure from every other list RPC in this codebase, and the departure is the
point.

### D2 — The actor is two columns, and the second one is not decoration

`actor_id` is nullable, and `actor_name` resolves through `public.profiles.full_name`,
which is **also** nullable. `0096_list_movements.sql` paid for this distinction
already and states it plainly: a null name does not mean "the system did it" —
it equally means a real operator who never set a display name. **Only a null
`actor_id` means the clock.**

So both ship on every row, the screen labels "(system)" off `actor_id` alone,
and — as 0096 also settled after review — **no `coalesce` onto an e-mail**.

### D3 — `detail` renders as JSON, and the action code gets a lookup with a fallback

There are dozens of action codes and there will be more. Two options were
considered:

- A renderer per action, turning each `detail` into a sentence. It reads better
  and it rots silently: an action added by a later block gets no branch and
  renders as nothing, which in an audit viewer is indistinguishable from an
  event that carried no detail.
- The raw `jsonb`, formatted, in an expandable cell.

**The second, with one concession:** the *action code* gets a human label from a
lookup table in TypeScript, falling back to the raw code when it is not there.
An unknown action then reads as `winners.reopen_deadline` rather than as blank —
ugly, honest, and self-announcing. The `detail` itself is never summarised,
because summarising is exactly where an audit viewer would start lying.

### D4 — No export, and the reason is not "later"

Block 8b built the export engine and its spec explicitly excluded the audit
trail. Adding `AUDIT` as a sixth listing type would be cheap now. It is deferred
anyway, because **exporting an audit trail is itself an audited event**, and the
recursion is a decision rather than a detail: who may take the record of what
everyone did, out of the system, into a spreadsheet. That belongs with Block 11's
retention work, where the whole question of how long the trail lives is already
open.

### D5 — The integration screen writes identifiers, never secrets

`WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_ACCESS_TOKEN` are
**installation-wide environment variables**. One Meta app serves every Station;
each Station carries only its own `phone_number_id` and `waba_id`.

The screen writes exactly that per-Station set — `phone_number_id`, `waba_id`,
`display_phone_number`, `enabled` — and no secret ever enters the database.

**It does show whether each of the three secrets is configured**, as a boolean,
never a value. That is not a nicety: the screen's real job is answering "why does
this radio receive no messages", and "the access token is not set" is half the
answers.

Per-Station Meta credentials were considered and rejected for this block. They
are what a radio needs to own its own WhatsApp Business account rather than use
the platform's, and they cost an entire secrets subsystem — encryption at rest,
rotation, who may read — plus a webhook signature check that becomes per-Station
where it is a constant today.

### D6 — The two unique indexes are the error taxonomy, and they already exist

`0057` shipped both, and the screen inherits its refusals from them rather than
re-checking anything:

- `integrations_number_live` — unique `(provider, phone_number_id)` where live.
  **This is a correctness constraint, not hygiene**: the webhook routes an
  inbound message by `phone_number_id`, so two Stations sharing one would be
  ambiguous in a way that silently delivers a listener's message to the wrong
  radio.
- `integrations_one_per_company` — unique `(company_id, provider)` where live.

Both raise `23505`, and the screen tells them apart by constraint name.

### D7 — The integration screen is in the platform admin console, and the audit viewer is not

§11 puts webhook configuration under the *Administrator (App owner)* console and
the audit viewer under *org admin*, and that split follows from D5: the
credentials are the platform's, so the configuration is the platform's. The
audit trail is the Organization's own record of itself.

So: `/admin/integrations` behind `is_platform_admin()`, and `/audit` in the app
behind `audit.view`.

### D8 — Every integration write is audited

Which closes the loop the block is named for: the one screen that changes how a
Station reaches its audience leaves rows in the other screen.

---

## 4. The two screens

### 4.1 `/audit` — `audit.view`, Organization-scoped

Columns: when, actor (name + "(system)" when `actor_id` is null), action, target
table, target id, Station, succeeded, detail.

Filters: actor, action, target table, Station, date range, succeeded. Keyset
pagination on `(created_at, id)` — `id` is `bigint` here, not a uuid, which is
the one place this listing's cursor differs from every other in the codebase.

`total_count` comes back from the same CTE the rows do, the rule 0090 set.

### 4.2 `/admin/integrations` — platform admin

One row per Station that has an integration, plus every Station that does not,
so connecting a new radio starts from the list rather than from knowing an id.
Fields per D5. A panel at the top states which of the three installation-wide
secrets are configured.

---

## 5. Migrations

| # | contents |
| --- | --- |
| `0129` | `list_audit_logs` — `SECURITY INVOKER`, keyset, `total_count` |
| `0130` | `list_integrations`, `upsert_integration`, `disable_integration` — `SECURITY DEFINER`, `is_platform_admin()`, each writing `audit_logs` |

---

## 6. Verification

**pgTAP** — `list_audit_logs` is `SECURITY INVOKER` (asserted on `prosecdef`,
because the whole of D1 rests on it); the keyset does not repeat a row across
pages with a `bigint` cursor; `total_count` agrees with the rows; the three
integration RPCs refuse a non-admin with `42501`; a duplicate
`phone_number_id` raises `23505` on `integrations_number_live` and a second
integration for one Station on `integrations_one_per_company`; every write leaves
an `audit_logs` row.

**Isolation suite** — a user holding `audit.view` in Organization A sees no row
of Organization B, **including rows with a null `organization_id`**, which the
policy excludes and which a `SECURITY DEFINER` rewrite would have included; a
user without `audit.view` sees nothing at all rather than an empty page; a
non-admin cannot call any integration RPC.

**Vitest** — the action-label lookup falls back to the raw code; the actor label
says "(system)" for a null `actor_id` and not for a null name.

**Playwright** — an owner opens `/audit`, filters by action, and sees a row that
a fixture wrote; an admin connects a Station on `/admin/integrations` and the
resulting audit row appears in the viewer.

**The gate is the usual one:** `lint`, `typecheck`, `test`, `db:test`,
`test:isolation`, `build`, `test:e2e`.

---

## 7. Out of scope

`entitlements`; the Company `pending` lifecycle; per-Station Meta credentials;
exporting the audit trail; audit retention (Block 11 owns it, and it is the
right place for both).
