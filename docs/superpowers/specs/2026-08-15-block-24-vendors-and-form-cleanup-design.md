# Block 24 — Vendors become a record, four fields leave the screens, and a participation can be read

**Status:** design agreed with the owner, 2026-08-15.
**Scope:** the owner's list of 2026-08-15, eight items — a title filter on the
Deezer search, four promotion fields removed from the screens, moderation
guidelines on a Poll question, a View window and a promotion thumbnail on
Participations, a Vendors screen under Inventory, and a Vendor on each stock
entry.
**Depends on:** Block 2 (`prizes`, `inventory_movements`, the five inventory
permissions), Block 4a (`promotions`, `promotion_questions` and the WhatsApp
list fields), Block 4c (`participations`, `participation_answers`), Block 5b
(the conversation engine that consumes the four fields being removed), Block 13a
(the Deezer transport), Block 18 (`/shows`, the layout every new screen copies),
Block 22 (`AttendDialog`, the window the participation window is modelled on),
Block 23 (`inventory_movements` invoice columns, `list_movements` in `0196`,
`record_stock_entry` in `0194`).

---

## 1. What this is for

Three unrelated jobs arrived in one list, and they stay three jobs.

**The screens have fields nobody fills in any more.** Four of them — two button
labels on the WhatsApp tab, a call to action on the promotion, and the two list
titles on a quiz question — were written when WhatsApp was the only door a
listener could come through. The widget is now that door for most Stations, and
these four are dead weight on every promotion an operator registers. They go.

**A participation cannot be read.** The grid shows who entered and when; what
the person actually answered is in the database and on no screen. An operator
running a Poll — where the whole point is that listeners write something — has
nowhere to read the writing. So the row gains a window, and the question gains a
place to say what a good answer looks like.

**Prizes come from somebody, and nobody is recorded.** An entry carries an
invoice number, a unit price and a total since Block 23, and no supplier. So
suppliers become a record with a screen of their own, and every stock entry can
name one.

---

## 2. What already exists and is reused

Stated first because the risk in a list like this is rebuilding what is built.

- **`/shows` (Block 18) is the layout for `/inventory/vendors`.** Station
  switcher, URL-driven filter bar, keyset paging, record-as-a-modal, reads
  through PostgREST under RLS, writes through `SECURITY DEFINER` RPCs. The
  Vendors screen is that screen with different columns and is not designed
  again.
- **`AttendDialog` (Block 22) is the model for the participation window** — it
  derives its subject from the live `rows` by id every render, and closes itself
  when that row leaves the page. Both behaviours are copied, including the
  `useEffect` that clears the id, which `requests-grid.tsx` had to add after the
  window resurrected itself.
- **`RequestsGrid`'s `covers` map is the model for the promotion thumbnail.**
  `list_music_requests` carries no cover, so `page.tsx` fetches them for the page
  in one query and passes a `Map`. `list_participations` carries no thumbnail and
  gets the same treatment, for the same reason: widening it means `DROP` +
  `CREATE` on a long function to add one field.
- **`DEFAULT_YES_BUTTON_LABEL` / `DEFAULT_NO_BUTTON_LABEL` (`engine.ts`) already
  exist**, with the rule beside them: *"A blank label is a label the operator
  never set. The default is copy, not data."* Two more constants join them
  rather than a new mechanism.
- **`maskedPhone` (`request-status.tsx`)** already renders a phone as its last
  four digits. The participation window imports it.
- **`inventory.view` and `inventory.catalogue`** are the permissions Vendors
  uses. No new permission is introduced — see D6.
- **`participation_answers`' select policy (`0053`)** already gates on
  `participations.view` and inherits the archived-promotion rule through its
  sub-select. The window reads through it and adds no RPC.

---

## 3. Decisions

**D1 — The Deezer filter drops titles, and only on search.** A title containing
`karaoke`, `cover)`, `(cover`, `cover]` or `[cover`, compared in lower case, is
not listed. Applied in `search()` and never in `track(trackId)`: a recording
already registered in a Station's catalogue must stay readable when it is fetched
by id, and a filter there would make an existing row unresolvable. The predicate
lives in `transport.ts` beside `buildSearchQuery` and is called by both
`client.ts` and `fake.ts`, so the end-to-end suite proves the screen and not only
the unit.

Accepted consequence: `SEARCH_LIMIT` is 20 and is spent before the filter runs,
so a search whose first twenty hits are karaoke versions shows fewer than twenty
rows, or none. Asking Deezer for more to compensate would spend a second call on
every search to serve a rare case.

**D2 — The four removed fields keep their columns.** Nothing is dropped. The
inputs leave the three components, the fields leave `promotionFormSchema` and
`questionFormSchema`, and the actions stop posting them; `update_promotion`
replaces every field on every call, so the columns go to null on the next save of
each promotion. A destructive migration against a live hosted database to remove
a screen field is a trade with no upside — the columns cost nothing where they
are, and the engine already reads null correctly for three of the four.

