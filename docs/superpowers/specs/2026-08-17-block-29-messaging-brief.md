# Block 29 — Messaging & Bulk Campaigns: adapted brief

**Status:** brief, not a design spec. This is the owner's original request rewritten
in this codebase's own terms — what already exists, what actually changes, and the
decisions that must be settled before a design spec is written.

**Rule that governs the whole document:** nothing here creates a parallel
architecture. Where this project already solved a problem — a queue, a retry
ladder, a consent record, a Station picker, a scheduler, a retention sweep — the
new module uses it. Every section below names the existing thing first.

---

## 0. Vocabulary correction

The original request says "empresa/tenant" and "emissora". This system has **two**
tenant levels and the words are not interchangeable:

| Request said | This system means | Table |
|---|---|---|
| empresa / tenant | **Organization** — the group | `organizations` |
| emissora / Station | **Station** — one radio | `companies` |
| ouvinte | **Member** — Organization-scoped, visible per Station | `members` + `member_company_links` |

A Member belongs to an Organization and is *linked* to the Stations that may see
them. Campaigns are therefore **Station-scoped** (a `company_id`), audience
resolution runs over `member_company_links`, and "tenant isolation" means both
levels, not one.

---

## 1. Menu changes (Part 1 of the request)

### What exists

`src/lib/auth/shell.ts:371-396` declares the section:

```
key: 'templates'          // NOT the label — see below
label: t('templates')
items:
  /templates/messages   t('messages')    ICONS.message
  /templates/whatsapp   t('whatsapp')    ICONS.megaphone
```

`/templates/messages` edits the ten bot texts (`station_message_templates`, 0109)
plus the service hashtags. `/templates/whatsapp` is the approved-template registry
(`message_templates`, 0110) and currently also carries the pairing card.

### What changes

**D6 + D7 — SETTLED (2026-08-17, owner). Five items, and the routes move once,
into `/messages/`.**

| Label | Route | Was |
|---|---|---|
| Section **`Messages`** | — | label `Templates` |
| `Promo Messages` | `/messages/promo` | `/templates/messages` |
| `Templates` | `/messages/templates` | `/templates/whatsapp` |
| `Bulk messaging` | `/messages/campaigns` | new |
| `Schedules` | `/messages/schedules` | new |
| `Message History` | `/messages/history` | new |

The two existing screens change address **once**, in 29a, so the module is built in
its final home and nothing is moved twice. `/templates/messages` and
`/templates/whatsapp` answer a permanent redirect. No tabbed container: Block 20b's
report calls the `?tab=` shortcut the error of that block, and 20c replaced it with
real routes — three list screens are three routes.

**What the route move drags with it**, and each is a place this project has been
bitten before: `revalidatePath` calls in both `actions.ts` files; the `action=` and
`href=` of every `StationSearchForm` and `stationSwitchHref` on both pages; the e2e
suite's navigation specs (`tests/e2e/nav-content.spec.ts` and `tests/e2e/nav.ts`);
and `docs/PERMISSIONS.md`. A redirect that exists but a `revalidatePath` still
naming the old path is the worst of the set: the write reaches the database and the
screen re-renders the value it had before, so the operator reads a successful save
as a refused one. That exact combination has already cost this project a debugging
session against a console that denied a save Postgres had accepted.

**Trap this project already documented.** `NavSection.key` is `'templates'` and
must NOT be renamed to `'messages'`. `src/components/layout/sidebar-nav.tsx:26-38`
states the reason in full: the disclosure cookie is keyed on `key`, so renaming it
silently collapses every operator's sidebar and forgets every expansion. The
**label** is `t('templates')` and is what changes — in `messages/en.json`,
`messages/pt.json` and `messages/es.json`, all three.

**Icons.** Five items in one section means five distinct glyphs. `message` and
`megaphone` are taken; three new paths are needed, and `shell.ts`'s own comments
record the rule they must satisfy — no glyph repeated on adjacent rows of the same
section, because one icon on two rows reads as one link rendered twice.

---

## 2. WhatsApp pairing — corrected (Part 3 of the request)

### The request, and why it cannot be executed literally

The request says: move "Connect WhatsApp Business" to **Stations → WhatsApp tab**.
That tab exists — `src/app/(admin)/admin/stations/integration-tab.tsx` — but it
lives under `src/app/(admin)/layout.tsx`, which redirects anyone failing
`is_platform_admin()` straight to `/app`.

Today the pairing card is rendered at `(app)/templates/whatsapp/page.tsx:152-154`
under `isStationOwner(...)`. **Moving it to `/admin/stations` would take pairing
away from the Organization owner and hand it exclusively to the platform
operator.** The owner has confirmed this must not happen.

