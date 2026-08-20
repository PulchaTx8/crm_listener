# Block 30a — the listener card, and the number that stops travelling

**Date:** 2026-08-20
**Depends on:** Block 22 (merged) — `reveal_request_phone` and the masked
Requests grid are the precedent this block generalises.
**Blocks:** nothing. 30b–30e are independent of it.
**Parent request:** the owner's 19-item list of 2026-08-19, items **3, 4, 5, 6
(mask half), 7, 9 (View half)**.

---

## 1. What this delivers

Three screens — Pickups, Participations, Requests — stop sending a listener's
telephone number to the browser with the list, and gain a shared read-only
listener card that shows sensitive fields masked and reveals one at a time,
audited. Pickups also gains a Hand over window that shows what is being handed
over before it is handed over.

## 2. What this deliberately does not deliver

- **The Refresh buttons** on Participations, Members and Requests, and the
  Birthday filter. Block 30b.
- **Any change to the Members screen itself.** `MemberRecordDialog` keeps its
  five tabs, its edit powers and its unmasked fields: it is reached from the
  screen whose whole purpose is administering a listener, by a caller who
  already holds `members.edit`. This block adds a second, narrower window for
  three screens that only read.
- **A `members.reveal` permission.** The boundary stays `members.view`, which is
  the boundary `reveal_request_phone` already draws and the one all three
  screens already compute.

---

## 3. The five items, mapped

| Item | Screen | What changes |
| --- | --- | --- |
| 3 | Pickups | grid shows `•••• 1234` instead of the number |
| 4 | Pickups | **View** opens the listener card |
| 5 | Pickups | **Hand over** opens a window before it delivers |
| 6 (mask half) | Participations | grid shows `•••• 1234` |
| 7 | Participations | a second row action opens the listener card |
| 9 (View half) | Requests | **View** opens the listener card |

---

## 4. Decisions

### D1 — The mask is the door's job, not the screen's

`list_pickups` (0095) and `list_participations` (0090) currently return
`m.phone` whole to any caller holding `members.view`. Both stop, and return the
last four digits instead — the shape `list_music_requests` already returns
(`member_phone_last4`, 0191).

This is the block's central decision and it is not cosmetic. Masking in React
would leave the whole number in the HTML payload, in the browser's memory and in
any error report the page produces: *"masking a number the page already carries
would be a lock on a door standing in an open field"* — `services/music.ts`
already says exactly this about the screen Block 22 fixed. The same argument
applies unchanged to these two.

**Rule 2 of each door is untouched.** A caller without `members.view` still gets
null, not four digits. Withholding and masking are different facts and the
narrowing must not collapse them.

### D2 — One card, one door, three screens

A new client component `ListenerCardDialog` (`src/components/members/`), opened
from all three grids. It reads through a new Server Action that returns an
**already-masked** projection; nothing sensitive reaches the browser unrevealed.

Read path: `getMember` (`services/members.ts`) — RLS, invoker, unchanged.
`members_select_reachable` (0035) already decides which listeners a caller may
read, and it is the same boundary the three screens rely on. No new read door.

Masked in Node, in a new pure module `src/lib/members/mask.ts`, so the rules are
testable without a browser or a database:

| Field | Masked as | Revealable |
| --- | --- | --- |
| `phone` | `•••• 1234` (`maskedPhone`, reused) | yes |
| `email` | `j•••@•••.com` — first character, domain suffix | yes |
| `passport` | `•••• 4821` | yes |
| `addressLine` + `addressNumber` + `addressComplement` | `••••` | yes, as one field |
| `cpfLastDigits` | shown as-is | **no** — the column holds only the last digits; the CPF itself is a hash (0031) and there is nothing to reveal |
| `birthDate`, `gender`, city, state, neighbourhood, country | shown as-is | n/a — the geography is what the dashboards already aggregate, and a birthday is what 30b filters on |