**D3 — The quiz list titles get defaults, because the database requires them.**
`promotion_questions_list_fields` (`0041`) requires `menu_title` and
`button_label` to be non-null and non-blank on every `QUIZ` and
`MULTIPLE_CHOICE` question, and `engine.ts:454` throws a `PromptContextError` if
they arrive null. So removing the inputs is not removing the values: the save
action supplies `DEFAULT_QUESTION_MENU_TITLE` and
`DEFAULT_QUESTION_BUTTON_LABEL`, declared in `engine.ts` beside the two that
already exist there, and the WhatsApp list message goes on working unchanged.

The alternative — relaxing the constraint and sending the question as plain text
over WhatsApp — was rejected by the owner: it changes what a listener sees and
how they answer, which is not what "remove a field from the screen" asked for.

**D4 — Moderation guidelines get their own door, and the freeze does not apply
to it.** `0055` refuses the REPLACE branch of `save_promotion_question` once any
participation exists, so that rewording an option cannot invalidate an answer
already given. Moderation guidelines are internal text that no listener is ever
shown and that no answer points at, so that reason does not reach them — and the
field is useless under the freeze, because the only time anyone needs it is while
answers are arriving.

So the column gets a narrow door of its own,
`set_question_moderation_guidelines`, gated on `promotions.edit` and unaffected
by the participation count. `save_promotion_question` is **not** recreated: it
has already been rewritten once by `0055`, and recreating a long function to add
one parameter is the defect this repository has shipped three times (`0113`,
Block 17b, Block 17c). One field, one door.

**D5 — The guidelines are internal, and the code must make that unbreakable.**
The column is read by exactly two screens — the quiz form that writes it and the
participation window that displays it. It is not added to `PromptContext`, not
returned by `start_conversation` / `complete_conversation`
(`0070`/`0071`/`0114`), and not exposed on any widget or public API route. The
question's `prompt` is what a listener sees; the guidelines are what a reader
sees.

**D6 — Vendors reuse the inventory permissions.** `inventory.view` to read,
`inventory.catalogue` to register, edit and archive. A `vendors.*` pair is not
two rows in a table — it is a permissions migration, the roles screen, every
seeded role, `PERMISSIONS.md`, and every role a customer has already configured,
none of which would grant it. Shipping the screen behind a permission nobody
holds would hide it from everybody. This is the reasoning Block 18's §5 recorded
for `/shows`, and it applies unchanged.

`inventory.catalogue`'s own description already reads *"Register, edit and
archive prizes and categories"*; the migration updates it to name vendors too, so
the roles screen does not describe a narrower power than it grants.

**D7 — A vendor belongs to the entry, not to the prize.** `vendor_id` on
`inventory_movements`, permitted on the entry movement types and null everywhere
else — the shape `0193` established for `reserved_for_show_id` and `0045` before
it for `promotion_prize_id`. The same prize is bought from different suppliers in
different months, and the invoice number it sits beside is already per entry. A
column on `prizes` would answer "who supplied this" with one name for a shelf
that several suppliers filled.

**D8 — Vendors are Station-scoped and soft-deleted.** `organization_id` +
`company_id`, like `prizes` and `prize_categories`; `deleted_at` rather than a
delete, because a movement points at one and a supplier that vanishes takes an
entry's history with it. Archiving is refused for nothing: a vendor with entries
behind it archives fine, and the entries go on naming it, exactly as
`archive_song` is never refused over a live request (`0101`).

**D9 — The vendor picker loads its list with the record.** The prize record
dialog already receives its data from the server; the active vendors of the
Station come with it, and the picker filters that list in the browser. A
debounced server search per keystroke — the shape `prizes-tab.tsx` uses for
linking prizes — is what a list of thousands needs, and a Station's supplier list
is tens. If a customer's list grows past what one payload should carry, the
picker changes and nothing else does.

**D10 — The participation window shows four digits; the grid is left alone.**
The owner asked for the name and the last four digits in the window, and that is
what the window shows. The grid's Listener column renders the full phone today
and keeps doing so — narrowing it was not asked for, and a screen that shows less
than it did is a change an operator notices and reports. Recorded here because
the two will look inconsistent side by side, and that inconsistency is a decision
rather than an oversight.

---

## 4. The database

Four migrations, `0197`–`0200`.

### 0197 — `vendors`

```
id, organization_id, company_id,
name, legal_name, document, contact_name, phone, email,
address_line, city, state, postal_code, website, notes,
created_by, created_at, updated_at, deleted_at
```

`name` is required and non-blank; everything else is optional, because a
supplier's paperwork arrives at a different time from the supplier. The composite
foreign key `(company_id, organization_id) → companies` is the tenant proof every
table in this schema carries.