### What actually happens

The card moves *off* the Templates screen and into a **Station settings screen in
the member area**, owner-gated, with a **WhatsApp** tab — the reading the request
intended ("o pareamento pertence à empresa"), with the audience the owner requires.

- One shared `<ConnectWhatsAppBusiness>` component, rendered in **two** places:
  the owner-facing Station settings tab, and the platform console's existing
  `IntegrationTab` (which already shows `phone_number_id`, `waba_id`, enabled
  state). One component, two hosts — not two copies.
- The owner's tab shows pairing status read-only. It does **not** gain the
  credential-editing controls: `integrations` deliberately stores no secrets
  (0130's D5/D7), and the three WhatsApp secrets are installation-wide
  environment variables, so there is nothing per-Station for an owner to edit.
- `embeddedSignupUrl(env.WHATSAPP_EMBEDDED_SIGNUP_URL)` and its https-only guard
  travel unchanged.

**D1 — SETTLED (2026-08-17, owner). A `Settings` button on each card in
`/app` ("Your stations"), opening the Station record as a modal with tabs.**

`(app)/app/page.tsx` already renders one card per Station with name, status,
timezone, band, frequency and address. Each card gains a **`Settings`** button,
shown only when `is_owner_of_company` (0044) is true — the same predicate
`isStationOwner` already uses, and the same one that lets the platform admin reach
it on a customer's behalf, which `templates/permissions.ts` records as intended
rather than a leak.

The button opens a modal mirroring `(admin)/admin/stations/station-record-dialog.tsx`
— the house pattern for a record with tabs, also used by Block 23's five-tab prize
record. **First tab: `WhatsApp`**, holding the shared `<ConnectWhatsAppBusiness>`
and the pairing status read-only (`display_phone_number`, `waba_id`, enabled). No
listing route is added: `/app` already is the listing, and a second one would
duplicate it.

This also gives the next per-Station setting somewhere to live, which the
alternatives did not.

---

## 3. Templates (Parts 2, 3 and 4 of the request)

### What exists

`message_templates` (0110) — one row per **approved Meta template**, keyed
`(company_id, purpose)` unique where `deleted_at is null`. Columns: `purpose`,
`name`, `language`, `body`, `variables` (ordered jsonb array of meanings),
`created_by`, timestamps. RLS select on `templates.view`; the four write doors in
0113 are SECURITY DEFINER and re-check `templates.manage`. 0165 added the OTP
button flag.

`template_purpose` enum: `PICKUP_REMINDER` (0110) and `WEB_VERIFICATION` (0160) —
**these are exactly the two system categories the request asks for.** They already
exist and are already undeletable in the only sense that matters: they are enum
values, not rows.

### Three things the request changes, each a documented reversal

**3.1 — "The two system categories must come with every new Station."**

0110's design is deliberately *no row until somebody registers one*: an absent row
means "this Station sends nothing", and 0109's sibling comment explains the same
choice — required rows make a missing one a silence a listener experiences and
nobody sees.

**D2 — SETTLED (2026-08-17, owner). Rendered from the enum. No seeded rows.**

The two categories are constants of the system and always **render** on the
Templates screen for every Station, from the enum, in a `Not registered — nothing
sends` state — which the screen already does today (string
`notRegisteredNothingSends`). Nothing is seeded, nothing is backfilled, and neither
can be deleted because neither is a row. That is what "já vem no sistema quando se
adicionar uma nova Station" means here, and 0110's design survives intact.

The reason a seeded row would be actively worse, not merely redundant: a body only
sends if Meta approved **that exact name** on **that WABA**. A seeded row asserts a
registration that does not exist on Meta's side, so the send **fails** instead of
not happening — and a failure is what an operator reads as a broken product, while
`Not registered — nothing sends` is a state the screen already explains.

The Templates grid therefore has two groups: **System** (the two enum categories,
never deletable, one registration each — the existing unique index) and
**Marketing** (everything the operator creates, `purpose is null`, unbounded).

**3.2 — Status, and creation through Meta's API.**

`message_templates`' own table comment forbids a status column, and gives the
reason: *"this system records what the operator was told at registration and
cannot know whether Meta still approves it, so a status here would look like live
truth and would actually be a memory."*

The request asks for `Draft | Pending | Approved | Rejected | Paused | Disabled`
plus submission and status sync. **This resolves 0110's objection rather than
ignoring it** — but only if the sync is real. A status column added *without* a
working sync reintroduces exactly the lie 0110 refused.

So the status column ships **with** the sync, or not at all:

- Creation/submission: `POST /{waba_id}/message_templates` on the Graph API.
- Status: the `message_template_status_update` webhook, and a reconciliation read
  on the existing tick as a backstop.
- The screen keeps a **manual registration** path for templates approved out of
  band in Meta's console — that is how every existing template got here, and
  removing it would strand the two system categories on installations whose token
  lacks the management scope.

**Open decision D3 — a blocker.** Template management on the Graph API requires
`whatsapp_business_management` on the **tenant's** WABA. This installation holds
one installation-wide `WHATSAPP_ACCESS_TOKEN` (0057's header, 0130's D5). Whether
that token carries the scope over WABAs onboarded through Embedded Signup must be
verified against the live Meta app **before** this half is designed — not
assumed. If it does not, submission is out of scope and the screen stays a
registry with a manual status field, plainly labelled as a record and not a fact.

**3.3 — One template per purpose becomes many templates per Station.**

`message_templates_purpose_unique` is `(company_id, purpose)`. Bulk messaging needs
many marketing templates per Station. So:

- `purpose` becomes **nullable** — a marketing template has no system purpose.
- The unique index narrows to `where deleted_at is null and purpose is not null`,
  preserving the "one registered template per system purpose" guarantee that
  `enqueue_whatsapp_outbound` (0111) resolves against, without capping the rest.
- New columns: `channel`, `category`, `description`, `status`, `meta_template_id`,
  `rejection_reason`, `header`, `footer`, `buttons`, `updated_by`.
- `variables` already exists and already carries per-position meaning. **Variable
  mapping to CRM fields extends that column** rather than adding
  `message_template_variables` — the request's §22 offered either.

**Email templates.** Same table, `channel = 'EMAIL'`, with `subject`,
`from_name`, `from_email`, `reply_to`, `body_html`, `body_text`. Channel-specific
columns nullable and constrained in pairs — the shape `outbox_messages_template_shape`
(0111) and `outbox_messages_sent_shape` (0059) already use throughout this schema:
a row names all of a channel's fields or none of them. A separate
`email_template_details` table is not worth the join for one channel's worth of
columns; if a third channel arrives with a large field set, that is when it splits.

---

## 4. Consent and opt-out (Parts 7, 18, 19 of the request)

### What exists — and what must NOT be built

The request proposes a new `communication_preferences` table. **This project
already has one**, and it is better shaped than what was proposed:

`member_consents` (0032) — append-only, per Station, `granted boolean`,
`granted_at`, `origin`, `promotion_id`, `recorded_by`. *"A withdrawal is a new
row, not an edit."* Enum `member_consent_type`: `rules`, `image_use`,
`sponsor_communication`.

### What changes

- Two enum values: **`whatsapp_marketing`** and **`email_marketing`**. Per-channel
  by construction, which is precisely §18's requirement that an email opt-out must
  not block WhatsApp.
- Opt-out is a new row with `granted = false`. Latest row per (member, company,
  type) wins — the same "latest consent" resolution `listOrganizationMembers`
  already implements for its `hasRulesConsent` filter.
- **`member_blocks` (0032) is honoured too.** An active `suspension` bars a Member;
  `members_blocked_bulk` (0036) is the set-at-a-time predicate and is already
  written for exactly this shape of question.
- `members.anonymized_at` is an absolute bar. An erased Member is never a
  recipient.

### Unsubscribe link

Mirror `widget_link_tokens` (0178, retention in 0183): a random token stored
hashed, never an internal id in the URL, with its own expiry and its own retention
sweep. The public route lands in `(public)`, records the event, writes the
`granted = false` consent row with `origin` naming the campaign, and is rate
limited through `src/lib/rate-limit`. Block 11c's per-IP limiter trap applies.

---

## 5. Audience selection (Part 6 of the request)

### What exists

`listOrganizationMembers` (`src/services/members.ts:471`) with keyset pagination
(`src/lib/keyset.ts`), exact totals, and filters: free-text search, age range
(converted to a `birth_date` range, never a per-row age), `blockedOnly`,
`hasRulesConsent`, registration date range, sort and direction.

`members` columns available as filters: `city`, `state`, `country` (0213,
two-letter, constrained), `neighbourhood`, `postal_code`, `birth_date`,
`discovery_source`, `first_contact_at`, `created_at`, plus Station via
`member_company_links`.

### What the request asks for that does not exist

| Requested filter | Reality |
|---|---|
| Sexo / gender | **No column** — and its absence is a recorded decision (Block 4a, spec D5), not an oversight. Reversed by the gender block, §5b. |
| Tags / grupos | **No table.** Nothing in this schema groups Members. |
| Data da última interação | Derivable from `participations` / `music_requests` / conversation, but **no maintained column** — it is a join, and an expensive one over a large audience. |

**D4 — SETTLED (2026-08-17, owner), then REOPENED and split the same day.**

Gender and tags were first treated as one deferred item. They are not the same
kind of thing and have been separated:

- **Gender is structural and urgent.** It is a question the conversation must ask,
  which makes it a `promotion_requested_field`, a `system_message_key`, a
  `members` column and a normaliser — not a form field somebody adds later. It
  gets **its own block, fully specified in §5b below**, sequenced before 29d.
- **Tags/groups stay deferred, unhurried.** Nobody asks a listener for a tag: it is
  a label an operator applies, it never passes through the conversation, and it
  touches no engine. Its own block, no ordering constraint against Block 29.

29d ships the audience filter over **what exists at the time it is built**: Station
link, city, state, country, neighbourhood, age range, birthday month, registration
date range, consent state, block state, free-text search — plus gender, if its
block has landed. The filter is a `MemberListParams` extension, built so a new
criterion drops in without reshaping it.

"Última interação" stays out for a different reason: it is a join, not a column,
and an expensive one across a large audience. Wanting it means wanting a maintained
column, which is the tags block's kind of work, not this one's.

### Non-negotiable

Filtering, counting and recipient resolution run **in the database**. The frontend
sends filter criteria and receives a count and a page — never the audience. This is
already how every list screen in this project works.

---

## 5b. Gender as a listener field — its own block, before 29d

Not part of Block 29, and not a column somebody adds to a form. It is a question the
conversation asks, so it lands in five places the compiler already guards together.

### This reverses a recorded decision, and the spec must say so

`0040_promotions.sql:13-15`, in the enum's own comment:

> *"Three fields the owner's old system offered — **gender**, favourite station,
> favourite show — are deliberately absent (spec D5); they have no column and will
> not get one."*

Block 4a's D5 excluded it on purpose. **The reason has since changed**: when D5 was
written this product had no segmented outbound messaging, so a gender column
answered no question anybody could ask. Block 29 creates that question. The
reversal is legitimate and must be written down as a reversal — this project pays
for decisions undone in silence.

`favourite station` and `favourite show` are **not** reopened. D5 stands for both.

### The precedent to copy exactly: `country` (Block 28, D10)

A ninth requested field was added five weeks ago, and the path is documented:

| Piece | `country` (0213) | `gender` |
|---|---|---|
| Column | `members.country`, `check ~ '^[A-Z]{2}$'` | `members.gender`, `check in ('M','F','N')` |
| Normaliser | `country_alpha2(text)` — `IMMUTABLE`, `EXECUTE` to nobody | `gender_normalize(text)`, same shape |
| Write point | `apply_member_field_values` (0213) — one function, shared by the conversation **and** the widget | one more `coalesce(...)` arm |
| Read point | `member_field_value`'s `when 'country' then m.country` | one more `when` arm |
| Failure mode | null from the normaliser → `coalesce` leaves the old value | identical |

0213's own sentence is the rule for both: *"an unrecognised answer must cost the
answer, never the participation."* A gender the normaliser cannot resolve is a
gender not recorded — never a refused entry, never an abandoned conversation.

### D8 — SETTLED. Targeting only. Not eligibility.

The promotion stays open to everyone; what gender segments is **who the campaign is
sent to**. Nothing in participation or the draw changes.

This matters more than it looks: **no attribute-based eligibility rule exists
anywhere in this system today.** `promotions` carries no minimum age and no
restriction of any kind, and `draw_eligible_participations` (0076) is the single
definition of who is in the hat — its own comment refuses to let a second definition
exist. Gender eligibility would be the first rule of its kind, would have to decide
*when* it refuses (at consent, after asking, or only at the draw), and would touch
0076, `run_draw` (0078) and `apply_participation` (0054). **Deferred with its cost
written**, not omitted.

### D9 — SETTLED. Three values, and `NULL` means something different from all three.

```
members.gender text check (gender is null or gender in ('M','F','N'))

  M    masculino
  F    feminino
  N    prefiro não informar   — asked, and declined
  NULL never asked
```

`N` and `NULL` are deliberately distinct populations, and the campaign filter
exposes both. A forced binary produces noise; an explicit decline produces a fact.
Three values also fit the Cloud API's three-button limit exactly
(`MAX_BUTTONS`, `interactive.ts`), which the next decision needs.

### D10 — SETTLED. Asked with buttons, as a **field shape** — not as a special case.

Today every field is text: `promptFor`'s `case 'field'` returns `{ kind: 'text' }`,
and `fieldTurn` opens with `if (message.kind !== 'text') return failure(...)`. A
button reply to a field is currently refused, and three refusals abandon the
conversation.

So the field path learns a **shape**, `text | choice`, total over `RequestedField`
the way `FIELD_PROMPTS` and `FIELD_MESSAGE_KEYS` already are — **not**
`if (field === 'gender')`. Gender is the first choice-shaped field; the next one
reuses the shape rather than adding a second special case.

**The normaliser is still mandatory, and this is the point that decides the
design.** WhatsApp leaves the keyboard open beneath the buttons, so a listener who
types "masculino" instead of pressing must be accepted — otherwise the conversation
dies on a field that is optional by design. Buttons are UX **on top of** the
normaliser, never instead of it:

```
button reply  -> optionId          -> 'M' | 'F' | 'N'
typed text    -> gender_normalize() in SQL -> 'M' | 'F' | 'N' | null
null          -> coalesce leaves the column alone; the entry proceeds
```

**Known asymmetry, carried as declared debt.** `station_message_templates` (0109)
holds one body per key, so a Station can reword the **question** and not the three
**option labels**. The labels ship as system constants in this block. Extending
0109's override schema to carry option labels is recorded as a follow-up with its
cost, not left to be discovered.

In the widget the field is a `<select>` — closed by construction, no engine
involvement, and it reaches the same `apply_member_field_values`.

### LGPD

Gender is **not** in Art. 5º II's sensitive-data list — that list names "vida
sexual", which is not the same thing as sex or gender. It is ordinary personal
data, and the legal basis is consent, which is already this project's typed pattern
(`member_consents`, Block 3). The field is optional in every sense: the promotion
decides whether to ask, `N` lets the listener decline, and an unresolvable answer
costs nothing.

The article that would matter is **Art. 6º IX, non-discrimination** — and it bites
on **eligibility**, not on targeting. D8 keeps this block clear of it. The block
that eventually opens eligibility must engage with it directly, and record on the
promotion why the restriction exists.

`anonymize_member` (0034) must clear this column with the rest of the record.

### What the block touches

Column and normaliser; `promotion_requested_field` += `gender`; `system_message_key`
+= `GENDER`; `FIELD_PROMPTS`, `FIELD_MESSAGE_KEYS`, `SYSTEM_MESSAGE_DEFAULTS` and
the new `FIELD_SHAPE` (the compiler refuses all four if any is missed);
`apply_member_field_values` and `member_field_value`; `promptFor` and `fieldTurn`;
the promotion form's field checkboxes (`whatsapp-fields.tsx`, `schemas/promotions.ts`,
`services/promotions.ts`); the widget's identify form; the Member record form and
its create/update doors; a card on the Promo Messages screen for the `GENDER`
override; `listOrganizationMembers` and `MemberListParams`; the LISTENERS report;
`anonymize_member`; i18n ×3.