Under four digits, a mask renders as `••••` with nothing after it. A mask that
reveals a two-digit number is not a mask — `participation-dialog.tsx` already
states this rule for phones, and it is generalised here.

### D3 — Revealing is a second call, and it is audited

New door, modelled line-for-line on `reveal_request_phone` (0190):

```sql
public.reveal_member_field(p_member_id uuid, p_field text) returns text
```

- SECURITY DEFINER, `search_path = pg_catalog, public`.
- Gated on `has_permission('members.view', …)` in **some Station this listener
  is linked to** (`member_company_links`), not in a Station named by the caller.
  A caller who cannot reach the listener gets 42501 and a `raise log`.
- `p_field` is one of `phone`, `email`, `passport`, `address` — anything else is
  a 22023. A door that selects a column named by its argument is a door that
  selects any column.
- `for share` on the member row, **not** `for update` and **not** a bare read.
  0190's comment argues this at length: `anonymize_member` (0034) erases through
  a plain UPDATE, which under READ COMMITTED never blocks an unlocked reader, so
  a disclosure racing an erasure could hand a human the live number a moment
  before the scrub commits. Same lock, same reason, one door over.
- Returns null for an anonymised listener. **The audit row is written either
  way** — somebody asked, and that is the fact being recorded.
- Audit `action` is `reveal_member_field`, `target_table` `members`,
  `detail` carries `{"field": "..."}`.

The client keeps 0190's `phoneErased` distinction: "not yet revealed" and
"revealed, and there is nothing to reveal" both start at null and would
otherwise render identically, leaving the button offered so a second click
spends another audit row to learn the same nothing.

### D4 — Participations keeps its own window and gains a second action

The existing **View** stays as it is: it opens `ParticipationDialog`, which is
the **only** screen in the product where a participation's quiz answers can be
read (`readParticipationAnswersAction`). Replacing it would silently delete that
capability.

The row gains a second action, **Listener**, opening the card. Offered only when
the caller holds `members.view` — the page already computes this
(`participations/access.ts`).

`ParticipationDialog` itself simplifies: `lastFourDigits(entry.listenerPhone)`
becomes the door's own four digits, and the local `lastFourDigits` helper goes.

### D5 — Hand over asks before it delivers

Today the Pickups row runs `deliver` through `WinnerActions`' generic
reason-only confirm strip. It becomes a window showing **Promotion, Listener
(masked, revealable), Prize**, a **Delivery notes** field, and a confirm button.

- **Delivery notes is the field that already exists.** `deliver_prize(p_winner_id,
  p_note)` (0084) already takes it, and `receiptOfTheHandover` / *Recibo da
  entrega* is what renders it today. It moves into the window and is relabelled —
  a second free-text column beside it would be two places to look for the same
  sentence. **No migration is needed for item 5.**
- **The confirm button reads "Write off" / "Dar baixa"**, on the owner's ruling
  of 2026-08-19: that is what the operator says when a prize is handed over.
- **Therefore the existing destructive `write_off` action is relabelled** to
  `actionWriteOffAsLost` / *Baixa por perda* in all three catalogues. Two
  buttons reading "Dar baixa" on one screen, one of which delivers and one of
  which declares the prize lost, is the shape of a mistake nobody can undo:
  `write_off` has no reversing door.
  **The `WinnerAction` value, the door and the audit action are unchanged** —
  this is a label, and renaming the enum would be a migration across
  `winners.status` history for no behaviour.

### D6 — Nothing here reaches the widget

All five items are operator screens. The widget's own masking, and the phone
sanitation of item 1b, are Block 30d.

---

## 5. Migrations

Two, and both redefine functions that already exist.

| # | File | What |
| --- | --- | --- |
| 0253 | `reveal_member_field.sql` | the new door, plus `revoke ... from public` / `grant ... to authenticated` |
| 0254 | `pickup_and_participation_phone_last4.sql` | `list_pickups` and `list_participations` return four digits |

