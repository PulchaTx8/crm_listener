# Block 3c — The record dialog — Verification Report

Branch `block-3c`, taken from `block-3b` and **rebased onto `main` at `a407efe`**
once PR #13 merged. The rebase was clean and left the tree byte for byte what it
had been — `main` carried no content of its own beyond the merge commit.
Seventeen commits of this block's own — the spec, the
plan, and fifteen of work: two UI primitives, two pure modules with their tests,
one hook, and five list screens turned into grid + record dialog, with the two
detail routes they replaced deleted.

**What the block set out to do, and did:** every list screen is now a grid with
filters and a create button, and a record opens as a tabbed dialog **over** that
list. Opening a record, moving between its tabs, saving it and closing it does
not re-run the list query. `/members/[memberId]` and `/inventory/[prizeId]` are
gone.

**No migrations, no new RPCs, no policy changes.** Four RPCs that shipped in
earlier blocks with no interface at all reached one here: `update_member`,
`archive_member`, `update_prize`, `archive_prize`. `add_member_note` still has
no screen, deliberately.

---

## 1. Verification

Every gate below was run at its real defaults on the final tree.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | ✔ no ESLint warnings or errors |
| Types | `npm run typecheck` | clean |
| Unit | `npm test` | **206 passed**, 18 files |
| Database | `npx supabase db reset` then `npx supabase test db` | **244 passed**, 3 files, `Result: PASS` |
| Isolation | `npm run test:isolation` | **101 passed**, 11 files, under real JWTs |
| Build | `npm run build` | compiled successfully |
| End to end | `CI=1 npx playwright test --workers=2` | **10 passed** |

Unit tests went from 188 to 206: eleven cases for `record-params`, seven for
`row-patch`. Isolation went from 95 to 101: the six in
`tests/isolation/record.test.ts`. End to end went from 9 to 10:
`tests/e2e/record-dialog.spec.ts`. pgTAP is unchanged at 244 — this block added
no SQL.

### 1.1 One local-stack trap, which is not the code

`npx supabase db reset` restarts the stack's containers, and Kong comes back
holding a **stale upstream for the auth container**. Every request through
`/auth/v1/…` then returns `502 {"message":"An invalid response was received from
the upstream server"}`, which supabase-js surfaces as an `AuthRetryableFetchError`
whose `message` is the string `"{}"`. In Playwright that reads as

```
Error: could not create admin: {}
```

from every spec's `beforeAll` at once — which looks exactly like a broken test
harness and is not one. `docker restart supabase_kong_<project>` fixes it in
about ten seconds. The sequence that works locally is **reset, restart Kong,
wait, then run**. This is the same class of trap as Block 3b's invitation
rate-limiter, and it costs the same half hour if it is not written down.

---

## 2. The rule this block rests on, and what actually enforces it

**No action invoked from a record dialog calls `revalidatePath` on its list
route.** Five action files carry that as a banner comment: `members`,
`inventory`, `roles`, `team` and `admin/customers`.

`tests/e2e/record-dialog.spec.ts` counts requests that would re-render
`/members` — a document navigation, or an RSC fetch (`_rsc` query parameter or
`RSC: 1` header) — across a journey that opens two records, switches three tabs,
saves, closes with ESC and closes with Back. It asserts zero.

**That counter cannot see a `revalidatePath`, and the spec now says so in its own
comment.** Next returns the re-rendered tree **inside the server action's own
POST response**, which the counter deliberately excludes — a POST to the action
endpoint is exactly what a legitimate save looks like. Written naively, this
spec would have been the sixth test in this project that cannot fail.

What catches a reintroduced `revalidatePath` is the **row-position assertion made
at the moment of the save**, and it is asserted there rather than at the end of
the journey so that the failure names its cause. The list is sorted by name and
the save renames the first row to `Zoe …`; a list rebuilt from the server
re-sorts and the row moves.

### 2.1 The mutation, verbatim

`revalidatePath('/members')` was put back into `updateMemberAction` and the spec
re-run:

```
  1) tests\e2e\record-dialog.spec.ts:97:5 › the record opens over a list that is never re-queried

    Error: expect(locator).toContainText(expected) failed

    Locator: locator('[data-testid="member-row"]').first()
    Expected substring: "Zoe Dialog 1785345651635"
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toContainText" with timeout 5000ms
      - waiting for locator('[data-testid="member-row"]').first()
        3 × locator resolved to <tr data-testid="member-row" …>
          - unexpected value "Ana Dialog 1785345651635—————29 Jul 2026—"

    > 266 |   await expect(ownerPage.locator('[data-testid="member-row"]').first()).toContainText(renamed);
```

The row did not merely move — it reverted to the name it had before the save,
because the re-rendered list threw away the patch the grid had just applied.
That is the whole damage, stated by the test.

An earlier run of the same mutation, before this assertion was moved to the
point of the write, failed five lines later on `Saved.` being absent. It went
red either way; it named its cause only after the reordering.

Restored with `git checkout --` as a separate command, never chained behind the
failing run, and verified with `git diff` (empty) before continuing. The full
suite was then re-run: 10 passed.

### 2.2 Assertions shown to fail under mutation

| Assertion | Mutation | Result |
| --- | --- | --- |
| `withRecord` replaces rather than appends | `query.append` for `query.set` | red (Task 3, recorded in that commit) |
| A saved row keeps its position | re-sort inside `applyRowPatch`'s save branch | red (Task 4) |
| A saved row keeps its position, end to end | `revalidatePath('/members')` in `updateMemberAction` | red, §2.1 |

---

## 3. What the block found

Five defects, none of them in the plan, all found by writing the tests and by
looking at the screens rather than at the code.

**3.1 The record dialogs never re-read themselves after a write made inside
them.** The detail pages they replaced got that from
`revalidatePath('/members/[memberId]')`; those routes are gone, and the list
route must never be revalidated — so recording a consent, a block, a lift or a
stock movement wrote the row and then did not show it. Each record now refreshes
itself through the one server action that opened it. This is not a hole in the
rule: the prohibition is on re-running the **list**, not on reading one record
again, and nothing about the screen behind the dialog is re-rendered.

**3.2 Registering read the new record twice.** `onRegistered` fetched the whole
record to build a grid row while the dialog fetched the same record to display
it, both in the same tick. The record is opened on the id the write returned and
the row comes from that read. The same shape is now used for a newly registered
prize, which previously got **no row at all** until the next navigation.

**3.3 The row action menu was invisible on a narrow viewport.** Found by hand
(§4), not by any test. `Table`'s wrapper carries `overflow-x-auto` so wide
columns scroll instead of the page; a computed `overflow-x: auto` forces
`overflow-y: auto` as well, so the wrapper clipped the absolutely positioned
menu. The trigger toggled, `aria-expanded` flipped, and nothing appeared. The
panel is now portalled to `document.body` and positioned `fixed` from the
trigger's rect, following it on scroll and resize.

**3.4 The inventory ledger stopped naming the far end of a movement.** When the
history moved into the dialog it began skipping a null bucket, so a stock entry
read `50 · to Available` with nowhere named for the stock to have come from —
losing exactly what `formatBucket(null)` ("outside the Station") exists to say.

**3.5 Two controls named "Close" in one dialog.** The header's icon button and
the footer's button had the same accessible name, so nothing that reads names —
a screen reader, or a test — could tell them apart. The icon is "Close record"
now.

---

## 4. Verified by hand, on the running app

Driven at **390 × 844** through a real browser against a production build, with
screenshots taken and read back. What was seen, not what was expected:

- **The record is a full-height sheet, not a floating box.** Header pinned at
  the top with the title and the registered date, tab strip under it, the body
  scrolling, the footer's Close pinned at the bottom. Scrolling to the end of
  the Data tab left both pinned and moved only the fields.
- **The Data tab's two-column grid collapses to one column** at that width, and
  every field remained reachable.