**The trap that applies to four of those functions:** `apply_member_field_values`,
`member_field_value`, `create_member` and `update_member` are all recreated by this
block. Recreating one from the body in its **original** migration silently reverts
every fix applied to it since — this project has paid for that exact mistake. The
live definition is what gets copied forward.

---

## 6. Campaigns, queue and workers (Parts 5, 8, 11, 13, 14, 24)

### The model to copy

`report_runs` (0122) — **queue and history in one table**, and its header explains
why in terms that transfer exactly: *"A finished run is exactly a queued run with
an outcome, and the two questions an operator asks — 'is it ready?' and 'what did I
export last month?' — are one query against one table."*

That is the campaign table. `QUEUED | RUNNING | READY | FAILED` becomes the campaign
status set; `filters jsonb`, `attempts`, `last_error`, `started_at`, `finished_at`
all carry over unchanged in meaning.

### Why the recipient table is the queue

`message_campaign_recipients` is **both** the §13 snapshot and the send queue.
One row per recipient carrying `campaign_id`, `member_id`, `channel`, the phone or
email **as resolved at snapshot time**, the variable values used, status, attempts,
`next_attempt_at`, `claimed_at`, provider message id, error code and description.

The snapshot requirement (§13) and the queue requirement (§11) describe the same
row. Splitting them would mean copying every recipient twice and keeping the copies
in agreement.

