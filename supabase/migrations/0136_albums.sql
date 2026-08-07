-- supabase/migrations/0136_albums.sql

-- Block 13a, Task 1: the album, which Block 7 left out because nothing then
-- had a use for it and which the Deezer tab now needs a home for.
--
-- Per Station, in the shape 0098 gave the other five music tables:
-- organization_id AND company_id, the composite foreign key against
-- companies (id, organization_id), and the unique (id, company_id) pair so a
-- song proves its Station in a constraint rather than a trigger. A group with
-- five Stations keeps five catalogues and registers "Prenda Minha" five times.
-- That was the owner's ruling of 2026-08-03 and it is not revisited here.
--
-- THE COVER IS A HASH, NOT A URL (design D4). Deezer returns `md5_image`
-- beside every album, and every size is built from it in code:
--
--   https://cdn-images.dzcdn.net/images/cover/{md5}/{W}x{H}-000000-80-0-0.jpg
--
-- Two things follow, and both were the point. A CDN host change becomes a
-- one-line fix in src/lib/integrations/deezer/cover.ts rather than a migration
-- over every row already written. And this column never holds a value that
-- lands verbatim in `<img src>`, so a bad write cannot turn a data column into
-- a vector -- the check below and cover.ts's own guard say the same thing in
-- the two places that can enforce it.

create table public.albums (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  title           text not null,

  -- The barcode of the release. 12 to 14 digits: UPC-A is 12, EAN-13 is 13,
  -- and Deezer pads some to 14. Text and not a number -- leading zeros are
  -- significant, and it is an identifier rather than a quantity, the same
  -- reasoning 0057 gives phone_number_id.
  upc text,

  -- bigint, not uuid and not text: Deezer's ids are integers (album 103763,
  -- track 921568). integer would fit today and is an unnecessary bet.
  deezer_album_id bigint,

  cover_md5    text,
  release_date date,

  legacy_id  text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint albums_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint albums_title_not_blank check (btrim(title) <> ''),
  constraint albums_upc_shape check (upc is null or upc ~ '^[0-9]{12,14}$'),
  -- Deezer's md5_image is a plain MD5, lower-case hex. Anything else is
  -- refused here rather than discovered in a browser as a broken image.
  constraint albums_cover_md5_shape
    check (cover_md5 is null or cover_md5 ~ '^[0-9a-f]{32}$')
);

-- What songs (0138) points at to prove its Station in a constraint rather than
-- a trigger. Without this pair the composite foreign key cannot be declared.
alter table public.albums
  add constraint albums_id_company_key unique (id, company_id);

-- Partial, for the reason 0057 wrote out at length: re-registering an album
-- means soft-deleting one row and inserting another, and a total unique
-- constraint would refuse that second insert forever -- the shape of rule this
-- project prefers to state once rather than discover in support.
create unique index albums_deezer_live
  on public.albums (company_id, deezer_album_id)
  where deleted_at is null and deezer_album_id is not null;

-- The picker reads by title within a Station; the Songs grid joins on id,
-- which the primary key already serves.
create index albums_company_title
  on public.albums (company_id, title)
  where deleted_at is null;

comment on table public.albums is
  'Block 13a. One Station''s albums. Holds the cover hash every screen that names a song renders, and the UPC of the release.';

comment on column public.albums.cover_md5 is
  'Deezer''s md5_image. The URL is built from it in src/lib/integrations/deezer/cover.ts and is never stored, so a CDN host change is a code fix rather than a migration over data.';

comment on column public.albums.deezer_album_id is
  'Set by the Deezer register path (0139) alone. update_album takes no parameter for it, by design D6 -- the code and the cover travel together.';

-- ---------------------------------------------------------------------------
-- RLS, identical to what 0099 gives the other music tables: read gated on
-- music.view resolved from the row's own company_id, and filtering deleted_at
-- AT THE POLICY -- the convention every soft-deleted table in this project
-- uses, so that an ordinary PostgREST select cannot list archived rows just
-- because whoever wrote the next screen forgot to filter them.
--
-- No write policy follows, and that is the deny. Writes go through 0137's
-- SECURITY DEFINER doors, which is where the music.manage check lives.
-- ---------------------------------------------------------------------------

alter table public.albums enable row level security;

revoke all on public.albums from anon, authenticated;
grant select on public.albums to authenticated;

create policy albums_select_music_view on public.albums
  for select to authenticated
  using (deleted_at is null and public.has_permission('music.view', company_id));
