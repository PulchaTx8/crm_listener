# Block 29b-1 — The multi-channel template registry

**Status:** design, approved section by section on 2026-08-17. The
implementation plan is written from this document.

**Parent:** `2026-08-17-block-29-messaging-brief.md`. That brief settles the
Block 29 decisions this one inherits — D2 (system categories render from the
enum, nothing is seeded), D5 (one installation-wide SMTP transport, sender
identity per Station), and the vocabulary correction that Station means
`companies`. Decisions numbered here are this block's own.

---

## 1. What this block is, and the line it does not cross

The Block 29 brief planned one pass called 29b: the registry, the Meta cycle and
the email shape together. Reading the terrain split it in two, and the line is
not arbitrary — it is `message_templates`' own table comment:

> *"this system records what the operator was told at registration and cannot
> know whether Meta still approves it, so a status here would look like live
> truth and would actually be a memory."*

**So status arrives with its synchronisation, or it does not arrive.** That
sentence is the whole boundary:

| | |
|---|---|
| **29b-1 (this)** | `channel`, the System/Marketing split, `purpose` nullable, email templates, the variable vocabulary, the screen. **No status column.** A template is registered or it is not, which is what is true today and stays true. |
| **29b-2** | The Graph management client, create and submit, the `message_template_status_update` webhook family, reconciliation — and only then a status column, as a synchronised fact. |

29d (campaigns) needs status to decide what may be sent, so it waits for 29b-2.
The order is 29b-1 → 29b-2 → 29c → 29d.

**29b-2's first task, recorded here because it gates that block and not this
one:** prove the POST. Block 29's D3 probed the live Meta app with a GET and
learned that the installation-wide token carries
`whatsapp_business_management`. A GET proves the SCOPE; Meta gates template
creation on the scope **and** on the system user's role over the asset, and a
viewer can list templates it may not create. Nothing in 29b-1 depends on the
answer.

---

## 2. Decisions

| | Decision |
|---|---|
| **D1** | One table for both channels. Not one table per channel. |
| **D2** | Email bodies are **plain text rendered into a Station-branded frame**. No arbitrary HTML enters the system. |
| **D3** | A closed vocabulary of substitutable values, as a database enum, covering both the campaign-resolvable family and the caller-supplied one. |
| **D4** | The email sender identity lives on the **Station**; a template may override it. |
| **D5** | Two write doors: the system half upserts by purpose, the marketing half writes by id. |
| **D6** | No cursor pagination on the marketing list. |

### D1 — one table, and the reason is 29d rather than the join

`message_templates` carries both channels, with a `channel` column.

What decides it is not saving a join. It is that a campaign points at **one**
template and must not use the wrong channel's. With one table and a `channel`
column, "the campaign's channel equals its template's channel" is a foreign key
and a CHECK. With two tables a campaign needs either two nullable foreign keys
or a polymorphic reference, and that rule stops being expressible in the schema
at all — it becomes a sentence in application code that the database cannot
hold.

### D2 — plain text, rendered into a frame

The original request asked for an HTML body *and* for messages "compatible with
email clients". Those pull apart: email HTML is not web HTML, and an editor that
produces browser markup produces mail that Outlook deforms.

The operator writes **text**. The system renders it into **one** frame carrying
the Station's logo and name. Consequences, each of them the point:

- **No sanitiser, no editor dependency, no XSS surface.** This codebase uses
  `dangerouslySetInnerHTML` nowhere and has no HTML sanitiser; that stays true.
  Nothing untrusted is ever interpreted as markup.
- **What is sent is always the same frame**, so it renders the same way
  everywhere, and a rendering complaint is about one artefact rather than about
  whatever an operator pasted.
- **The cost, stated:** a Station wanting its own layout cannot have one. If
  that is ever wanted, it is a block that adds a second frame — not a field that
  accepts markup.

### D3 — see §4.

### D4 — see §6.

### D5 — see §7.

### D6 — no cursor pagination

A Station has tens of templates, not thousands. The marketing list is ordered
and whole, with a notice if it is ever cut — the same honesty the Station picker
already prints. Keyset is the fix the day a Station has hundreds, and this
paragraph is the note that says so rather than leaving the absence to be read as
an oversight.

---

## 3. The schema

### `message_templates`, changed