### Why not `outbox_messages`

`outbox_messages` (0059) is the right *pattern* and the wrong *table*:
`integration_id` is `NOT NULL` and references `integrations` — WhatsApp only;
`dedupe_key` is unique per provider and shaped around one reply per inbound
message; `prune_outbox_messages` nulls `to_phone` because there is **no
`member_id` to join on**, a limitation the new table does not have.

So the table is new and the **code is reused**: `src/services/whatsapp.ts` already
holds `OUTBOX_BATCH`, `BACKOFF_SECONDS = [1, 4, 16, 64, 256]`, `MAX_ATTEMPTS`,
`STALE_CLAIM = '5 minutes'`, `PARKED_AT = 'infinity'` and the consecutive-retryable
circuit breaker, each with its reasoning written down. The claim is
`for update skip locked` over a partial index on the sendable status — `claim_outbox_batch`
(0063/0111) is the template, including the index-condition warning about which
statuses may appear in the predicate.

### Where it runs

A **fifth drain** on the existing tick, `src/app/api/worker/tick/route.ts`,
following the four already there: wrapped in its own try/catch so a failure shows
up as a standing count rather than a 500 that loses the other four, and reported
into `job_succeeded`'s counters. The tick's own header states the ordering
principle — *a listener waiting on a WhatsApp reply must not wait because somebody
exported a spreadsheet* — and a bulk campaign is the largest thing this tick will
ever do, so it drains **after** the conversation outbox, in bounded batches.

