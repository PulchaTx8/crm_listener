# Block 7a — The Music Catalogue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Station's music catalogue — genres, record labels, artists, shows and songs — registered, edited and archived through audited RPCs, with the requests table standing ready for 7b and three screens where an operator builds the whole acervo.

**Architecture:** Six per-Station tables in the shape Block 2 established (`organization_id` + `company_id`, the composite foreign key against `companies (id, organization_id)`, and a `unique (id, company_id)` pair so a child proves its Station in a constraint rather than a trigger). The four short lists share one kind-discriminated trio of `SECURITY DEFINER` doors; `songs` — the only one with real fields — gets its own three. Reads go through ordinary RLS and PostgREST keyset paging, not a `SECURITY DEFINER` list function: no listener identity is on any of these tables, so there is nothing here for D6's rule to protect. Three screens read them.

**Tech Stack:** Postgres 15 (Supabase), plpgsql, Next.js 15 App Router, TypeScript strict, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-03-block-7-music-design.md`

## Global Constraints

- **Language:** every identifier, comment, migration, test name, UI string and commit message is in **English**. This block writes no listener-facing copy at all.
- **Migrations are append-only and never edited once merged.** `0098`–`0101` are new files. Nothing in `0001`–`0097` is edited in place.
- **Every table is per Station (D1).** All six carry `organization_id` **and** `company_id`. There is no cross-Station read, no cross-Station dedup, and no shared catalogue anywhere in this block.
- **Every new `SECURITY DEFINER` function checks its permission before revealing whether a row exists** — the rule `0093` settled, using its one-gated-query idiom (`where id = $1 and public.has_permission(...)`, `not found` → `42501`). This block adds no instance of the older P0002-before-permission shape. `create_*` resolves the Organization only **after** the permission check, for the same reason.
- **Permission checks in the UI are a courtesy, never the boundary.** Every RPC re-checks; every read is cut by RLS.
- **`npm run test:isolation` runs in the same task that writes the functions it proves** (Task 5), never deferred to the end. This is the lesson Block 6c paid five commits for.
- **pgTAP fixtures for this block live in the `...00e0xx`–`...00e4xx` range.** `09_draws` owns `a0xx`–`a3xx`, `10_delivery` `b0xx`–`b4xx`, `11_filtered_hat` `c0xx`–`c4xx`, `12/12b/13` `d0xx`–`d2xx`. A collision fails in whichever file runs second.
- **Gates, all of which must pass before the block is called done:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run db:test`, `npm run test:isolation`, `npm run test:e2e`.
- **Commit after every task.** Message body in English, imperative subject, prefixed `feat(music):`, `fix(...)`, `test(...)` or `docs:`.

---

## Two readings of the spec this plan settles, and one it does not

**1. §7a says "the two catalogue screens (Songs, Artists, Catalog)" and names three.** §5 lists five screens; 7b takes Requests and Maintenance. Three screens are built here. The word "two" is a slip in the spec, not a scope reduction.

**2. `music_requests` is created here, and nothing writes it until 7b.** §7a says "the six tables" and §3 lists `music_requests` among them; §7b takes "the requests and the cleanup", which is the screen and the manual-entry door, not the table. The table, its RLS and its constraints land here so that 7b writes a function against a schema that already exists and has been tested. Nothing in this block inserts a request.

**3. Not settled here, and deliberately left for the owner at 7b:** `shows` is the one catalogue entity with **no cure for a duplicate**. D2 allows duplicates everywhere and D3 gives songs, artists, labels and genres a merge door; shows gets neither a unique index nor a door. This plan follows the spec literally — no unique name index on any of the six — and records the gap. Adding `merge_shows` in 7b is one more `when` branch in the core and one more `update`; whether it is wanted is the owner's call, and Block 8 has no "most requested show" indicator today that would force it.

---

## File Structure

**Created:**

- `supabase/migrations/0098_music_catalogue.sql` — three enums, six tables, four permissions
- `supabase/migrations/0099_rls_music.sql` — RLS, policies and grants for all six
- `supabase/migrations/0100_music_reference_rpcs.sql` — the kind-discriminated trio for genres, labels, artists, shows
- `supabase/migrations/0101_music_song_rpcs.sql` — `create_song`, `update_song`, `archive_song`
- `supabase/tests/14_music_catalogue.test.sql` — pgTAP for Tasks 1 and 2
- `supabase/tests/15_music_rpcs.test.sql` — pgTAP for Tasks 3 and 4
- `tests/isolation/music.test.ts` — cross-Station and permission proofs, with real JWTs
- `src/schemas/music.ts` — the Zod forms
- `src/services/music.ts` — reads and write wrappers
- `src/app/(app)/music/songs/{page,list-params,songs-filters,songs-grid,song-record-dialog,song-fields,actions,record,errors}.tsx|ts`
- `src/app/(app)/music/artists/{page,list-params,artists-filters,artists-grid,artist-record-dialog,actions,record}.tsx|ts`
- `src/app/(app)/music/catalog/{page,reference-tabs,reference-panel,actions}.tsx|ts`
- `src/app/(app)/music/errors.ts`, `src/app/(app)/music/format.ts`, `src/app/(app)/music/permissions.ts` — shared by the three screens
- `tests/unit/music-schema.test.ts`, `tests/unit/music-params.test.ts`
- `tests/e2e/music-catalogue.spec.ts`
- `docs/block-7a-report.md`, `docs/block-7a-runbook.md`

**Modified:**

- `supabase/tests/02_permissions.test.sql` — RLS-enabled and no-write-grant assertions for the six new tables
- `src/lib/record-params.ts` — `SONG_TABS`, `ARTIST_TABS`
- `src/lib/auth/shell.ts` — the Music nav section
- `src/lib/supabase/database.types.ts` — regenerated, never hand-edited

---

## Task 1: The six tables, the three enums and the four permissions

**Files:**
- Create: `supabase/migrations/0098_music_catalogue.sql`
- Create: `supabase/tests/14_music_catalogue.test.sql`

**Interfaces:**
- Consumes: `public.companies (id, organization_id)`, `public.members (id, organization_id)` (`members_id_org_unique`, 0031), `public.permissions`.
- Produces: tables `music_genres`, `record_labels`, `artists`, `shows`, `songs`, `music_requests`; enums `music_nationality` (`DOMESTIC | INTERNATIONAL`), `music_vocal` (`MALE | FEMALE | DUO | GROUP | INSTRUMENTAL`), `music_request_channel` (`MANUAL | IMPORT`); permission codes `music.view`, `music.manage`, `music.request`, `music.merge`. Every later task depends on all of it.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/14_music_catalogue.test.sql`:

```sql
begin;
select plan(24);

-- Block 7a, Task 1: the acervo's shape.
--
-- Fixtures live in the ...00e0xx range. 12_deadline_clock owns ...00d0xx,
-- 12b ...00d1xx and 13_pickup_reads ...00d2xx; a collision would fail in
-- whichever file ran second. 15_music_rpcs owns ...00e1xx.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e0f1', 'Org 7a catalogue'),
  ('00000000-0000-0000-0000-00000000e0f2', 'Org 7a other');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e0c1', '00000000-0000-0000-0000-00000000e0f1',
   'Station 7a A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e0c2', '00000000-0000-0000-0000-00000000e0f1',
   'Station 7a B', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e0c3', '00000000-0000-0000-0000-00000000e0f2',
   'Station 7a elsewhere', 'America/Sao_Paulo');

-- 1-6: the six tables §4.2 names.
select has_table('public', 'music_genres',   'music_genres exists');
select has_table('public', 'record_labels',  'record_labels exists');
select has_table('public', 'artists',        'artists exists');
select has_table('public', 'shows',          'shows exists');
select has_table('public', 'songs',          'songs exists');
select has_table('public', 'music_requests', 'music_requests exists');

-- 7-9: the three enums, whole. Equality against the full array rather than
-- a per-label check: vocal has FIVE values and not the two §4.2 named (D-§3.2),
-- and an assertion that only proves MALE and FEMALE exist would pass over
-- exactly the mistake this is here to prevent.
select is(
  enum_range(null::public.music_nationality)::text[],
  array['DOMESTIC', 'INTERNATIONAL'],
  'music_nationality is DOMESTIC | INTERNATIONAL');
select is(
  enum_range(null::public.music_vocal)::text[],
  array['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL'],
  'music_vocal carries all five, not the two §4.2 named');
select is(
  enum_range(null::public.music_request_channel)::text[],
  array['MANUAL', 'IMPORT'],
  'music_request_channel mirrors participation_source, WHATSAPP not yet');

-- 10-13: what may not be null. A song without an artist is a draft (§3.2);
-- a request always names a listener and a catalogued song (D5).
select col_not_null('public', 'songs', 'title', 'songs.title is not null');
select col_not_null('public', 'songs', 'artist_id', 'songs.artist_id is not null');
select col_not_null('public', 'music_requests', 'member_id', 'music_requests.member_id is not null');
select col_not_null('public', 'music_requests', 'song_id', 'music_requests.song_id is not null');

-- 14: no status column on songs. Deliberately absent (§3.2) — nobody here
-- knows what catalog_medias.status means, and Block 9 is to check it against
-- the real source. Pinned so it is not added absent-mindedly.
select hasnt_column('public', 'songs', 'status', 'songs carries no status column');

-- Fixtures for the constraint cases.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c1', 'Caetano Veloso'),
  ('00000000-0000-0000-0000-00000000e0a2', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c2', 'Caetano Veloso');

-- 15: D1 in one row. The same artist registered twice, once per Station,
-- is two rows and no complaint.
select is(
  (select count(*)::int from public.artists
    where name = 'Caetano Veloso'
      and company_id in ('00000000-0000-0000-0000-00000000e0c1',
                         '00000000-0000-0000-0000-00000000e0c2')),
  2,
  'a group with two Stations registers the same artist twice (D1)');

insert into public.songs (id, organization_id, company_id, title, artist_id) values
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000e0f1',
   '00000000-0000-0000-0000-00000000e0c1', 'Sozinho', '00000000-0000-0000-0000-00000000e0a1');

-- 16: D2. The same title by the same artist, twice, is allowed — a
-- re-recording, a live version and a remix are all of them that, and the
-- maintenance screen is the cure.
select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Sozinho', '00000000-0000-0000-0000-00000000e0a1')
$$, 'a duplicate song is allowed and fixed afterwards (D2)');

-- 17: the composite foreign key, which is the whole reason songs carries
-- company_id as well as organization_id. Station B's artist on Station A's
-- song is refused by a constraint, not by a screen.
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Borrowed', '00000000-0000-0000-0000-00000000e0a2')
$$, '23503', null, 'a song cannot name an artist from another Station');

-- 18: a duration is whole seconds and a positive number of them (§3.2).
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, duration_seconds)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Zero length', '00000000-0000-0000-0000-00000000e0a1', 0)
$$, '23514', null, 'duration_seconds must be greater than zero');

-- 19: a blank title is not a title.
select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          '   ', '00000000-0000-0000-0000-00000000e0a1')
$$, '23514', null, 'a blank title is refused');

-- 20-21: D7. legacy_id is unique per Station when present, and NOT unique
-- across them — the acervo replicates once per Station (D1), so the same
-- legacy row lands in every Station with the same handle.
update public.songs set legacy_id = 'LEG-1'
 where id = '00000000-0000-0000-0000-00000000e0b1';

select throws_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, legacy_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'Second import', '00000000-0000-0000-0000-00000000e0a1', 'LEG-1')
$$, '23505', null, 'one legacy row imports once per Station (D7)');

select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id, legacy_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c2',
          'Sozinho', '00000000-0000-0000-0000-00000000e0a2', 'LEG-1')
$$, 'the same legacy_id may appear once in each Station (D1 + D7)');

-- 22: two songs with no legacy_id at all must not collide — the partial
-- index is what makes the nullable handle usable, and prizes.internal_code
-- (0025) had this same trap.
select lives_ok($$
  insert into public.songs (organization_id, company_id, title, artist_id)
  values ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'No handle A', '00000000-0000-0000-0000-00000000e0a1'),
         ('00000000-0000-0000-0000-00000000e0f1', '00000000-0000-0000-0000-00000000e0c1',
          'No handle B', '00000000-0000-0000-0000-00000000e0a1')
$$, 'two songs without a legacy_id do not collide');

-- 23: the four codes appear in the catalogue, so they appear in the role
-- editor without that screen being touched (the check 0025 makes for its own).
select is(
  (select count(*)::int from public.permissions
    where code in ('music.view', 'music.manage', 'music.request', 'music.merge')),
  4,
  'the four music permissions are in the catalogue');

