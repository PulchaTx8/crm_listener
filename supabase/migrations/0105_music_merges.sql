-- supabase/migrations/0105_music_merges.sql

-- Block 7b, Task 1: the record of what was merged into what.
--
-- §3.4 of the design spec: who won, who left, of what kind, the reason
-- (mandatory), the actor and when. It is what answers, six months later, why a
-- song vanished from the catalogue — without it a merge is indistinguishable
-- from somebody having deleted the wrong record.

-- FIVE kinds, not the four D3 named. The owner ruled on 2026-08-04 that shows
-- merge too: a duplicated programme splits Block 8's per-show numbers exactly
-- as a duplicated song splits "most requested", and shows had no other cure —
-- D2 removed every unique index, and archiving one leaves its requests
-- pointing at a row 0099's policy makes unreadable.
--
-- This is NOT music_reference_kind (0100). That enum is the four short lists
-- that are a name and nothing else; this one drops nothing and adds SONG.
create type public.music_merge_kind as enum ('SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW');

comment on type public.music_merge_kind is
  'The five entities a merge can collapse. Distinct from music_reference_kind (0100), which is the four short lists: this set adds SONG and keeps SHOW, after the owner ruled for merge_shows on 2026-08-04.';

-- The one place a kind becomes a table name. IMMUTABLE and total, in the shape
-- of music_reference_table (0100): a value added to the enum without a branch
-- here returns null, and every caller formats that null into `public.""` and
-- fails loudly rather than writing somewhere unintended.
create function public.music_merge_table(p_kind public.music_merge_kind)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'SONG'   then 'songs'
    when 'ARTIST' then 'artists'
    when 'LABEL'  then 'record_labels'
    when 'GENRE'  then 'music_genres'
    when 'SHOW'   then 'shows'
  end;
$$;

revoke execute on function public.music_merge_table(public.music_merge_kind) from public;

comment on function public.music_merge_table(public.music_merge_kind) is
  'Maps a merge kind to its table name, for the format(%I) in 0106''s core. EXECUTE granted to nobody: it is only ever called from inside a SECURITY DEFINER body.';

create table public.music_merges (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  kind            public.music_merge_kind not null,
  -- No foreign key on either id, and this is the cost of one history table
  -- rather than five: the pair points at whichever of the five tables `kind`
  -- names, and Postgres has no way to express that. The core resolves both
  -- through music_merge_table and locks them before writing, so nothing
  -- unverified reaches these columns — but a reader must not mistake the
  -- absence of an FK for an oversight.
  winner_id       uuid not null,
  loser_id        uuid not null,
  reason          text not null,
  -- Beyond §3.4's six. D3's whole failure mode is a merge that forgets its
  -- update: §6 asks the TEST to count children before and after, and this
  -- column asks the same question in production, months later, where no test
  -- is running. Zero is a legitimate value — a duplicate nobody had used yet.
  children_moved  integer not null,
  merged_by       uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  constraint music_merges_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),
  -- Blank as well as null. '   ' satisfies NOT NULL and answers nothing in six
  -- months, which is the entire purpose of the column.
  constraint music_merges_reason_not_blank check (btrim(reason) <> ''),
  constraint music_merges_winner_is_not_loser check (winner_id <> loser_id),
  constraint music_merges_children_not_negative check (children_moved >= 0)
);

comment on table public.music_merges is
  'One row per absorbed record: who won, who left, of what kind, why, by whom and when, plus how many children the merge repointed. Written only by apply_music_merge (0106), which is SECURITY INVOKER and granted to nobody — there is no other way to add a row, and no way at all to remove one. This is the first merge history in this codebase; the listener merge ruled for on 2026-08-01 should reuse the same shape.';

create index music_merges_company_created_idx on public.music_merges (company_id, created_at desc);
-- "Where did this record go?" is asked of the LOSER, which is the id that
-- stopped appearing in every list.
create index music_merges_loser_idx  on public.music_merges (loser_id);
create index music_merges_winner_idx on public.music_merges (winner_id);

-- ---------------------------------------------------------------------------
-- RLS. Read-only for everybody; 0106's doors write as the table owner.
-- ---------------------------------------------------------------------------

alter table public.music_merges enable row level security;

revoke all on public.music_merges from anon, authenticated;

grant select on public.music_merges to authenticated;

-- music.view, not music.merge: the history explains a hole in a list, and
-- everybody who can read the list needs to be able to read the explanation.
-- Holding the power to merge is a different question from being allowed to
-- learn that one happened.
--
-- No `deleted_at is null` clause, because there is no deleted_at: a history
-- row is never removed. That is deliberate and not an omission of the
-- convention 0099 follows for the six domain tables.
create policy music_merges_select_music_view on public.music_merges
  for select to authenticated
  using (public.has_permission('music.view', company_id));

-- service_role needs the explicit grant (Block 1a §3.9: BYPASSRLS does not
-- substitute for a GRANT), and read-only for the reason 0099 gives: it is
-- 0106's five doors, not this table's own core, that are SECURITY DEFINER and
-- run as the table owner — the core (see the table comment above) is
-- SECURITY INVOKER and inherits that identity only when a door calls it, the
-- same pattern 0084's deliver_prize/apply_winner_transition pair already
-- proves in production. Either way, no write grant to service_role is needed
-- to make a merge work, and giving one would be a second, unaudited way to
-- rewrite a Station's merge history.
grant select on public.music_merges to service_role;

-- The default ACL leaves service_role holding TRUNCATE, which `revoke all`
-- above never touched (it named anon and authenticated only). One statement
-- would erase every explanation of every merge. 0029 closed this on the
-- inventory ledger and 0099 on the six music tables; closed here before
-- anybody has to find it a fourth time.
revoke truncate on public.music_merges from service_role;

-- ---------------------------------------------------------------------------
-- Three comments that predicted four doors, re-issued to say five.
--
-- Migrations are append-only, so 0098's and 0100's text cannot be edited —
-- and a comment that contradicts the schema is worse than no comment, because
-- a reader trusts it. src/schemas/music.ts carries the third and is edited in
-- place, being ordinary source.
-- ---------------------------------------------------------------------------

comment on table public.shows is
  'A Station''s programmes. Merged like the other four (0106''s merge_shows), after the owner ruled on 2026-08-04 against D3''s original set of four — 0098''s own comment recorded that gap as the owner''s call at 7b, and this is the call. Still deliberately carries no unique index on the name: D2 allows the duplicate and the merge is the cure.';

comment on type public.music_reference_kind is
  'The four catalogue lists that are a name and nothing else. Not the merge''s kinds (music_merge_kind, 0105) — that set adds SONG and, since the owner''s 2026-08-04 ruling, keeps SHOW. 0100''s own header predicted it would drop SHOW; it does not.';
