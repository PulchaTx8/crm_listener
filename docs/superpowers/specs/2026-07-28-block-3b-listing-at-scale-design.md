# Block 3b — Listing at scale — Design

**Date:** 2026-07-28
**Status:** approved by the owner, ready for an implementation plan
**Position:** inserted between Block 3 (Members) and Block 4 (Promotions), following
the precedent of Block 1c, which was inserted before Inventory.

---

## 1. What this block is, and what it deliberately is not

Every list in this product renders every row it can see. There are eleven list
surfaces and **not one of them paginates** — no `.range()`, no cursor, no page
control exists anywhere in `src/`. Only two carry a row limit at all, and both are
dead ends: they fetch one row past the limit purely to print "showing the first N",
with no way to reach row N+1.

This was invisible while the data was small. At the owner's projected scale it is
not:

| Screen | Rows it will load | Behaviour today |
| --- | --- | --- |
| Inventory | 300–30,000 prizes per Organization | loads **all** of them, filters in the browser |
| Members | 30,000–60,000 per Organization | hard cap of 50, no next page |
| Admin customers | 1,500 companies (15,000 at 10× growth) | unbounded |
| Station picker | 2,500 companies platform-wide | first 50 alphabetically, no way past |

**This block is not a performance optimisation.** Sixty thousand rows behind an
index is a millisecond query for Postgres; thirty thousand prizes is nothing. The
screens are not slow because the data is large. They are broken because nothing
pages, and one of them does its filtering after transferring the entire table to the
browser.

**It is also not a generic data-table framework.** See §4.

---

## 2. Decisions taken

Every one of these is the owner's, taken during the design conversation on
2026-07-28.

1. **Keyset pagination — Previous/Next, no page numbers.** Constant cost at any
   depth. Jumping to page 37 is given up deliberately; nobody browses 60,000
   listeners by page number.
2. **Exact total on the filtered result, on the two tenant-scoped screens — always
   exact, never estimated.** Keyset paging and a count are independent, and at
   30–60k rows per Organization a count is cheap even through a free-text ILIKE,
   because every query is cut to one Organization by RLS before it touches disk. The
   owner's stated need is counting ("how many listeners are from São Paulo"), which
   Previous/Next alone cannot answer.

   An earlier draft of this section proposed a planner estimate above a threshold.
   That was calibrated for hundreds of thousands of rows, which is not this
   product's per-tenant scale, and below the threshold it would have rendered an
   estimate in a footer that reads as fact — on the one screen whose purpose is
   answering "how many". Revisit only with a measurement, never with an estimate
   wearing a total's clothes.

   **The two admin screens get no total** — they are platform-wide, so §3's
   comfortable per-tenant arithmetic does not apply to them, and they are operator
   tools rather than screens that answer "how many".
3. **CSV export is cut from this block entirely.** See §8.
4. **Station is not a column on the audience list.** A listener belongs to the
   Organization and interacts with any of its Stations; the Station link is an
   access-control mechanism, not an attribute of the person.
5. **City is not a filter in this block.** See §7.
6. **The Team screen does not get pagination.** See §6.

Three decisions from earlier blocks were re-examined against the owner's reference
ER diagram and **explicitly confirmed unchanged**: the CPF is stored as
`cpf_hash` + `cpf_last_digits` and never raw; prize quantity is derived from the
`inventory_movements` ledger and its seven projected buckets, never a maintained
column; and a promotion's state is derived from `data_inicio`/`data_fim` with no
`ativo` flag. The ER diagram is a reference for **table hierarchy only**, not a
schema to implement.

---

## 3. Scale, and why the per-Organization number is the one that matters

Owner's projection: ~500 Organizations, averaging 3 Companies each (radio, TV),
each Company serving a whole city with 10–20k listeners, and holding between 100
and 10,000 prizes. Ten users per Company. Hundreds of promotions per Company.

