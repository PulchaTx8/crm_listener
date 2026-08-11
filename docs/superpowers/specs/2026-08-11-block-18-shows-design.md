# Block 18 — Programmes become a thing the audience has, and a listener can ask for

**Date:** 2026-08-11
**Status:** awaiting review
**Block:** 18 (Block 17 is delivered and live)

---

## 1. What this is for

A programme is currently a name in a tab of the music catalogue, reached at
`/music/catalog?tab=shows`. It has exactly one column of its own — `name` — and
it exists because `music_requests.show_id` had to point at something.

This block makes it what a radio station actually means by a programme: a thing
with a presenter, a producer, a kind, an age rating, a picture and **a weekly
schedule**. It moves to a screen of its own under **Audiência**, and a listener
in the widget can attach their song request to one.

**It is asked for because of the music request.** A listener may want a song
played on a particular programme — including one that only airs at the weekend,
asked for on a Tuesday.

---

## 2. Decisions

The owner's, taken 2026-08-11.

**D1 — The age rating is a fixed list**, the steps Brazilian classification
uses: Livre, 10, 12, 14, 16, 18. An enum, so it can be grouped and filtered
rather than spelled ten ways.

**D2 — The kind is a fixed list too**: Musical, Jornalismo, Talk Show, Esportes,
Entretenimento.

**D3 — Name, kind, age rating and schedule are required to save.** But **the
columns are nullable**, and that is not a contradiction: production already
holds four programmes carrying nothing but a name — Manhã Total, Tarde Animada,
Vozes do Brasil, Madrugada Pulchá. A `NOT NULL` column would have to invent a
kind for each of them, and invented data in a field nobody checked is worse than
an empty one. **The requirement lives in the write path**, so the four survive,
appear marked as incomplete, and the first edit of each one has to complete it.

**D4 — The schedule is stored one row per weekday, and each row remembers which
BAND it came from.** "Seg–Sex 10:00–12:30" is five rows sharing a band marker.
The screen groups by the marker and shows back what was typed; queries use the
weekday, which is what they ask about.

**D5 — A band crossing midnight is split when it is written, not when it is
read.** "Sáb 23:00–02:00" becomes Saturday 23:00–24:00 and Sunday 00:00–02:00,
same band. The screen regroups and shows 23:00–02:00.

**D6 — Choosing a programme in the widget is optional, and every programme on
air is offered** — including ones that do not air today. A listener may ask on
Tuesday for Saturday's programme.

**D7 — A programme has a start date and an end date, and the end may be
indeterminate.** `starts_on` joins D3's required set; `ends_on` is null while
the programme is still on the air. **Ending a programme is how it leaves
circulation** — a record with relationships is archived, not deleted.

**D8 — The screen offers no delete at all.** `shows.deleted_at` stays in the
table because other code filters on it, but nothing on this screen writes it. A
programme registered by mistake is ended on the day it started, and the list
hides ended programmes by default.

**What "ended" changes, and what it deliberately does not.** An ended programme
disappears from the widget — nobody asks for a song on a programme that is off
the air — and from the operator's list unless the filter is opened. **Every
request and every participation already attached to it keeps pointing at it, and
keeps reading correctly.** That is the whole reason for ending rather than
deleting, and §10 records what would have broken instead.

---

## 3. Why these three fields are shaped for grouping

The owner stated the requirement that decides the model: **filters are coming.**
Which requests arrived during a given programme's hours. How many entries came
from programmes of a given age rating. So the schedule, the age rating and the
kind are not decoration on a screen — they are dimensions.

That rules out free text for the two vocabularies, and it rules out storing a
band as a set of days.

**The rejected shape and why.** Storing "Seg–Sex 10:00–12:30" as one row with
`weekdays smallint[]` reads back exactly as typed, which is the argument Block
17b used for keeping an interval rather than a count. It fails here for a reason
17b did not have: every question the owner named is *given an instant, which
programme was on* — a per-day question. An array turns each of those into a
containment test the planner cannot index as cheaply, and the join from
`music_requests.requested_at` to a schedule becomes an expression rather than a
comparison.

**The band marker is what recovers the thing the array was protecting.** Without
it, five rows with the same times are indistinguishable from five bands that
happen to coincide, and grouping them for display is a guess. With it, the
round-trip is exact and the query is still per-day.

### The two traps this shape has to survive

**The timezone.** A schedule is wall-clock time. "What is on air now" must
convert the instant to the Station's own clock — `companies.timezone`, already
`not null` — before extracting a weekday and a time. Computed in UTC it works
every afternoon and is wrong at 21:00, which is the same trap Block 17b avoided
by choosing an interval over a calendar count.