### The identity trap

Block 8b's report records it: the worker runs as `service_role` and **cannot call a
SECURITY INVOKER function**. Recipient resolution therefore happens either at
campaign creation as the caller (the `report_runs` panel-payload precedent, D2
there) or in a SECURITY DEFINER function that re-checks permissions in its own
body. It cannot be an invoker-rights aggregate the worker calls later.

---

## 7. Providers (Part 12)

`MessagingProvider` per channel, with the existing WhatsApp side reused whole:
`GraphTransport` / `FakeTransport` (`src/lib/integrations/whatsapp/`), the same
retryable-vs-permanent error taxonomy `graph.ts` already draws, and the same
`FakeTransport` discipline — with the trap that has already cost this project a
production investigation written into the design: **a fake that reports SENT for a
message nobody sent.** A campaign whose recipients all read `sent` against a fake
transport is indistinguishable, on every screen, from one that worked.

Email reuses `src/lib/mailer/index.ts` — the `Mailer` interface with `DevMailer`
and `SmtpMailer` is already the abstraction §12 asks for, already injected the same
way, already used by invitations, contact requests, data-deletion and the health
alert.

**D5 — SETTLED (2026-08-17, owner). One installation-wide SMTP transport;
sender identity per Station.**

`SmtpMailer` stays configured from installation-wide `SMTP_URL` + `MAIL_FROM`.
The **template** carries `from_name`, `from_email` and `reply_to`, so each Station
signs its own mail while one transport sends it. Three consequences, each of them
a thing the block must state rather than discover:

1. **No per-tenant credentials.** §20's per-tenant SMTP is deliberately not built.
   Credentials at rest mean encryption, rotation and an answer to "who may read
   it" — the exact scope `0130` declined to open for WhatsApp. Recorded as a later
   block, not as an omission.
2. **Deliverability rests on the installation's domain,** not on each radio's. SPF,
   DKIM and DMARC are the installation's to hold. A Station setting a `from_email`
   on a domain the installation cannot sign will land in spam, so the field needs a
   plain warning beside it — and a later block that adds per-tenant senders is what
   removes that warning.
3. **Email status is `queued | sent | failed`, and nothing else.** Plain SMTP emits
   no bounce, open, click or complaint callback, so §15's email half and §14's
   email status list are **out of scope**. The History screen shows the three
   states it can actually observe and says why — it does **not** render zeroes for
   opens and bounces, which would read as "nobody opened it" rather than "this is
   not measured". `message_delivery_events` still ships, populated by WhatsApp
   only; email joins it when a provider does.

Unsubscribe (§19) is unaffected: it is this system's own route and token, not a
provider callback, so it works identically under SMTP.

---

## 8. Schedules and the scheduler (Parts 9, 10)

### What exists

Two scheduling shapes, both already running under pg_cron, and the tick's header
explains when to use which:

- **`sweep_pickup_reminders` (0112)** — a `procedure`, scheduled directly by
  `cron.schedule` inside its own migration, called as plain SQL with no HTTP and no
  application code in the path. It commits **per winner**, because *one Station
  whose enqueue is refused must not roll back every other Station's reminders*.
- **the HTTP tick** — every ten seconds, secret-authenticated, for work that needs
  Node (a third-party HTTP call, a file, a transport).

Schedule evaluation belongs to the **first** shape: it is a SQL question ("which
schedules are due, which Members have a birthday today") and it must commit per
schedule for 0112's exact reason.

### Idempotency, which the request asks for and this project already has answers for

- `next_run_at` / `last_run_at` on the schedule row, claimed with
  `for update skip locked` — the mechanism `claim_outbox_batch` uses.
- A **unique key on (schedule_id, occurrence)** on the generated campaign, so a
  restart mid-generation cannot produce a second campaign for the same occurrence.
  This is `outbox_messages_dedupe_unique`'s lesson applied: *the constraint holds
  it, rather than the worker being careful* — and 0059's own header records how
  that key was once wrong in a way no test caught.
- Occurrence is computed in the **Station's** timezone (`companies.timezone`,
  already used by the Templates screen), not the server's. A birthday sweep on UTC
  fires on the wrong calendar day for part of every day.