-- 24: music.merge is its own code, not folded into manage (D8).
select isnt(
  (select code from public.permissions where code = 'music.merge'),
  null,
  'music.merge is a code of its own — the only one that destroys');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `14_music_catalogue` cannot even parse past the first fixture insert, because none of the six tables exists.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0098_music_catalogue.sql`:

```sql
-- supabase/migrations/0098_music_catalogue.sql

-- Block 7a, Task 1: the Music domain, which §4.2 of the master spec calls a
-- gap and which nothing in this codebase has ever modelled.
--
-- Every table here is per Station (D1): organization_id AND company_id, the
-- composite foreign key against companies (id, organization_id), and a
-- unique (id, company_id) pair so that a child proves its Station in a
-- constraint rather than a trigger — the shape 0025 established for prizes
-- and 0040 for promotions. A group with five Stations keeps five catalogues
-- and registers "Caetano Veloso" five times. That was the owner's ruling on
-- 2026-08-03, against the Block 3 alternative (shared across the
-- Organization, access per Station), and its consequences run through the
-- whole block: every uniqueness is scoped by company_id, there is no
-- cross-Station dedup to write, and Block 9's ETL replicates the same acervo
-- once per Station.

create type public.music_nationality as enum ('DOMESTIC', 'INTERNATIONAL');

comment on type public.music_nationality is
  'Whether a song is domestic or foreign. Nullable on songs: the legacy source may not carry it, and guessing would be worse than not knowing.';

-- Five values, not the two §4.2 named. A sertanejo duo, a band and an
-- instrumental track have no honest answer among MALE and FEMALE, and Block
-- 8's vocal indicator would then be counting over a badly classified acervo
-- — a number that looks right and is not.
create type public.music_vocal as enum ('MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL');

comment on type public.music_vocal is
  'Who sings. Five values rather than the two §4.2 named, so a duo, a group and an instrumental have somewhere honest to sit.';

-- Mirrors participation_source (0052), which is also MANUAL | IMPORT. A
-- separate type rather than a reuse of that one: the WhatsApp music-request
-- block adds WHATSAPP here, and reusing participation_source would drag that
-- value into participations, where nothing means it. That addition is a
-- one-line migration of its own, for the Postgres reason 0082 and 0091 both
-- hit — ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds
-- it.
create type public.music_request_channel as enum ('MANUAL', 'IMPORT');

comment on type public.music_request_channel is
  'How a request reached the Station. The WhatsApp block adds WHATSAPP in a migration that does nothing else.';

-- ---------------------------------------------------------------------------
-- The four short lists. A name, and a legacy handle. Identical in shape,
-- which is why 0100 gives them one trio of doors rather than twelve.
-- ---------------------------------------------------------------------------

create table public.music_genres (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint music_genres_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint music_genres_name_not_blank check (btrim(name) <> '')
);

create table public.record_labels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint record_labels_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint record_labels_name_not_blank check (btrim(name) <> '')
);

create table public.artists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint artists_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint artists_name_not_blank check (btrim(name) <> '')
);

-- Not music metadata, and here anyway: a request may arrive inside a
-- programme, so something has to name the programme. §5 puts it on the
-- Catalog screen's third tab for the same practical reason.
create table public.shows (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null,
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint shows_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  constraint shows_name_not_blank check (btrim(name) <> '')
);

comment on table public.shows is
  'A Station''s programmes. The one catalogue entity with no cure for a duplicate: D2 allows duplicates everywhere and D3 gives songs, artists, labels and genres a merge door, and shows gets neither. Recorded rather than quietly fixed with a unique index — adding merge_shows in 7b is one branch in the core and one update, and whether it is wanted is the owner''s call.';

-- The pairs every child's composite foreign key references. Non-partial,
-- because a foreign key cannot reference a partial index — which is exactly
-- why an archived parent needs an explicit check in the RPCs (0100/0101),
-- the same gap 0025 documents for prizes.
alter table public.music_genres  add constraint music_genres_id_company_unique  unique (id, company_id);
alter table public.record_labels add constraint record_labels_id_company_unique unique (id, company_id);
alter table public.artists       add constraint artists_id_company_unique       unique (id, company_id);
alter table public.shows         add constraint shows_id_company_unique         unique (id, company_id);

-- ---------------------------------------------------------------------------
-- Songs. The one with fields.
-- ---------------------------------------------------------------------------

create table public.songs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id),
  company_id       uuid not null,
  title            text not null,
  -- Required: a song without an artist is a draft, not a record. Label and
  -- genre are optional because the legacy source may not carry them, and
  -- refusing the import over a missing label would cost more truth than it
  -- bought.
  artist_id        uuid not null,
  label_id         uuid,
  genre_id         uuid,
  nationality      public.music_nationality,
  vocal            public.music_vocal,
  -- Whole seconds rather than an interval, following the ledger's choice of
  -- an integer quantity in Block 2: it removes a class of formatting error
  -- and every consumer formats it the same way.
  duration_seconds integer,
  internal_code    text,
  legacy_id        text,
  created_by       uuid references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint songs_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- The three that make "no Station sees or edits another's catalogue" a
  -- constraint rather than a promise: an artist, a label or a genre from
  -- another Station is refused by Postgres, before any screen or RPC gets a
  -- say.
  constraint songs_artist_company_fk
    foreign key (artist_id, company_id)
    references public.artists (id, company_id),
  constraint songs_label_company_fk
    foreign key (label_id, company_id)
    references public.record_labels (id, company_id),
  constraint songs_genre_company_fk
    foreign key (genre_id, company_id)
    references public.music_genres (id, company_id),
  constraint songs_title_not_blank check (btrim(title) <> ''),
  constraint songs_duration_positive
    check (duration_seconds is null or duration_seconds > 0)
);

comment on table public.songs is
  'A Station''s songs. Deliberately carries NO unique index on (title, artist) — D2: a re-recording, a live version and a remix are the same artist and the same title, and a wall there would meet a real acervo during Block 9''s import. The duplicate is allowed and the maintenance screen (7b) merges it. Deliberately carries no `status` column either (§3.2): nobody here knows what it means in catalog_medias, and inventing it now to discover later that it meant something else is worse than not having it — Block 9 checks it against the real source.';

alter table public.songs add constraint songs_id_company_unique unique (id, company_id);

-- ---------------------------------------------------------------------------
-- Requests. The table lands here; the door and the screen are 7b's.
-- ---------------------------------------------------------------------------

create table public.music_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  -- Required (D5). Every request belongs to a registered listener, which is
  -- what makes 7b's manual-entry form find or create one through Block 3's
  -- machinery rather than accept a name typed into a box.
  member_id       uuid not null,
  -- Required too: a request points at a catalogued song, never at free text.
  song_id         uuid not null,
  -- Optional: not every request arrives inside a programme.
  show_id         uuid,
  channel         public.music_request_channel not null default 'MANUAL',
  requested_at    timestamptz not null default now(),
  legacy_id       text,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint music_requests_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- Members are Organization-scoped (0031) — the same person entering at two
  -- of the group's Stations is one row — so the pair that proves a listener
  -- belongs here is (member_id, organization_id), not company_id. Which
  -- Stations may see them is member_company_links' business, and 7b's door
  -- checks that link; the constraint proves the Organization.
  constraint music_requests_member_org_fk
    foreign key (member_id, organization_id)
    references public.members (id, organization_id),
  constraint music_requests_song_company_fk
    foreign key (song_id, company_id)
    references public.songs (id, company_id),
  constraint music_requests_show_company_fk
    foreign key (show_id, company_id)
    references public.shows (id, company_id)
);

comment on table public.music_requests is
  'What a listener asked for, and when. No status column, deliberately (D5): a request is a historical fact, not a studio queue — PENDING → PLAYED would force Block 8 to choose between counting requests and counting plays, two different questions that would then look like one. deleted_at exists only so a mistyped manual entry can be withdrawn. Written by nothing in Block 7a; 7b brings the door and the screen.';

-- ---------------------------------------------------------------------------
-- Indexes.
-- ---------------------------------------------------------------------------

-- D7. Unique when present, per Station. Without it an ETL that runs twice
-- duplicates the entire acervo, because D2 removed every other uniqueness.
-- This does not contradict D2: that decision is about human duplicates — the
-- same song typed twice by an operator is still allowed — and this says only
-- that one row of the old system imports once into one Station. Partial on
-- `legacy_id is not null` so the many rows with no handle do not collide,
-- the trap prizes.internal_code (0025) had first.
create unique index music_genres_legacy_unique   on public.music_genres   (company_id, legacy_id) where legacy_id is not null;
create unique index record_labels_legacy_unique  on public.record_labels  (company_id, legacy_id) where legacy_id is not null;
create unique index artists_legacy_unique        on public.artists        (company_id, legacy_id) where legacy_id is not null;
create unique index shows_legacy_unique          on public.shows          (company_id, legacy_id) where legacy_id is not null;
create unique index songs_legacy_unique          on public.songs          (company_id, legacy_id) where legacy_id is not null;
-- On requests most of all: they are the highest-volume thing Block 9 imports,
-- and a doubled request history is exactly the number Block 8 reports.
create unique index music_requests_legacy_unique on public.music_requests (company_id, legacy_id) where legacy_id is not null;

-- The lists every screen opens on, and the joins songs makes.
create index music_genres_company_idx   on public.music_genres   (company_id, name) where deleted_at is null;
create index record_labels_company_idx  on public.record_labels  (company_id, name) where deleted_at is null;
create index artists_company_idx        on public.artists        (company_id, name) where deleted_at is null;
create index shows_company_idx          on public.shows          (company_id, name) where deleted_at is null;
create index songs_company_title_idx    on public.songs          (company_id, title) where deleted_at is null;
create index songs_company_created_idx  on public.songs          (company_id, created_at) where deleted_at is null;
create index songs_artist_idx           on public.songs          (artist_id) where deleted_at is null;
create index songs_genre_idx            on public.songs          (genre_id) where deleted_at is null;
create index songs_label_idx            on public.songs          (label_id) where deleted_at is null;