| Entity | Per Organization | Platform (500 orgs) | Scope |
| --- | --- | --- | --- |
| companies | 3 | 1,500 | Organization |
| members | 30,000–60,000 | 20–30 million | Organization |
| prizes | 300–30,000 | 150k–15 million | **Station** |
| internal users | ~30 | ~15,000 | Station |
| promotions | ~600 | ~300,000 | **Station** |
| participations | millions | billions | Station × listener |

Listeners are Organization-scoped and the Companies serve distinct cities, so the
audiences barely overlap: 3 × 20k ≈ 60k per Organization, deduplicated.

**Every query in this block is cut to one Organization by RLS before it touches
disk**, so the middle column is what any screen must handle. That is a comfortable
size. The genuinely large tables are elsewhere and are not this block's problem:
`audit_logs` grows one row per write across the entire system, and `participations`
(Block 4) will exceed everything else by an order of magnitude. Both need their own
strategy — retention, partitioning, archival — and neither is in scope here.

**The two admin screens are the exception**: they operate platform-wide with no
Organization cut, so they carry 1,500–15,000 real rows. Keyset paging handles that
comfortably, but their totals are the only counts in this block that are not
trivially cheap — so they get Previous/Next **without** a total. They are operator
tools, not screens that answer "how many".

---

## 4. Architecture: query in TypeScript, one predicate in the database

Filters, sort and cursor travel in the URL. The Server Component reads
`searchParams`, calls the service, and the service builds the query with the keyset
condition. It returns the page's rows, the next cursor, and the filtered total.
Previous/Next are links that change the cursor — no client state, and the page is
shareable by link, which is what makes "send me the ones from Campinas" work.

This is the pattern the codebase already uses: the audience search puts `q` in the
URL today.

**Two alternatives were considered and rejected.**

*A listing RPC per domain, in PL/pgSQL.* One round trip per page, count and rows in
one query. Rejected because `SECURITY DEFINER` bypasses RLS, so each listing RPC
becomes a new place the visibility boundary can leak — five screens, five such
places. Block 3 spent two review rounds on exactly that class of defect. Querying
through RLS keeps the boundary in one already-reviewed place. It is also the most
rigid option: every new filter becomes a migration.

*A generic data-table engine.* Describe columns, filters and sorts declaratively;
generate query and UI for any table. Rejected as premature abstraction. Five
surfaces with genuinely different needs — inventory has category and balance
buckets, Team has a role per Station, the audience has age and block state — and the
configuration ends up more complex than the code it replaces. Block 3's lesson was
that the right answer to duplication is **one small specific function**, not an
engine.

**One piece does go into the database**: the bulk block predicate (§5), because the
N+1 it replaces cannot be fixed from the client.

---

## 5. The three shared pieces

**A keyset cursor helper** (`src/lib/`). Pure TypeScript, the only place that knows
how a cursor is encoded. The cursor must carry the sort column **and the `id` as a
tiebreak** — without it, two listeners with the same name make pagination skip or
repeat rows.

**A table primitive** (`src/components/ui/table.tsx`). None exists today: the eleven
lists are stacks of bordered `div`s, and the only `<table>` in `src/` is hand-rolled
inside the reconciliation panel. Header with a sort indicator, body, and a footer
carrying the total and Previous/Next. Presentation only — it knows no domain.

**A bulk block predicate**, in a migration. Today the audience list costs up to one
`is_member_blocked` RPC **per listener per reachable Station** — around 107 round
trips for a 50-row page. Worse, `is_member_blocked` is `SECURITY DEFINER` and
re-runs its full caller guard on every call: a `permissions` lookup, plus
`has_company_access`, plus a `company_memberships ⋈ roles ⋈ role_permissions` join.
The same permission subtree is recomputed fifty times for the same Station. One call
replaces all of it.

That guard was added deliberately in Block 3 to close a cross-tenant oracle, and it
stays. The cost is why this list needs a bulk predicate, not a reason to remove it.

### Indexes

