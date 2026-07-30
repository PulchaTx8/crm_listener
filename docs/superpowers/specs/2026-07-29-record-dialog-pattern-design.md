# Block 3c — The record dialog — Design

**Status:** approved by the owner on 2026-07-29, in conversation.
**Depends on:** Block 3b (`block-3b`, PR #13). This block is branched from it and
must be rebased onto `main` once that PR merges.

---

## 1. What this block is

Every list screen in the app currently renders its forms **on the page**, stacked
above or beside the list. The audience screen shows a registration card before the
grid; the inventory screen shows two registration cards before its table; a
listener's record lives on its own route, `/members/[memberId]`.

This block makes the record a **dialog over the list**. The grid, its filters and a
creation button are the whole screen. A record opens on top of it, is edited or
operated on, and closes — and the list underneath is never re-queried, never
re-ordered and never loses its scroll position.

**The owner's words for why**, from the design conversation: the operator should
feel like they are *inspecting the row they clicked*, close it, click the next one,
and repeat. Editing forty listeners should not mean rebuilding the list forty times
and losing the sequence of work each time.

This is a **site-wide standard**, not a members-screen feature. All five list
screens convert in this block (§7).

## 2. Decisions taken

Every decision below is the owner's, taken in conversation on 2026-07-29.

1. **The record opens over the list, and the list is never re-run.** Not a
   preference — the requirement the block exists to satisfy. §3 states what
   threatens it.
2. **The whole record lives in the dialog, in tabs.** `/members/[memberId]`
   ceases to exist as a route.
3. **The open record is addressable** — `?record=<id>&tab=<slug>` — written with
   the browser's history API so it costs no server round trip. A pasted link
   opens the list with that record open.
4. **After saving, the row updates in place and does not move.** Sort order and
   filters are re-evaluated only when the operator next navigates. A row that no
   longer matches the active filter stays until then.
5. **The trash menu offers what the domain actually has**, screen by screen. For a
   **listener** that is block, archive and erase-personal-data — and no delete,
   because the row must survive for the audit trail and for the promotions that
   reference it. Other domains differ: a role really is deletable (`delete_role`),
   and §7 lists each screen's menu as the migrations define it.
6. **Archiving ships with copy that tells the truth**: it cannot be undone from
   the app (§6.3).
7. **All five list screens convert in this block.** A half-adopted pattern leaves
   two grammars alive at once, and the unconverted half tends never to happen.

## 3. Architecture

Three layers per screen.

**The Server Component** keeps doing exactly what Block 3b built: read
`searchParams`, run the keyset query, render the grid. Unchanged.

**A thin client host** wraps it and owns three pieces of state and nothing else:
which record is open, which tab, and that record's data. It also owns the local
row patches (§5).

**The forms** that exist today move inside the dialog. They keep their server
actions, their `useActionState` shape and their `data-testid`s.

### 3.1 The guarantee, and the thing that breaks it

Every server action in this codebase ends in `revalidatePath`. Called from inside
the dialog, that returns a freshly rendered payload for the current route along
with the action's result — **which re-runs the list query**, silently, while
looking like it works.

So, stated as a rule this block enforces and tests:

> Actions invoked from the record dialog return the saved record and **do not
> revalidate the list route**. The grid is updated by patching the row on the
> client. Any action that still needs revalidation names what it revalidates and
> why, one by one.

### 3.2 Why not Next's intercepting routes

Next's own modal-over-list pattern (`@modal/(.)members/[id]`) gives the URL and the
back button for free and renders the dialog on the server. Rejected for two
reasons. The no-re-list guarantee would depend on router internals rather than on
our own code, and it would have to be re-proved on every Next upgrade. And it
presupposes keeping `/members/[id]` as a route, which decision 2 removes.

### 3.3 Two new primitives

Both in `src/components/ui/`, following that folder's existing convention —
`export const`, `React.forwardRef`, `cn()`, a `displayName`, no default export,
no `'use client'` where it is not needed.

- **`dialog.tsx`**, built on the native `<dialog>` element. Focus trapping, ESC,
  the inert backdrop and the top layer come from the platform rather than from
  code of ours that would rot.
- **`dropdown-menu.tsx`**, for the row's action menu: keyboard navigation,
  `aria-expanded`, click-outside to dismiss.

`lucide-react` is already a dependency and is used nowhere. It starts being used
here, for the pencil, the trash and the menu affordances.

## 4. The open record

**Opening.** Clicking the row's name or its pencil opens the same dialog. It
appears immediately, titled with the value the grid already knows, with a skeleton
body, and fires **one** request for the whole record — identity, links, consents,
notes, blocks. One round trip, not one per tab; the tabs render from what arrived.

**The URL.** Opening pushes `?record=<id>&tab=<slug>` with `history.pushState`, so
no server navigation occurs. **Switching tabs uses `replaceState`**, so Back always
closes the record instead of walking backwards through the tabs the operator
visited. Closing — the X, ESC or a click on the backdrop — calls `history.back()`
so no ghost entries accumulate. (The native `<dialog>` does not dismiss on a
backdrop click on its own; that one behaviour is ours.)

**Closing with unsaved edits asks first.** ESC and the backdrop are easy to hit by
accident, and silently discarding a half-typed record is the same failure as losing
it to a network error. The guard applies only where something was actually typed
and not saved.

**Saving has two shapes, and the difference is behavioural, not cosmetic:**

- Saving the **identity** tab closes the dialog and patches the row. The edit is
  finished.
- The **other tabs' operations** — record a consent, add a note, block, lift a
  block, move stock — keep the dialog open and update that tab in place, because
  they are things the operator does *while inspecting* the record, often several
  in a row.

## 5. What the grid does after each operation

The list is never re-queried, so every one of these is a local patch.

| Operation | The row | The footer total |
| --- | --- | --- |
| Identity saved | Shows what the server stored, in its current position | unchanged |
| Consent / note / block added | unchanged (not grid columns) — except a block, which flips the Block state cell | unchanged |
| Archived | removed from the grid | −1 |
| Personal data erased | stays, rendered as erased with its fields blanked | unchanged |
| Created | inserted at the top, marked as newly created | +1 |

A created record goes to the top rather than to the position the active sort would
give it, for the same reason a saved row does not move: position and filters are
re-evaluated on the next navigation. The operator just created it, so it belongs
where they can see it.

## 6. The grid's controls

### 6.1 The action column

A column pinned to the right edge, **sticky under horizontal scroll**. The
inventory table is eleven columns wide and scrolls sideways; an action column that
disappears when the operator scrolls to the balances is useless.

Two controls per row, each with an explicit accessible name — `Edit Ana Almeida`,
`Actions for Ana Almeida`, never a bare "button". Icon-only controls say nothing to
a screen reader, which was already a review finding in this project when the table
primitive shipped.

### 6.2 Permission-driven rendering

Each control renders only if the caller holds the power. The codes already exist in
the catalogue (0031 for members; the equivalents per screen):

| Control | Power |
| --- | --- |
| Pencil (edit) | `members.edit` — the same power that covers consents and notes |
| Trash → Block | `members.block` |
| Trash → Archive | `members.archive` |
| Trash → Erase personal data | `members.erase` |
| Create | `members.create` |

The other four screens gate their controls the same way, on their own codes. The
implementation plan enumerates each one from the permission catalogue rather than
inferring it from the action's name — `inventory.catalogue` and `inventory.move`
are not interchangeable, and neither are `users.manage` and `roles.manage`.

Hiding a control is **courtesy, not the boundary** — this project's existing
phrase, and still true: every RPC re-checks the power in the database before
writing. The hidden button avoids a refusal; it does not replace one.

### 6.3 The archive confirmation

`members_select_reachable` (0035) hides an archived listener from every read, for
every caller. Archiving is therefore **irreversible from the app** — nobody on the
site can see or restore that listener afterwards; only direct database access can.
The same is true of `archive_prize` against `prizes_select_inventory_view` (0029).

The owner's decision is to ship it anyway, with copy that says so:

> **Archive this listener?**
> Ana Almeida leaves every list in the app. **This cannot be undone here** — not by
> you, not by support. Only direct database access can restore it.
> To bar someone from draws without archiving, use Block instead.

Offering a way back means widening an RLS policy, which is a visibility decision
rather than a screen decision, and is out of scope (§8).

### 6.4 The creation button

Beside the filters, labelled for its domain rather than a generic "New": *Register
listener*, *Register prize*, *Create role*, *Invite*, *Provision customer*. The
inventory screen has two creatable things — a prize and a category — so it carries
two buttons rather than a menu that hides one of them.

**Registering a listener stays a two-step flow inside the dialog**: the duplicate
check by phone/e-mail/CPF first, the form second. That check is what keeps one
person from existing twice in an Organization; it is not a step to skip because it
is now inside a dialog.

## 7. The five screens

Enumerated from the migrations, not from memory. **This block wires up four RPCs
that exist in the database and have no interface at all today**: `update_member`,
`archive_member`, `update_prize`, `archive_prize`.

| Screen | Tabs | Editable? | Row menu |
| --- | --- | --- | --- |
| Members | Data · Stations · Consents · Notes · Blocks | yes (`update_member`) | block · archive · erase |
| Inventory | Prize data · Stock movements | yes (`update_prize`) | archive (`archive_prize`) |
| Roles | Role data · Powers | yes (`update_role`) | delete (`delete_role`) |
| Team | Person · Per-Station access | **no** | remove Station access · remove from Organization · revoke invitation |
| Customers | Customer · Stations · Owner | **no** | suspend · reactivate |

The tabs carry the operations that belong to them, not just data: Customers'
Stations tab is where a Station is added (`add_company`) and its Owner tab is where
a provisional password is reissued; Team's access tab is where a per-Station role
is assigned (`assign_company_role`); Inventory's movements tab is where stock is
entered, taken out, adjusted, reserved and released.

**Team and Customers have no editable data tab**, and that is a finding rather than
an omission: there is no `update_company` or rename RPC in any migration, and a
person's profile belongs to that person, not to whoever is looking at the list.
Their records open for inspection and for the operations beside them. This block
adds no RPC to close that gap (§8).

Two constraints that come from the database and that the screens must respect:

- `update_member` **replaces the whole record** rather than merging, so the data
  tab always loads and submits every field.
- It **refuses an already-erased listener**, and deliberately never touches
  `first_contact_at` / `first_contact_origin`, which are the evidence behind the
  owner's position on first-contact consent. So an erased record opens with a
  read-only data tab, and those two fields are never editable anywhere.

## 8. Out of scope

- **No migrations, no new RPCs, no policy changes.** This block is the interface
  plus the reads the dialogs need.
- **No optimistic locking.** Two operators editing one listener means last-write-
  wins, because `update_member` writes the whole record. Recorded so nobody
  discovers it by accident.
- **No bulk operations.** No multi-row selection.
- **Nothing about Block 3b's paging, filtering or totals changes.**
- **No "show archived" view** anywhere — see §6.3.

## 9. Errors

The list is already rendered behind the dialog, which means no failure of a record
needs to take the screen down.

- **The record read fails** — the dialog shows the error in its body with a retry.
  The grid behind stays intact and usable.
- **A save fails** — the message appears inside the dialog **with the typed values
  preserved**. Losing a filled form to a network error is how an operator learns
  to distrust a tool.
- **The record was archived or erased by somebody else while it was open** —
  `update_member` already distinguishes those two cases with separate messages
  rather than guessing. The dialog shows which happened, and closes.
- **`?record=<id>` for a listener beyond the caller's reach** — the list renders
  normally and the dialog opens with **one message covering both cases**, "no such
  record, or you do not have permission", carrying no name, no phone, nothing.
  RLS remains the boundary; the screen simply does not confirm whether the id is
  real. The end-to-end test that proves this today, against `/members/[id]`, is
  rewritten for the new shape rather than dropped.

## 10. Accessibility

Half the work of a dialog, and most of it comes from choosing the native element.

- Focus enters the dialog on open and **returns to the control that opened it** on
  close.
- The rest of the page is inert while it is open.
- ESC closes.
- Tabs respond to arrow keys, as real tabs do.
- On a narrow viewport the dialog is a full-height sheet, not a small centred box.

## 11. Testing

The central promise is a negative — "opening, editing and closing does **not**
re-run the list" — and a negative is not verified by looking at the screen. It is
verified by counting.

**The block's proof**, in Playwright: open a record, switch tabs, save, close, open
the next one, and count the requests that would re-render the list. The assertion
is zero. The record read and the save itself are expected and are not counted.

**The mutation that proves the proof bites:** put a `revalidatePath('/members')`
back into one of the actions. The test must go red. That is precisely the
regression somebody will introduce three blocks from now, out of habit.

The rest:

- **Unit** — the URL ⇄ record/tab encoding, in the shape of the existing
  `list-params` modules; and the row-patch reducer: save updates fields and holds
  position, archive removes and decrements, erase blanks and keeps, create
  prepends and increments.
- **Isolation, under real JWTs** — the new whole-record read must be RLS-narrowed:
  a delegate at another Station gets nothing. Plus `update_member` and
  `archive_member` through the new path, which have no coverage today because they
  have no interface.
- **End to end** — focus returns to the pencil on close; ESC closes; Back closes
  the dialog rather than leaving the screen; and the `?record=` security case
  above.
- **The existing journeys are rewritten**, because they navigate to
  `/members/[memberId]`, which stops existing. Rewritten, not loosened: every
  assertion they make today is still made.

**What gets no automated coverage, said now rather than discovered later:** how the
dialog looks on a narrow viewport, and how it behaves in a real screen reader. The
tests prove focus *moves*; they do not prove the experience is good. Those are
verified by hand in a browser, the way Block 3's two gaps were.

## 12. Definition of done

- All five screens converted; no form renders on a list page any more.
- `/members/[memberId]` removed, and every link to it updated.
- The no-re-list proof passes, and has been shown to fail under its mutation.
- Every gate at its real defaults: lint, typecheck, unit, pgTAP, isolation, build,
  and the e2e suite against a production build.
- A block report in `docs/`, following the shape of `docs/block-3b-report.md`.