---

## 9. Webhooks and events (Part 15)

`webhook_events` (0058) already ingests Meta's callbacks with
`(provider, external_id)` idempotency, hashed external ids, claim/reclaim and
payload pruning. Delivery statuses (`sent`, `delivered`, `read`, `failed`) arrive
on the **same** webhook the conversation already uses
(`src/app/api/webhooks/whatsapp/route.ts`), correlated by the provider message id
stored on the recipient row.

`message_delivery_events` from the request's §22 is a real addition — the per-event
history, append-only, feeding the aggregate columns on the campaign. Email events
exist only if D5 adopts a provider.

**The route trap, already paid for once:** both the webhook route and the tick route
are excluded from the middleware matcher, and the tick's header records what happens
when they are not — a 307 to `/login`, no error anywhere, and queues that silently
stop draining. Any new public route in this module inherits that checklist.

---

## 10. Cancellation (Part 17)

Three states, as requested. The one this schema makes easy: cancelling a running
campaign means marking pending recipients `cancelled`; rows already claimed and
in flight are not cancellable, and the request already says so. Recorded with
`cancelled_by`, `cancelled_at`, `cancel_reason` on the campaign, and an
`audit_logs` row from the SECURITY DEFINER door — the pattern every write door in
this project follows.

---

## 11. Permissions (Part 20)

New codes in the `permissions` catalogue (0010, extended with `module`, `label`,
`scope`, `display_order`), inserted by this block's own migration — *"a permission
is born beside the feature it guards"*. Company-scoped, checked with
`has_permission(code, company_id)`:

- `messaging.view` — see campaigns, schedules and history
- `messaging.manage` — create and edit campaigns, schedules and templates
- `messaging.send` — **separate**, because approving a send to twenty thousand
  people is not the same act as drafting one

`templates.view` / `templates.manage` (0109) keep the template screens.

Every door is SECURITY DEFINER with `set search_path`, re-checking the permission
in its own body — the boundary is in the database and hiding a link is a courtesy.

The standing open question about how broadly permissions should fan out across
modules is untouched by this block: three codes is the same shape every module
since Block 2 has used, and this is not the block that changes the pattern.

---

## 12. Retention and erasure — absent from the original request

`message_campaign_recipients` will hold a Member's phone number and email address
in the clear, in volume. This project has been bitten by exactly that once already:
0059's header records how `outbox_messages` outlived a listener's erasure request
because there was no `member_id` to join on.

Here there **is** one, so both mechanisms apply and both must be built:

- **`anonymize_member` (0034) must reach this table** — erasure is subject-driven
  and already exists.
- **`sweep_retention` (0131) must cover it** — installation-wide fixed periods, and
  0131's own file lists what it does and does not touch precisely so an absence
  reads as a decision. This table gets a line in that list either way.
- `docs/DATABASE.md` and `docs/SECURITY.md` are updated in the same block.

The known open item — the "anonymised listener" erasure branch that no screen or
door currently triggers — is **not** resolved by this block, and this block must not
quietly widen it by adding a second table full of contact details that erasure
cannot reach.

---

## 13. Interface (Part 21)

Every screen follows the house pattern, which is concrete here rather than generic:

- **The Station picker.** `listCompanyAccess(supabase, '<permission>', search)` +
  `StationSearchForm` + `stationSwitchHref` — the exact three-part pattern on
  `(app)/templates/whatsapp/page.tsx`, including the capped-list notice, the
  suspended-Station pills and the no-match screen.
- **Filters on top, keyset-paginated grid, Actions column**, `Card`/`CardContent`
  from `src/components/ui`.
- **Modals for records**, per Block 23's five-tab prize record.
- **Real routes, not `?tab=`.** Block 20b's report calls the query-string shortcut
  the error of that block; Block 20c replaced it with three real routes.
- **Controlled filter checkboxes.** A checkbox bound directly to server state
  unticks itself the moment it is clicked, because the render that follows restores
  the old value. The songs screen still carries this defect; the audience filter
  must not add another instance of it.
- **`key` on conditionally-rendered buttons.** Two `<Button>`s rendered in the same
  position without distinct `key` props let React reuse the DOM node, and the
  survivor inherits `type="submit"` — which is how a participation was once
  recorded by a button nobody pressed. A confirm/cancel pair in a send dialog is
  exactly that shape, over twenty thousand recipients.