- **The row action menu was broken** and is fixed (§3.3): re-checked after the
  fix, the panel appears below the trigger, over the table, with "Block
  listener…" and "Archive listener…" legible.
- **The filters and the create button stack** above the grid rather than
  overflowing, and the grid itself scrolls sideways with the actions column
  pinned to the right.

**What was NOT verified, stated plainly:** the focus behaviour was checked with
Playwright (`toBeFocused` after ESC, and the native `<dialog>`'s own focus trap),
**not in a real screen reader**. No screen reader was run against this build.
NVDA or VoiceOver on the record dialog — the tab strip's `role="tablist"`
without `aria-controls`, and the portalled menu's placement in the DOM away from
its trigger — is the check this block did not perform, and it is worth doing
before this pattern is copied any further.

---

## 5. Decisions worth keeping

**Team and Customers have read-only data tabs, and that is a finding rather than
an omission.** No migration defines `update_company` or a rename, and a person's
profile belongs to that person. Their records open for inspection and for the
operations beside them, so the pencil is an "open" affordance there — same icon,
same place, no Save button on the first tab. The tabs still carry writes:
`add_company` on Customers' Stations tab, the provisional password on its Owner
tab, `assign_company_role` and `remove_company_access` on Team's access tab, and
the Organization role — an operation on the membership, not a field of the
person — on Team's Person tab.

**Archiving is irreversible from the app, on both listeners and prizes, and the
confirmations say so.** That is literally true and not caution:
`members_select_reachable` (0035) and `prizes_select_inventory_view` (0029) both
carry `deleted_at is null`, so an archived row leaves **every** read for **every**
caller — the delegate who archived it and the owner alike. The isolation suite
proves it for a listener from both sides (§6). Only direct database access
restores one.

**Five actions stopped swallowing their failures.** `changeOrgRole`,
`assignCompanyRole`, `removeCompanyAccess`, `removeMember` and `revoke` were
plain `<form action={…}>` handlers with nowhere to put a message: a refusal was
logged and then rendered as nothing having happened. Through `useActionState` the
sentence comes back with the result. The same change retired the `?deleteError=`
and `?stationError=` round trips and the redirects that existed only to clear
those parameters from the address bar.

**A role's two halves are one form across two tabs.** `update_role` replaces the
permission set wholesale, so the Powers panel is hidden rather than unmounted
when the Role data tab is showing — `hidden` keeps its checkboxes in the
submission where unmounting would silently strip every power the role has.

---

## 6. Isolation coverage added

`tests/isolation/record.test.ts`, six cases, every one driven by a **non-owner
delegate** — the discipline `members.test.ts` adopted after Block 1c shipped two
defects that thirteen reviews missed because the owner's bypass hid the
delegate's failure. They call the service functions the server actions call,
with a real delegate's access token, which is the whole of what those actions add
beyond `requireAccessToken()`.

| Case | Proves |
| --- | --- |
| whole-record read, reachable | the record and all four tab reads come back |
| whole-record read, another Station | `getMember` returns **null**, and each tab read returns empty — the `?record=<id>` oracle is closed |
| `update_member`, with `members.edit` | the save lands and the re-read shows what was stored, including a field blanked by the wholesale replace |
| `update_member`, without it | rejected, and the row is unchanged for a caller who can still read it |
| `archive_member`, with `members.archive` | archived, and the row leaves every read for the delegate **and** the owner |
| `archive_member`, without it | rejected, nothing half-done |

---

## 7. Open, and deliberately not done

- **`add_member_note` still has no interface.** The Notes tab reads; writing one
  is a screen this block did not take on.
- **No screen reader was run** (§4).

The rebase onto `main` that this section used to list as open was done before the
branch was pushed. Lint, types and the 206 unit tests were re-run on the rebased
tree and are green; the database, isolation, build and end-to-end gates were not
re-run locally against it, because the tree is identical to the one they passed
above — CI runs them on the pull request.