| Column | Today | After |
|---|---|---|
| `channel` | — | `public.message_channel` NOT NULL — `WHATSAPP` \| `EMAIL` |
| `purpose` | NOT NULL | **nullable**. Null means marketing. |
| `name` | NOT NULL | required only for `WHATSAPP` |
| `language` | NOT NULL | required only for `WHATSAPP` |
| `body` | NOT NULL | unchanged — it serves both channels, because it is the words either way |
| `subject` | — | required only for `EMAIL` |
| `internal_name` | — | NOT NULL. With many templates, Meta's name is not how an operator finds one. **A system template gets it from `name`** — see §7; that door takes no label because a system card is titled by its purpose and there is nothing else for an operator to call it. |
| `description` | — | nullable |
| `from_name`, `from_email`, `reply_to` | — | nullable **always** — overrides of what the Station declares (§6) |
| `variables` | `jsonb` of prose | `public.template_variable[]` (§4) |
| `updated_by` | — | `uuid references auth.users (id)` — the grid shows who last changed a template |

### The conditional pairs

Written as CHECK constraints in the shape this schema already uses three times
(`outbox_messages_template_shape`, `_sent_shape`, `_retention_shape`): a row
names all of a channel's fields or none of them.

```
message_templates_whatsapp_shape
  channel <> 'WHATSAPP'  or (name is not null and language is not null)

message_templates_email_shape
  channel <> 'EMAIL'     or (subject is not null and btrim(subject) <> '')

message_templates_email_no_meta_fields
  channel <> 'EMAIL'     or (name is null and language is null)
```

The third is not tidiness. Without it an email template may carry a `name` and a
`language`, and every screen and query that reads "is this registered at Meta"
gains a row that answers yes and is not.

### The unique index, narrowed

```sql
create unique index message_templates_purpose_unique
  on public.message_templates (company_id, purpose)
  where deleted_at is null and purpose is not null;
```

Without `and purpose is not null`, every marketing template in a Station
collides with every other on "purpose is null". **This index is also an
`ON CONFLICT` target — see §7, which is where the consequence lands.**

### `enqueue_whatsapp_outbound` (0111) gains one term

Its lookup is `where company_id = … and purpose = p_template_purpose and
deleted_at is null`. It gains **`and channel = 'WHATSAPP'`**.

Without it, the day somebody registers an email template carrying a system
purpose, the pickup reminder resolves it and tries to send an email through the
Cloud API. Recreated from its **live** definition, not from 0111's body.

### The backfill is one row

Production holds exactly one `message_templates` row: `pulchtx_widgetcode`,
`WEB_VERIFICATION`, `variables = ["Código de verificação"]`. It becomes
`channel = 'WHATSAPP'`, `internal_name = name`, `variables =
'{VERIFICATION_CODE}'`.

That measurement is what makes §4's typed vocabulary affordable at all: a prose
array over hundreds of rows would have to be guessed at; over one row it is
stated.

---

## 4. D3 — the variable vocabulary

`variables` is prose today — `["Código de verificação"]` — which describes
something to a human and lets no code act on it.

It becomes a database enum, covering **both** families:

```
public.template_variable

  campaign-resolvable   LISTENER_FIRST_NAME, LISTENER_FULL_NAME,
                        LISTENER_CITY, STATION_NAME
  caller-supplied       PRIZE_NAME, PICKUP_DEADLINE, VERIFICATION_CODE
```

The second family is what the two system templates already use and what is prose
today. Including them is what makes this **one** vocabulary rather than a
marketing vocabulary sitting beside an untyped legacy.

**Which family a value belongs to is held by the compiler**, not by a comment:

```ts
export const CAMPAIGN_RESOLVABLE: Record<TemplateVariable, boolean> = { … };
```

Total over the generated enum, so an eighth value does not build until somebody
says which family it is in. 29d offers only the `true` half.

### Two notations, one vocabulary, and the second is derived

| | Notation | Where it comes from |
|---|---|---|
| WhatsApp | positional `{{1}}`, `{{2}}` — what the Cloud API accepts | the **order of the array**: index 0 is `{{1}}` |
| Email | named `{{listener_first_name}}` | the enum value lower-cased — mechanical, never declared twice |

**For email the array is empty, and that is a simplification rather than an
omission.** The body names its own placeholders inline, so an array would be a
second declaration to drift from the first. The door validates the body's
`{{…}}` against the enum on save — the same shape as the placeholder-count check
`enqueue_whatsapp_outbound` already performs. A CHECK holds it structurally:

```
message_templates_email_variables_empty
  channel <> 'EMAIL' or cardinality(variables) = 0
```

---

## 5. The email frame

One frame, in code rather than in a column, beside the mailer.