**Midnight.** One of the four existing programmes is called **Madrugada
Pulchá**. A band from 23:00 to 02:00 has an end earlier than its start, and the
naive `time between start and end` returns nothing for it — the programme
disappears from "on air now" during precisely the hours it is on air. D5 splits
it on write so that no future filter has to remember.

---

## 4. The data

```sql
create type public.show_kind as enum
  ('MUSICAL', 'NEWS', 'TALK_SHOW', 'SPORTS', 'ENTERTAINMENT');

create type public.show_age_rating as enum
  ('L', '10', '12', '14', '16', '18');

alter table public.shows
  add column kind public.show_kind,
  add column age_rating public.show_age_rating,
  add column presenter_name text,
  add column producer_name text,
  add column thumb_url text,
  -- D7. starts_on joins the required set; ends_on null IS the indeterminate
  -- case rather than a sentinel date, because a far-future date is a value
  -- somebody eventually filters on and believes.
  add column starts_on date,
  add column ends_on date,
  -- A programme cannot end before it began. Both nullable, so this only bites
  -- when both are present -- which is the only time it means anything.
  add constraint shows_run_dates check (ends_on is null or starts_on is null
                                        or ends_on >= starts_on);

create table public.show_schedules (
  id              uuid primary key default gen_random_uuid(),
  show_id         uuid not null,
  organization_id uuid not null,
  company_id      uuid not null,
  -- Which band the operator typed this row as part of. Rows sharing a band are
  -- one line on the screen; without it, regrouping five identical rows is a
  -- guess about whether they were one band or five.
  band            smallint not null,
  -- ISO: 1 = Monday … 7 = Sunday, matching `extract(isodow from …)` so the
  -- "on air now" query compares a column against a function result and not
  -- against a convention this schema invented.
  weekday         smallint not null check (weekday between 1 and 7),
  starts_at       time not null,
  ends_at         time not null,
  -- No band may end before it starts, because D5 splits the overnight case on
  -- write. A row that violates this is a writer that forgot to.
  constraint show_schedules_within_a_day check (ends_at > starts_at)
);
```

**No `deleted_at` on `show_schedules`**, unlike almost every other table here. A
schedule is not a record of something that happened — it is the current shape of
a programme, replaced wholesale on every save the way `save_promotion_question`
replaces a question's options. There is nothing to keep a tombstone for, and a
soft-deleted band would have to be excluded by every reader forever.

Its RLS follows `shows`: readable with the same permission, written only inside
a `SECURITY DEFINER` body.

`thumb_url` follows Block 14's artwork path: uploaded, never typed, written by a
door of its own against the saved record.

**No `NOT NULL` on the five new `shows` columns** — D3.

---

## 5. The doors

**`save_show(...)`** — one call writes the programme and its whole schedule,
because they are one form. Splitting them would let a programme exist for an
instant with no schedule, or still carrying the previous version's. This is the
shape `save_promotion_question` (0055) already uses for a question and its
options.

It **refuses** a save without a name, a kind, an age rating, a start date or at
least one band — D3 and D7's requirement, enforced here rather than only on
screen.

**The bands arrive as the operator typed them** — `[{days: [1,2,3,4,5], starts:
'10:00', ends: '12:30'}]` — and the door expands them into rows, splitting any
band whose end precedes its start (D5). The screen never sends rows.

**`shows_on_air(p_company_id)`** — which programmes are on now, in the Station's
own timezone. Used by the widget to mark the list, and by whatever filter comes
next.

**`end_show(p_show_id, p_ends_on)`** — D8's only way out. It writes the end date
and nothing else; there is no delete door on this screen, and the schedule is
left exactly as it was so a past request can still be read against the hours it
was made in.

**`list_shows(...)`** — the paginated list, keyset like every other list in this
product. There is no such door today: the catalogue tab reads the table directly
under its one policy, and `merge_shows` (0106) is the only function `shows` has.

### The permission, and a mismatch left standing on purpose

`shows` carries exactly one policy — `shows_select_music_view`, gated on
**`music.view`** — and no insert or update policy at all, so every write already
goes through a `SECURITY DEFINER` body.

**The screen moves to Audiência; the permission stays a music one.** Reading and
writing a programme will still require `music.view` and `music.manage`, which
means a member who administers the audience but holds nothing in music cannot
open the new screen.

That is a real mismatch and it is deferred deliberately. A `shows.view` /
`shows.manage` pair is not two rows in a table: it is a permissions migration,
the roles screen, every seeded role, `docs/PERMISSIONS.md`, and — the part that
decides it — **every role a customer has already configured**, none of which
would grant the new permission. Shipping this block with a permission nobody
holds would hide the screen from everyone.

The block records it here so the next person reads a decision rather than
guessing at an oversight.

---

## 6. The screens

