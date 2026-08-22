# Block 31a — the number that stops travelling, the day nobody typed, and the covers the search kept offering

**Date:** 2026-08-22
**Base:** `main` at `1538f5e` — Block 30e (PR #94) merged, migrations `0269`–`0270`
applied to the hosted database.
**Depends on:** Block 30a (the masking precedent and `reveal_member_field`), Block
30b (`members.birth_md` and the shared `RefreshButton`), Block 30c
(`promotions.show_id`), Block 24 (the Deezer title exclusion this extends).
**Blocks:** nothing. Block 31b — moving a Station between Organizations — shares
no code with this and is being specified separately.
**Parent request:** `docs/superpowers/specs/2026-08-22-block-31-brief.md`,
everything in it EXCEPT the Organizations section.

---

## 1. What this delivers

Six adjustments across five screens and one integration:

1. **Members** stops sending whole telephone numbers to the browser, gains a
   birthday column, and its two date fields change shape with the filter beside
   them.
2. **Promotions** gains a Refresh button and a Programme column.
3. **Pickups** gains a Refresh button, renames one button, and moves two
   destructive actions off the row and into a window that shows what they act on.
4. **Music Requests** and **Participations** rename one button each.
5. **The music search** stops offering recordings Deezer itself marks as covers.

## 2. What this deliberately does not deliver

- **Moving a Station between Organizations.** That is Block 31b: 50 tables carry
  `organization_id`, 92 tenancy foreign keys are neither deferrable nor
  cascading, and the owner's decisions about listeners, roles and audit are
  recorded but not implemented here.
- **Click-to-reveal on the Members grid.** The owner's ruling of 2026-08-22: the
  grid shows the last four digits and offers no reveal, because the record dialog
  behind it already shows the number in full to the same caller (D2).
- **Any change to `MemberRecordDialog`.** Its five tabs, its edit powers and its
  unmasked fields are what Block 30a deliberately left alone, and nothing in this
  request asks for them.
- **Re-gating Programmes on a Promotions permission.** `docs/PERMISSIONS.md`
  carries the reasoning, and D6 below adds a fourth recorded surface rather than
  moving the gate.
- **A general listener merge.** This project has none — the merge screen belongs
  to the music catalogue — and building one is Block 31b's problem, where the
  owner's "swap one for the other" ruling needs it.
- **Widening the Deezer search limit.** Block 24's own comment already accepts
  that the twenty results are fetched before the exclusion runs; this block
  excludes more of them and does not revisit that trade.

---

## 3. The six items, mapped

| Item | Where | What changes |
| --- | --- | --- |
| Members 1 | `listOrganizationMembers`, `members-grid.tsx` | the list returns four digits, not a number |
| Members 2 | `members-grid.tsx` | a Birthday column, read from `birth_md` |
| Members 3 | `members-filters.tsx` | day+month selects in Birthday mode; the date box stays in Registered mode |
| Promotions 1 | `promotions-filters.tsx` | the shared Refresh button |
| Promotions 2 | `services/promotions.ts`, `promotions-grid.tsx` | a Programme column that tells absence from invisibility |
| Pickups 1 | `pickups-filters.tsx` | the shared Refresh button |
| Pickups 2 | `pickups-grid.tsx` | **View** → **Member** |
| Pickups 3–6 | `pickups-grid.tsx`, a new dialog | a pencil opens a summary; Return to stock and Write off move into it |
| Requests | `requests-grid.tsx` | **View** → **Member** |
| Participations | `participations-grid.tsx` | **View** → **Member** |
| Music search | `deezer/transport.ts`, `deezer/client.ts` | Deezer's `version` field is read, and judged |

---

## 4. Decisions

### D1 — The telephone number is cut on the SERVER, not hidden in the browser

The request says "display only the last 4 digits". Doing that in the grid
component would leave the whole number travelling to the browser with every page
of the list, sitting in the RSC payload for anyone who opens the developer tools
— which is the exact failure Block 30a's `0254` exists to prevent on three other
screens, and it would be a mask rather than a narrowing.

So `listOrganizationMembers` (`src/services/members.ts`) stops projecting `phone`
into what it returns. The row carries `phoneLast4` instead, computed where the
row is built, and the grid renders that.

**The search is unaffected**, and this is the distinction worth stating: the
search does not PROJECT the number, it FILTERS on it — `phone.ilike`,
`phone_normalized.ilike` — inside a query Postgres runs. Narrowing what comes
back does not narrow what can be searched, and an operator can still find a
listener by typing the number they were given on the telephone.

Unlike the other three screens, this needs no migration: Members reads the table
through PostgREST under its own RLS rather than through an RPC, so the projection
is a column list in one service function.

### D2 — No reveal on this grid, and that is a fourth rule rather than a gap

Pickups, Participations and Requests mask with a reveal behind
`reveal_member_field` (0253), audited one field at a time. The owner's ruling for
Members is different: mask, and offer no reveal.

The reason it holds together: on those three screens the listener's card is the
ONLY way to the number, so a reveal is the difference between reachable and
gone. On Members the record dialog is one click away and shows the number in
full, unmasked, to the same caller — the screen exists to administer that
listener. A reveal button beside a dialog that reveals everything would be
ceremony, and an audited ceremony at that.

What this costs, recorded so nobody discovers it as a surprise: **reading a
number on Members leaves no audit trail**, where reading one on the other three
does. The boundary is the same (`members.view`); the record is not.

### D3 — The birthday column reads a column that already exists

The column is derived from `birth_date`, which the row ALREADY CARRIES — the Age
column beside it is computed from exactly that field. Adding `birth_md` to the
projection would put the same fact on the wire twice.

`members.birth_md` (`0257`, a generated `smallint` holding `MMDD`) stays what it
has been since Block 30b: the column the birthday WINDOW compares against in
SQL, where extracting month and day per row would cost an index. It is the
filter's column, not the display's, and this block does not touch it.

The cell reads `20/12` and shows a dash when the listener has no birth date.

Nothing is computed in the browser and nothing is added to the schema.

### D4 — Day and month are two selects, and the URL does not change

HTML has no day-and-month control. Block 30b used `<input type="date">` with a
fixed placeholder year that the code sliced off — which works, and puts a year on
the screen that the filter ignores, which is the request's own complaint.

In **Birthday** mode each field becomes two selects: day (1–31) and month, named
in the reader's language. In **Registered** mode the date box stays exactly as it
is, year included.

**`bfrom` / `bto` keep carrying `MM-DD`,** and `from` / `to` keep carrying
instants. The URL contract Block 30b wrote does not move: this is a change of
control, not of vocabulary, and a pasted link means today what it meant
yesterday.

A day the chosen month does not have (31 September) is offered rather than
hidden: it is a filter BOUND, not a date, and `birth_md` simply has nothing
between `0931` and `1001`. Removing days per month would mean the day list
changing under the operator's hand every time they change the month, to prevent
an input that already means nothing.

### D5 — Refresh is the component three screens already have

`RefreshButton` (`src/components/ui/refresh-button.tsx`) calls `router.refresh()`,
which re-runs the Server Component for the current route without touching the
address bar — so the filters survive because they were never in play. Promotions
and Pickups mount the same component in the same place their neighbours do. There
is nothing to design here beyond not writing a second one.

### D6 — The Programme column must tell "no Programme" from "you may not see it"

`listPromotionsPage` does not read `show_id` today; the column needs the
projection widened to `show_id` and an embedded `shows(name)`.

**And that embed is read under the caller's own RLS**, where
`shows_select_music_view` (0099) gates `shows` on `music.view` — which an
operator who administers Promotions need not hold. For them the embedded name
comes back null on every row.

An empty cell would then say *"this promotion has no Programme"*, which is false.
This is the same failure the band combo would have had in Block 30e, and the
fourth recorded surface of one mismatch (`docs/PERMISSIONS.md`).

The column therefore reads three states, not two, and it can, because `show_id`
comes back regardless of whether the name does:

| `show_id` | name readable | cell |
| --- | --- | --- |
| null | — | `—` |
| set | yes | the Programme's name |
| set | no | a muted marker whose title says the name needs `music.view` |

No door is opened here: Block 30e opened one for a read that had no alternative,
and this cell has one — say less, honestly.

### D7 — The pencil moves WHERE the two actions are mounted, never what they do

**Return to stock** and **Write off as lost** are rendered today by
`WinnerActions` (`src/components/draws/winner-actions.tsx`), the strip Draws and
Pickups share. It owns the confirmation, the mandatory reason, the refusal
messages and the call into `apply_winner_transition`, and every validation and
permission behind them lives in the RPC.

The pencil opens `PickupRecordDialog`, a window showing what is being acted on —
promotion, listener (four digits, per this screen's existing masking), prize,
status, deadline — and mounts **the same `WinnerActions`** inside it, with
`powers` narrowed to those two actions. Nothing about the flow is reimplemented:
the same component, the same reason field, the same server action, the same audit
rows.

**One consequence, stated because it is the point of the change:** the two
actions leave the row. A row that offered them offers them no longer, and an
operator reaches them through the pencil. That is what the request asks for, and
it also fixes something Block 30a recorded and left alone — the strip's reason
box sat in the row, shared per row, with nothing on screen naming what was about
to be returned or written off.

Draws is not touched. It keeps the strip in its own layout, where it has always
been.

### D8 — **Member / Membro / Miembro**, against the product's own word, on the owner's ruling

Three buttons are renamed: **View** → **Member** on Pickups and on Music
Requests, **View** → **Member** on Participations (the brief calls it the
Listener button; the code's label is `view` with an `aria-label` of "view the
listener").

The owner ruled on the translations: **Membro** and **Miembro**, literally,
rather than the **Ouvinte** / **Oyente** the rest of the product uses for that
same person.

**This is deliberate and it is written here so that no future review "fixes" it.**
It does leave two words for one person on one row — the column says Ouvinte and
the button says Membro — and that was the trade the owner chose over renaming the
vocabulary product-wide, which is a translation block of its own (Block 12c moved
451 keys for less).

Only the three buttons and their `aria-label`s change. No column heading, menu
entry, message template or report changes wording.

### D9 — "Cover Version" hides in the field the code never read

Block 24 already drops karaoke and covers, judged by title, through
`isExcludedTitle` — `karaoke`, `(cover`, `cover)`, `[cover`, `cover]`. The
bracketed forms are deliberate: the bare word sits inside "Undercover",
"Discovery" and a real recording called "Cover Me".

What escapes is not a hole in that list. **Deezer carries a `version` field
beside `title`, and `toTrack` never read it** — so a recording whose title is
clean and whose `version` says "(Cover Version)" arrives looking like the
original.

So: `DeezerTrack` gains `version`, `toTrack` reads it, and the search judges
`title` and `version` together. `cover version` joins the term list — unbracketed,
because in that field it stands alone, and the phrase is two words that do not
occur inside "Undercover" or "Discovery".

**The exclusion stays on SEARCH only.** `track(id)` — the lookup the widget's
song request makes for a recording already in a Station's catalogue — must keep
answering, or a song already registered becomes unresolvable. That rule is Block
24's and this block does not touch it.

---

## 5. Migrations

**None.** Every item is a service projection, a component, a catalogue key or an
integration mapping. `birth_md` (`0257`), `show_id` (`0258`) and
`reveal_member_field` (`0253`) all already exist.

This is worth stating rather than leaving implicit: it means the deployment note
that has opened the last four blocks' PRs does not apply, and nothing has to be
pushed to the hosted database after the merge.

---

## 6. Testing

**Unit** — `isExcludedTitle` over the version field: a clean title with a
`(Cover Version)` version is excluded; a clean title with a `(Live)` version is
kept; "Undercover" and "Discovery" survive both fields, which is the case Block
24's own list exists for.

**Unit** — the day/month select values map to the `MM-DD` the URL already
carries, including the single-digit day and month that must be padded.

**Isolation** — `listMembersPage` returns four digits and no `phone` field at
all, asserted on the returned object rather than on the screen: a row that still
carried the number would render identically and fail nothing else.

**e2e** — the Members grid shows four digits and a birthday, and the two date
fields change shape when the filter beside them changes; Promotions shows the
Programme name for a promotion that has one and a dash for one that does not;
Pickups' pencil opens the summary and Return to stock is inside it and not on the
row; the three renamed buttons read **Member** (the suite runs in `en-US`).

**Existing suites to re-run rather than assume**: `birthday-filter.spec.ts` (the
fields it fills change shape), `members-flow.spec.ts`, `pickups` journeys inside
`delivery-flow.spec.ts` and `deadline.spec.ts` (the two actions move), and
`music-requests.spec.ts` (a renamed button).

---

## 7. What the owner has to do, and when

**Nothing.** No migration, no key, no configuration. The change is in the
application bundle, so it arrives with the deploy.

## 8. Debt this records

- **Reading a telephone number on Members leaves no audit trail**, unlike the
  other three screens (D2). If that asymmetry ever matters, the fix is the
  reveal door that already exists, not a new one.
- **The Programmes permission mismatch now has four surfaces** (D6). The
  fourth was supposed to be the one that decided it; it is instead the one that
  learned to say "not visible". The decision is still owed.
- **Two words for one person** on Pickups, Requests and Participations (D8),
  by the owner's ruling.
- **The grid still receives each listener's whole date of birth**, because the
  Age column has always been computed in the browser from it. Nobody asked for
  that to change and this block did not change it — but it is the same shape of
  fact D1 just narrowed one column over.