-- 7b's Requests screen filters by song and by listener, and Block 8 counts
-- over the period. Built here with the table so the screen that needs them
-- does not arrive with a sequential scan.
create index music_requests_company_requested_idx on public.music_requests (company_id, requested_at) where deleted_at is null;
create index music_requests_song_idx              on public.music_requests (song_id) where deleted_at is null;
create index music_requests_member_idx            on public.music_requests (member_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- The permissions. All four now, though two of them guard nothing until 7b.
-- ---------------------------------------------------------------------------

-- A permission is born beside the feature it guards; these four arrive
-- together so that a Station's roles are composed ONCE rather than re-edited
-- after 7b ships. The cost, stated rather than discovered: a role granted
-- music.request or music.merge today acquires no capability, and gains one
-- silently the day 7b's doors land. That is the same shape as
-- allows_return_to_stock in 0025 — a column Block 6 consumed and Block 2
-- shipped — and the alternative is worse: an operator who has already built
-- the catalogue being told to go back through every role.
--
-- music.merge is its own code because it is the only one that DESTROYS.
-- Whoever builds a catalogue should not acquire the power to collapse it by
-- implication — the separation 6d made between winners.reopen_deadline and
-- winners.return, and 0025 between inventory.entry and inventory.exit.
insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('music.view',    'Read the catalogue and the requests',         '7a', 'music', 'See the music catalogue',            'company', 10),
  ('music.manage',  'Register and edit the catalogue',             '7a', 'music', 'Register and edit the catalogue',    'company', 20),
  ('music.request', 'Record a music request by hand',              '7a', 'music', 'Record a music request',             'company', 30),
  ('music.merge',   'Merge duplicated songs, artists, labels and genres', '7a', 'music', 'Merge duplicated records', 'company', 40);
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: `14_music_catalogue` reports 24 of 24. Every other suite still green — this migration adds tables and touches nothing existing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0098_music_catalogue.sql supabase/tests/14_music_catalogue.test.sql
git commit -m "feat(music): six tables for an acervo, one per Station"
```

---

## Task 2: RLS, the read gate, and no write grant anywhere

**Files:**
- Create: `supabase/migrations/0099_rls_music.sql`
- Modify: `supabase/tests/14_music_catalogue.test.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Consumes: the six tables from Task 1; `public.has_permission(text, uuid)` (0016).
- Produces: `select`-only grants to `authenticated` and `service_role` on all six, each policy gated on `music.view` resolved from the row's own `company_id`, each filtering `deleted_at is null`. Every write in this block therefore goes through a `SECURITY DEFINER` RPC — Tasks 3 and 4 depend on there being no other way in.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/14_music_catalogue.test.sql`, immediately before `select * from finish();`, and change the header to `select plan(40);`:

```sql
-- 25-30: RLS is on. A table this migration misses looks exactly like a table
-- that never needed securing — this project has shipped that mistake once
-- already (rate_limit_counters, Block 0) — so the state is asserted rather
-- than left to whoever reads the migration list.
select is(relrowsecurity, true, 'RLS enabled on music_genres')
  from pg_class where oid = 'public.music_genres'::regclass;
select is(relrowsecurity, true, 'RLS enabled on record_labels')
  from pg_class where oid = 'public.record_labels'::regclass;
select is(relrowsecurity, true, 'RLS enabled on artists')
  from pg_class where oid = 'public.artists'::regclass;
select is(relrowsecurity, true, 'RLS enabled on shows')
  from pg_class where oid = 'public.shows'::regclass;
select is(relrowsecurity, true, 'RLS enabled on songs')
  from pg_class where oid = 'public.songs'::regclass;
select is(relrowsecurity, true, 'RLS enabled on music_requests')
  from pg_class where oid = 'public.music_requests'::regclass;

-- 31-36: authenticated may read and may never write. Every write goes
-- through a SECURITY DEFINER RPC that runs as the table owner and needs no
-- grant of its own; a grant here would be a second, unaudited way in.
select ok(has_table_privilege('authenticated', 'public.songs', 'SELECT'),
  'authenticated may read songs — RLS decides which');
select ok(not has_table_privilege('authenticated', 'public.songs', 'INSERT'),
  'authenticated cannot insert songs directly');
select ok(not has_table_privilege('authenticated', 'public.songs', 'UPDATE'),
  'authenticated cannot update songs directly');
select ok(not has_table_privilege('authenticated', 'public.songs', 'DELETE'),
  'authenticated cannot delete songs directly');
select ok(not has_table_privilege('authenticated', 'public.artists', 'INSERT'),
  'authenticated cannot insert artists directly');
select ok(not has_table_privilege('authenticated', 'public.music_requests', 'INSERT'),
  'authenticated cannot insert requests directly — 7b brings the door');

-- 37-39: service_role likewise. BYPASSRLS does not substitute for a GRANT
-- (Block 1a §3.9), and the revoke below only ever ran against anon and
-- authenticated, so TRUNCATE has to be taken from service_role explicitly —
-- it is neither INSERT, UPDATE nor DELETE, and one statement would empty a
-- Station's whole acervo (0029 closed this same hole for the ledger).
select ok(not has_table_privilege('service_role', 'public.songs', 'INSERT'),
  'service_role cannot insert songs');
select ok(not has_table_privilege('service_role', 'public.songs', 'TRUNCATE'),
  'service_role cannot truncate songs');
select ok(not has_table_privilege('service_role', 'public.music_requests', 'TRUNCATE'),
  'service_role cannot truncate the request history');

-- 40: anon reaches none of it.
select ok(not has_table_privilege('anon', 'public.songs', 'SELECT'),
  'anon cannot read songs');
```

Add the same six `relrowsecurity` assertions to `supabase/tests/02_permissions.test.sql` — that file is where this project keeps the standing inventory of secured tables — and raise its `select plan(233);` to `select plan(239);`:

```sql
select is(relrowsecurity, true, 'RLS enabled on music_genres')
  from pg_class where oid = 'public.music_genres'::regclass;
select is(relrowsecurity, true, 'RLS enabled on record_labels')
  from pg_class where oid = 'public.record_labels'::regclass;
select is(relrowsecurity, true, 'RLS enabled on artists')
  from pg_class where oid = 'public.artists'::regclass;
select is(relrowsecurity, true, 'RLS enabled on shows')
  from pg_class where oid = 'public.shows'::regclass;
select is(relrowsecurity, true, 'RLS enabled on songs')
  from pg_class where oid = 'public.songs'::regclass;
select is(relrowsecurity, true, 'RLS enabled on music_requests')
  from pg_class where oid = 'public.music_requests'::regclass;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — sixteen assertions in `14_music_catalogue` and six in `02_permissions` report false. RLS is off and `authenticated` holds the default ACL.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0099_rls_music.sql`:

```sql
-- supabase/migrations/0099_rls_music.sql

-- Six tables built in 0098, secured only now. That split is how every block
-- in this project has sequenced it, and Block 1c's final review closed the
-- safety question with evidence: the default ACL on `public` grants a freshly
-- created table only Dxtm to the Supabase roles, so there was never a
-- readable window between the two migrations.

alter table public.music_genres   enable row level security;
alter table public.record_labels  enable row level security;
alter table public.artists        enable row level security;
alter table public.shows          enable row level security;
alter table public.songs          enable row level security;
alter table public.music_requests enable row level security;

revoke all on public.music_genres   from anon, authenticated;
revoke all on public.record_labels  from anon, authenticated;
revoke all on public.artists        from anon, authenticated;
revoke all on public.shows          from anon, authenticated;
revoke all on public.songs          from anon, authenticated;
revoke all on public.music_requests from anon, authenticated;

-- Read gate only, on all six: `select` for authenticated, gated on music.view
-- resolved from the row's own company_id, and filtering deleted_at — the
-- convention every soft-deleted table in this project uses AT THE POLICY
-- (0006's companies, 0019's roles, 0029's prizes), so that an ordinary select
-- through PostgREST cannot list archived rows just because whoever writes the
-- next screen forgot to filter them client-side.
--
-- That filter has one consequence worth stating plainly, because Block 3b
-- discovered it the expensive way and wrote it into services/inventory.ts: an
-- archived song is not merely hidden from the list, it is UNREADABLE through
-- RLS for every caller. So this block ships no "show archived" filter, and
-- 7b's merge — which soft-deletes the losers — reads its own rows from inside
-- a SECURITY DEFINER body, where this policy never applies.
grant select on public.music_genres   to authenticated;
grant select on public.record_labels  to authenticated;
grant select on public.artists        to authenticated;
grant select on public.shows          to authenticated;
grant select on public.songs          to authenticated;
grant select on public.music_requests to authenticated;

create policy music_genres_select_music_view on public.music_genres
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

create policy record_labels_select_music_view on public.record_labels
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

create policy artists_select_music_view on public.artists
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

create policy shows_select_music_view on public.shows
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

create policy songs_select_music_view on public.songs
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- music_requests takes the same gate, and D6's extra rules — the listener's
-- name only to a caller holding members.view, and no search at all without it
-- — are NOT expressible here. They live in list_music_requests (7b), which is
-- SECURITY DEFINER and re-states by hand what this policy cannot say. This
-- policy is the floor: without music.view at the Station, no request row is
-- readable by any route.
create policy music_requests_select_music_view on public.music_requests
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));

-- service_role needs explicit grants: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9) — a table missing
-- this fails at runtime, not at deploy time. Read-only here too: every RPC in
-- 0100/0101 is SECURITY DEFINER and runs as the table owner, so service_role
-- never needs a write grant to make one work, and giving it one would be a
-- second, unaudited way to rewrite a Station's catalogue.
grant select on public.music_genres   to service_role;
grant select on public.record_labels  to service_role;
grant select on public.artists        to service_role;
grant select on public.shows          to service_role;
grant select on public.songs          to service_role;
grant select on public.music_requests to service_role;

-- `revoke all` above only ever ran against anon/authenticated, so service_role
-- kept the default ACL's TRUNCATE grant — neither INSERT, UPDATE nor DELETE,
-- so nothing above closes it, and a single statement would empty a Station's
-- acervo or its whole request history. 0029 closed exactly this on the
-- inventory ledger; it is closed here before anyone has to find it twice.
revoke truncate on public.music_genres   from service_role;
revoke truncate on public.record_labels  from service_role;
revoke truncate on public.artists        from service_role;
revoke truncate on public.shows          from service_role;
revoke truncate on public.songs          from service_role;
revoke truncate on public.music_requests from service_role;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: `14_music_catalogue` 40 of 40, `02_permissions` 239 of 239.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0099_rls_music.sql supabase/tests/14_music_catalogue.test.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(music): read gate on music.view, and no write grant anywhere"
```

---

## Task 3: One trio of doors for the four short lists

**Files:**
- Create: `supabase/migrations/0100_music_reference_rpcs.sql`
- Create: `supabase/tests/15_music_rpcs.test.sql`

**Interfaces:**
- Consumes: the six tables and the `music.manage` permission.
- Produces: enum `public.music_reference_kind` (`GENRE | LABEL | ARTIST | SHOW`); `create_music_reference(p_company_id uuid, p_kind music_reference_kind, p_name text, p_legacy_id text default null) returns uuid`; `update_music_reference(p_kind music_reference_kind, p_id uuid, p_name text, p_legacy_id text default null) returns void`; `archive_music_reference(p_kind music_reference_kind, p_id uuid) returns void`. Tasks 7–11 call all three.

**Why one trio and not twelve functions.** 0027 writes a separate RPC per operation and its comment gives the reason: the permission check belongs beside the operation, so a reader looking for "who may do this" finds it there. That reason does not reach here — all four entities are gated on the same single code, `music.manage`, so there is nothing to keep beside anything. What is left is four tables with identical columns, and twelve near-identical bodies is twelve places for one fix to be applied to eleven. The kind-discriminated shape is also the shape §4 prescribes for 7b's merge (one private core, four public doors), so the block ends up with one idea rather than two.

**One trap to note for 7b:** `music_reference_kind` is `GENRE | LABEL | ARTIST | SHOW`. The merge's four kinds are **songs, artists, labels, genres** — shows is not among them and songs is. They are different sets. 7b declares its own `music_merge_kind` and does not reuse this one.

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/15_music_rpcs.test.sql`:

```sql
begin;
select plan(14);

-- Block 7a, Tasks 3 and 4: the doors.
--
-- Fixtures live in the ...00e1xx range; 14_music_catalogue owns ...00e0xx.
--
-- What pgTAP can prove here is the mechanics: the shape of the write, the
-- refusals that need no second identity, and the audit row. Everything that
-- needs a REAL user with a REAL, narrower grant — the permission gate, and
-- the cross-Station refusal as a caller actually experiences it — is in
-- tests/isolation/music.test.ts, written in the same block, because that is
-- what the boundary means and pgTAP cannot cheaply set up two authenticated
-- identities.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e1f1', 'Org 7a rpcs');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e1c1', '00000000-0000-0000-0000-00000000e1f1',
   'Station 7a rpcs', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e1c2', '00000000-0000-0000-0000-00000000e1f1',
   'Station 7a rpcs two', 'America/Sao_Paulo');

-- 1: the four kinds, and no fifth. Pinned because 7b's merge kinds are a
-- DIFFERENT set (songs in, shows out) and reusing this enum there would be a
-- silent mistake.
select is(
  enum_range(null::public.music_reference_kind)::text[],
  array['GENRE', 'LABEL', 'ARTIST', 'SHOW'],
  'music_reference_kind is the four short lists — songs is not one of them');

-- 2-5: one door writes four tables. Called as the table owner here, which
-- has_permission answers true for only because pgTAP runs as superuser —
-- the gate itself is proved in the isolation suite.
select lives_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'GENRE', 'Samba')
$$, 'create_music_reference writes a genre');

select is(
  (select count(*)::int from public.music_genres
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and name = 'Samba'),
  1, 'the genre is in music_genres and nowhere else');

select is(
  (select count(*)::int from public.artists
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and name = 'Samba'),
  0, 'GENRE did not land in artists');

select lives_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'SHOW', 'Morning Show', 'LEG-SHOW-1')
$$, 'create_music_reference writes a show, with its legacy handle');

-- 6: a blank name is not a name, in any kind.
select throws_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'ARTIST', '   ')
$$, '22023', null, 'a blank name is refused');

-- 7: D7 through the door, not only through the index — the RPC turns 23505
-- into a message naming the handle rather than a bare constraint name.
select throws_ok($$
  select public.create_music_reference(
    '00000000-0000-0000-0000-00000000e1c1', 'SHOW', 'Second import', 'LEG-SHOW-1')
$$, '23505', null, 'a legacy handle imports once per Station');

-- 8: the audit row. Six months later this is what says who added it.
select is(
  (select count(*)::int from public.audit_logs
    where action = 'create_music_reference'
      and company_id = '00000000-0000-0000-0000-00000000e1c1'),
  2, 'every create writes an audit row');

-- 9-10: update replaces the name, and refuses a blank one.
select lives_ok($$
  select public.update_music_reference(
    'GENRE',
    (select id from public.music_genres where name = 'Samba'),
    'Samba de raiz')
$$, 'update_music_reference renames a genre');

select is(
  (select name from public.music_genres
    where company_id = '00000000-0000-0000-0000-00000000e1c1' and deleted_at is null),
  'Samba de raiz', 'the new name is stored');