- `vendors_name_unique` — unique on `(company_id, lower(name))` where
  `deleted_at is null`. Two live suppliers with the same name in one Station is a
  data-entry error, not a case.
- `vendors_id_company_unique` — plain unique on `(id, company_id)`, non-partial,
  so `0199`'s foreign key can pin the vendor and its Station together in one
  constraint. Non-partial because a foreign key cannot reference a partial index,
  which is why archival needs its own explicit check in the door.
- `vendors_company_idx` on `(company_id)` where `deleted_at is null`.
- RLS on; `select` to `authenticated` gated on `has_permission('inventory.view',
  company_id)`. No insert, update or delete policy — writes go through the doors
  in `0198`, the shape `shows` uses.

### 0198 — the vendor doors

- `save_vendor(p_company_id, p_vendor_id, …)` — insert when
  `p_vendor_id` is null, update when it is given. `SECURITY DEFINER`, gated on
  `has_permission('inventory.catalogue', p_company_id)` with `42501`. Refuses an
  archived vendor with `22023`, and a blank name with `22023`. Returns the id.
- `archive_vendor(p_vendor_id)` — sets `deleted_at`, same gate, `22023` if
  already archived. Resolves `company_id` from the row rather than accepting one,
  so a caller cannot name another Station's vendor.
- `inventory.catalogue`'s `description` and `label` updated to name vendors.

`search_path` pinned and `execute` revoked from `public` then granted to
`authenticated`, as every door in this schema does.

### 0199 — the vendor on a movement

- `inventory_movements.vendor_id uuid`.
- `inventory_movements_vendor_company_fk` — `(vendor_id, company_id) → vendors
  (id, company_id)`.
- `inventory_movements_vendor_reference` — `vendor_id` is null unless
  `movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY',
  'BARTER_ENTRY')`, the same set `inventory_movements_invoice_reference` already
  names.
- `record_stock_entry` recreated with `p_vendor_id`, **from the live body of
  `0194`** and not from `0027`. It refuses a vendor belonging to another Station
  or already archived with `22023` — the foreign key would catch the first as a
  `23503` that reaches the operator as a generic failure.
- `list_movements` recreated with a `vendor_name` column, **from the live body of
  `0196`**, resolved by a left join so an entry with no vendor still lists.

Both recreations are the trap this repository has fallen into three times:
rebuilding a function from the migration that first created it silently reverts
every fix made since. The live definition is read with `pg_get_functiondef`
against a freshly reset database before either file is written.

### 0200 — moderation guidelines

- `promotion_questions.moderation_guidelines text`.
- `promotion_questions_guidelines_shape` — null unless `kind = 'ESSAY'`. A Quiz
  has right answers rather than judgement calls, and a nullable column with no
  such constraint eventually holds a value nobody can interpret.
- `set_question_moderation_guidelines(p_question_id, p_guidelines)` —
  `SECURITY DEFINER`, gated on `has_permission('promotions.edit', company_id)`
  resolved from the question's own row. Refuses a non-`ESSAY` question with
  `22023`. Blank or whitespace stores null. **No participation check** — D4.

---

## 5. The screens

### 5.1 Promotions — three components lose fields

- `whatsapp-fields.tsx` — the two-column block holding `yesButtonLabel` and
  `noButtonLabel` goes. The `enabled &&` branch keeps the hashtag alone.
- `promotion-fields.tsx` — the `callToAction` textarea goes. `Textarea` becomes
  an unused import and goes with it.
- `quiz-tab.tsx` — the two-column block holding `menuTitle` and `buttonLabel`
  goes. The `!isEssay` branch keeps the options fieldset alone.
- `schemas/promotions.ts` — the four fields leave both schemas, along with the
  `!whatsappEnabled` stray-field check's two entries and the ESSAY branch's
  "a written answer shows no menu" issue, which now has no field to raise itself
  against.
- `promotions/actions.ts` — stops reading the four from `FormData`; the question
  action sends the two constants for a non-ESSAY kind.
- `services/promotions.ts` — `createPromotion`/`updatePromotion` send null for
  the three promotion fields; `savePromotionQuestion` takes the two list fields
  from its caller as it does today, which is now the action's constants.

`PromotionDetail` keeps `callToAction`, `yesButtonLabel` and `noButtonLabel` on
its type: the conversation engine reads all three through
`services/conversation.ts`, and that path is untouched.

### 5.2 Promotions — the Poll question gains guidelines

A textarea in `QuestionForm`, rendered when `kind === 'ESSAY'`, labelled
*Moderation guidelines* with the hint that it is internal and never sent to the
listener.

Two write paths, because the freeze makes one impossible:

- **A new question** — the action calls `save_promotion_question`, takes the id
  it returns, and calls `set_question_moderation_guidelines` with it when the
  textarea is non-blank. Two calls, and a failure of the second leaves a saved
  question with no guidelines and an error on screen, which is recoverable by
  typing them again.
- **An existing question** — the guidelines save through their own door alone.
  When the promotion is frozen, `QuestionForm` renders every other field
  read-only with a sentence saying why, and offers only this one. `QuizTab`
  learns `frozen` from the record, which already counts participations.

### 5.3 Participations — a View column, a thumbnail, and a window

`ParticipationsGrid` gains a first column carrying the promotion's thumbnail —
`promotionThumbs: Map<string, string | null>`, fetched in `page.tsx` for the
distinct promotion ids of the page — and a last column, sticky right, with a
`View` button per row.

`ParticipationDialog` (new) shows:

- the listener's name, and the phone as `maskedPhone(last four)`;
- the promotion, with its thumbnail;
- status, source, when they entered, whether they have already won here;
- **the answers**: for each question in position order, the prompt, then either
  the option they chose — marked right or wrong when the question is a `QUIZ` —
  or the text they wrote;
- for a Poll question, the moderation guidelines above its answer, which is the
  reader this field was added for.

The answers are read by a server action calling a new service function, a
PostgREST select over `participation_answers` embedding `promotion_questions` and
`promotion_question_options`, under RLS. `0053`'s policy gates it on
`participations.view` and carries the archived-promotion rule; `0044`'s gates the
question and option text on `promotions.view`, which `list_participations`
already required of anyone reading this list.

The window derives its subject from the live `rows` by id every render and
clears the id when the row leaves the page — both copied from `requests-grid.tsx`,
including the effect it had to add after the window reopened itself.

### 5.4 `/inventory/vendors`

`/shows` with different columns. Station switcher, `StationSearchForm`, filter
bar in the URL, keyset paging, `Register vendor` opening the record modal.

- **Filters** — a search over name, document and contact, and a status select
  (active / archived / both), defaulting to active.
- **Columns** — name, document, contact, phone, city, and an actions cell with
  `Edit` and `Archive`. Archive asks twice, as every archive in this product
  does.
- **The record modal** — every column in §4's list, in three groups: who they
  are, how to reach them, where they are.
- **Nav** — third item in the Inventory section, after Stock and Movements,
  `ICONS.building`. `building` is already used by Catalogue > Labels and
  Platform > Organizations, both distant sections, so it never sits adjacent to
  itself — the non-adjacency rule `shell.ts` records for `box` and `shield`.

### 5.5 The vendor on the entry form

`StockEntryForm` gains a Vendor field between the invoice number and the unit
price, where the paperwork puts it: a text input that filters, and a `Select`
beneath it listing the matches. Optional — a barter from a listener has no
supplier, and an entry recorded before this block has none either.

`MovementHistory` shows the vendor on an entry row beside the invoice number,
from `list_movements`' new `vendor_name`.

---

## 6. What is deliberately not done

- **No column is dropped** (D2) and no `promotions` or `promotion_questions` data
  is deleted. The four removed fields go to null as each promotion is next saved.
- **The Listener column keeps the full phone** (D10).
- **No `vendors.*` permission** (D6).
- **The conversation engine is not touched** beyond two new constants. The
  WhatsApp door goes on sending the same interactive messages.
- **Vendors carry no stock, no balance and no ledger of their own.** A vendor is
  a name on an entry; "what did we buy from them" is a filter over movements,
  which `/inventory/movements` can already express once `vendor_name` is on the
  row.

---

## 7. How this is proved

- **pgTAP** — `vendors` RLS and the two doors (permission, tenancy, archived
  refusals, the name uniqueness); `vendor_id` accepted on entry types and refused
  on every other; `set_question_moderation_guidelines` gated, refusing a
  non-`ESSAY` question, and **succeeding on a question whose promotion already
  has participations**, which is D4 and the one thing a reviewer would assume was
  broken.
- **`tests/isolation`** — a vendor of Station A is invisible and unwritable from
  Station B, and `record_stock_entry` refuses a vendor from another Station.
- **Unit** — the Deezer title predicate against all five terms in both cases and
  against titles that must survive (`Discover`, `Undercover`, a song actually
  called `Cover Me`); the two new question-label constants reaching
  `save_promotion_question`; the participation answer mapping.
- **e2e** — the Vendors screen registers, edits, filters and archives; the
  participation window opens from the grid, shows four digits and the answers,
  and closes; a stock entry records a vendor and the history shows it.
- **The existing suites that must not regress** — `tests/e2e/deezer.spec.ts`
  (the filter must not empty the search), `promotions-schema.test.ts`,
  `conversation-engine.test.ts` and `whatsapp-interactive.test.ts` (the removals
  must not change what WhatsApp sends), and `03_promotions.test.sql`.
