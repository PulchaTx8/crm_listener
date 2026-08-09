# Block 16 — The platform console, by Organization and by Station

**Date:** 2026-08-09
**Status:** awaiting review
**Block:** 16

---

## 1. What this is for

The console has one screen for customers, it is called **Clientes**, and every row
in it is a **Station**. The word *Organization* appears nowhere — not as a
column, not as a filter, not as a screen — even though the whole data model rests
on it: listeners belong to an Organization, catalogues and stock belong to a
Station, and the owner sits on the Organization.

The consequence was found by the owner on 2026-08-09, looking at four rows and
being unable to answer *"is this four customers, or two customers with four
radios?"* from the screen. The answer needed SQL:

| Organization | Stations |
| --- | --- |
| GRUPO JOVEM PAN | JOVEM PAN FM |
| Pulsar Corporation | ALPHA FM, DISNEY FM, Pulsar FM |

The data was right. The console simply could not show it.

This block splits the console along the seam the database already has:
**Organizations** and **Stations** become two screens, each with a record of its
own, and the Station's record finally becomes editable — which is also where
Block 15's WhatsApp integration and API keys come to live.

---

## 2. Decisions

All taken with the owner on 2026-08-09.

**D1 — An Organization is provisioned empty.** "Provisionar Organização" asks for
the group's name and the owner's e-mail, and creates neither a Station nor
anything else. Stations are created in one place only, from the Stations screen.
The state this admits, and it is admitted knowingly: an Organization with no
Station at all, whose owner signs in and reads *"no station is linked to your
account yet"* until the first one is created.
Rejected: keeping today's behaviour, where provisioning creates the first Station
too. It needs no migration, and it puts a second creation path on a screen that
exists to be the only one.