-- 11: archive is a soft delete. This project deletes nothing — 7b's merge
-- history needs something to keep pointing at.
select lives_ok($$
  select public.archive_music_reference(
    'SHOW', (select id from public.shows where name = 'Morning Show'))
$$, 'archive_music_reference soft-deletes a show');

select isnt(
  (select deleted_at from public.shows where name = 'Morning Show'),
  null, 'the show is soft-deleted, and the row is still there');

-- 13: an archived row cannot be renamed. The composite foreign key cannot see
-- deleted_at (it references a non-partial constraint), so this check is the
-- only thing standing between an archived genre and an edit that resurrects
-- it in every screen's reference list.
select throws_ok($$
  select public.update_music_reference(
    'SHOW', (select id from public.shows where name = 'Morning Show'), 'Back again')
$$, '42501', null, 'an archived record answers 42501, not a silent success');

-- 14: an unknown id answers 42501 too, never P0002. An id that does not exist
-- and a Station the caller holds nothing in are indistinguishable from out
-- here — the rule 0093 settled, and the one this block does not break.
select throws_ok($$
  select public.archive_music_reference(
    'ARTIST', '00000000-0000-0000-0000-00000000e199')
$$, '42501', null, 'an unknown id answers permission denied, not "not found"');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `15_music_rpcs` cannot resolve `public.music_reference_kind`; nothing in the file runs.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0100_music_reference_rpcs.sql`:

```sql
-- supabase/migrations/0100_music_reference_rpcs.sql

-- Block 7a, Task 3: one trio of doors for the four short lists.
--
-- 0027 writes a separate RPC per operation, and its comment gives the reason:
-- the permission check belongs beside the operation, so a reader looking for
-- "who may do this" finds it there rather than inside a shared helper. That
-- reason does not reach here. All four of these entities are gated on the
-- SAME single code, music.manage (D8), so there is nothing to keep beside
-- anything — and what is left is four tables with identical columns, where
-- twelve near-identical bodies would be twelve places for one fix to be
-- applied to eleven.
--
-- It is also the shape §4 prescribes for 7b's merge: one private core, four
-- public doors, discriminated on a kind. The block ends up with one idea.
--
-- NOTE FOR 7b: these four kinds are NOT the merge's four. The merge covers
-- songs, artists, record labels and genres; shows is not among them and songs
-- is. 7b declares music_merge_kind of its own and does not reuse this type.
create type public.music_reference_kind as enum ('GENRE', 'LABEL', 'ARTIST', 'SHOW');

comment on type public.music_reference_kind is
  'The four catalogue lists that are a name and nothing else. Not the merge''s kinds (7b) — that set drops SHOW and adds SONG.';

