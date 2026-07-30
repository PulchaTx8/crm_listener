# Block 4a — Promotions and the quiz — Design

Block 4 of the design document (§11) is "Promotions, quiz & participations". It
is **three passes**, decided with the owner in this session:

| Pass | Delivers | Own PR |
| --- | --- | --- |
| **4a** — this spec | The promotion record and the quiz that defines it | yes |
| **4b** | Prize linking: the ledger learns which promotion, the per-promotion projection (H1), link/unlink, reconciliation of both | yes |
| **4c** | Participations: manual entry, import, the per-person limit under concurrency (N3) | yes |

The split exists because 4b is **surgery on the accounting core Block 2 shipped**,
not a use of it, and deserves review of its own. Section 8 lists what 4a
deliberately leaves to the later passes.

---

## 1. What the owner's system does today

The requirements for this block came from the owner's current promotion screen,
a four-tab dialog. Read literally, tab by tab:

**Tab 1 — Promoção.** `Cód. Integração Site` (an integer, `0` in the sample),
`WhatsApp` as SIM/NÃO, the promotion name, a window `De <date> <time> à <date>
<time>`, a checkbox "Permitir mais de uma participação do ouvinte", and
`Chamado da promoção` as free text. The footer counts `Total Quiz`, `Total
Mult` and `Total Dissert`.

**Tab 2 — Dados Whatsapp**, enabled only when tab 1 says WhatsApp = SIM.
`Hashtag` (`#EUQUERO`), a `Usar Imagem` checkbox beside an `Arte (Imagem)` URL,
the labels of the two reply buttons (`Botão SIM` = "Quero!", `Botão NÃO`), and
`Solicitar Dados Pessoais` with eleven tickable fields.

**Tab 3 — Enquetes.** Optional. A question has a `Chamada`, a `Tipo`, a
`Título do Menu` and a `Título do Botão` — the last two being the fields of a
WhatsApp interactive **list** message.

**Tab 4 — Prêmios.** Links prizes from stock to the promotion, with columns
`Vinculados`, `Sorteados`, `Resto`. **This tab is 4b**, not 4a: those three
columns are the per-promotion projection (H1) that does not exist yet.

### 1.1 What the current data model already anticipated, and what it did not

`PROMOTION_LINK` and `PROMOTION_UNLINK` exist in the `inventory_movement_type`
enum and are legal transitions in the ledger's `inventory_movements_legal_transition`
check (`0026`, lines 48–51) — but **no RPC issues either one**, so they are
unreachable today. `inventory_movements` carries **no promotion reference at
all**, and `promotion_prize_balances` does not exist. That is 4b's work.

`member_consents.promotion_id` exists **without a foreign key**, carrying the
comment "No foreign key yet: public.promotions does not exist." **4a adds it.**

---

## 2. Decisions taken with the owner

Each of these overrides the design document where they differ. They are not to
be relitigated during implementation.

**D1 — There is no draft state. The window decides.** A promotion accepts
participations when `now()` falls inside `[starts_at, ends_at)` and it has not
been cancelled. "Agendada", "No ar" and "Encerrada" are **computed** from the
window; only cancellation is stored. The design document's §12 item 6 ("explicit
state machines") is satisfied by cancellation alone.

The owner considered and rejected a draft/publish step. The hole it would have
closed — a half-configured promotion whose start date has already passed — is
narrower than it first appears: the bot recognises a participation **only by the
hashtag**, so a promotion with no hashtag is unreachable by itself. Where a draft
would still matter is manual entry and import, which are 4c.

**D2 — Cancelling is a button.** A cancelled promotion stops accepting
immediately and is shown as Cancelada, without anyone editing the end date to
disguise a mid-flight stop.

**D3 — Three question kinds, and only `QUIZ` has a right answer.** `QUIZ` has
options and a marked correct one. `MULTIPLE_CHOICE` is an opinion poll: options,
no right answer. `ESSAY` is free text.

**D4 — Whether a wrong answer disqualifies is per promotion.** Tab 1 gains
"Exigir acerto para concorrer". The participation records the answer and whether
it was right either way; what changes is whether Block 6's draw may see that
participant.

