# Block 22 — A request stops being only a fact, and the studio gets a window

**Status:** design agreed with the owner, 2026-08-13.
**Scope:** the owner's list of 2026-08-13 — eleven items on `/music/requests`, one
on `/catalog/genres`, one on `/catalog/labels`.
**Depends on:** Block 7a/7b (the `music_requests` table, its four permissions,
and the three RPCs that write and read it), Block 17b (the listener note the
widget writes), Block 20c (the one reference screen `/catalog/genres` and
`/catalog/labels` both render).

---

## 1. What this is for

`/music/requests` today is a diary. It lists what was asked for, newest first,
and the only thing anybody can do to a row is withdraw it. That was the right
screen for Block 7b, which was building a history.

It is the wrong screen for the person it is actually used by. A presenter on air
has a queue, not a history: they need to know which requests nobody has read out
yet, which songs have already gone to air, and they need to read one request —
name, song, and the sentence the listener typed — from a metre away, between two
tracks, without squinting at a table row.

So this block gives a request two states it never had, a filter bar that can ask
for exactly the slice the studio wants, and a window big enough to read one
request out loud from.

Two small items ride along at the end: `/catalog/genres` and `/catalog/labels`
get the row actions every other grid in the product already has.

---

## 2. The decision this block reverses, deliberately

Migration `0098` states, in the table comment that ships with `music_requests`:

> No status column, deliberately (D5): a request is a historical fact, not a
> studio queue — PENDING → PLAYED would force Block 8 to choose between counting
> requests and counting plays, two different questions that would then look like
> one.

That reasoning was sound and its conclusion is now wrong: the owner has asked for
the studio queue. The fear it names is real and is answered rather than ignored —
see **D11**. `0189` amends that comment in place instead of leaving a sentence in
the database that contradicts the columns beside it.

---

## 3. Decisions

All taken with the owner on 2026-08-13.

**D1 — Three timestamps are the truth; the two statuses are generated columns.**
`read_at`, `played_at` and `cancelled_at` (each with the actor who set it) are
what is written. `read_status` and `play_status` are `GENERATED ALWAYS AS … STORED`
columns computed from them by Postgres. They filter, sort and index like ordinary
columns, and no future door can leave a status saying `PLAYED` over an empty
`played_at` — the state that a hand-written enum column invites and that nothing
in the database would have complained about.

**D2 — Cancelling cancels the whole request, and is refused once the song has
played.** The owner chose one button over two: `cancel_music_request` stamps
`cancelled_at`, and both statuses read `CANCELLED` from the same fact. The
refusal after `played_at` is the price of D1's derivation: cancellation outranks
the other two in the `CASE`, so cancelling a played request would erase from the
screen a play that really happened. The door says so rather than silently
rewriting history.

**D3 — Read and Played are independent.** Marking a request played does not
require it to have been read first, and does not set `read_at`. Two people do
those two jobs, sometimes in either order.

**D4 — Marking twice is a no-op, not an error.** The first `read_at` survives a
second click; the same for `played_at` and `cancelled_at`. A presenter
double-tapping a button on a phone is not an exception to report, and the first
stamp is the true one. The audit row is written only when a stamp actually
changes.

**D5 — The three buttons are gated on `participations.view`.** The owner's
choice, over a code of this block's own. Recorded with the objection made at
design time and overruled: `participations.view` is a *read* code for a
different domain, so whoever may see promotion entries acquires the power to
mark songs played, and taking that power away means taking the promotion screen
away with it. Changing this later is one line in `0190` and one row in
`permissions`.

**D6 — Ordering by time keeps the keyset; the other three orderings are top-N.**
A keyset cursor compares exactly the columns it orders by. `Horário` keeps
`(requested_at desc, id desc)` and pages exactly as today. `Música`, `Artista`
and `Programa` order by their text column with `id` as the tiebreak, ignore any
cursor, and return one bounded batch. Building keysets over three more orderings
is possible; it is four times the SQL and the owner asked for a bounded studio
list, not a browsable archive by artist.

**D7 — The limit decides which of the two the screen is doing.** Empty limit and
ordering by time: paging, 50 a page, Anterior/Próxima. Any other ordering, or any
limit typed: one batch of at most N rows and no pager. N is clamped to 1–200 in
the URL parser *and* again in the function, because a URL is not a form.

