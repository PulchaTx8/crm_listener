-- supabase/migrations/0238_send_lists.sql

-- Block 29d-1. A send list: the people a campaign will go to, or the question
-- that finds them.
--
-- ONE STATION, ALWAYS (spec D3). member_consents.company_id is not null and a
-- campaign goes out as one Station, so a list spanning Stations would show a
-- number that is never the number sent. A group reaching three Stations makes
-- three lists, which is honest: those are three separate consents.
--
-- TWO KINDS (spec D2). A FIXED list stores its people in send_list_members and
-- never changes. A LIVING list stores `filters` and is resolved again on each
-- send. "Todos os ouvintes" wants to be living; "who requested a song between
-- 18:00 and 20:00 yesterday" is historical and wants to be fixed.
--
-- `filters` IS STORED FOR BOTH KINDS, not only living ones. A fixed list needs
-- it too: a list called "engajados" says nothing three months later, and the
-- question asked then is always "what exactly did I filter here". For a fixed
-- list it is a record; for a living one it is the query.
--
-- WHAT IS NOT HERE: eligibility. A list holds people, not permission to write to
-- them. Consent is applied when a campaign snapshots (29d-2) and again at send,
-- because it changes and a list should not silently come to mean something its
-- filters never said.
create table public.send_lists (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  name            text not null check (btrim(name) <> ''),
  source          public.send_list_source not null,
  kind            public.send_list_kind not null,
  filters         jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint send_lists_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

-- The RLS policy below reads this on every listing.
create index send_lists_company_idx on public.send_lists (company_id) where deleted_at is null;

comment on table public.send_lists is
  'Block 29d-1. One row per named send list, scoped to exactly one Station (spec D3), because a campaign goes out as one Station and consent is per Station. FIXED (kind) freezes its people into send_list_members; LIVING keeps filters and is resolved again on every send (spec D2). filters is kept for both kinds: for a fixed list it is the record of what was asked, for a living one it is the query. Carries no eligibility -- consent is applied when a campaign snapshots (29d-2) and again at send.';

comment on column public.send_lists.filters is
  'The listing filter this list was cut from -- kept even for a FIXED list, whose membership never re-reads it, because a list named months ago says nothing on its own about who was in it.';

-- ON DELETE CASCADE on both foreign keys below, and the two cover different
-- things -- writing them as one sentence is how the second one ends up
-- claiming something it does not do (whole-branch review, F10).
--
-- list_id: fires on a hard DELETE of a send_lists row. A deleted list's people
-- are not a fact about anything once the list itself is gone. NOTHING IN THIS
-- FEATURE ISSUES THAT DELETE -- delete_send_list (0239) is a soft delete and
-- empties this table by hand for exactly that reason -- so the cascade is what
-- keeps a future hard delete from leaving orphans, not something the doors
-- lean on.
--
-- member_id: fires on a hard DELETE of a members row, WHICH ERASURE IS NOT.
-- Erasure under section 12 runs through anonymize_member (0034, last replaced
-- in 0220), which UPDATES the row in place -- every personal column nulled,
-- anonymized_at set -- and nothing in this project deletes from members at
-- all. So an erased listener's id GOES ON EXISTING in every fixed list it was
-- already in, and this cascade is not what covers that. It is ids only, and
-- members_marketing_eligible_bulk (0235) bars an anonymised listener before
-- anything is sent (`m.anonymized_at is null`, outside its coalesce, so no
-- consent row can override it) -- but a later block must not read this cascade
-- as "erasure already prunes these lists", because it does not.
create table public.send_list_members (
  list_id   uuid not null references public.send_lists (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  primary key (list_id, member_id)
);

comment on table public.send_list_members is
  'Block 29d-1. A FIXED list''s frozen membership. ON DELETE CASCADE on both foreign keys, and NEITHER ONE IS WHAT COVERS ERASURE: list_id fires only on a hard DELETE of a send_lists row (delete_send_list is a soft delete and empties this table itself, 0239), and member_id only on a hard DELETE of a members row -- anonymize_member (0034, last replaced in 0220) erases IN PLACE with an UPDATE and nothing here ever deletes from members, so an erased listener''s id stays in every fixed list and is barred at send by members_marketing_eligible_bulk (0235) instead. RLS is on with NO POLICY, the same shape unsubscribe_tokens (0232) uses for its own table -- nothing reads this as a user; the doors (0239, 0240) and the send-time resolver reach it. anon and authenticated hold nothing; service_role holds no SELECT, and its default-ACL TRUNCATE is revoked below.';

-- RLS -------------------------------------------------------------------

alter table public.send_lists enable row level security;

revoke all on public.send_lists from anon, authenticated;

-- READ GATE ONLY. Creating, renaming and archiving a list are doors (0239),
-- the same shape vendors (0198) already uses for a Station-scoped table whose
-- writes are all RPCs -- a grant here would be a second, unaudited way to
-- rewrite a Station's send lists.
grant select on public.send_lists to authenticated;

create policy send_lists_select_messaging_view on public.send_lists
  for select to authenticated
  using (deleted_at is null and public.has_permission('messaging.view', company_id));

comment on policy send_lists_select_messaging_view on public.send_lists is
  'has_permission already carries the platform-admin bypass (0121), so no separate is_platform_admin() check is needed here. deleted_at is null at the policy, the convention every soft-deleted table in this project uses (0006, 0019, 0029, 0198), so an archived list is unreadable through RLS rather than merely hidden by a screen that remembered to filter it.';

grant select on public.send_lists to service_role;

-- service_role keeps the default ACL's TRUNCATE grant unless it is revoked
-- here explicitly -- the same closing vendors (0198) and prize_categories
-- apply, because BYPASSRLS does not substitute for a GRANT and a missing
-- revoke would leave one statement able to empty a Station's send lists.
revoke truncate on public.send_lists from service_role;

alter table public.send_list_members enable row level security;

-- NO POLICY, deliberately, as 0232's unsubscribe_tokens states for its own
-- table: nothing reads this as a user, so there is nothing for a policy to
-- grant. The doors (0239, 0240) and the send-time resolver reach it from
-- inside a SECURITY DEFINER body, where RLS never applies.
revoke all on public.send_list_members from anon, authenticated;

-- AND THE SAME CLOSING send_lists GETS TWELVE LINES ABOVE, which this table
-- was missing (whole-branch review, F9). The revoke on the line above names
-- only anon and authenticated, so service_role kept the default ACL's
-- TRUNCATE -- 0198_vendors.sql:114-119 closed exactly this hole on vendors,
-- and 0029 and 0099 closed it before that. "Nothing reads this as a user" and
-- "RLS with no policy" say nothing whatever about the service key: neither is
-- a GRANT, and one `truncate public.send_list_members` from anything holding
-- that key would empty every fixed list on the platform in one statement.
-- No `grant select` to service_role either, unlike send_lists: nothing that
-- runs as the service key reads this table, and 0240 is the door for
-- everything that does.
revoke truncate on public.send_list_members from service_role;