-- The one place a kind becomes a table name. IMMUTABLE and total: adding a
-- value to the enum without adding a branch here returns null, and every
-- caller below formats that null into `public.""` and fails loudly rather
-- than writing somewhere unintended.
create or replace function public.music_reference_table(p_kind public.music_reference_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'GENRE'  then 'music_genres'
    when 'LABEL'  then 'record_labels'
    when 'ARTIST' then 'artists'
    when 'SHOW'   then 'shows'
  end;
$$;

revoke execute on function public.music_reference_table(public.music_reference_kind) from public;

comment on function public.music_reference_table(public.music_reference_kind) is
  'Maps a reference kind to its table name, for the format(%I) in the three doors below. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

-- ---------------------------------------------------------------------------
-- The three doors. Each is SECURITY DEFINER and each checks music.manage
-- BEFORE revealing whether anything exists — the rule 0093 settled and wrote
-- out at length. create_ resolves the Organization only AFTER the check;
-- update_ and archive_ use 0093's one-gated-query idiom, where an unknown id
-- and an unauthorised Station are the same 42501 from outside.
--
-- The table name reaches SQL through format(%I) over a value this schema
-- produced from an enum — never through a caller's string. The identifier is
-- the only part that cannot be a bind parameter; every value below is bound.
-- ---------------------------------------------------------------------------

create or replace function public.create_music_reference(
  p_company_id uuid,
  p_kind       public.music_reference_kind,
  p_name       text,
  p_legacy_id  text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_table  text := public.music_reference_table(p_kind);
  v_name   text := nullif(btrim(p_name), '');
  v_legacy text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_id     uuid;
begin
  -- Permission first, existence second — the opposite order to 0027's
  -- catalogue RPCs, deliberately. has_permission is false for a Station that
  -- does not exist and for one that is suspended, so this answers 42501
  -- without ever confirming whether the id names anything.
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_music_reference denied: actor=% company=% kind=%', v_actor, p_company_id, p_kind;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  -- Nearly unreachable — has_permission already required an active Company —
  -- and kept for the Station archived between the two statements, where the
  -- alternative is a null organization_id reaching a not-null column.
  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  begin
    execute format(
      'insert into public.%I (organization_id, company_id, name, legacy_id, created_by)
       values ($1, $2, $3, $4, $5) returning id', v_table)
    into v_id
    using v_org, p_company_id, v_name, v_legacy, v_actor;
  exception
    when unique_violation then
      -- The only unique index on these tables is the legacy handle (D7);
      -- names deliberately have none (D2/D3 — the cure is the merge, not a
      -- wall). So this branch can mean one thing, and says it.
      raise exception 'a record with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_music_reference', v_table, v_id, v_org, p_company_id,
     jsonb_build_object('kind', p_kind, 'name', v_name, 'legacy_id', v_legacy));

  return v_id;
end;
$$;

comment on function public.create_music_reference(uuid, public.music_reference_kind, text, text) is
  'Registers a genre, record label, artist or show in one Station. Gated on music.manage, checked BEFORE the Station is resolved so an unauthorised caller cannot learn whether a Company id names anything. Names are deliberately not unique (D2/D3): a duplicate is allowed and 7b''s maintenance screen merges it. legacy_id is unique per Station when present (D7) and a collision is refused with 23505 naming the handle.';

create or replace function public.update_music_reference(
  p_kind      public.music_reference_kind,
  p_id        uuid,
  p_name      text,
  p_legacy_id text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_name    text := nullif(btrim(p_name), '');
  v_legacy  text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_org     uuid;
  v_company uuid;
begin
  -- 0093's idiom: ONE gated query resolves the Station, and `not found`
  -- covers three facts on purpose — no such id, an id in a Station this
  -- caller holds nothing in, and an already-archived row. The composite
  -- foreign keys cannot see deleted_at (they reference a non-partial
  -- constraint), so `deleted_at is null` here is the only thing standing
  -- between an archived genre and an edit that puts it back in every screen's
  -- reference list.
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'update_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  begin
    execute format(
      'update public.%I set name = $1, legacy_id = $2, updated_at = now() where id = $3', v_table)
    using v_name, v_legacy, p_id;
  exception
    when unique_violation then
      raise exception 'a record with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind, 'name', v_name, 'legacy_id', v_legacy));
end;
$$;

comment on function public.update_music_reference(public.music_reference_kind, uuid, text, text) is
  'Replaces a reference record''s name and legacy handle wholesale (the convention update_role and update_prize follow: every field set on every call, never merged). The Station is resolved from the row itself, never from a parameter, so a caller cannot redirect the permission check at a Station they do hold music.manage in. An unknown id, a Station the caller cannot reach and an already-archived row all answer 42501 alike.';

create or replace function public.archive_music_reference(
  p_kind public.music_reference_kind,
  p_id   uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_table   text := public.music_reference_table(p_kind);
  v_org     uuid;
  v_company uuid;
  v_in_use  integer;
begin
  execute format(
    'select organization_id, company_id from public.%I
      where id = $1 and deleted_at is null
        and public.has_permission(''music.manage'', company_id)
        for update', v_table)
  into v_org, v_company
  using p_id;

  if v_company is null then
    raise log 'archive_music_reference denied: actor=% kind=% id=%', v_actor, p_kind, p_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Refused while a live song still names it. Archiving it anyway would leave
  -- the song pointing at a row no screen can read (0099's policy filters
  -- deleted_at), so the song's own record would render an artist that had
  -- silently become blank — the same shape as archive_prize refusing a prize
  -- with stock, and delete_role refusing a role in use.
  --
  -- SHOW is checked against music_requests instead: nothing else references
  -- it, and a show with requests behind it is exactly as load-bearing as an
  -- artist with songs.
  if p_kind = 'ARTIST' then
    select count(*) into v_in_use from public.songs
     where artist_id = p_id and deleted_at is null;
  elsif p_kind = 'LABEL' then
    select count(*) into v_in_use from public.songs
     where label_id = p_id and deleted_at is null;
  elsif p_kind = 'GENRE' then
    select count(*) into v_in_use from public.songs
     where genre_id = p_id and deleted_at is null;
  else
    select count(*) into v_in_use from public.music_requests
     where show_id = p_id and deleted_at is null;
  end if;

  if v_in_use > 0 then
    raise exception 'this record is still used by % live row(s); change them first', v_in_use
      using errcode = '23503';
  end if;

  execute format(
    'update public.%I set deleted_at = now(), updated_at = now() where id = $1', v_table)
  using p_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_music_reference', v_table, p_id, v_org, v_company,
     jsonb_build_object('kind', p_kind));
end;
$$;

comment on function public.archive_music_reference(public.music_reference_kind, uuid) is
  'Soft-deletes a genre, label, artist or show. Gated on music.manage. Never a DELETE — this project deletes nothing, and 7b''s merge history needs rows to keep pointing at. Refused while a live song (or, for a show, a live request) still names it, so no screen is left rendering a reference that RLS has made unreadable. Takes FOR UPDATE on the row, so a create_song naming this artist cannot interleave past the count.';

revoke execute on function public.create_music_reference(uuid, public.music_reference_kind, text, text)   from public;
revoke execute on function public.update_music_reference(public.music_reference_kind, uuid, text, text)   from public;
revoke execute on function public.archive_music_reference(public.music_reference_kind, uuid)              from public;

grant execute on function public.create_music_reference(uuid, public.music_reference_kind, text, text)    to authenticated;
grant execute on function public.update_music_reference(public.music_reference_kind, uuid, text, text)    to authenticated;
grant execute on function public.archive_music_reference(public.music_reference_kind, uuid)               to authenticated;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: `15_music_rpcs` 14 of 14.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0100_music_reference_rpcs.sql supabase/tests/15_music_rpcs.test.sql
git commit -m "feat(music): one trio of doors for genres, labels, artists and shows"
```

---

## Task 4: The song's own three doors

**Files:**
- Create: `supabase/migrations/0101_music_song_rpcs.sql`
- Modify: `supabase/tests/15_music_rpcs.test.sql`

**Interfaces:**
- Consumes: `songs`, `artists`, `record_labels`, `music_genres`, `music.manage`.
- Produces: `create_song(p_company_id uuid, p_title text, p_artist_id uuid, p_label_id uuid default null, p_genre_id uuid default null, p_nationality music_nationality default null, p_vocal music_vocal default null, p_duration_seconds integer default null, p_internal_code text default null, p_legacy_id text default null) returns uuid`; `update_song` with the same fields plus `p_song_id` and no `p_company_id`; `archive_song(p_song_id uuid) returns void`.

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/15_music_rpcs.test.sql`, before `select * from finish();`, and raise the header to `select plan(23);`:

```sql
-- Fixtures for the song doors: an artist in each of the two Stations, and a
-- label in the second, so "belongs to this Station" is never accidentally
-- true because there was only one of everything.
insert into public.artists (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e1a1', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c1', 'Elis Regina'),
  ('00000000-0000-0000-0000-00000000e1a2', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c2', 'Elis Regina');
insert into public.record_labels (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-00000000e1d2', '00000000-0000-0000-0000-00000000e1f1',
   '00000000-0000-0000-0000-00000000e1c2', 'Label of the other Station');

-- 15: the ordinary case, with every optional field filled.
select lives_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Águas de Março',
    '00000000-0000-0000-0000-00000000e1a1', null, null,
    'DOMESTIC', 'FEMALE', 213, 'INT-1', 'LEG-SONG-1')
$$, 'create_song registers a song with its whole record');

select is(
  (select vocal::text from public.songs where title = 'Águas de Março'),
  'FEMALE', 'the vocal is stored as given');

-- 17: a song without an artist is a draft, not a record (§3.2).
select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'No artist', null)
$$, '22023', null, 'a song must name an artist');

-- 18-19: the Station boundary, checked IN THE DATABASE and not on the
-- screen. The composite foreign key would also refuse this, but with a
-- constraint name; the RPC refuses it first, with a message an operator can
-- act on.
select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Borrowed artist',
    '00000000-0000-0000-0000-00000000e1a2')
$$, 'P0002', null, 'an artist from another Station is refused');

select throws_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Borrowed label',
    '00000000-0000-0000-0000-00000000e1a1',
    '00000000-0000-0000-0000-00000000e1d2')
$$, 'P0002', null, 'a label from another Station is refused');

-- 20: D2 through the door. Two identical songs, no complaint — the cure is
-- 7b's merge, not a wall here.
select lives_ok($$
  select public.create_song(
    '00000000-0000-0000-0000-00000000e1c1', 'Águas de Março',
    '00000000-0000-0000-0000-00000000e1a1')
$$, 'the same title by the same artist may be registered twice (D2)');

-- 21: update replaces the whole record, and resolves the Station from the
-- song rather than a parameter.
select lives_ok($$
  select public.update_song(
    (select id from public.songs where legacy_id = 'LEG-SONG-1'),
    'Aguas de Marco', '00000000-0000-0000-0000-00000000e1a1',
    null, null, 'DOMESTIC', 'DUO', 214, 'INT-1', 'LEG-SONG-1')
$$, 'update_song replaces the record wholesale');

select is(
  (select vocal::text from public.songs where legacy_id = 'LEG-SONG-1'),
  'DUO', 'the updated vocal is stored');

-- 23: an unknown song answers 42501, never P0002 — 0093's rule again.
select throws_ok($$
  select public.archive_song('00000000-0000-0000-0000-00000000e199')
$$, '42501', null, 'an unknown song answers permission denied');
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.create_song(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0101_music_song_rpcs.sql`. `create_song` and `update_song` share one private validator, because "does this artist/label/genre belong to this Station and is it live" is one question asked twice and the composite foreign key answers only half of it:

```sql
-- supabase/migrations/0101_music_song_rpcs.sql

-- Block 7a, Task 4: songs get their own three doors, because songs are the
-- one catalogue entity with fields rather than a name.

-- Private. SECURITY INVOKER and EXECUTE for nobody — it is only ever called
-- from inside a SECURITY DEFINER body, where it already runs with that body's
-- privileges, and making it DEFINER too would let a future GRANT turn it into
-- an unchecked read path. The shape apply_inventory_movement (0027) and
-- apply_winner_transition (0092) both use.
--
-- The composite foreign keys on songs (0098) prove the Station on their own,
-- so this is not that. It is the half they cannot prove: a foreign key
-- references a non-partial constraint and therefore cannot see deleted_at, so
-- without this an ARCHIVED artist could still be named by a new song — and
-- 0099's policy makes that artist unreadable, so the song's record would
-- render a blank where the artist should be.
create or replace function public.assert_song_references_live(
  p_company_id uuid,
  p_artist_id  uuid,
  p_label_id   uuid,
  p_genre_id   uuid
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_artist_id is null then
    raise exception 'a song must name an artist' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.artists
     where id = p_artist_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'artist not found in this station: %', p_artist_id using errcode = 'P0002';
  end if;

  if p_label_id is not null and not exists (
    select 1 from public.record_labels
     where id = p_label_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'record label not found in this station: %', p_label_id using errcode = 'P0002';
  end if;

  if p_genre_id is not null and not exists (
    select 1 from public.music_genres
     where id = p_genre_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'genre not found in this station: %', p_genre_id using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.assert_song_references_live(uuid, uuid, uuid, uuid) from public;

comment on function public.assert_song_references_live(uuid, uuid, uuid, uuid) is
  'Refuses an artist, label or genre that is missing, archived, or from another Station. SECURITY INVOKER, EXECUTE granted to nobody. The composite foreign keys prove the Station by themselves; what they cannot see is deleted_at, which is the half this covers.';

create or replace function public.create_song(
  p_company_id       uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_legacy_id        text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_title  text := nullif(btrim(p_title), '');
  v_code   text := nullif(btrim(coalesce(p_internal_code, '')), '');
  v_legacy text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_id     uuid;
begin
  if not public.has_permission('music.manage', p_company_id) then
    raise log 'create_song denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds <= 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  perform public.assert_song_references_live(p_company_id, p_artist_id, p_label_id, p_genre_id);

  begin
    insert into public.songs
      (organization_id, company_id, title, artist_id, label_id, genre_id,
       nationality, vocal, duration_seconds, internal_code, legacy_id, created_by)
    values
      (v_org, p_company_id, v_title, p_artist_id, p_label_id, p_genre_id,
       p_nationality, p_vocal, p_duration_seconds, v_code, v_legacy, v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a song with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_song', 'songs', v_id, v_org, p_company_id,
     jsonb_build_object('title', v_title, 'artist_id', p_artist_id, 'legacy_id', v_legacy));

  return v_id;
end;
$$;

comment on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) is
  'Registers a song. Gated on music.manage, checked before the Station is resolved. The artist is required (a song without one is a draft, not a record); label and genre are optional because the legacy source may not carry them. Every reference must be live and in the same Station — refused with P0002 naming the id, which the composite foreign keys would also refuse but with a constraint name. No uniqueness on title and artist, deliberately (D2): the duplicate is the maintenance screen''s business, not this door''s.';

create or replace function public.update_song(
  p_song_id          uuid,
  p_title            text,
  p_artist_id        uuid,
  p_label_id         uuid default null,
  p_genre_id         uuid default null,
  p_nationality      public.music_nationality default null,
  p_vocal            public.music_vocal default null,
  p_duration_seconds integer default null,
  p_internal_code    text default null,
  p_legacy_id        text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_title   text := nullif(btrim(p_title), '');
  v_code    text := nullif(btrim(coalesce(p_internal_code, '')), '');
  v_legacy  text := nullif(btrim(coalesce(p_legacy_id, '')), '');
  v_before  jsonb;
begin
  -- The Station — and so the permission to check — comes from the song
  -- itself, never from a parameter a caller could point at whichever Station
  -- they happen to hold music.manage in. 0093's idiom, so an unknown id, an
  -- unreachable Station and an archived song are one answer from outside.
  select organization_id, company_id into v_org, v_company
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id);

  if not found then
    raise log 'update_song denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'a title is required' using errcode = '22023';
  end if;

  if p_duration_seconds is not null and p_duration_seconds <= 0 then
    raise exception 'a duration is a positive number of whole seconds' using errcode = '22023';
  end if;

  perform public.assert_song_references_live(v_company, p_artist_id, p_label_id, p_genre_id);

  select jsonb_build_object(
           'title', title, 'artist_id', artist_id, 'label_id', label_id,
           'genre_id', genre_id, 'nationality', nationality, 'vocal', vocal,
           'duration_seconds', duration_seconds, 'internal_code', internal_code,
           'legacy_id', legacy_id)
    into v_before
  from public.songs where id = p_song_id;

  begin
    update public.songs
       set title            = v_title,
           artist_id        = p_artist_id,
           label_id         = p_label_id,
           genre_id         = p_genre_id,
           nationality      = p_nationality,
           vocal            = p_vocal,
           duration_seconds = p_duration_seconds,
           internal_code    = v_code,
           legacy_id        = v_legacy,
           updated_at       = now()
     where id = p_song_id;
  exception
    when unique_violation then
      raise exception 'a song with legacy id "%" already exists in this station', v_legacy
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_song', 'songs', p_song_id, v_org, v_company,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'title', v_title, 'artist_id', p_artist_id, 'label_id', p_label_id,
       'genre_id', p_genre_id, 'nationality', p_nationality, 'vocal', p_vocal,
       'duration_seconds', p_duration_seconds, 'internal_code', v_code,
       'legacy_id', v_legacy)));
end;
$$;

comment on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) is
  'Replaces a song''s fields wholesale (the convention update_prize and update_role follow: every field set on every call, never merged). The Organization and Company are resolved from the song row, never from a parameter. Gated on music.manage; an unknown id, an unreachable Station and an archived song all answer 42501.';

create or replace function public.archive_song(p_song_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  select organization_id, company_id into v_org, v_company
  from public.songs
  where id = p_song_id and deleted_at is null
    and public.has_permission('music.manage', company_id)
    for update;

  if not found then
    raise log 'archive_song denied: actor=% song=%', v_actor, p_song_id;
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  -- Deliberately NOT refused when requests point at it, unlike
  -- archive_music_reference's guard on artists. A request is a historical
  -- fact (D5) — this person asked for this song on this day — and that fact
  -- does not stop being true because the Station retired the song. 7b's
  -- requests list reads the title from inside its own SECURITY DEFINER body,
  -- where 0099's deleted_at filter does not apply, so an archived song's
  -- requests still render with their title rather than a blank.
  update public.songs set deleted_at = now(), updated_at = now() where id = p_song_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'archive_song', 'songs', p_song_id, v_org, v_company);
end;
$$;

comment on function public.archive_song(uuid) is
  'Soft-deletes a song. Gated on music.manage. Never refused over existing requests — a request is a historical fact and stays true after the song is retired — which is the opposite of archive_music_reference''s guard on an artist, because a song with no artist would render blank and a request with a retired song does not. 7b''s list_music_requests reads titles from inside a SECURITY DEFINER body, where the deleted_at policy does not apply.';

revoke execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) from public;
revoke execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text)  from public;
revoke execute on function public.archive_song(uuid)                                                                                            from public;

grant execute on function public.create_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text) to authenticated;
grant execute on function public.update_song(uuid, text, uuid, uuid, uuid, public.music_nationality, public.music_vocal, integer, text, text)  to authenticated;
grant execute on function public.archive_song(uuid)                                                                                            to authenticated;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm run db:reset && npm run db:test`
Expected: `15_music_rpcs` 23 of 23, every other suite green.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0101_music_song_rpcs.sql supabase/tests/15_music_rpcs.test.sql
git commit -m "feat(music): the song's three doors, and the references they must respect"
```

---

## Task 5: The isolation suite — the boundary, with real JWTs

**Files:**
- Create: `tests/isolation/music.test.ts`

**Interfaces:**
- Consumes: `provisionCustomer`, `addCompany`, `grantRoleWith`, `signInAs`, `cleanupUsers` from `tests/isolation/harness.ts`; every function from Tasks 3 and 4.
- Produces: nothing the application imports. This is the task that proves the tenant boundary — **it runs here, not at the end of the block.**

**Why it cannot wait.** pgTAP runs as superuser: `has_permission` answers true for it unconditionally, so every gate in Tasks 3 and 4 is *unexercised* by `npm run db:test`. Only a real user with a real, narrower grant proves them. Block 6c paid five commits for deferring exactly this.

- [ ] **Step 1: Write the failing test**

Create `tests/isolation/music.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addCompany,
  cleanupUsers,
  grantRoleWith,
  provisionCustomer,
  signInAs,
  type ProvisionedCustomer,
} from './harness';

/**
 * Block 7a's tenant boundary, proved the only way it can be: with real users
 * holding real, narrower grants.
 *
 * Every case here is invisible to pgTAP, which runs as superuser and so gets
 * `true` from has_permission unconditionally. That is not a gap in the pgTAP
 * suite — it is the reason this file exists and the reason it is written in
 * the same task as the functions, never at the end of the block.
 */
describe('Block 7a — the music catalogue across Stations', () => {
  let customer: ProvisionedCustomer;
  let secondCompanyId: string;

  beforeAll(async () => {
    customer = await provisionCustomer('music7a');
    secondCompanyId = await addCompany(customer, 'Second Station 7a');
  }, 60_000);

  afterAll(async () => {
    await cleanupUsers();
  });

  it('refuses to register anything without music.manage', async () => {
    const viewer = await grantRoleWith(customer, 'music-viewer', ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error } = await client.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Should not exist',
    });

    expect(error?.code).toBe('42501');
  });

  it('refuses a Station the caller holds nothing in, without saying it exists', async () => {
    // The grant is in the FIRST Station only; the call names the second.
    const manager = await grantRoleWith(customer, 'music-manager-a', ['music.manage'], [
      customer.companyId,
    ]);
    const client = await signInAs(manager.email, manager.password);

    const { error } = await client.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Wrong Station',
    });

    expect(error?.code).toBe('42501');
  });

  it('never answers P0002 for an id the caller may not see', async () => {
    const manager = await grantRoleWith(customer, 'music-manager-b', ['music.manage'], [
      customer.companyId,
    ]);
    const owner = await signInAs(customer.email, customer.password);

    // An artist the manager genuinely cannot reach: it lives in the Station
    // their role does not cover.
    const { data: hiddenId, error: createError } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Hidden artist',
    });
    expect(createError).toBeNull();

    const client = await signInAs(manager.email, manager.password);
    const { error } = await client.rpc('update_music_reference', {
      p_kind: 'ARTIST',
      p_id: hiddenId as string,
      p_name: 'Renamed from outside',
    });

    // 42501 and not P0002: an unknown id and an unreachable Station are one
    // answer from outside, which is the rule 0093 settled.
    expect(error?.code).toBe('42501');
  });

  it('refuses a song that names an artist from another Station', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: otherArtist } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist over there',
    });

    const { error } = await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Cross-station song',
      p_artist_id: otherArtist as string,
    });

    // Checked in the database, not on the screen — even for the owner, who
    // holds music.manage in both Stations and so passes every permission gate.
    expect(error?.code).toBe('P0002');
  });

  it('shows a caller only the catalogue of the Stations they can reach', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: hereArtist } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Artist here',
    });
    await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Song here',
      p_artist_id: hereArtist as string,
    });

    const { data: thereArtist } = await owner.rpc('create_music_reference', {
      p_company_id: secondCompanyId,
      p_kind: 'ARTIST',
      p_name: 'Artist there',
    });
    await owner.rpc('create_song', {
      p_company_id: secondCompanyId,
      p_title: 'Song there',
      p_artist_id: thereArtist as string,
    });

    const viewer = await grantRoleWith(customer, 'music-one-station', ['music.view'], [
      customer.companyId,
    ]);
    const client = await signInAs(viewer.email, viewer.password);

    const { data: songs, error } = await client.from('songs').select('title, company_id');
    expect(error).toBeNull();

    const titles = (songs ?? []).map((s) => s.title);
    expect(titles).toContain('Song here');
    expect(titles).not.toContain('Song there');
  });

  it('hides an archived record from the ordinary read path entirely', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: genreId } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'GENRE',
      p_name: 'Retired genre',
    });

    await owner.rpc('archive_music_reference', { p_kind: 'GENRE', p_id: genreId as string });

    const { data: genres } = await owner.from('music_genres').select('name');
    expect((genres ?? []).map((g) => g.name)).not.toContain('Retired genre');
  });

  it('refuses to archive an artist a live song still names', async () => {
    const owner = await signInAs(customer.email, customer.password);

    const { data: artistId } = await owner.rpc('create_music_reference', {
      p_company_id: customer.companyId,
      p_kind: 'ARTIST',
      p_name: 'Still in use',
    });
    await owner.rpc('create_song', {
      p_company_id: customer.companyId,
      p_title: 'Depends on the artist',
      p_artist_id: artistId as string,
    });

    const { error } = await owner.rpc('archive_music_reference', {
      p_kind: 'ARTIST',
      p_id: artistId as string,
    });

    expect(error?.code).toBe('23503');
  });

  it('lets a caller with music.view read but never write', async () => {
    const viewer = await grantRoleWith(customer, 'music-readonly', ['music.view']);
    const client = await signInAs(viewer.email, viewer.password);

    const { error: readError } = await client.from('artists').select('id').limit(1);
    expect(readError).toBeNull();

    // No INSERT grant exists for `authenticated` on any of the six tables
    // (0099), so this is refused by the grant, before RLS is consulted.
    const { error: writeError } = await client
      .from('artists')
      .insert({
        organization_id: customer.organizationId,
        company_id: customer.companyId,
        name: 'Through the back door',
      });
    expect(writeError).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail, then pass**

Run: `npm run test:isolation`

If the migrations from Tasks 1–4 are applied, this suite should pass on its first run — it proves migrations that already exist rather than driving new ones. **A failure here is a real defect in `0098`–`0101`, not a test to be adjusted.** Two failures worth naming in advance:

- *`create_music_reference` answers `P0002` instead of `42501`* → the permission check is below the Company lookup. Move it above (Task 3, Step 3).
- *the cross-Station song is refused with `23503` rather than `P0002`* → `assert_song_references_live` is not being called, and the composite foreign key is catching it instead. The constraint is the floor, not the message.

Expected once correct: 8 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/isolation/music.test.ts
git commit -m "test(music): the tenant boundary, with real users and narrower grants"
```

---

## Task 6: Types, schemas and the URL contract

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (regenerated)
- Create: `src/schemas/music.ts`
- Create: `tests/unit/music-schema.test.ts`
- Modify: `src/lib/record-params.ts`

**Interfaces:**
- Consumes: every function from Tasks 3 and 4.
- Produces: `songFormSchema` / `SongFormInput`, `songUpdateSchema` / `SongUpdateInput`, `referenceFormSchema` / `ReferenceFormInput`, `MUSIC_REFERENCE_KINDS`, `SONG_SEARCH_MAX_LENGTH`; `SONG_TABS = ['data'] as const`, `ARTIST_TABS = ['data', 'songs'] as const` in `record-params.ts`. Tasks 7–11 import all of it.

- [ ] **Step 1: Regenerate the database types**

Run: `npm run db:reset && npm run db:types`

The file is generated — never hand-edit it. Confirm the new doors appear:

```bash
grep -c "create_music_reference\|update_music_reference\|archive_music_reference\|create_song\|update_song\|archive_song" src/lib/supabase/database.types.ts
```
Expected: at least 6.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/music-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { referenceFormSchema, songFormSchema } from '@/schemas/music';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const ARTIST = '00000000-0000-0000-0000-0000000000a1';

describe('songFormSchema', () => {
  it('accepts a song with nothing but a title and an artist', () => {
    const parsed = songFormSchema.safeParse({
      companyId: COMPANY,
      title: 'Águas de Março',
      artistId: ARTIST,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a song with no artist — the database would too, one round trip later', () => {
    const parsed = songFormSchema.safeParse({ companyId: COMPANY, title: 'No artist' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a blank title rather than sending whitespace to be trimmed away', () => {
    const parsed = songFormSchema.safeParse({
      companyId: COMPANY,
      title: '   ',
      artistId: ARTIST,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a fractional or zero duration', () => {
    for (const durationSeconds of [0, -1, 3.5]) {
      const parsed = songFormSchema.safeParse({
        companyId: COMPANY,
        title: 'Timed',
        artistId: ARTIST,
        durationSeconds,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('turns an empty optional into undefined rather than an empty string', () => {
    const parsed = songFormSchema.parse({
      companyId: COMPANY,
      title: 'Blank fields',
      artistId: ARTIST,
      labelId: '',
      internalCode: '',
      legacyId: '',
    });
    expect(parsed.labelId).toBeUndefined();
    expect(parsed.internalCode).toBeUndefined();
    expect(parsed.legacyId).toBeUndefined();
  });

  it('accepts every vocal the enum carries, including the three §4.2 never named', () => {
    for (const vocal of ['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL']) {
      const parsed = songFormSchema.safeParse({
        companyId: COMPANY,
        title: 'Sung',
        artistId: ARTIST,
        vocal,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('referenceFormSchema', () => {
  it('accepts the four kinds and refuses a fifth', () => {
    for (const kind of ['GENRE', 'LABEL', 'ARTIST', 'SHOW']) {
      expect(referenceFormSchema.safeParse({ companyId: COMPANY, kind, name: 'X' }).success).toBe(
        true,
      );
    }
    expect(
      referenceFormSchema.safeParse({ companyId: COMPANY, kind: 'SONG', name: 'X' }).success,
    ).toBe(false);
  });

  it('refuses a blank name', () => {
    expect(
      referenceFormSchema.safeParse({ companyId: COMPANY, kind: 'GENRE', name: '  ' }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/unit/music-schema.test.ts`
Expected: FAIL — `Cannot find module '@/schemas/music'`.

- [ ] **Step 4: Write the schemas**

Create `src/schemas/music.ts`:

```ts
import { z } from 'zod';

/**
 * Mirrors 0100/0101. Every bound here exists so that a refusal the database
 * would make anyway arrives as a field-level message instead of a round trip
 * — the reasoning schemas/inventory.ts sets out for its own.
 */

/** The four short lists 0100's music_reference_kind carries. NOT 7b's merge kinds, which drop SHOW and add SONG. */
export const MUSIC_REFERENCE_KINDS = ['GENRE', 'LABEL', 'ARTIST', 'SHOW'] as const;
export type MusicReferenceKind = (typeof MUSIC_REFERENCE_KINDS)[number];

export const MUSIC_NATIONALITIES = ['DOMESTIC', 'INTERNATIONAL'] as const;
export const MUSIC_VOCALS = ['MALE', 'FEMALE', 'DUO', 'GROUP', 'INSTRUMENTAL'] as const;

/** The one bound on a search term, exported so screens enforce this number rather than a copy of it. */
export const SONG_SEARCH_MAX_LENGTH = 100;

// `text` in Postgres has no length of its own, so an unbounded field here
// would let the form store what no screen could display or compare — the same
// reasoning prizeFormSchema gives internal_code.
const name = z.string().trim().min(1, 'Give it a name.').max(160);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

const optionalUuid = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? undefined : v));

export const referenceFormSchema = z.object({
  companyId: z.string().uuid(),
  kind: z.enum(MUSIC_REFERENCE_KINDS),
  name,
  legacyId: optionalText(120),
});

export type ReferenceFormInput = z.infer<typeof referenceFormSchema>;

export const referenceUpdateSchema = referenceFormSchema.omit({ companyId: true }).extend({
  id: z.string().uuid(),
});

export type ReferenceUpdateInput = z.infer<typeof referenceUpdateSchema>;

export const songFormSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the song a title.').max(200),
  // Required, and the message says why rather than naming a field: 0101
  // refuses this too, and a song without an artist is a draft, not a record.
  artistId: z.string().uuid('Choose an artist — a song without one is a draft.'),
  labelId: optionalUuid,
  genreId: optionalUuid,
  nationality: z.enum(MUSIC_NATIONALITIES).nullable().optional(),
  vocal: z.enum(MUSIC_VOCALS).nullable().optional(),
  // 0098's check is `duration_seconds is null or duration_seconds > 0`, and
  // the column is an integer. All three refusals happen here first.
  durationSeconds: z
    .number()
    .int('A duration is a whole number of seconds.')
    .positive('A duration is greater than zero.')
    .nullable()
    .optional(),
  internalCode: optionalText(40),
  legacyId: optionalText(120),
});

export type SongFormInput = z.infer<typeof songFormSchema>;

/**
 * Updating a song names the song, never its Station: update_song (0101)
 * resolves the Organization AND the Company from the song row itself, so a
 * companyId here would be a value the RPC ignores — and a parameter that looks
 * like it decides something while deciding nothing is how a caller ends up
 * believing it can move a song between Stations.
 */
export const songUpdateSchema = songFormSchema.omit({ companyId: true }).extend({
  songId: z.string().uuid(),
});

export type SongUpdateInput = z.infer<typeof songUpdateSchema>;
```

- [ ] **Step 5: Add the tab vocabularies**

In `src/lib/record-params.ts`, beside the existing tuples — **this module is the only one that knows how a record's address is spelled**, and a tuple declared beside a `'use client'` dialog is the defect its own comment documents at length:

```ts
export const SONG_TABS = ['data'] as const;
export type SongTab = (typeof SONG_TABS)[number];

/**
 * An artist's record opens on its own fields and offers what the artist is
 * FOR: the songs registered under them. One read per opening feeds both, the
 * shape every other record dialog in this codebase uses.
 */
export const ARTIST_TABS = ['data', 'songs'] as const;
export type ArtistTab = (typeof ARTIST_TABS)[number];
```

- [ ] **Step 6: Run it and watch it pass**

Run: `npx vitest run tests/unit/music-schema.test.ts && npm run typecheck`
Expected: PASS, and a clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/music.ts src/lib/record-params.ts src/lib/supabase/database.types.ts tests/unit/music-schema.test.ts
git commit -m "feat(music): the forms, the tab vocabularies and the regenerated types"
```

---

## Task 7: The service layer

**Files:**
- Create: `src/services/music.ts`

**Interfaces:**
- Consumes: `keysetFilter`/`keysetPage`/`Cursor`/`SortDirection` from `@/lib/keyset`; `escapeLikePattern`/`quoteForOrFilter` from `@/lib/postgrest`; `createUserClient`; the schemas from Task 6.
- Produces:
  - `listSongsPage(params: SongListParams): Promise<SongListPage>` — `SongListParams = { companyId, search?, artistId?, genreId?, sort: SongSortKey, direction, cursor, cursorSide }`, `SongSortKey = 'title' | 'created'`
  - `listArtistsPage(params: ArtistListParams): Promise<ArtistListPage>` — `ArtistSortKey = 'name' | 'created'`
  - `listMusicReferences(companyId: string, kind: MusicReferenceKind): Promise<ReferenceSummary[]>`
  - `getSongById(songId: string): Promise<{ companyId: string; song: SongSummary } | null>`
  - `getArtistById(artistId: string)`, `getArtistSongs(companyId: string, artistId: string)`
  - `createSong`, `updateSong`, `archiveSong`, `createMusicReference`, `updateMusicReference`, `archiveMusicReference` — each taking an `accessToken` last
  - `SONG_PAGE_SIZE`, re-exported `SONG_SEARCH_MAX_LENGTH`

**Two rules this file follows, both from precedent:**

1. **Reads go through `createUserClient()` and RLS.** No `SECURITY DEFINER` list function is built in this block. D6's rule exists to protect the listener's identity on `music_requests`, and no listener identity is on any table 7a reads. Building a definer list here would mean re-stating by hand a gate RLS already applies correctly — more code and one more place to get it wrong.
2. **Writes go through `asCaller(accessToken)`.** Every RPC re-checks `has_permission` against `auth.uid()`; calling one with the service key would defeat the check it exists to make.

- [ ] **Step 1: Write the file**

Create `src/services/music.ts`, modelling `listSongsPage` directly on `listPrizesPage` in `src/services/inventory.ts` (`M:\CRM - LISTENER\src\services\inventory.ts:164`) — same keyset walk, same `build()` closure shared between the row read and the exact count, same `walkingBack` handling:

```ts
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createUserClient } from '@/lib/supabase/user-client';
import { getUserSupabaseConfig } from '@/lib/supabase/config';
import { BusinessRuleError, ConflictError, InternalError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { keysetFilter, keysetPage } from '@/lib/keyset';
import type { Cursor, SortDirection } from '@/lib/keyset';
import { escapeLikePattern, quoteForOrFilter } from '@/lib/postgrest';
import type { Database } from '@/lib/supabase/database.types';
import { SONG_SEARCH_MAX_LENGTH } from '@/schemas/music';
import type { MusicReferenceKind, ReferenceFormInput, ReferenceUpdateInput, SongFormInput, SongUpdateInput } from '@/schemas/music';

export { SONG_SEARCH_MAX_LENGTH };

/** A client bound to the caller's JWT — see services/inventory.ts's asCaller for why every write uses one. */
function asCaller(accessToken: string) {
  const { url, anonKey } = getUserSupabaseConfig();
  return createClient<Database>(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

with these specifics:

- **`SONG_PAGE_SIZE = 50`** — the audience and inventory lists' page size, for the same reason: it is what a person can scan.
- **`SONG_COLUMNS`** — one constant shared by the row read and the count read, so the two cannot disagree: `'id, title, artist_id, label_id, genre_id, nationality, vocal, duration_seconds, internal_code, legacy_id, created_at'` plus the embedded names PostgREST resolves through the foreign keys: `artists(name), record_labels(name), music_genres(name)`.
- **the search term** covers title and internal code, escaped exactly as `listPrizesPage` does — `escapeLikePattern` **before** the wildcard markers, then `quoteForOrFilter`:
  ```ts
  const wildcard = quoteForOrFilter(`%${escapeLikePattern(term)}%`);
  q = q.or(`title.ilike.${wildcard},internal_code.ilike.${wildcard}`);
  ```
  The artist's name is deliberately **not** searched here: `.or()` cannot reach an embedded resource's column, and faking it with a second query would make the exact count wrong. Recorded in the block report; the Artists screen is where an artist is found by name.
- **the sort columns** are `title` and `created_at`, neither nullable (0098), so `keysetFilter`'s `nullsLast` argument is `false` — there is no null region for a cursor to cross into.
- **the error mapping**: reuse the `describe`-style translation the other services use — `42501` → `UnauthorizedError`, `P0002` → `NotFoundError`, `23505` → `ConflictError`, `22023`/`23514` → `ValidationError`, `23503` → `BusinessRuleError`, anything else → `InternalError` carrying the message.
- **`listMusicReferences`** reads one of the four tables by kind, `deleted_at is null`, ordered by name. It maps the kind to a table name with a `Record<MusicReferenceKind, 'music_genres' | 'record_labels' | 'artists' | 'shows'>` so the table name is never a string a caller supplies.
- **`getArtistSongs`** feeds the artist record's second tab: `id, title, created_at` for live songs of that artist, ordered by title, capped at 200 with a `hasMore` flag rather than paged — an artist with more than two hundred songs in one Station is not the case this tab is for, and the Songs screen filtered by artist is.

- [ ] **Step 2: Verify it compiles against the generated types**

Run: `npm run typecheck && npm run lint`
Expected: clean. A failure naming `create_music_reference` means Task 6's regeneration did not happen.

- [ ] **Step 3: Commit**

```bash
git add src/services/music.ts
git commit -m "feat(music): reads through RLS, writes through the caller's own JWT"
```

---

## Task 8: The Songs screen

**Files:**
- Create: `src/app/(app)/music/errors.ts`, `src/app/(app)/music/format.ts`, `src/app/(app)/music/permissions.ts`
- Create: `src/app/(app)/music/songs/page.tsx`, `list-params.ts`, `songs-filters.tsx`, `songs-grid.tsx`, `song-record-dialog.tsx`, `song-fields.tsx`, `actions.ts`, `record.ts`
- Create: `tests/unit/music-params.test.ts`

**Interfaces:**
- Consumes: everything from Task 7; `listCompanyAccess` and `STATION_SEARCH_MAX_LENGTH` from `src/app/(app)/inventory/station-access.ts` (already generalised over a permission code — pass `'music.view'`); `parseRecordParam` and `SONG_TABS`; `useRecordDialog`.
- Produces: `MusicSearchParams`, `SongListState`, `parseSongListState`, `parseSongCursor`, `songHref`, `songSortHref`; `getMusicPermissions(supabase, companyId): Promise<{ manage: boolean; request: boolean; merge: boolean }>` in `src/app/(app)/music/permissions.ts`, imported by all three screens.

The screen is the inventory screen's shape, and the file that shows it end to end is `src/app/(app)/inventory/page.tsx`: resolve the caller, resolve the Stations they hold `music.view` in, fall back to the first, parse the list state and cursor from the URL, read reference data and the page in one `Promise.all`, render filters, then grid.

- [ ] **Step 1: Write the failing test for the URL contract**

Create `tests/unit/music-params.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SONG_SORT,
  hasActiveSongFilters,
  parseSongCursor,
  parseSongListState,
  songHref,
  songSortHref,
} from '@/app/(app)/music/songs/list-params';

const COMPANY = '00000000-0000-0000-0000-0000000000c1';

describe('parseSongListState', () => {
  it('defaults to title, ascending — a catalogue is browsed alphabetically', () => {
    const state = parseSongListState({}, COMPANY);
    expect(state.sort).toBe('title');
    expect(state.direction).toBe('asc');
  });

  it('flips created to descending, because recency reads newest first', () => {
    const state = parseSongListState({ sort: 'created' }, COMPANY);
    expect(state.direction).toBe('desc');
  });

  it('ignores a sort key it does not know rather than erroring', () => {
    expect(parseSongListState({ sort: 'nonsense' }, COMPANY).sort).toBe(DEFAULT_SONG_SORT);
  });

  it('treats a whitespace-only search as no search', () => {
    expect(parseSongListState({ q: '   ' }, COMPANY).search).toBeUndefined();
  });
});

describe('songHref', () => {
  it('carries the Station and drops the defaults', () => {
    const state = parseSongListState({}, COMPANY);
    expect(songHref(state)).toBe(`/music/songs?companyId=${COMPANY}`);
  });

  it('drops the cursor when the sort changes, because a cursor is a position in one ordering', () => {
    const state = parseSongListState({ q: 'elis', after: 'abc' }, COMPANY);
    expect(songSortHref(state, 'created')).not.toContain('after=');
    expect(songSortHref(state, 'created')).toContain('q=elis');
  });

  it('carries the Station search, so a sort click cannot move the operator to another Station', () => {
    const state = parseSongListState({ station: 'radio' }, COMPANY);
    expect(songHref(state)).toContain('station=radio');
  });
});

describe('parseSongCursor', () => {
  it('prefers before over after, so walking back wins a malformed pair', () => {
    expect(parseSongCursor({ before: 'b', after: 'a' })).toEqual({ side: 'before', value: 'b' });
  });

  it('is null when neither is present', () => {
    expect(parseSongCursor({})).toBeNull();
  });
});

describe('hasActiveSongFilters', () => {
  it('does not count the Station selection as a filter', () => {
    expect(hasActiveSongFilters(parseSongListState({}, COMPANY))).toBe(false);
    expect(hasActiveSongFilters(parseSongListState({ q: 'x' }, COMPANY))).toBe(true);
    expect(hasActiveSongFilters(parseSongListState({ artist: 'x' }, COMPANY))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/unit/music-params.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the URL contract**

Create `src/app/(app)/music/songs/list-params.ts` on the shape of `src/app/(app)/inventory/list-params.ts` (`M:\CRM - LISTENER\src\app\(app)\inventory\list-params.ts`), with:

```ts
export interface MusicSearchParams {
  companyId?: string;
  station?: string;
  q?: string;
  artist?: string;
  genre?: string;
  sort?: string;
  dir?: string;
  after?: string;
  before?: string;
  record?: string;
  tab?: string;
}

/** Alphabetical: a catalogue is browsed by title, not by recency. */
export const DEFAULT_SONG_SORT: SongSortKey = 'title';

export function defaultDirectionFor(sort: SongSortKey): SortDirection {
  return sort === 'title' ? 'asc' : 'desc';
}
```

and `parseSongListState`, `parseSongCursor`, `hasActiveSongFilters`, `songHref`, `songSortHref` written exactly as the inventory file writes its five, over `/music/songs` and the `artist`/`genre` filters. Every link carries `companyId` and `station` — dropping `station` would put the Station list back to its capped first page, and a Station only reachable **through** the search would silently fall out of it on the next sort click.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run tests/unit/music-params.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the screen**

Create the remaining files. What each one is for, and the two decisions that are not mechanical:

- **`src/app/(app)/music/errors.ts`** — `describeMusicReadError(cause)` and `describeMusicWriteError(cause, action)`, mirroring `src/app/(app)/inventory/errors.ts`. Shared by all three screens, which is why it sits at `music/` and not `music/songs/`.
- **`src/app/(app)/music/format.ts`** — `formatDuration(seconds: number | null)` → `m:ss`, and the label maps for `nationality` and `vocal`. One module, because the Songs grid, the song record and the Artists screen's song tab all render a duration and would otherwise each round it their own way.
- **`src/app/(app)/music/permissions.ts`** — `getMusicPermissions`, the `Promise.all` over `has_permission` for `music.manage`, `music.request` and `music.merge`, in the shape of `getInventoryPermissions`. A failed check **throws** rather than folding into "not granted": collapsing a transient RPC failure into "no access" would silently hide every form from someone who does hold the permission.
- **`page.tsx`** — a Server Component, `export const dynamic = 'force-dynamic'`, resolving access with `listCompanyAccess(supabase, 'music.view', stationSearch)`. Redirect to `/app` when the caller holds `music.view` nowhere — a courtesy, not the boundary — but **only after** handling a Station search that matched nothing, so the search can always be undone.
- **`songs-filters.tsx`** — search box, artist select, genre select. The selects are fed from `listMusicReferences`, so an operator filters by the names their own Station registered.
- **`songs-grid.tsx`** — the table, the sort headers built from `songSortHref`, the previous/next links, and `useRecordDialog(SONG_TABS, initialRecord)`. It patches its own row on save via `src/lib/row-patch.ts` rather than revalidating.
- **`actions.ts`** — `createSongAction`, `updateSongAction`, `archiveSongAction`. **Not one `revalidatePath` in this file**, the rule `members/actions.ts` and `inventory/actions.ts` both carry: `revalidatePath` returns a fresh render of the route alongside the action's result, re-running the keyset query and losing the operator's place in the list. The actions return what was stored and the grid patches the row.
- **`record.ts`** — `getSongRecordAction(songId)`, returning `{ status: 'ok' | 'not-found' | 'error' }`. `not-found` covers two facts on purpose — no such song, and a song at a Station this caller cannot reach — because RLS decides which rows exist and the screen must not let them be told apart.
- **`song-record-dialog.tsx` / `song-fields.tsx`** — one read per opening, one tab (`data`). The fields: title, artist, label, genre, nationality, vocal, duration, internal code, legacy id. **`legacyId` is rendered read-only** — it is Block 9's idempotency handle, not an operator's field, and a hand-edited one would let a second ETL run duplicate the row it was supposed to recognise. It is shown rather than hidden so that "why did the import skip this" has an answer on the screen.

- [ ] **Step 6: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/music" tests/unit/music-params.test.ts
git commit -m "feat(music): the Songs screen, with filters and a record over the list"
```

---

## Task 9: The Artists screen

**Files:**
- Create: `src/app/(app)/music/artists/page.tsx`, `list-params.ts`, `artists-filters.tsx`, `artists-grid.tsx`, `artist-record-dialog.tsx`, `actions.ts`, `record.ts`

**Interfaces:**
- Consumes: `listArtistsPage`, `getArtistById`, `getArtistSongs`, `createMusicReference`, `updateMusicReference`, `archiveMusicReference` from Task 7; `ARTIST_TABS`; `describeMusicReadError`/`describeMusicWriteError` and `getMusicPermissions` from Task 8.
- Produces: `/music/artists` and the artist record dialog. Nothing else imports it.

Same shape as Task 8's screen, over `listArtistsPage`, with two differences that matter:

1. **The record has two tabs.** `data` is the name and the legacy handle; `songs` lists what is registered under this artist, from `getArtistSongs`, in one read taken when the record opens — so switching tabs cannot reach the server and therefore cannot re-run the list behind the dialog. Each row links to `/music/songs?companyId=…&artist=<id>&record=<songId>`, which is how an operator gets from an artist to one of their songs without losing the Station.
2. **Archiving an artist can be refused.** `archive_music_reference` answers `23503` while a live song still names them. `describeMusicWriteError` maps that to a sentence the operator can act on — *"This artist still has songs registered. Move or archive them first."* — rather than the raw constraint message.

- [ ] **Step 1: Write the screen**

Create the seven files above, `list-params.ts` over `/music/artists` with sort keys `'name' | 'created'`, default `name`/`asc`, and a single `q` filter.

- [ ] **Step 2: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/music/artists"
git commit -m "feat(music): the Artists screen, and the songs behind each name"
```

---

## Task 10: The Catalog screen — three lists, one screen

**Files:**
- Create: `src/app/(app)/music/catalog/page.tsx`, `reference-tabs.tsx`, `reference-panel.tsx`, `actions.ts`

**Interfaces:**
- Consumes: `listMusicReferences`, `createMusicReference`, `updateMusicReference`, `archiveMusicReference`; `getMusicPermissions`; `describeMusicWriteError`.
- Produces: `/music/catalog`, with `?tab=labels|genres|shows`.

**Why one screen and not three.** §5: these are short lists of names chosen from a select, and three menu items for three one-field forms would swell the sidebar for nothing. Shows are not music metadata and sit here for the same practical reason.

The tab lives in the URL (`?tab=`) rather than in component state, so a link to "the genres of this Station" exists and survives a reload. It is validated against the tuple and falls back to the first — the contract `parseRecordParam` already carries for hostile input, applied to one more parameter.

There is **no record dialog here**: the whole record is one field. Each row is edited in place — a name input and a Save button — and archived from the same row. That is the deliberate difference from the other two screens, and the reason `record-params.ts` gains no `CATALOG_TABS`: nothing opens a record over this list.

- [ ] **Step 1: Write the screen**

- `page.tsx` — Server Component, resolves the Station the same way, reads all three lists in one `Promise.all` (they are short), renders `ReferenceTabs`.
- `reference-tabs.tsx` — a client component holding the three panels; the tab is read from the URL on first render and rewritten with `history.replaceState`, never `router.push`, for the reason `use-record-dialog.ts` documents: a push re-runs the route's server render.
- `reference-panel.tsx` — one list of names, an inline "Add" row at the top, and per-row edit/archive. Renders forms only when `powers.manage` — a courtesy; `create_music_reference` re-checks.
- `actions.ts` — `createReferenceAction`, `updateReferenceAction`, `archiveReferenceAction`, each parsing against `referenceFormSchema`/`referenceUpdateSchema`, each returning `{ status, message? }`. These **do** call `revalidatePath('/music/catalog')` — the opposite of Task 8's rule, and deliberately: there is no keyset position to lose here and no open record to preserve, so a fresh render is the simplest correct answer.

- [ ] **Step 2: Verify**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/music/catalog"
git commit -m "feat(music): labels, genres and shows on one screen with tabs"
```

---

## Task 11: The navigation, and the round trip

**Files:**
- Modify: `src/lib/auth/shell.ts`
- Modify: `src/components/layout/app-shell.tsx` (one icon)
- Create: `tests/e2e/music-catalogue.spec.ts`

**Interfaces:**
- Consumes: the three routes from Tasks 8–10.
- Produces: a `Music` section in the sidebar with `Songs`, `Artists` and `Catalog`.

- [ ] **Step 1: Add the icon**

In `src/components/layout/app-shell.tsx`, add to `ICONS` — its own path rather than a reuse, for the reason the `ticket` entry's own comment gives: one icon on two rows in the same section reads as one link rendered twice, and `radio` is already the Overview item:

```ts
  // A music note, for the catalogue. Its own path rather than reusing radio:
  // that one is Overview's "My stations" and would make the two sections read
  // as the same destination.
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
```

- [ ] **Step 2: Add the section**

In `src/lib/auth/shell.ts`, after the `Promotions` section and before `Organization`:

```ts
    {
      // Visible to every member, including those holding no music permission
      // in any Station at all — the same courtesy Inventory, Audience and
      // Promotions already extend. Each of the three pages redirects at the
      // top of its own render for anyone holding music.view nowhere, the
      // select policies in 0099 cut every read to the Stations that do hold
      // it, and every RPC in 0100/0101 re-checks has_permission in its own
      // body. Hiding a link is a courtesy; the boundary is in the database.
      label: 'Music',
      items: [
        { href: '/music/songs', label: 'Songs', icon: ICONS.music },
        { href: '/music/artists', label: 'Artists', icon: ICONS.users },
        { href: '/music/catalog', label: 'Catalog', icon: ICONS.box },
      ],
    },
```

- [ ] **Step 3: Write the round trip**

Create `tests/e2e/music-catalogue.spec.ts` — one journey, in the order an operator actually works, because a catalogue cannot be built out of order:

```ts
import { expect, test } from '@playwright/test';

/**
 * Block 7a's whole journey: an operator arrives with an empty catalogue and
 * leaves with a song in it.
 *
 * The order is the point. A song cannot be registered before its artist
 * exists, and the artist select is empty until the artist is created — so a
 * spec that seeded rows directly and only checked the grid would pass over
 * exactly the ordering an operator meets on their first day.
 */
test('an operator builds a Station catalogue from nothing', async ({ page }) => {
  // Signs in through the existing helper the other specs use.
  await page.goto('/music/catalog');

  // 1. A genre and a label, on the Catalog screen.
  await page.getByRole('tab', { name: 'Genres' }).click();
  await page.getByLabel('Name').fill('MPB');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('cell', { name: 'MPB' })).toBeVisible();

  // 2. An artist, on its own screen.
  await page.getByRole('link', { name: 'Artists' }).click();
  await page.getByRole('button', { name: 'Register an artist' }).click();
  await page.getByLabel('Name').fill('Elis Regina');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'Elis Regina' })).toBeVisible();

  // 3. The song, which needs both.
  await page.getByRole('link', { name: 'Songs' }).click();
  await page.getByRole('button', { name: 'Register a song' }).click();
  await page.getByLabel('Title').fill('Águas de Março');
  await page.getByLabel('Artist').selectOption({ label: 'Elis Regina' });
  await page.getByLabel('Genre').selectOption({ label: 'MPB' });
  await page.getByLabel('Duration (seconds)').fill('213');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('cell', { name: 'Águas de Março' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '3:33' })).toBeVisible();

  // 4. The artist's record now knows about the song — one read, two tabs.
  await page.getByRole('link', { name: 'Artists' }).click();
  await page.getByRole('cell', { name: 'Elis Regina' }).click();
  await page.getByRole('tab', { name: 'Songs' }).click();
  await expect(page.getByText('Águas de Março')).toBeVisible();

  // 5. And the artist cannot be archived out from under it.
  await page.getByRole('tab', { name: 'Artist data' }).click();
  await page.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByText(/still has songs registered/i)).toBeVisible();
});
```

Follow the sign-in and Station-selection preamble the neighbouring specs already use — read `tests/e2e/inventory-flow.spec.ts` and copy its setup rather than inventing a second one.

- [ ] **Step 4: Run every gate**

```bash
npm run lint && npm run typecheck && npm run build && npm test && npm run db:test && npm run test:isolation && npm run test:e2e
```
Expected: all seven green. **Report what the commands actually printed** — this is the block's verification, and a gate reported as passing without being run is the failure `superpowers:verification-before-completion` exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/shell.ts src/components/layout/app-shell.tsx tests/e2e/music-catalogue.spec.ts
git commit -m "feat(music): the Music section, and the journey that builds a catalogue"
```

---

## Task 12: The report and the runbook

**Files:**
- Create: `docs/block-7a-report.md`
- Create: `docs/block-7a-runbook.md`

**Interfaces:**
- Consumes: everything.
- Produces: the two documents every block in this project ends with.

- [ ] **Step 1: Write the report**

`docs/block-7a-report.md`, in the shape of `docs/block-6d-report.md`. It must carry, at minimum:

- **What was built**, against the spec's §7a list, and the three screens rather than the "two" §7a says.
- **The decisions this plan made that the spec did not**, each with its reasoning: one kind-discriminated trio instead of twelve functions; permission-before-existence on `create_*` (a departure from 0027's order); reads through RLS rather than a `SECURITY DEFINER` list function; `legacy_id` rendered read-only; the Catalog screen revalidating where the other two do not.
- **What is knowingly missing**, so nobody rediscovers it as a bug:
  - `shows` has no cure for a duplicate — no unique index and no merge door (§ "Two readings", item 3).
  - The song search does not reach the artist's name, because `.or()` cannot cross into an embedded resource and a second query would make the exact count wrong.
  - `music.request` and `music.merge` are granted from this block and guard nothing until 7b.
  - No "show archived" filter exists, and cannot be built from the client: 0099's policy makes an archived row unreadable rather than hidden — the same finding `services/inventory.ts` records for prizes.
- **The counts, actually counted.** Every figure in this document — assertions, functions, tables — is to be produced by running a command and pasting its output, not estimated. This project has corrected false headcounts in four separate documents; do not add a fifth.

- [ ] **Step 2: Write the runbook**

`docs/block-7a-runbook.md`, in the shape of `docs/block-6d-runbook.md`, for whoever operates a Station:

- Where the three screens live and what each is for.
- **Which permission unlocks what**, as a table: `music.view` sees, `music.manage` builds, `music.request` and `music.merge` do nothing until 7b.
- **Why a Station cannot see another Station's catalogue**, and that this is deliberate (D1) rather than a bug to be reported — the first question a group with five Stations will ask.
- **Why a duplicate song is allowed**, and that the cure arrives in 7b.
- **Why an artist cannot be archived while songs name them**, and what to do instead.
- The SQL to confirm the four permissions are installed:
  ```sql
  select code, module, label from public.permissions where module = 'music' order by display_order;
  ```
  A healthy install returns exactly four rows.

- [ ] **Step 3: Commit**

```bash
git add docs/block-7a-report.md docs/block-7a-runbook.md
git commit -m "docs: what Block 7a built, what it decided, and what it knowingly left"
```

---

## Self-review — spec coverage

| Spec | Where |
|---|---|
| D1 — every table per Station | Task 1 (schema + assertion 15), Task 5 (proved with real users) |
| D2 — a duplicate song is allowed | Task 1 (assertion 16), Task 4 (assertion 20) |
| D3 — merging covers four entities | **7b.** `music_reference_kind`'s comment warns that its four are not the merge's four |
| D4 — merging takes many losers, atomically | **7b** |
| D5 — a request names a listener, and has no state | Task 1 — the table, `member_id not null`, no status column. The door is 7b's |
| D6 — the listener's identity rule | **7b.** Task 2's policy is the floor it builds on |
| D7 — `legacy_id` | Task 1 (the six partial unique indexes, assertions 20–22), Task 8 (read-only in the form) |
| D8 — four permissions, the destructive one separate | Task 1 |
| §3.1 the four simple ones | Task 1, Task 3 |
| §3.2 songs | Task 1, Task 4 |
| §3.3 music_requests | Task 1 (table only — 7b brings the door) |
| §3.4 music_merges | **7b** |
| §4 the merge | **7b** |
| §5 the screens | Tasks 8, 9, 10 — Songs, Artists, Catalog. Requests and Maintenance are 7b's |
| §6 verification | Tasks 1–5 and 11. The four proofs §6 calls non-obvious are all merge proofs, and all 7b's |
| §7a scope | Every task |
| §8 what other blocks inherit | Task 12's report |