**D8 — The full telephone number never reaches the browser unasked.**
`list_music_requests` stops returning `member_phone` and returns
`member_phone_last4` instead — still withheld entirely from a caller without
`members.view`, exactly as the whole number was (0107's RULE 2). The reveal is a
second door, `reveal_request_phone`, which returns the number and writes an
`audit_logs` row for that one request. This is stronger than the masking the
owner asked for, and stronger than today: the grid currently renders the whole
number on every row. It also makes the audit true — a log line that claims to
record a disclosure while the number was already sitting in the page source
would be a comment that lies.

**D9 — "Retirar pedido" leaves the screen; `archive_music_request` stays in the
database.** Item 7. Cancellation is now the operational answer, and it keeps the
row visible, which is what a cancelled request should be. The withdrawal door
keeps its tests and its grant: it exists for a mistyped manual entry (D5 of Block
7), and that need did not disappear because a button did. Nothing in the UI calls
it after this block, and the spec says so rather than leaving a reader to wonder.

**D10 — The attend window opens for anyone who can read the list.** Its first
purpose, in the owner's words, is *"ter uma área de leitura maior do pedido e ler
com mais clareza"*. Only the four action buttons are gated by D5; without the
permission the window is a reading surface with a Fechar button.

**D11 — Reports and dashboards are untouched, and that is what answers `0098`.**
The music dashboard counts **requests**; it keeps counting requests. No aggregate
learns the word `PLAYED` in this block, so no figure anybody reads today changes
value. The two questions `0098` feared would collapse into one stay apart because
only one of them is asked. Adding a "songs played" figure is a later decision,
made deliberately, with `played_at` sitting there ready for it.

**D12 — Genres and Labels are one change, not two.** They render one component
(`references-grid.tsx`, Block 20c's D2). The action column is added there once.

---

## 4. The data model — `0189`

Two enum types, six columns of fact, two generated:

```sql
create type public.music_request_read_status as enum ('UNREAD', 'READ', 'CANCELLED');
create type public.music_request_play_status as enum ('NOT_PLAYED', 'PLAYED', 'CANCELLED');

alter table public.music_requests
  add column read_at        timestamptz,
  add column read_by        uuid references auth.users (id),
  add column played_at      timestamptz,
  add column played_by      uuid references auth.users (id),
  add column cancelled_at   timestamptz,
  add column cancelled_by   uuid references auth.users (id),
  add column read_status public.music_request_read_status
    generated always as (
      case when cancelled_at is not null then 'CANCELLED'::public.music_request_read_status
           when read_at      is not null then 'READ'::public.music_request_read_status
           else 'UNREAD'::public.music_request_read_status end
    ) stored,
  add column play_status public.music_request_play_status
    generated always as (
      case when cancelled_at is not null then 'CANCELLED'::public.music_request_play_status
           when played_at    is not null then 'PLAYED'::public.music_request_play_status
           else 'NOT_PLAYED'::public.music_request_play_status end
    ) stored;
```

Every row that already exists reads `UNREAD` / `NOT_PLAYED`, which is true of
them: nobody has attended anything yet.

One index, for the filter the studio will always have on:

```sql
create index music_requests_company_status_idx
  on public.music_requests (company_id, read_status, play_status, requested_at desc)
  where deleted_at is null;
```

The text orderings (song, artist, programme) sort over a join and this index does
not serve them. That is accepted rather than papered over: those orderings are
bounded by D7's limit, so the sort is over a small set.

**Stated because it is a lock, not a footnote:** adding a `STORED` generated
column rewrites the table under `ACCESS EXCLUSIVE`. At the current volume of
`music_requests` this is a fraction of a second. It would not be, after Block 9's
import of a legacy acervo — which is an argument for this migration landing
*before* that block, not for a different design.

`0099`'s RLS policies are untouched: every write below is `SECURITY DEFINER` and
the list already was.

---

## 5. The doors — `0190`

Four functions, all `security definer`, `set search_path = pg_catalog, public`,
all following `0093`'s idiom — permission before existence, so a request id in a
Station the caller cannot reach and an id that names nothing answer alike.

Each of the three writers: locks the row `for update` (two presenters pressing the
same button is the ordinary case here, not the exotic one), re-reads its own
stamp under the lock, returns without writing if the stamp is already set (D4),
and writes one `audit_logs` row when it does write.

| Function | Gate | Refuses when |
|---|---|---|
| `mark_music_request_read(uuid)` | `participations.view` at the row's Station | `cancelled_at is not null` |
| `mark_music_request_played(uuid)` | `participations.view` | `cancelled_at is not null` |
| `cancel_music_request(uuid)` | `participations.view` | `played_at is not null` (D2) |
| `reveal_request_phone(uuid) returns text` | `members.view` at the row's Station | — |

Refusals raise `22023` — the code this codebase already uses 250 times for
exactly this ("you asked for something the state does not allow"), which
`mapMusicError` maps to `ValidationError` and both describers pass through
verbatim. Verbatim means the operator reads the SQL's own English sentence, which
is the pre-existing behaviour of every business refusal in the product and is not
fixed here. It is made rare instead: the screen never offers Cancelar on a played
request (§8), so a refusal is reachable only by a genuine race — two people, two
buttons, one request — and that is the one case where an untranslated sentence is
better than a lie.

`reveal_request_phone` always writes its audit row — that is the entire reason it
exists — and returns `members.phone` for the row's listener, or null where the
listener has since been anonymised.

All four `revoke … from public`, `grant … to authenticated`.

---

## 6. The list — `0191`

`list_music_requests` is dropped and recreated: it `returns table`, and Postgres
will not let a replacement change that shape. **The body is taken from
`pg_get_functiondef` against the live database, not copied from `0169`** —
`copiar-corpo-de-funcao-para-frente` records what copying an old migration
forward costs, and `0169` itself carries the warning.

New parameters, all defaulting to "no narrowing":

- `p_read_status public.music_request_read_status default null`
- `p_play_status public.music_request_play_status default null`
- `p_sort text default 'requested'` — one of `requested | song | artist | show`;
  anything else falls back to `requested` rather than raising, the same way an
  unrecognised channel narrows nothing today.

New returned columns: `read_status`, `play_status`, `read_at`, `played_at`,
`cancelled_at`. `member_phone` is **replaced** by `member_phone_last4` (D8),
which is `right(public.normalize_phone(m.phone), 4)` and is withheld with
`member_name` from a caller without `members.view`.

Ordering, in one `order by` with the same `case` shape the function already uses
for walking back:

- `requested` — `requested_at desc, id desc`, keyset comparison exactly as today,
  including the walking-back branch;
- `song` / `artist` / `show` — `song_title asc, id asc` (and the two others),
  **cursor parameters ignored**. A `null` `show_name` sorts last.

`p_limit` keeps its meaning at the function's edge — it is a row cap and nothing
more. The service is what decides which number to send: `REQUEST_PAGE_SIZE + 1`
when paging, so `keysetPage` can tell there is a next page, and **exactly** the
typed limit for a top-N batch, which has no next page to detect. Sending N + 1
there would show the operator N + 1 rows after they asked for N.

The function's `comment on` is rewritten to state the three original rules
(unchanged), the new sort contract, and that the phone now leaves as four digits.

---

## 7. The service and the URL contract

`src/services/music.ts`:

- `RequestSummary` gains `readStatus`, `playStatus`, `readAt`, `playedAt`,
  `cancelledAt`; `memberPhone: string | null` becomes
  `memberPhoneLast4: string | null` — a rename the compiler will chase into the
  one component that reads it.
- `RequestListParams` gains `readStatus`, `playStatus`, `sort`, `limit`.
- `listMusicRequestsPage` returns `nextCursor`/`previousCursor` as `null` for the
  three text orderings, which is how the grid renders no pager without knowing
  the rule.
- Three thin writers (`markMusicRequestRead`, `markMusicRequestPlayed`,
  `cancelMusicRequest`) and `revealRequestPhone`, each `asCaller(token).rpc(…)`
  through `mapMusicError`, matching `archiveMusicRequest`'s shape.

`music/requests/list-params.ts` — new URL keys, and the clamp:

| key | meaning | default |
|---|---|---|
| `read` | `UNREAD` \| `READ` \| `CANCELLED` | all |
| `play` | `NOT_PLAYED` \| `PLAYED` \| `CANCELLED` | all |
| `sort` | `song` \| `artist` \| `show` \| (absent = time) | time |
| `limit` | 1–200, clamped | absent |

`REQUEST_SORT_KEYS` and the clamp are exported so a unit test pins them without a
database. `requestHref` carries all four, and drops the cursor whenever any of
them changes — a cursor is a position in one ordering of one result set.

---

## 8. The screen

### The grid

Columns: Ouvinte · Música · Artista · Programa · Canal · Pedida · **Leitura** ·
**Música (status)** · **Atender**.

The two status cells are badges: muted for `UNREAD`/`NOT_PLAYED`, solid for
`READ`/`PLAYED`, struck-through muted for `CANCELLED`, each with a `title`
carrying the timestamp in the Station's zone. The listener cell shows
`•••• 4321`; the Actions dropdown and its withdraw item are deleted (D9); the
Atender button is a plain button in the last column, and it is not gated (D10).

### The filters

Four new controls beside the three that exist: Status de Leitura, Status de
Música, Ordenar por, Limite. `hasActiveRequestFilters` learns all four, so
"Limpar filtros" appears when any of them is set. The limit input is a
`type="number"` debounced like the search box.

### The attend window

```
JOÃO DA SILVA                                    ← text-2xl
•••• 4321   [ mostrar ]                          ← D8: a round trip, then audited
Garota de Ipanema · Tom Jobim                    ← text-xl
┌ mensagem do ouvinte ───────────────── A− A+ ┐
│ …                                            │  ← three sizes, kept in localStorage
└──────────────────────────────────────────────┘
Programa · pedido às 20:14 · Widget
[ Lido ]   [ Tocado ]   [ Cancelar ]   [ Fechar ]
```

- A button whose fact is already true renders as a static label ("Lido às 20:14")
  rather than a disabled button that looks broken. **Cancelar is not offered at
  all once the request has played** — D2's refusal is then reachable only by a
  race, which is what §5 relies on.
- The three writers call `revalidatePath('/music/requests')`, which is what this
  screen already does for its two writes and why its rows are plain props
  (`requests-grid.tsx`'s own header). The window stays open on success and
  re-derives its row from the fresh `rows` prop by id — `references-grid.tsx`'s
  pattern — so a mark is visible without closing anything.
- A refusal (D2's cancel-after-played, a permission revoked since the page
  loaded) renders inside the window, and the row's true state arrives with the
  next render rather than being guessed at.

### The permission

`page.tsx` resolves `participations.view` for the selected Station in the
existing `Promise.all` and passes `canAttend` down. It is a courtesy gate: all
four doors re-check for themselves.

---

## 9. Genres and Labels

`references-grid.tsx` gains the Actions column `albums-grid.tsx` already has: a
pencil that opens the record dialog (what clicking the name does), and, for
`manage`, a `DropdownMenu` with the archive item. `ArchiveReferenceDialog` lives
in `reference-record-dialog.tsx` today and is hoisted so both the dialog and the
grid can open it, rather than a second copy being written. Both routes get it at
once, which is D12.

---

## 10. What this block does not touch

- **The export.** `MUSIC_REQUESTS` keeps its columns and its filter translation.
  Status in the report is a follow-up the owner can ask for; it is not smuggled
  in here.
- **The dashboards.** D11.
- **The widget, the API and the WhatsApp doors.** They write requests and never
  mention status, so they need no change: the defaults are correct for them.
- **`archive_music_request`.** Kept exactly as it is — same grant, same tests —
  and called by no screen after this block (D9).

---

## 11. Verification

The eight gates in the order `portoes-e-banco-local-sujo` records: typecheck,
lint, unit, `db:reset`, `db:test`, `seed:branding`, e2e, isolation. `db:test`
after `db:reset`, never after the e2e run.

`supabase/tests/17_music_requests.test.sql` carries the weight:

- each door refuses without `participations.view`, in another Station, and for an
  id that does not exist — all three with the same `42501`;
- the generated columns say what the stamps say, including after a cancel;
- a second mark is a no-op that writes no second audit row (D4);
- cancel after played is refused (D2), and read/played after cancel are refused;
- the list filters by both statuses, orders four ways, honours the limit, and
  returns `member_phone_last4` — never the whole number — with and without
  `members.view`;
- `reveal_request_phone` writes its audit row and refuses without `members.view`.

`tests/isolation/` proves a caller cannot attend a request in a Station they hold
nothing in, and that the four new doors are `SECURITY DEFINER` without inheriting
the caller's RLS (the rule Block 6c recorded).

Unit tests pin `list-params.ts`: the clamp, an out-of-range limit, an unknown
sort key falling back to time, and the cursor being dropped when sort or limit
changes.

`tests/e2e/music-requests.spec.ts` gets one journey: filter to *Não lido*, open
Atender, read the note, mark Lido, see the badge change, mark Tocado, and find
the row again through the *Tocadas* filter. Plus one assertion for the masked
telephone. `tests/e2e/music-catalogue.spec.ts` gets the two action columns.

Copy lands in `messages/en.json`, `pt.json` and `es.json` in the same commit as
the component that reads it — Block 12c's rule, and its lesson about a key that
exists in one file and not the other three.

---

## 12. Sequence

One block, three tasks, one PR.

- **22a — the database and the service.** `0189`, `0190`, `0191`, the pgTAP
  suite, `services/music.ts`, `list-params.ts` and its unit tests.
- **22b — the requests screen.** Filters, the two status columns, the attend
  window, the permission, the telephone.
- **22c — the catalogue columns and the proof.** `references-grid.tsx`, the e2e
  journeys, the three message files.

---

## 13. After this block

Recorded so it is not lost:

- **"Songs played" as a figure.** `played_at` exists from this block; no
  dashboard reads it. The moment one does, `0098`'s original warning becomes live
  again and the two counts must be labelled apart on the screen.
- **The permission question of D5.** If `participations.view` proves too wide in
  use, a `music.request.handle` code is a one-line migration and one line in
  `0190`.