**D5 — The requested-fields list drops to eight.** Of the eleven fields in the
owner's tab 2, eight map to columns `members` already has: Nome Completo →
`full_name`, Endereço → `address_line`, Cidade → `city`, Bairro →
`neighbourhood`, Idade → `birth_date`, CPF → `cpf_hash`, Passaporte →
`passport`, Como Ouve a Rádio → `discovery_source`. Gênero, Rádio Mais Gosta
and Programa Mais Gosta na Rádio have no column, and the owner's decision is
that **the new system will not have them**. No column is added for them.

**D6 — Every marked field is asked the same way.** The owner was asked directly
whether a requested field would ever need settings of its own — required versus
optional, or the order the bot asks — and said no. That answer is what makes the
list a column on the promotion instead of a table of its own (§3).

**D7 — Repetition is a yes/no plus a minimum interval.** Unticked, one
participation per person for the whole promotion. Ticked, the promotion must
also say the minimum number of hours between one person's participations. The
current system's ticked state means *unlimited*, which lets one person send the
hashtag five hundred times and occupy five hundred places in the draw.

**D8 — `Cód. Integração Site` stays, typed by hand, unique per Station.** It is
how the radio's website refers to the promotion. Optional; when filled, no two
live promotions in a Station may share it.

**D9 — Once a participation exists, the quiz is frozen; the rest stays open.**
Frozen: the questions, their options, the hashtag and the start date. Open: the
name, the call to action, the art, the button labels, the end date, and
**adding** a new question. Editing an option after somebody has answered it
would leave that answer pointing at text the person never read.

**D10 — `Usar Imagem` stays, and it commands the URL field.** Ticked, the URL is
required and the dialog renders a **preview of the banner**; unticked, the field
is disabled and cleared. The two can therefore never disagree. The image is what
the bot sends when a listener texts the hashtag to the Station's number.

**D11 — The art URL must be `https`.** The WhatsApp Cloud API fetches that image
itself and will not fetch over `http`. An `http` URL would validate, preview
correctly in the browser, and fail only at send time in Block 5 — far from the
screen that accepted it.

**D12 — The owner sees archived records, and every archive records who did it.**
The owner resolves discrepancies without calling support, so an archived
promotion stays readable **to the owner and the platform admin** and shows the
name of whoever archived it and when. This is new to the project: **no table
today stores `deleted_by`** — every soft delete records when, never who.

D12 is deliberately **not** applied to `prizes` and `members` in this block. It
is the decision Block 3b's report was waiting for, and applying it there means
widening two shipped RLS policies, adding an archived filter to two screens, and
rewriting the archive confirmation Block 3c shipped — which says archiving
cannot be undone from the app. That is **its own short PR**, agreed with the
owner, so a promotions delivery does not carry RLS changes to two domains that
are not its own.

---

## 3. Data model

Three tables. The design document's §4.1 listed five for this area
(`promotions`, `promotion_whatsapp_settings`, `promotion_requested_fields`,
`promotion_questions`, `promotion_question_options`); two of those collapse, for
one structural reason and one owner decision.

**The structural reason: the hashtag and the window must share a row.** The bot
identifies which promotion a message belongs to by its hashtag, so two
promotions accepting at the same time in the same Station must not share one. A
plain unique index is too strong — it would forbid reusing `#EUQUERO` next year.
What is wanted is "no two promotions with the same hashtag whose windows
overlap", which in Postgres is an **exclusion constraint** over
`tstzrange(starts_at, ends_at)` — and an exclusion constraint cannot span two
tables. `promotion_whatsapp_settings` therefore cannot hold the hashtag, and
holding only the leftovers earns nothing.

**The owner decision is D6:** with no per-field settings, the requested fields
are a fixed list of eight values, which is a column, not a table. Each table
avoided is also one fewer set of RLS policies to write and to prove — the cost
that dominated Blocks 2 and 3.

### 3.1 `promotions`

```
identity      id, organization_id, company_id        (per Station, like prizes)
              site_integration_code                  optional, unique per Station
              name
window        starts_at, ends_at                     stored UTC, shown in the Station's timezone
              cancelled_at, cancelled_by, cancellation_reason  (reason required when cancelled)
repetition    allow_multiple_entries                 boolean
              min_hours_between_entries              required when the above is true
quiz          require_correct_answer                 "Exigir acerto para concorrer"
copy          call_to_action                         the Chamado da promoção
whatsapp      whatsapp_enabled                       boolean
              hashtag                                required when enabled
              use_art, art_url                       both or neither; https only
              yes_button_label, no_button_label
              requested_fields                       promotion_requested_field[]
audit         created_by, created_at, updated_at
              deleted_at, deleted_by
```