Verified against `0031_members.sql`. An index on the name exists — but on
`lower(full_name)`, so **sorting must order by `lower(full_name)`** or the index is
silently ignored. Nothing indexes `created_at` or `birth_date`.

```
(organization_id, created_at, id)     -- sort by registration + cursor
(organization_id, birth_date)         -- age filter, as a date range
```

Both partial on `where deleted_at is null`, following the project's convention.
Inventory and the admin screens get the equivalent for whatever they sort by.

**The age filter must be converted to a birth-date range in the query.** Computing
an age per row in the `WHERE` clause defeats every index and turns the query into a
full scan. The column on screen still displays an age; computing that for 50 rows is
irrelevant.

---

## 6. What changes on each screen

**Audience (`/members`)** — the full treatment. Columns: **Name · Phone · E-mail ·
CPF (last 3) · Age · City · Registered · Block state**. Filters: **age, block state,
rules consent, registration period**. Sort: **name, registered**. Keyset paging with
the filtered total. The bulk predicate replaces the N+1.

Block state and consent are filters, not sorts, deliberately: block state is derived
from dates rather than stored, so sorting by it would mean recomputing it for every
row in the table. Filtering "blocked only" answers the same need at a fraction of
the cost.

The existing subtitle — "The audience across every Station you can reach" — stays.
It is what keeps the list honest about being RLS-narrowed without making Station a
column.

**Inventory (`/inventory`)** — the most urgent. The screen loads **every** prize and
filters in the browser; at 10,000 it does not open. Becomes a server-side filtered,
paginated table **with the filtered total**, on the same terms as the audience: it is
Organization-scoped through its Station, so the count is cheap. Columns: prize, code,
category and the balance buckets. Filters: category and archived state. It is already
per-Station with a switcher — that part is correct and matches the schema, where
`prizes` and `prize_categories` are Company-scoped with a composite key. Shipped
alongside: the prize-by-id lookup currently loops `listPrizes` **sequentially over up
to 50 Companies** to find one prize; it becomes a direct query.

**Team (`/team`)** — **no pagination.** At the owner's real scale, 30 users and 3
Companies per Organization, the screen is fine: 30 rows, and the nested
per-Station-per-role controls come to roughly 90 blocks, not thousands. It gets two
small corrections the survey found: the query does not filter `deleted_at`, unlike
every other list in the project, and it has no bound at all — a high limit is added
as a safety net, not as paging.

**Admin customers console** — paging and search. 1,500 rows today, unbounded.

**The 50-Station cap** — `COMPANY_SCAN_CAP` returns the alphabetically-first 50 with
no route to the 51st. For an owner with 3 Stations it never fires; for a platform
admin it is a dead end. Becomes search rather than a cap.

---

## 7. City is a column, not a filter — and why

The owner's rule for geography, decided on 2026-07-28: **either a record links to a
valid geographic code, or it has no link. No free text alongside.** A listener whose
city was never selected has no city, and falls out of geographic reports or appears
as "undefined".

That rule is correct, and it is why the city filter cannot be built here. `members`
today stores `city`, `neighbourhood` and `state` as free text — columns the geography
block will remove. A city filter built now would filter the very column that gets
dropped, and until then would **count wrongly**: `Campinas`, `campinas`,
`Campinas/SP` and `Campinas - SP` are four distinct values on a screen whose stated
purpose is answering "how many".

So: the city column stays **visible** in the table, showing whatever is stored. It
does not become a filter or a count. The age half of "how many 18-year-olds are from
Campinas" works in this block; the city half waits for geography, where it is exact.

**Recorded for the geography block**, not built here: `countries → cities →
neighbourhoods`, with **state as a column on `cities`** rather than its own table.
`organizations`, `companies` and `members` all gain an optional structured address —
**nullable links, never a registration blocker**. Since a record with no link is
invisible to a geographic filter, that block needs a reconciliation view showing how
many addresses remain unlinked, in the shape the inventory reconciliation already
uses — otherwise a report lies by omission.