**The live definition is copied forward, never the migration body.** Both
functions are defined once (0090, 0095) and nothing has redefined them since —
verified with `grep -l "function public.list_participations"` over
`supabase/migrations/`, which returns 0090 alone, and the same for 0095. The
rule still holds, because it has cost this project whole blocks before:

```sql
select pg_get_functiondef('public.list_participations'::regproc);
```

Run that against the hosted database first and rewrite *that* body. Re-deriving
one from an old migration reverts every later repair silently, and does so
without a single test turning red.

**Neither migration is edited in place after merge.** A repair to either is a
new numbered file.

**`total_count` comes from the same CTE the rows come from** in both functions.
The narrowing touches the projection only; if a page and its count ever narrow
differently, that is the defect each function's own comment warns about.

---

## 6. Files

**New**

- `src/components/members/listener-card-dialog.tsx`
- `src/lib/members/mask.ts` (pure; unit-tested)
- `src/app/(app)/members/listener-card.ts` (Server Action: read + reveal)
- `src/app/(app)/pickups/hand-over-dialog.tsx`
- `supabase/migrations/0253_reveal_member_field.sql`
- `supabase/migrations/0254_pickup_and_participation_phone_last4.sql`

**Changed**

- `src/services/pickups.ts` — `memberPhone` → `memberPhoneLast4`
- `src/services/participations.ts` — `listenerPhone` → `listenerPhoneLast4`
- `src/app/(app)/pickups/pickups-grid.tsx` — mask, View, Hand over
- `src/app/(app)/participations/participations-grid.tsx` — mask, Listener action
- `src/app/(app)/participations/participation-dialog.tsx` — drop `lastFourDigits`
- `src/app/(app)/music/requests/requests-grid.tsx` — View action
- `src/components/draws/winner-actions.tsx` — the `actionWriteOff` relabel, and
  a `handOver: false` opt-out so `deliver` can leave the generic confirm strip
  **on the Pickups screen only**. `WinnerActions` is also mounted by
  `src/components/draws/draw-detail.tsx`, which is unchanged and keeps the
  strip — the same courtesy `reopenDeadline: false` already uses to keep a
  button off a screen that cannot serve it
- `messages/{en,pt,es}.json` — new keys and the `actionWriteOff` relabel
- `src/lib/supabase/database.types.ts` — regenerated

---

## 7. Testing

- **Unit** — `mask.ts`: every field, the under-four-digits case, null, and an
  email with no domain. `winner-actions`: the relabelled action still maps to
  the unchanged `WinnerAction` value.
- **pgTAP** — `reveal_member_field`: the four legal fields; an illegal
  `p_field`; a caller without `members.view` at any of the listener's Stations;
  an anonymised listener returning null **with the audit row still written**;
  the audit row's shape.
- **Isolation** — `list_pickups` and `list_participations` return four digits
  and never the whole number, for a caller holding `members.view`; and still
  null, not four digits, for one without it. This is the assertion that fails if
  somebody "restores" the column later.
- **Playwright** — one journey: filter Pickups, read `•••• 1234`, open View,
  reveal the number, open Hand over, type a receipt, confirm, and see the row
  turn delivered.

**Gate order matters.** `db:test` after `e2e` or `isolation` gives two false
reds; run the suites in the order the standing note records, against a clean
local database.

---

## 8. Debt this records

- **`reveal_member_field` has no rate limit.** An operator holding `members.view`
  can enumerate one listener at a time, leaving an audit row each time. That is
  the same exposure `reveal_request_phone` has carried since Block 22, and
  making it a limiter is a decision about operators, not about this block.
- **The card is read-only by construction, not by permission.** It offers no
  write, but a caller holding `members.edit` sees the same window as one who
  does not. If editing is ever wanted from these three screens, it needs the
  powers plumbing `MemberRecordDialog` already has.