- **i18n in all three catalogs**, `en.json`, `pt.json`, `es.json`. Block 12c's
  §6.5 found 451 missing strings where the plan said 38. Operator strings in
  English; only what a **listener** reads is Portuguese, which for this module is
  the template bodies and nothing else.
- **Channel badges**, dark-mode aware (Block 25).

---

## 14. What this brief deliberately does not carry over

| Requested | Why not |
|---|---|
| `communication_preferences` table | `member_consents` (0032) already is one, append-only and per Station |
| `message_template_variables` table | `message_templates.variables` already carries ordered per-position meaning |
| Separate queue table beside recipients | The snapshot row *is* the queue row (§6 above) |
| New scheduler process | pg_cron already runs, in two shapes, both documented |
| New provider abstraction for email | `Mailer` / `DevMailer` / `SmtpMailer` already is one |
| "Messaging Campaigns" as a new top-level area | The section is the renamed `MESSAGES`, key unchanged |
| Gender and tag filters | Gender is its own block (§5b), specified and sequenced before 29d; tags are their own block with no ordering constraint |

---

## 15. Open decisions, in the order they block work

| # | Decision | Blocks |
|---|---|---|
| ~~D1~~ | ~~Owner-facing Station settings~~ — **SETTLED**: `Settings` button on each `/app` card, opening a tabbed record modal; WhatsApp is its first tab | — |
| ~~D2~~ | ~~System categories~~ — **SETTLED**: rendered from the enum, no seeded rows; grid splits System / Marketing | — |
| **D3** | Does the installation's Meta token carry `whatsapp_business_management` over onboarded WABAs? **Awaiting a probe against the live app** — the token exists only in production, in no local `.env`. Probe: `GET /v21.0/968641936128887/message_templates?limit=1` | 29b |
| ~~D4~~ | ~~Gender and tags~~ — **SETTLED, then split**: gender is its own fully-specified block (§5b) before 29d; tags stay deferred with no ordering constraint | — |
| ~~D8~~ | ~~Gender: targeting or eligibility~~ — **SETTLED**: targeting only; eligibility deferred with its cost written (§5b) | — |
| ~~D9~~ | ~~Gender values~~ — **SETTLED**: `M` / `F` / `N`, with `NULL` a distinct fourth population (§5b) | — |
| ~~D10~~ | ~~How the conversation asks~~ — **SETTLED**: interactive buttons via a total `FIELD_SHAPE`, with the normaliser underneath; option-label overrides are declared debt (§5b) | — |
| ~~D5~~ | ~~Email transport~~ — **SETTLED**: installation-wide SMTP, per-Station sender identity, email status limited to `queued/sent/failed` | — |
| ~~D6~~ | ~~Route move~~ — **SETTLED**: `/templates/*` → `/messages/*` in 29a, with permanent redirects | — |
| ~~D7~~ | ~~Sidebar shape~~ — **SETTLED**: five items, five real routes, no tabbed container | — |

---

## 16. Proposed sequence

| | Delivers | Depends on |
|---|---|---|
| **29a** | Section renamed to `Messages`, five items, routes moved to `/messages/*` with redirects, three new icons, i18n ×3; `Settings` button on `/app` cards opening a tabbed Station record whose first tab is WhatsApp; `<ConnectWhatsAppBusiness>` shared with the console | — |
| **29b** | Templates: `channel`, System/Marketing split, `purpose` nullable with narrowed unique index, email fields, variable mapping, status + Meta sync **subject to D3** | 29a |
| **29c** | `whatsapp_marketing` / `email_marketing` consent types, opt-out, unsubscribe token route, per-channel recipient validation | — |
| **29d** | Campaigns, audience resolution in SQL, recipient snapshot table that is also the queue, providers, fifth drain on the tick, Send Now | 29b, 29c, **gender block** |
| **29e** | Schedules: fixed date/time and event-based (birthday), pg_cron procedure committing per schedule, occurrence idempotency in the Station's timezone | 29d |
| **29f** | Message History, `message_delivery_events`, webhook correlation, cancellation, retention and erasure coverage | 29d |

**Outside Block 29, sequenced before 29d:** the **gender block** (§5b) — column,
normaliser, choice-shaped conversation field, promotion checkbox, widget select,
Member form, filter. It is independent of 29a, 29b and 29c, so it can run in
parallel with all three; only 29d waits on it.

**Outside Block 29, no ordering constraint:** the tags/groups block. Nobody asks a
listener for a tag, so it touches no engine and nothing in Block 29 needs it.

One design spec and one PR per pass, as every block since Block 1.