---

## 8. CSV export is cut

Export was in the original scope and is removed. It is the highest-risk feature in
the block and the owner's lowest priority — that combination decides it alone.

Done properly it needs its own permission, a row cap, an audit entry and streaming so
60,000 rows are not assembled in memory. Done halfway it creates the largest
personal-data egress surface in the product without the controls that make it safe:
a delegate holding `members.view` at one Station downloading names, phones, e-mails
and CPF fragments for tens of thousands of people, in one click, past everything
Block 3 built. RLS does not protect a CSV already on someone's laptop.

Deferring costs nothing structurally — export sits on top of pagination and filters,
so once those exist it is an isolated addition.

**Three decisions are already taken, so whoever builds it does not re-litigate them:**
a dedicated `members.export` permission, separate from `members.view`, so seeing and
taking away are different powers; a row cap; and a mandatory `audit_logs` entry
recording who, when, which filter and how many rows — with no personal values, which
keeps it consistent with Block 3's rule that the audit trail holds no personal data.

---

## 9. Errors

Block 3's typed-error taxonomy continues to apply. Two new situations arrive by URL,
and URL is hostile input:

- **An invalid or tampered cursor resets to the first page.** It never surfaces as a
  server error.
- **A filter value that does not parse** — a malformed date, a non-numeric age —
  becomes an inline message on the form, not a crash.

---

## 10. Testing

**The bug that matters is skipped or repeated rows when sort values tie.** Two
listeners with the same name and the next page starts in the wrong place. It is
invisible: pages load, the count looks right, and somebody vanishes from the middle.

So the load-bearing test seeds listeners with **identical names**, walks every page,
and asserts the traversed set is exactly the expected set — no gaps, no repeats.
**Removing the `id` tiebreak must turn it red.**

Alongside it: cursor encode/decode round-trip as a unit test; the age→birth-date
range conversion; and, under real JWTs, that paging never escapes RLS on any page.

**Performance is deliberately not asserted by automated test.** Timing assertions are
flaky and prove little. What is verifiable and stable is that the query plan uses the
intended index, and that is what gets checked.

---

## 11. Definition of done

- Keyset paging, filters and sort on the audience and inventory screens, each with
  its filtered total.
- Paging and search on the admin customers console; search replacing the 50-Station
  cap.
- Team's `deleted_at` filter and safety bound.
- The bulk block predicate replacing the per-row N+1.
- The tie-breaking pagination test, red when the tiebreak is removed.
- Every gate at real defaults: `lint`, `typecheck`, `test`, `test:isolation`,
  `supabase test db`, `build`, `test:e2e`.

---

## 12. Out of scope

- **CSV export** (§8), with its three decisions recorded.
- **Geographic tables and the city filter** (§7) — the next block.
- **`audit_logs` and `participations` growth strategy** — retention, partitioning and
  archival, when those tables exist and matter.
- **Song requests (`PedidoMusica`, `Musica`)** — a domain the owner's ER diagram
  introduced that appears in no block of the plan. It bridges listener to Station
  directly, the same bridge participations use. Likely belongs near Block 5
  (WhatsApp), where a request arrives by message.
- Any generic table framework (§4).

---

## 13. Open risks

1. **The city column shows data that will be discarded.** Until the geography block
   lands, the audience table displays free-text cities that the geography rule will
   remove. Anyone reading them as reliable is reading wrong, and nothing on screen
   says so. The block report must say it plainly.
2. **The bulk predicate is a new `SECURITY DEFINER` surface.** It replaces an N+1
   whose guard was itself added to close a cross-tenant oracle. The same guard must
   hold in bulk form, and it must not become a way to ask about listeners outside the
   caller's reach. This is the single thing in the block most worth reviewing hard.
3. **Two admin screens have no Organization cut**, so every assumption in §3 about
   comfortable per-tenant sizes does not apply to them. Their paging must be keyset
   from the start rather than retrofitted.