```
┌─────────────────────────────────┐
│  [logo]  RÁDIO PULCHA FM        │  companies.thumb_url + name
├─────────────────────────────────┤
│  Oi Ana!                        │  the operator's text, variables
│                                 │  already substituted
│  Passa aqui hoje retirar…       │
├─────────────────────────────────┤
│  unsubscribe · the Station      │  an empty seam until 29c
└─────────────────────────────────┘
```

**Escaping is the security property, and it is what dispenses with a
sanitiser.** The operator's text is HTML-escaped on its way into the frame and
is never interpreted as markup. There is no path by which third-party HTML
reaches the frame, so there is nothing to sanitise.

**The logo must survive not loading.** Email clients block remote images by
default, so the frame carries the Station's name as `alt` and as text. Somebody
who never unblocks images reads the name rather than an empty box.

**The unsubscribe seam ships empty.** 29c fills it. Leaving the slot is cheaper
than reopening the frame later, and it is the one place this block looks ahead
on purpose.

The renderer produces **both** halves of `MailMessage` (`src/lib/mailer`): the
framed `html` and the operator's text as `text`. Both already exist on that
type; neither is new surface.

**Preview** renders the same frame and shows it in an `<iframe sandbox srcdoc>`
— not because the HTML is doubtful, since this system generates all of it, but
to keep intact the rule that this application never injects HTML into a page,
which is true of every file in the repository today.

---

## 6. D4 — the Station's email identity

Three nullable columns on `companies`: `email_from_name`, `email_from_address`,
`email_reply_to`. A Station that has configured none falls back to the
installation's `MAIL_FROM`, which is what invitations and password resets
already do.

They are edited on a second tab of the Station settings dialog Block 29a put on
`/app` — **Email**, beside **WhatsApp** — owner-gated by the same predicate.

**The Station's existing contact e-mail is deliberately not reused.** They answer
different questions: one is *how to reach the radio*, the other is *what address
a campaign is sent from*. They usually coincide and are not the same thing — and
the day a Station changes its commercial contact is not the day thirty thousand
e-mails should start arriving from a different sender.

**The domain warning lives on this tab**, next to the field where the address is
chosen, rather than repeated across thirty templates. D5 of the parent brief
made deliverability rest on the installation's domain; an address on a domain
the installation cannot sign lands in spam, and the operator choosing it is the
person who needs to be told.

A template's `from_*` columns override this per template. The common case sets
nothing.

---

## 7. D5 — the doors, and the trap the index sets

`register_message_template` (0113) is an **upsert**, which is how the screen's
"Replace what is recorded" works:

```sql
on conflict (company_id, purpose) where deleted_at is null
```

**That clause names the index §3 narrows.** The moment the index becomes
`where deleted_at is null and purpose is not null`, the clause matches no index
and PostgreSQL raises *"there is no unique or exclusion constraint matching the
ON CONFLICT specification"* — and the door that registers both system templates
stops working. It is not a consequence anyone reads out of a diff to an index.

So two doors, and the split is forced rather than chosen:

| | Door | How it writes |
|---|---|---|
| System | `register_message_template`, recreated with the matching predicate | upsert on `(company_id, purpose)`. **Signature unchanged**, so `create or replace` keeps the ACL. It fills the two new NOT NULL-ish columns itself: `channel = 'WHATSAPP'`, because a system purpose is never email, and `internal_name = name`, because the card is titled by its purpose and an operator has no second label to give it. Widening the signature to ask for one would drop the ACL for a field nobody would fill. |
| Marketing | `save_marketing_template`, new | by **id**: inserts when the id arrives null, updates when it does not. There is no natural conflict target — two marketing templates collide on nothing. |

Folding both into one function would mean a function branching on "is purpose
null" and using two different write strategies: two functions wearing one name.

`archive_message_template` serves both unchanged.

Both doors are SECURITY DEFINER with a pinned `search_path`, re-checking
`templates.manage` in their own bodies, and both write an `audit_logs` row —
the shape every write door in this project already has.

**Permissions:** `templates.view` and `templates.manage`, the two that exist.
`messaging.*` is born in 29d, where approving a send to twenty thousand people is
a different act from writing a text.

---

## 8. The screen

`/messages/templates`, in two groups.