**D2 — The Organization's record has three tabs**: **Dados** (the group's name,
editable — there is no way to rename an Organization anywhere today, in any
screen or RPC), **Proprietário** (the owner's e-mail and the provisional-password
button, which sits on the Station record today and belongs here), and
**Emissoras** (the group's Stations, read-only, because creating one is the other
screen's job).

**D3 — The Stations screen is filtered by Organization**, through a combobox at
the top. Nothing is listed until one is chosen. **Provisionar Emissora** creates
into the Organization currently selected, so the Station can never be attached to
the wrong group by a mis-click.

**D4 — The Station's record has three tabs**: **Dados da Emissora**, **Integração
WhatsApp**, **API Keys**. The last two already exist as a screen and as a tab
respectively; this is where they end up.

**D5 — Subscription and suspension stay on the Station.** `companies.status` is
what `has_company_access` reads, and moving it to the Organization would touch
every access check in the schema. Suspend/reactivate stays in the Stations
screen's row menu, exactly as it is.

**D6 — `/admin/integrations` leaves the menu.** Its content becomes the Station
record's WhatsApp tab. The owner named three items for the PLATAFORMA section and
that was not among them.

**D7 — Invoicing data lives on BOTH, and a selector says who emits.** The
Organization's record carries **Emissão de nota fiscal: Organização | Emissoras**.
The critical half, which the owner insisted on and which is what makes the design
correct: **the Station keeps its own invoicing data whatever the selector says.**
A radio has a CNPJ of its own even when the group is the one that invoices, and
blanking that field to model a preference would throw away a true fact. The
selector answers *who emits*, never *who has*.

**D8 — The Station's address serves both purposes.** One address per Station,
used as the postal address and as the invoicing address. The Organization gets an
address block of its own, because today it has none and an invoice cannot be
issued without one.

**D9 — This block stores invoicing data; it does not invoice.** No municipal
integration, no NFS-e generation, no tax calculation. It is the record somebody
consults when billing, and the screen must not grow a button that implies
otherwise.

---

## 3. Navigation

The **PLATAFORMA** section of the sidebar becomes exactly three items:

```
Organizações        /admin/organizations
Emissoras           /admin/stations
Pedidos de contato  /admin/contact-requests   (unchanged)
```

`/admin/customers` redirects to `/admin/organizations`, so an address somebody
bookmarked still lands somewhere sensible rather than on a 404.

---

## 4. The Organizations screen

One row per Organization, newest first, with the columns the owner's own query
produced plus the two the console needs:

| Column | Source |
| --- | --- |
| Organização | `organizations.name` |
| Emissoras | count of live `companies` |
| Quais | their names, comma-separated |
| Proprietário | the `owner` in `organization_memberships` |
| Criada em | `organizations.created_at` |

**Provisionar Organização** asks for the group's name, the owner's e-mail and the
owner's name (optional, as today). It returns the provisional password once, on
screen — the rule spec §6 already sets: shown once, never through a URL.

### The record

**Dados** — the group's name, editable, plus the invoicing block (§6) and the
emitter selector.

**Proprietário** — the owner's e-mail, and the button that generates a new
provisional password. Moved from the Station record, where it never belonged: the
owner is a row in `organization_memberships`, not a property of a radio.

**Emissoras** — the group's Stations with their status. Read-only, with a link
that opens the Stations screen already filtered to this Organization.

---

## 5. The Stations screen

A combobox of Organizations at the top, and nothing below it until one is chosen.
Choosing one lists that group's Stations in the layout the current screen already
has — **Emissora, Assinatura, Provisionada, Ações** — with suspend and reactivate
in the row menu (D5).

**Provisionar Emissora** creates into the selected Organization. It is
`add_company` (0016), which already exists and already takes the Organization as
its first argument; what changes is that a screen finally calls it from a place
where the Organization is unambiguous.

---

## 6. The Station's record

### 6.1 Dados da Emissora

**Already built in Block 15** — the picture, the band and frequency, the seven
address fields, latitude and longitude.

**New — contact and presence:**

| Field | Column |
| --- | --- |
| E-mail de contato | `contact_email` |
| Telefone | `contact_phone` |
| Site | `website_url` |
| Instagram | `instagram_url` |
| Facebook | `facebook_url` |
| YouTube | `youtube_url` |
| Slogan | `tagline` |
| Descrição | `description` |

**New — the invoicing block (D7):**

| Field | Column |
| --- | --- |
| Razão social | `legal_name` |
| CNPJ | `tax_id` |
| Inscrição municipal | `municipal_registration` |
| E-mail para a nota | `fiscal_email` |

The address is not repeated here (D8): the one above serves.

**Why `municipal_registration` and not a state one.** Radio advertising is a
*serviço*, so it is the municipal registration that appears on an NFS-e. A state
registration would be the field for goods, and this product sells none.

**CNPJ is stored as fourteen digits and nothing else** — punctuation stripped on
the way in, the way `normalize_phone` (0031) already treats a telephone, so two
people typing the same company two different ways produce one value. The CHECK
asserts the shape. **It does not verify the check digits**: that is a mod-11
calculation, it belongs in the application rather than in a constraint, and a
wrong-but-well-formed CNPJ is a data-entry problem a human notices, not a
corruption the database must prevent.

### 6.2 Integração WhatsApp

The content of `/admin/integrations`, for this Station alone. `list_integrations`
(0130) returns every Company with its integration or nulls; the tab needs one
Company, so it gains a sibling that takes a `company_id`.

### 6.3 API Keys

Block 15's tab, unchanged in behaviour.

---

## 7. The Organization's invoicing block

The same four fields as the Station — `legal_name`, `tax_id`,
`municipal_registration`, `fiscal_email` — plus an address block of its own
(D8), using the same seven column names `members` and `companies` already use, so
there is not a third address shape in one database.

And the selector:

```sql
create type public.billing_entity as enum ('ORGANIZATION', 'STATIONS');
```

`ORGANIZATION` means the group invoices and its data is the one to read.
`STATIONS` means each radio invoices with its own. **Neither value empties any
column** (D7).

---

## 8. Data model

### 8.1 `organizations` — twelve new columns

`legal_name`, `tax_id`, `municipal_registration`, `fiscal_email`,
`billing_entity` (not null, default `'STATIONS'`), and the seven address names.

`'STATIONS'` is the default because it is what is true today: nothing has ever
been recorded at the group level, so the group cannot be the emitter until
somebody says so.

### 8.2 `companies` — twelve new columns

The eight of §6.1's contact block and the four of its invoicing block.

### 8.3 Doors

| Function | Note |
| --- | --- |
| `provision_organization(p_user_id, p_organization_name)` | replaces `provision_customer`; creates no Station (D1) |
| `update_organization(...)` | the name, the invoicing block, the address, the selector. New — nothing can rename an Organization today |
| `list_organizations()` | the screen's list, with the Station count and the owner |
| `update_company_profile(...)` | gains the twelve parameters of §6.1 |
| `get_integration(p_company_id)` | `list_integrations`' single-Company sibling |
| `list_api_credentials_for(p_company_ids uuid[])` | see §9 |

All gated on `is_platform_admin()`, the gate `/admin` already requires.

`update_organization` and `update_company_profile` each **write every field they
take on every call, never merged** — the convention `update_prize`,
`update_role` and `update_song` all follow, so a partial submission blanks what
it omits and there is one rule rather than a per-field guess. The Station's
picture keeps its own writer for exactly that reason (0153), and the same will be
true of anything else uploaded rather than typed.

`provision_customer` is **dropped**, not left beside its replacement: two
provisioning doors where one creates a Station and one does not is a coin-flip
waiting to be got wrong.

---

## 9. A Block 15 defect this closes

Block 15's Station form never rendered. The cause, found on 2026-08-09:
`page.tsx` read the Station's record only when the address already carried
`?record=`, and `use-record-dialog.ts` opens a record **without a server round
trip** — deliberately, so the list underneath does not re-run its keyset query
and lose the operator's place. Clicking the pencil therefore never gave the
server a chance to load anything, and the form, gated on that data, drew nothing.
The API keys tab appeared because an empty list and an issue form need no server
data.

The house pattern is to load for **every row on the page** up front, the way
`initialStationsByOrganization` already does. Block 15 broke it.

**D3 makes the pattern affordable again.** A list filtered to one Organization is
three or four Stations rather than twenty-five, so the record and the keys for
all of them are read in the page's own query — no dialog fetch, no second round
trip. The bulk `list_api_credentials_for` in §8.3 is what keeps that one query
rather than one per row.

---

## 10. What is removed

- `/admin/customers` — the route redirects; the screen's parts are split between
  the two new ones.
- `/admin/integrations` as a menu item and a screen (D6).
- `provision_customer` (§8.3).
- `CUSTOMER_TABS` in `src/lib/record-params.ts`, replaced by `ORGANIZATION_TABS`
  and `STATION_TABS`.

---

## 11. How it is proved

**pgTAP** — the new columns and their CHECKs; `billing_entity` defaulting to
`STATIONS`; `provision_organization` creating an Organization and **no** Company;
`update_organization` refusing a caller who is not a platform admin; the CNPJ
shape.

**Isolation** — that `list_organizations` and both new screens are refused to a
signed-in customer who is not a platform admin. pgTAP cannot see this: it runs as
superuser with a null `auth.uid()`.

**Vitest** — the CNPJ normaliser, the invoicing-emitter resolution (given an
Organization and a Station, which record does the biller read?), the combobox's
empty state.

**Playwright** — provision an Organization, add a Station to it, fill the
Station's record, see the picture on the card at `/app`. This is also the
regression test for §9: the form must render on a **click**, never only on a
pasted address.

---

## 12. Risks, stated rather than discovered

**The empty Organization is a new state** (D1). Every screen that assumes a
member has at least one Station has to tolerate none. `/app` already does; the
others are checked in Task order.

**`provision_customer` disappearing is a breaking change** for anything calling
it outside this repository. Nothing does today — it is reachable only from the
console — but it is named here so the removal is a decision rather than a
surprise.

**Twenty-four new columns is a lot of form.** Two tabs will be long. If it reads
as a wall, the answer is grouping inside the tab, not spreading across more tabs:
somebody filling a fiscal block wants it in one place.

**The emitter selector has no consumer yet** (D9). Nothing in this product reads
`billing_entity` — it is recorded for a human. A field nothing reads is the shape
of `audit.view` before Block 10a, which existed for nine blocks as a flag that
looked like a control. The difference, and the reason it is acceptable here: this
one is data the operator reads on screen, not a permission the system is supposed
to enforce.