**`/shows`**, third under Audiência after Ouvintes and Participações, mirroring
`/music/songs`: a paginated list, a search box, and a **Cadastrar Programa**
button opening the record dialog.

The list shows the thumbnail, the name, the kind, the age rating and the
schedule summarised. **A programme missing any of D3's or D7's required fields
is marked incomplete** — which on the day this ships is all four of them.

**Ended programmes are hidden by default** and reachable through a filter, the
way the promotions list already treats archived ones. The only action that
retires a programme is **Encerrar**, which asks for a date; there is no delete
(D8).

**The schedule editor is a list of bands.** Each band: seven day checkboxes, a
start, an end, and a remove. "Adicionar faixa" appends another. It is how the
owner described the requirement and how it is stored.

**`/music/catalog?tab=shows` is removed.** A programme stops being a reference of
the music catalogue and becomes an entity of the audience.

**In the widget**, a step before the search: the programmes **still on the air**,
with the ones playing right now marked, and **"Qualquer horário"** which carries
on without attaching one. A programme whose `ends_on` has passed is absent — its
past requests still name it, and nobody can make a new one.

**This reverses 17b's D5**, which said a web request carries no programme. Its
reason was that a visitor does not know a programme's name — and now they are
shown a list of them.

---

## 7. How it is proved

| suite | what it pins |
| --- | --- |
| pgTAP | a save without kind, age rating or a band is refused; a band of five days becomes five rows sharing one marker; **an overnight band becomes two rows, on the two days, still sharing the marker**; `ends_at > starts_at` holds for every row written; `shows_on_air` answers in the Station's timezone, pinned by setting a Station to a timezone where the answer differs from UTC's |
| unit | the band ↔ rows round-trip in both directions; the Zod shapes |
| isolation | `shows` and `show_schedules` readable only through the permissions `shows` already uses |
| e2e | an operator registers a programme with two bands, one of them overnight, and reads it back unchanged; **ends it, and the request made before still names it while the widget stops offering it**; a listener attaches a request to a programme in the widget and the request carries the `show_id` |

**The overnight assertion is the one that matters.** It is the case that
disappears silently, and the only one where a green suite written carelessly
would prove nothing.

---

## 8. Migrations

**`0174_show_kinds.sql`** — the two enums, alone. `create type` and a statement
using the type can share a transaction, unlike `ALTER TYPE … ADD VALUE`, but the
file stays separate anyway so the vocabulary has one place to be read.

**`0175_shows_fields_and_schedule.sql`** — the columns, `show_schedules` with its
RLS and grants, and the three doors.

---

## 9. What was considered and removed

- **`NOT NULL` on the new columns with a backfill** — D3. It would invent a kind
  for four real programmes.
- **A band stored as `weekdays smallint[]`** — §3.
- **Storing 23:00–02:00 as written and handling it in every query** — the first
  filter that forgets loses the overnight programme in silence.
- **Making the widget's programme step mandatory** — D6. A listener who just
  wants a song played should not have to answer a question about scheduling.
- **"On air now" as a stored column** — it is a function of the clock, and a
  stored answer is wrong for all but one minute of every hour.
- **Deleting a programme from this screen** — D8. `merge_shows` (0106) exists
  because duplicates were the problem a deletion would otherwise solve, and
  `shows` is the one catalogue entity 0098 deliberately left without a merge
  door until then. Ending is what a station actually does to a programme.
- **A far-future date instead of a null `ends_on`** — a sentinel is a value
  somebody eventually filters on, groups by, and believes.

---

## 10. Risks, stated rather than discovered

**All four existing programmes become uneditable until completed.** D3 working
as designed: opening one to fix a typo means also choosing a kind, an age rating
and a schedule. The list marks them so nobody discovers this by surprise.

**The band marker is only as good as the writer.** Nothing in the database stops
two genuinely different bands from being written with the same marker; the door
assigns markers and is the only writer. A second writer added later must be
given the same rule, and the door's comment says so.

**`music_requests.show_id` already exists and is already nullable**, so nothing
about existing requests changes — but the operator's requests screen shows a
programme column that has been empty for every web request until now, and will
stop being.

**An ended programme is still referenced, and that is the point.** Its requests
and participations keep pointing at it and keep reading correctly, because
nothing about the row goes away. Had the screen offered a delete instead,
`shows` has NO cascade on any foreign key pointing at it — every reference is NO
ACTION — so the delete would simply have been refused with a 23503, and the
operator would have been told "could not save" about a row they were trying to
remove. Ending is not only kinder history, it is the only one of the two that
works.

**Two ways out of circulation now exist in the schema and only one on screen.**
`deleted_at` remains because other code filters on it; nothing this block writes
ever sets it. A future screen that offers both must say which is which, and the
door's comment says so.
