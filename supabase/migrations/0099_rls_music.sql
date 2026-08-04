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
