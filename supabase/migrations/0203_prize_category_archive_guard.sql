-- supabase/migrations/0203_prize_category_archive_guard.sql

-- Block 26, second pass. Archiving a prize category is now REFUSED while a live
-- prize still wears the label, where 0202 detached them.
--
-- The owner's ruling of 2026-08-16, and the reason is that setting every
-- category_id to null is a decision this door should not make on somebody's
-- behalf: which category each prize belongs to next is a judgement per prize,
-- and the maintenance screen that will move them is the next piece of work.
-- Until it exists the honest answer is "not yet" rather than a silent
-- unlabelling. It also puts categories on the same rule as their neighbours —
-- archive_music_reference for an artist with songs, delete_role for a role in
-- use, archive_prize for a prize with stock.
--
-- A FORWARD MIGRATION, NOT AN EDIT TO 0202, and the distinction is the whole
-- reason this file exists rather than a diff: 0202 is merged, so any database
-- that has recorded it as applied will never run it again. Editing it would
-- have left this rule on developers' machines and nowhere else — the shape this
-- project has shipped three times (13a, 17b, 17c).
--
-- IT ALSO REPLACES TWO FUNCTIONS IT DID NOT WRITE, and that is the price of the
-- rule being real rather than asserted. See the second half of this file.

-- DROP AND CREATE, not CREATE OR REPLACE: the return type changes from integer
-- (0202 answered with how many prizes it had detached) to void, and Postgres
-- refuses to replace a function's return type. The ACL has to be restated below
-- for the same reason — a DROP takes the grants with it, which 0102 recorded
-- when it hit this.
drop function public.archive_prize_category(uuid);