```
Templates — RÁDIO PULCHA FM              [ WhatsApp ▾ ] [ New template ]

SYSTEM · not deletable, one registration each
┌ Pickup reminder ──────────────┐  ┌ Web widget verification code ─┐
│ ○ Not registered — nothing    │  │ ● Registered · pt_BR          │
│   sends          [ Register ] │  │                           ⋯   │
└───────────────────────────────┘  └───────────────────────────────┘

MARKETING · what the operator creates
Internal name       Channel    Description            Changed          Actions
aniversario_2026    WhatsApp   Birthday greeting      17/08 · Ana      ⋯
natal_geral         Email      Christmas notice       16/08 · Ana      ⋯
```

The system group is what the screen renders today and keeps rendering: one card
per `template_purpose`, from the enum, in `Registered` or
`Not registered — nothing sends`. Nothing is seeded (parent brief, D2).

**One screen, two stories, and it has to say which is which.** In 29b-1 a
WhatsApp template is still **transcribed** from something Meta approved in its
own console — that is how the single production row arrived. An email template
is **written here**, entirely. Without that distinction on screen, somebody
writes a WhatsApp marketing template and waits for a send that cannot happen.

So the notice the screen already carries — *"Templates are created and approved
in Meta's own console"* — becomes **channel-scoped**: shown on the WhatsApp
form, absent from the email one.

Create and edit open in a modal following Block 23's record dialog, and the form
**switches fields on the `Channel` chosen**, which is what §1 of the original
request asked for. The channel filter sits above the marketing grid (§2 of the
request).

House patterns that are not restated per screen: the Station picker
(`listCompanyAccess` + `StationSearchForm` + `stationSwitchHref`), the
`Card`/`CardContent` shell, loading and empty states, and i18n in all three
catalogues with operator strings in English and only the template BODY in
Portuguese.

---

## 9. Testing

**The one that matters more than the rest:** a unit test that the frame
**escapes** the operator's text. A body containing `<script>` comes out escaped.
It is the only test standing between this product and an HTML injection path;
everything else here is diligence beside it.

| Level | What it holds |
|---|---|
| unit | the frame escapes; `CAMPAIGN_RESOLVABLE` is total; an email body naming a placeholder outside the enum is refused; the positional↔named derivation |
| pgTAP | the four conditional CHECKs; the narrowed index **and** that `register_message_template`'s `ON CONFLICT` still matches it; the new enum; the grant set on both doors; `enqueue_whatsapp_outbound` carries the channel term |
| isolation | `templates.view` alone writes through **neither** door; a delegate of one Station cannot read or write another's templates |
| e2e | extend `templates.spec.ts` — create an email template, see it in the grid, open the preview; the system cards still behave as they do today |
| migration | the backfill asserted rather than inspected: after it, the production-shaped row has `channel = 'WHATSAPP'` and `variables = '{VERIFICATION_CODE}'` |

Every count this block moves is pinned somewhere no compiler can see —
`toHaveCount`, `toHaveLength`, `has_function` argument arrays, and i18n keys
built at the call site. The rule learned in the gender block applies verbatim:
grep for those four before calling the block done, and run the domain's e2e, not
only the spec touched.

---

## 10. What this block deliberately does not do

| | Why |
|---|---|
| A status column | It arrives with its synchronisation in 29b-2, or it is the memory 0110 refuses. |
| Creating or submitting to Meta | 29b-2, and its first task is proving the POST. |
| Anything that sends | 29d. A marketing template registered here is inventory. |
| Per-tenant SMTP credentials | Parent brief D5. Credentials at rest mean encryption, rotation and "who may read it" — the scope 0130 declined for WhatsApp. |
| Unsubscribe | 29c. The frame ships the empty seam. |
| A rich text editor or a sanitiser | D2 removes the need for both. |

---

## 11. Order of work

1. **Migrations.** The `message_channel` and `template_variable` enums.
   `CREATE TYPE` and its first use may share a transaction — the rule 0219
   states is about `ALTER TYPE … ADD VALUE`, which nothing here does — so this
   is a separate file for readability rather than for correctness, and the
   plan should say so where a reader would otherwise assume the harder rule.
2. **The table**: columns, the four CHECKs, the narrowed index, the backfill.
3. **`enqueue_whatsapp_outbound`** gains the channel term, from its live body.
4. **The two doors**, with `register_message_template`'s `ON CONFLICT` predicate
   corrected in the same migration as the index — they cannot ship apart.
5. **The frame and its escaping test**, before any screen renders a preview.
6. **The Station's Email tab.**
7. **The screen**: the marketing grid, the channel filter, the record dialog.
8. **i18n ×3, and the four uncheckable pins.**
