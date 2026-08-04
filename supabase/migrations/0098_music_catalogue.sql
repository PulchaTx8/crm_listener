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