```sql
create type public.promotion_requested_field as enum (
  'full_name', 'address', 'city', 'neighbourhood',
  'age', 'cpf', 'passport', 'discovery_source'
);
```

The enum names the **member column** each field fills, not the Portuguese label
on screen — the label belongs to the interface, and a value that outlives a
rewording is worth more than one that matches today's copy.

### 3.2 `promotion_questions`

`id`, `promotion_id`, `organization_id`, `company_id`, `position`, `kind`
(`QUIZ` / `MULTIPLE_CHOICE` / `ESSAY`), `prompt` (the Chamada), `menu_title` and
`button_label` (the WhatsApp list message's own two fields), plus timestamps.

`unique (promotion_id, position)`, plain rather than deferrable, because **4a has
no reordering**: questions are appended at the end and asked in `position` order,
which is what the owner's screen does today. Deleting the second of three leaves
a gap, and a gap orders correctly. Adding reordering later means making this
constraint deferrable at that point, so a swap inside one transaction does not
collide with itself midway.

`unique (id, kind)` exists only so the options table can carry a composite
foreign key; see below.

**Neither this table nor its options carry `deleted_at`. A removed question is
really deleted.** Soft deletion exists to keep rows that something else still
points at; removal is only ever permitted while the promotion has no
participation (D9, enforced in 4c), so nothing can be pointing at a question when
it goes. A `deleted_at` here would be a column no query would ever have a reason
to filter on.

### 3.3 `promotion_question_options`

`id`, `question_id`, `kind`, `organization_id`, `company_id`, `position`,
`label`, `is_correct`.

`kind` is denormalised here on purpose, tied back by
`foreign key (question_id, kind) references promotion_questions (id, kind) on
update cascade`. That is the idiom this project already uses in `prizes` and
`inventory_movements` to keep a child from contradicting its parent, and it buys
two guarantees that would otherwise be prose: an option cannot hang off an essay
question, and a right answer cannot be marked on anything but a `QUIZ`.

The cascade earns its keep on the edit path. Changing a question from `QUIZ` to
`MULTIPLE_CHOICE` cascades the new kind onto its options, where the
`is_correct` check then refuses the update while any option is still marked
correct — so a quiz cannot quietly become a poll while keeping a right answer.

---

## 4. What the database guarantees on its own

Each line below is a constraint or index, not a convention, and each gets a
pgTAP case (§9).

| Made impossible | How |
| --- | --- |
| Two overlapping promotions sharing a hashtag in one Station | exclusion constraint over `(company_id, lower(hashtag), tstzrange(starts_at, ends_at))` |
| An inverted window | `check (ends_at > starts_at)` |
| Two live promotions sharing a site integration code | partial unique index, `where deleted_at is null and site_integration_code is not null` |
| WhatsApp enabled with no hashtag | check |
| Any tab-2 field set while WhatsApp is disabled | check — the whole tab, requested fields included, is empty when disabled |
| `use_art` and `art_url` disagreeing | check — both or neither |
| An art URL that is not `https` | check |
| An interval without repetition, or repetition without an interval | check |
| A cancellation missing its author or its reason | check — the three cancellation columns are all set or all null |
| An archive missing its author | check — `deleted_at` and `deleted_by` are set together |
| The same requested field twice | check, via an immutable `has_no_duplicates(anyarray)` helper — a `CHECK` may not contain a subquery, so the de-dup cannot be written inline |
| An option on an essay question | composite FK + `check (kind <> 'ESSAY')` |
| A right answer on a poll | composite FK + `check (kind = 'QUIZ' or not is_correct)` |
| Two right answers in one question | partial unique index on `(question_id) where is_correct` |
| Menu and button titles on an essay, or missing on a choice question | check |

### 4.1 Two things the database will not guarantee, said plainly

**"At least one right answer" is a save-time validation, not a constraint.** A
partial unique index forbids the *second* correct option; no index can require a
*first*. The rule lives in the RPC that writes a question, and is weaker for it.

**The half-open range is the point.** `tstzrange(starts_at, ends_at)` defaults to
`[)`, so a promotion ending at exactly the instant another starts does **not**
overlap it. That is the behaviour a radio wants when it runs the same hashtag in
back-to-back weekly rounds, and §9 tests it from both sides — touching accepted,
crossing refused — because a test that only proves the refusal would pass just as
well against an ordinary unique index.

### 4.2 `btree_gist`, and the constraint, verified against the real database

The exclusion constraint compares `company_id` (uuid) and `lower(hashtag)`
(text) with `=` inside a GiST index, which needs the `btree_gist` extension.
Only `pgcrypto` is declared today (`0001_extensions.sql`), so this block adds
`create extension if not exists btree_gist with schema extensions;` — with the
schema named explicitly, for the reason `0001`'s own comment gives.

`btree_gist` 1.7 is available in the project's local Supabase image, and the
constraint was **built and exercised there** rather than reasoned about. Nine
cases in one rolled-back transaction, each on its own savepoint so that a refusal
could not abort the ones after it:

| Case | Expected | Result |
| --- | --- | --- |
| Overlapping windows, same hashtag, same Station | refuse | refused |
| Same hashtag in a different case (`#euquero`) | refuse | refused |
| Touching windows, same hashtag | accept | accepted |
| Overlapping windows, same hashtag, different Station | accept | accepted |
| Overlapping, but the new row is cancelled | accept | accepted |
| Cancel the live one, then reuse its exact window | accept | accepted |
| Archived (`deleted_at` set) does not block a new one | accept | accepted |
| Null hashtag against another null hashtag, overlapping | accept | accepted |

The touching-window case is the one that distinguishes this constraint from an
ordinary unique index, and it passes: `tstzrange`'s default `[)` bounds mean a
promotion ending at the instant another starts does not overlap it.

**One behaviour found by the probe that was not designed for: the constraint
re-evaluates on `UPDATE`, so un-cancelling is not always possible.** Cancel a
promotion, let somebody reuse that window with the same hashtag, and restoring
the first one is refused — correctly, since two live promotions would then share
the hashtag. Nothing in this block un-cancels, so it does not bite here. It is
recorded because a future "reactivate" button would fail for a reason that looks
nothing like the permission error operators are used to, and whoever builds it
should refuse it in the RPC with a sentence a human can act on.

---

## 5. Screens

`/promotions`, following the pattern Block 3c fixed for the whole site: a grid
with filters and a create button, and the record opening **as a tabbed dialog
over that list**, addressable as `?record=<id>&tab=<slug>`, with the list never
re-queried on open, tab change, save or close.

Grid columns: name, window, situation, hashtag, number of questions. Filters:
situation, free text over name and hashtag, and period. Dialog tabs: **Promoção**,
**WhatsApp** (disabled while WhatsApp is NÃO) and **Enquete**. There is no
Prêmios tab in 4a.

**Situation filters but does not sort.** It is computed from `starts_at`,
`ends_at` and `cancelled_at`, and Block 3b proved that a keyset cursor must
compare the column it orders by — ordering by something computed pages wrongly.
Filtering on "No ar" is a predicate over those three columns and works; sorting
by situation will not exist. Default order is by `starts_at` descending, tie-broken
by `id`, with the index to match.

The archived filter is available **to the owner and the platform admin only**,
because they are the only callers whose reads return archived rows at all (D12).

---

## 6. Actions and permissions

`SECURITY DEFINER` RPCs, each gated on its own power beside the operation rather
than inside a shared helper, as in every block since Block 2:

| RPC | Power |
| --- | --- |
| `create_promotion` | `promotions.create` |
| `update_promotion` | `promotions.edit` |
| `cancel_promotion` | `promotions.cancel` |
| `archive_promotion` | `promotions.archive` |
| `save_promotion_question` | `promotions.edit` |
| `remove_promotion_question` | `promotions.edit` |

Three refusals that are part of the contract rather than interface politeness,
each with its own isolation case:

- **`cancel_promotion` requires a reason**, and refuses a promotion that is
  already cancelled or whose window has already closed. A cancellation with no
  reason is a row nobody can act on later; cancelling something already over
  changes nothing and would only mislabel it.
- **`archive_promotion` refuses while the promotion is still accepting.** The
  shape is `archive_prize`'s, which refuses while any bucket is non-zero: a
  record the audience can still reach is not a record to file away. Cancel it
  first, then archive.
- **`remove_promotion_question` renumbers nothing.** It deletes the row and
  leaves the gap, per §3.2.

A question and its options are written in **one call**: they are one form, and
splitting them would let a question exist for an instant with no options, or
with the previous question's. This is the same reasoning that keeps a role's two
halves in one submission in Block 3c.

New permission codes: `promotions.view`, `promotions.create`, `promotions.edit`,
`promotions.cancel`, `promotions.archive`.

No table takes an insert, update or delete grant from any role, `service_role`
included — every write goes through an RPC that runs as the table owner. That is
the rule Block 2 established and the reason its ledger's append-only comment is
true rather than intended.

---

## 7. RLS

```sql
create policy promotions_select_promotions_view on public.promotions
  for select to authenticated
  using (
    public.has_permission('promotions.view', company_id)
    and (deleted_at is null or public.is_owner_of_company(company_id))
  );
```

`has_permission` already admits the owner and the platform admin, so it cannot
express D12 by itself — a second predicate is needed, and it must be a new
`SECURITY DEFINER` helper rather than an inline `EXISTS` over `public.companies`.
`0024`'s own comment records why: an inline `EXISTS` inside a policy is itself
subject to the read policies of the table it touches, which is what forced the
same move there.

`promotion_questions` and `promotion_question_options` are readable to whoever
can read their promotion, by the same `promotions.view` check on their
denormalised `company_id`.

---

## 8. What 4a does not do

- **No prize linking.** No `promotion_prizes`, no promotion column on the
  ledger, no `promotion_prize_balances`, no Prêmios tab. That is 4b, and it is
  where `PROMOTION_LINK`/`PROMOTION_UNLINK` finally become reachable.
- **No participations, and therefore no frozen quiz.** D9's rule depends on
  `participations`, which 4c creates. Writing the guard here — against a table
  that does not exist — would produce a guard that can never fire, which is the
  exact defect this project has caught five times. **4c implements D9 and proves
  it red under mutation.** 4a's migration carries a comment saying so, and this
  is repeated in 4a's verification report so it cannot be lost between passes.
- **No bot.** Tab 2 stores what the bot needs; Block 5 is what reads it.
- **No reordering of questions** (§3.2). They are appended and asked in order,
  as the owner's current screen does.
- **`prizes` and `members` keep hiding archived rows from everyone**, per D12's
  second half.

---

## 9. How this will be verified

Every gate at its real defaults, as in every block: `npm run lint`,
`npm run typecheck`, `npm test`, `npx supabase test db`, `npm run test:isolation`,
`npm run build`, `CI=1 npx playwright test --workers=2`.

**pgTAP** covers every row of §4's table, one case each. The hashtag constraint
gets three: overlapping windows refused, touching windows accepted, and the same
hashtag accepted once the earlier promotion is cancelled. One further case
belongs to §1.1's loose end: `member_consents.promotion_id` now has a foreign
key, so a consent naming a promotion that does not exist must be refused where
before it was accepted.

**Isolation** tests run under real JWTs and are driven by a **non-owner
delegate** — the discipline adopted after Block 1c shipped two defects that
thirteen reviews missed because the owner's bypass hid the delegate's failure.
They cover: reading a promotion with and without `promotions.view`; each write
RPC with and without its power; a promotion in another Station being invisible;
and **D12 from both sides** — an archived promotion readable by the owner and
absent for a delegate who could read it while it was live.

**Unit** tests cover the validation schema: the interval required when repetition
is on, `https` enforced, the art pair, requested fields only when WhatsApp is on,
and at least one correct option on a `QUIZ`.

**End to end** proves the record dialog over the list once more, and that the
list is not re-queried. Block 3c's finding applies directly and must not be
rediscovered: **the request counter cannot see a `revalidatePath`**, because Next
returns the re-rendered tree inside the server action's own POST response. What
catches a reintroduced `revalidatePath` is the row-position assertion made at the
moment of the save.

Every assertion that is supposed to protect an invariant is shown failing against
a deliberate mutation, and the mutation is quoted in the report.

---

## 10. Open, and to be settled during implementation

1. **Whether five permission codes are the right granularity.** `cancel` and
   `archive` could fold into `edit`. Split is proposed because both stop a
   promotion the audience can see; the owner can collapse them at review.
2. **Timezone of the window.** `starts_at`/`ends_at` are `timestamptz` stored in
   UTC and displayed in `companies.timezone` per L2. The screen must make the
   Station's timezone visible beside the field, or an operator in another state
   will read the window wrongly — copy to be settled when the tab is built.
