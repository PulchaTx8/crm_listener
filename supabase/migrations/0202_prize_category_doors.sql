-- supabase/migrations/0202_prize_category_doors.sql

-- Block 26. Prize categories become a screen, so they need the two doors every
-- other record on this product has: one that registers or renames, one that
-- retires. Both SECURITY DEFINER, because 0029 grants `authenticated` nothing
-- but SELECT on prize_categories.
--
-- NO NEW PERMISSION. `inventory.view` reads and `inventory.catalogue` writes —
-- the pair that already governs prizes and vendors, which is what a category
-- sits beside. 0199 already widened that permission's own description to say
-- "prizes, categories and vendors", so there is nothing to update here.

-- ONE DOOR WHERE THERE WAS ONE, not two. `create_prize_category` (0027) could
-- only insert, and this replaces it rather than sitting beside it: a second door
-- onto the same write is how two callers drift into disagreeing about what a
-- category name may be. Dropped at the foot of this file, after the door that
-- takes over its job exists.

create function public.save_prize_category(
  p_company_id  uuid,
  p_name        text,
  -- Last and defaulted, so omitting it is what means "register a new one" — the
  -- commoner call, and the shape save_vendor, save_promotion_question and
  -- save_show all use.
  p_category_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid := p_category_id;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Before anything is read out of prize_categories: a caller who may not write
  -- here learns that, and learns nothing about which categories this Station has.
  if not public.has_permission('inventory.catalogue', p_company_id) then
    raise log 'save_prize_category denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the category needs a name' using errcode = '22023';
  end if;

  -- 0027's own bound, kept: the column is unbounded `text`, and the form's
  -- maxLength is a courtesy a caller posting straight at the RPC never sees.
  if length(v_name) > 120 then
    raise exception 'a category name is at most 120 characters' using errcode = '22023';
  end if;

  begin
    if v_id is null then
      insert into public.prize_categories (organization_id, company_id, name)
      values (v_org, p_company_id, v_name)
      returning id into v_id;
    else
      -- `company_id` in the WHERE is the tenancy proof — a caller-supplied uuid
      -- naming another Station's category must not match, and checking it here
      -- rather than trusting the permission above is what makes that true rather
      -- than merely unlikely. `deleted_at is null` too: an archived category is
      -- not editable, and gets the same P0002 an unknown id gets.
      update public.prize_categories
         set name       = v_name,
             updated_at = now()
       where id = v_id and company_id = p_company_id and deleted_at is null;

      if not found then
        raise exception 'category not found: %', v_id using errcode = 'P0002';
      end if;
    end if;
  exception
    when unique_violation then
      -- prize_categories_name_unique names an index at somebody typing a name.
      raise exception 'a category named "%" already exists in this station', v_name
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_prize_category', 'prize_categories', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name, 'created', p_category_id is null));

  return v_id;
end;
$$;

comment on function public.save_prize_category(uuid, text, uuid) is
  'Registers or renames a prize category. Gated on inventory.catalogue. The name is the only field, so there is no wholesale-replace warning to give: 22023 without one or over 120 characters, and 23505 from prize_categories_name_unique when another live category of this Station already has it. An archived category is not editable and answers P0002, the same as an unknown id. Replaces create_prize_category (0027), which could only insert.';

-- The only way a category leaves circulation. There is no delete, and its
-- absence is the decision: prizes point at a category, so a delete would be
-- refused with 23503 the moment one prize wore it.
create function public.archive_prize_category(p_category_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_company  uuid;
  v_detached integer;
begin
  -- The Station is READ FROM THE ROW rather than accepted from the caller, so
  -- there is no argument to disagree with the row it names — the shape
  -- archive_vendor and archive_promotion both use.
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

  -- THE PRIZES ARE DETACHED, which is the opposite of what archive_vendor does
  -- to the entries naming a supplier — and the difference is the point rather
  -- than an inconsistency. A movement's vendor is HISTORY: the purchase happened,
  -- and list_movements goes on reporting the name from an unfiltered join. A
  -- prize's category is a LABEL the screens resolve from the live list, so a
  -- prize left pointing at an archived row would render as "Uncategorised"
  -- anyway. Detaching makes that true instead of merely displayed, and leaves no
  -- pointer at a label nobody can see.
  --
  -- Live prizes only. An archived prize is unreadable through RLS for every
  -- caller (0029's own policy filters deleted_at), so rewriting its label would
  -- change nothing anybody can observe, and the count below is the number the
  -- operator was warned about on the confirmation — which counts what the list
  -- shows.
  update public.prizes
     set category_id = null,
         updated_at  = now()
   where category_id = p_category_id
     and company_id  = v_company
     and deleted_at is null;

  get diagnostics v_detached = row_count;

  update public.prize_categories
     set deleted_at = now(),
         updated_at = now()
   where id = p_category_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_prize_category', 'prize_categories', p_category_id, v_org, v_company,
     jsonb_build_object('detached_prizes', v_detached));

  return v_detached;
end;
$$;

comment on function public.archive_prize_category(uuid) is
  'Archives a prize category and returns how many live prizes it took the label off. Gated on inventory.catalogue, resolved from the row rather than from an argument. Unlike archive_vendor, the records naming it ARE rewritten: a movement''s supplier is history, a prize''s category is a label the screens resolve from the live list, so a prize left pointing at an archived row would read as uncategorised regardless. An already-archived category answers P0002, because 0029''s select policy hides it from every ordinary read too.';

revoke execute on function public.save_prize_category(uuid, text, uuid) from public;
revoke execute on function public.archive_prize_category(uuid) from public;

grant execute on function public.save_prize_category(uuid, text, uuid) to authenticated;
grant execute on function public.archive_prize_category(uuid) to authenticated;

-- Last, so the replacement above exists before the thing it replaces goes. The
-- only caller was services/inventory.ts's createPrizeCategory, which moves to
-- save_prize_category in the same commit.
drop function public.create_prize_category(uuid, text);