create function public.archive_prize_category(p_category_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_in_use  integer;
begin
  -- The Station is READ FROM THE ROW rather than accepted from the caller, so
  -- there is no argument to disagree with the row it names — the shape
  -- archive_vendor and archive_promotion both use.
  --
  -- FOR UPDATE IS LOAD-BEARING HERE, not decoration. It is the half that
  -- create_prize and update_prize's own FOR KEY SHARE conflicts with, and
  -- without the pair the count below can be overtaken: a create_prize naming
  -- this category reads it as live, both transactions commit, and a live prize
  -- ends up wearing a label no read can reach. 0103 measured exactly that
  -- interleaving for songs and artists, and its header is the full account.
  -- WHOEVER CHANGES ONE HALF CHANGES BOTH.
  select organization_id, company_id into v_org, v_company
    from public.prize_categories
   where id = p_category_id and deleted_at is null
   for update;

  if not found then
    raise exception 'category not found: %', p_category_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'archive_prize_category denied: actor=% category=%', v_actor, p_category_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  -- The refusal. `23503` is the code archive_music_reference (0100) raises for
  -- the identical situation, so mapInventoryError already turns it into a
  -- BusinessRuleError, which every caller in this codebase passes through
  -- verbatim. The SENTENCE is this domain's own rather than that one's generic
  -- "still used by N live row(s)": that function serves four kinds through one
  -- body and cannot name them, this one serves categories, and can also name
  -- the way out.
  --
  -- NOT scoped to v_company, deliberately, unlike the count a screen shows.
  -- Both doors that write prizes.category_id refuse a category from another
  -- Station, so a cross-Station pointer should not exist — and a GUARD is
  -- exactly the wrong place to assume that. Counting every live prize means
  -- this can never archive out from under one.
  --
  -- LIVE PRIZES ONLY, which leaves the one dangling pointer this design
  -- accepts: an archived prize goes on naming the category. 0029's policy makes
  -- that prize unreadable for every caller, so nothing can render the label,
  -- and blocking on it would strand a category behind a row nobody can reach to
  -- fix.
  select count(*) into v_in_use
    from public.prizes
   where category_id = p_category_id and deleted_at is null;

  if v_in_use > 0 then
    raise exception
      'this category still has % live prize(s); move them to another category first', v_in_use
      using errcode = '23503';
  end if;

  update public.prize_categories
     set deleted_at = now(),
         updated_at = now()
   where id = p_category_id;

  -- The detail is empty and can be: the door refuses while any live prize wears
  -- the label, so an entry here means the category was already unused. The
  -- prizes moved off it beforehand have update_prize entries of their own, each
  -- carrying its own before/after.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_prize_category', 'prize_categories', p_category_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.archive_prize_category(uuid) is
  'Archives a prize category. Gated on inventory.catalogue, resolved from the row rather than from an argument. REFUSED with 23503 while any live prize still wears the label — the owner''s ruling of 2026-08-16, replacing 0202''s detaching archive, and the same rule archive_music_reference holds for an artist with songs; the prizes are never silently unlabelled, and moving them is the maintenance screen''s job. An ARCHIVED prize does not block, because 0029''s policy makes it unreadable for every caller. Takes FOR UPDATE on the row, which is the half create_prize and update_prize''s FOR KEY SHARE conflicts with (0103 measured why the pair is the guarantee). An already-archived category answers P0002.';

revoke execute on function public.archive_prize_category(uuid) from public;
grant execute on function public.archive_prize_category(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The reader half. Both doors that put a category on a prize already checked it
-- was live and of this Station; both did it with a PLAIN read, which takes no
-- row lock and is never blocked by one — step 2 of the interleaving 0103
-- measured. `perform ... for key share` is the same fix, in the shape 0027
-- already uses for the identical job, and FOR KEY SHARE is the weakest mode that
-- conflicts with the archive's FOR UPDATE and with nothing weaker: two
-- create_prize calls naming one category still never queue behind each other,
-- and an ordinary rename (a bare UPDATE of a non-key column, FOR NO KEY UPDATE)
-- still does not block either. 0103's header carries the conflict table and the
-- measurement against this Postgres.
--
-- The PERFORM sits INSIDE the `is not null` guard rather than beside it: FOUND is
-- set by every execution, so `if p_category_id is not null and not found` would
-- work only by accident of evaluation order. 0103 records the same trap.
--
-- CREATE OR REPLACE, and the signatures are unchanged, so there is no second
-- overload to resolve to and nothing to drop — and REPLACE keeps each function's
-- ACL, so 0027's own revoke/grant pair still stands and no grant is restated for
-- these two. Both bodies are otherwise 0027's, verified against the LIVE
-- definitions rather than copied from the file: nothing had replaced either
-- since 0027, so there was no later fix for this to carry away.
-- ---------------------------------------------------------------------------

create or replace function public.create_prize(
  p_company_id             uuid,
  p_name                   text,
  p_category_id            uuid default null,
  p_internal_code          text default null,
  p_description            text default null,
  p_allows_return_to_stock boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor         uuid := auth.uid();
  v_org           uuid;
  v_name          text := nullif(trim(p_name), '');
  v_internal_code text := nullif(trim(coalesce(p_internal_code, '')), '');
  v_description   text := nullif(trim(coalesce(p_description, '')), '');
  v_id            uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', p_company_id) then
    raise log 'create_prize denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'prize name is required' using errcode = '22023';
  end if;

  -- prize_categories carries no composite foreign key to companies (only prizes
  -- and inventory rows need that proof), so a category from another Station
  -- would otherwise slip in unchecked.
  --
  -- FOR KEY SHARE, not a bare read: this is the half that holds the category
  -- against archive_prize_category's FOR UPDATE. See the header above.
  if p_category_id is not null then
    perform 1 from public.prize_categories
     where id = p_category_id and company_id = p_company_id and deleted_at is null
     for key share;

    if not found then
      raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
    end if;
  end if;

  begin
    insert into public.prizes
      (organization_id, company_id, category_id, name, internal_code, description,
       allows_return_to_stock, created_by)
    values
      (v_org, p_company_id, p_category_id, v_name, v_internal_code,
       v_description, coalesce(p_allows_return_to_stock, true), v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a prize with internal code "%" already exists in this station', v_internal_code
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_prize', 'prizes', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name, 'category_id', p_category_id));

  return v_id;
end;
$$;

create or replace function public.update_prize(
  p_prize_id               uuid,
  p_name                   text,
  p_category_id            uuid default null,
  p_internal_code          text default null,
  p_description            text default null,
  p_allows_return_to_stock boolean default true
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor         uuid := auth.uid();
  v_org           uuid;
  v_company       uuid;
  v_name          text := nullif(trim(p_name), '');
  v_internal_code text := nullif(trim(coalesce(p_internal_code, '')), '');
  v_description   text := nullif(trim(coalesce(p_description, '')), '');
  v_before        jsonb;
begin
  -- The Company — and so the permission to check — comes from the prize
  -- itself, never from a parameter the caller could point anywhere.
  select organization_id, company_id into v_org, v_company
  from public.prizes
  where id = p_prize_id and deleted_at is null;

  if not found then
    raise exception 'prize not found: %', p_prize_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'update_prize denied: actor=% prize=%', v_actor, p_prize_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'prize name is required' using errcode = '22023';
  end if;

  -- FOR KEY SHARE, for the reason create_prize's own copy states. This door is
  -- also the one that MOVES a prize off a category — omitting p_category_id
  -- clears it, the wholesale-replace convention 0027 records — so it is what the
  -- maintenance screen will drive to empty a category before retiring it.
  if p_category_id is not null then
    perform 1 from public.prize_categories
     where id = p_category_id and company_id = v_company and deleted_at is null
     for key share;

    if not found then
      raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
    end if;
  end if;

  select jsonb_build_object(
           'name', name, 'category_id', category_id, 'internal_code', internal_code,
           'description', description, 'allows_return_to_stock', allows_return_to_stock)
    into v_before
  from public.prizes where id = p_prize_id;

  begin
    update public.prizes
       set name                   = v_name,
           category_id            = p_category_id,
           internal_code          = v_internal_code,
           description            = v_description,
           allows_return_to_stock = coalesce(p_allows_return_to_stock, true),
           updated_at             = now()
     where id = p_prize_id;
  exception
    when unique_violation then
      raise exception 'a prize with internal code "%" already exists in this station', v_internal_code
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_prize', 'prizes', p_prize_id, v_org, v_company,
     jsonb_build_object(
       'before', v_before,
       'after', jsonb_build_object(
         'name', v_name, 'category_id', p_category_id,
         'internal_code', v_internal_code,
         'description', v_description,
         'allows_return_to_stock', coalesce(p_allows_return_to_stock, true))));
end;
$$;
