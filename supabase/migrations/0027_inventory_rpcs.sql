-- supabase/migrations/0027_inventory_rpcs.sql

-- One place where the ledger mechanics live. The permission check deliberately
-- stays OUT of here and in each public function, so a reader looking for "who may
-- do this" finds it beside the operation rather than inside a shared helper.
--
-- This function holds EXECUTE for nobody. It is SECURITY INVOKER: it is only ever
-- called from inside a SECURITY DEFINER body, where it already runs with the
-- definer's privileges. Making it DEFINER too would let a future GRANT turn it
-- into an unchecked write path.
create or replace function public.apply_inventory_movement(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_type            public.inventory_movement_type,
  p_quantity        integer,
  p_from            public.inventory_bucket,
  p_to              public.inventory_bucket,
  p_note            text,
  p_idempotency_key text
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_current  integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be a positive whole number' using errcode = '22023';
  end if;

  -- The prize must be live and belong to this Station. The composite foreign key
  -- proves the Station; it cannot see deleted_at, because it references a
  -- non-partial constraint — a foreign key cannot reference a partial index.
  select organization_id into v_org
  from public.prizes
  where id = p_prize_id and company_id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this is the prize's first movement, then lock it.
  -- ON CONFLICT DO NOTHING rather than a select-then-insert: two first movements
  -- racing would otherwise both see nothing and both insert.
  insert into public.inventory_balances (company_id, prize_id, organization_id)
  values (p_company_id, p_prize_id, v_org)
  on conflict (company_id, prize_id) do nothing;

  perform 1 from public.inventory_balances
   where company_id = p_company_id and prize_id = p_prize_id
     for update;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor)
  on conflict (company_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- A replay. Return the original movement and touch nothing else: the balance
    -- already reflects it.
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if v_id is null then
      raise exception 'movement could not be recorded' using errcode = 'XX000';
    end if;
    return v_id;
  end if;

  -- Source sufficiency. The CHECK constraints would also refuse this, but they
  -- would refuse it with a constraint name; the caller deserves the number.
  if p_from is not null then
    execute format('select %I from public.inventory_balances where company_id = $1 and prize_id = $2', p_from)
      into v_current using p_company_id, p_prize_id;

    if v_current < p_quantity then
      raise exception 'only % unit(s) are in %, and % were requested', v_current, p_from, p_quantity
        using errcode = '23514';
    end if;

    execute format(
      'update public.inventory_balances set %I = %I - $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_from, p_from
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  if p_to is not null then
    execute format(
      'update public.inventory_balances set %I = %I + $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_to, p_to
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to));

  return v_id;
end;
$$;

revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text) from public;

-- ---------------------------------------------------------------------------
-- Movement RPCs. Each resolves the Organization from the Company it was given
-- (never a caller-supplied Organization id), checks its own permission with
-- has_permission, then delegates every mechanic to apply_inventory_movement.
-- ---------------------------------------------------------------------------

-- Restricted to the three entry kinds; DRAW, DELIVERY and the rest move through
-- their own Blocks and must not become reachable by handing this function a
-- different label for the same shape of movement. The only one of the five
-- with an optional note — an entry rarely needs explaining, unlike an exit,
-- an adjustment or a reservation.
create or replace function public.record_stock_entry(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_type            public.inventory_movement_type,
  p_quantity        integer,
  p_note            text default null,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.entry', p_company_id) then
    raise log 'record_stock_entry denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.entry required' using errcode = '42501';
  end if;

  if p_type not in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY') then
    raise exception 'record_stock_entry does not accept movement type %', p_type
      using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, p_type, p_quantity, null, 'available', p_note, p_idempotency_key
  );
end;
$$;

create or replace function public.record_stock_exit(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.exit', p_company_id) then
    raise log 'record_stock_exit denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.exit required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to record a stock exit' using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, 'MANUAL_EXIT', p_quantity, 'available', null, v_note, p_idempotency_key
  );
end;
$$;

-- The one with real logic. It takes the counted figure, not a delta — someone
-- reconciling with a shelf counts what is there, and making them compute a
-- difference against a number they may not even have in front of them is how
-- the sign gets inverted. `available` is read under the SAME lock
-- apply_inventory_movement takes, so a movement racing this count cannot leave
-- the delta computed against a figure that was already stale by the time it
-- was read.
create or replace function public.adjust_stock(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_counted         integer,
  p_note            text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_note    text := nullif(trim(coalesce(p_note, '')), '');
  v_current integer;
  v_delta   integer;
  v_id      uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.adjust', p_company_id) then
    raise log 'adjust_stock denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.adjust required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to adjust stock' using errcode = '22023';
  end if;

  if p_counted is null or p_counted < 0 then
    raise exception 'the counted figure must be zero or a positive whole number' using errcode = '22023';
  end if;

  -- inventory_balances' foreign key to prizes would refuse a bogus prize_id
  -- anyway, but with a constraint name rather than the message a caller can act
  -- on — same reasoning apply_inventory_movement gives for the sufficiency
  -- check below.
  if not exists (
    select 1 from public.prizes
    where id = p_prize_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this prize has never moved, then lock it — same
  -- reasoning as apply_inventory_movement: two concurrent first counts must not
  -- both see zero and race to decide the delta from it.
  insert into public.inventory_balances (company_id, prize_id, organization_id)
  values (p_company_id, p_prize_id, v_org)
  on conflict (company_id, prize_id) do nothing;

  select available into v_current
  from public.inventory_balances
  where company_id = p_company_id and prize_id = p_prize_id
    for update;

  -- Check for a replay only now that the lock is held. A concurrent call for
  -- the same key holds this same lock for the whole of apply_inventory_movement
  -- (insert and balance update together), so once we have acquired it, that
  -- call's movement — if any — is already committed and visible here.
  if p_idempotency_key is not null then
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if found then
      -- `available` now already reflects that earlier adjustment, so
      -- recomputing the delta against today's figure would read zero and
      -- silently turn the replay into a no-op instead of returning what
      -- actually happened.
      return v_id;
    end if;
  end if;

  v_delta := p_counted - v_current;

  -- Counted matches booked: nothing happened, and an adjustment of zero is not
  -- an event worth a ledger row.
  if v_delta = 0 then
    return null;
  end if;

  if v_delta > 0 then
    return public.apply_inventory_movement(
      p_company_id, p_prize_id, 'ADJUSTMENT_POSITIVE', v_delta, null, 'available', v_note, p_idempotency_key
    );
  else
    return public.apply_inventory_movement(
      p_company_id, p_prize_id, 'ADJUSTMENT_NEGATIVE', -v_delta, 'available', null, v_note, p_idempotency_key
    );
  end if;
end;
$$;

create or replace function public.reserve_stock(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.reserve', p_company_id) then
    raise log 'reserve_stock denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.reserve required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to reserve stock' using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, 'RESERVATION', p_quantity, 'available', 'reserved', v_note, p_idempotency_key
  );
end;
$$;

create or replace function public.release_reservation(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.reserve', p_company_id) then
    raise log 'release_reservation denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.reserve required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to release a reservation' using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, 'RESERVATION_RELEASE', p_quantity, 'reserved', 'available', v_note, p_idempotency_key
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Catalogue RPCs. Gated on inventory.catalogue. create_prize_category and
-- create_prize resolve the Organization from the Company they were given;
-- update_prize and archive_prize resolve BOTH the Company and the Organization
-- from the prize row itself, never from a parameter, because a caller who
-- could name the Company would be able to point a prize's update at whichever
-- Company they happen to hold inventory.catalogue in.
-- ---------------------------------------------------------------------------

create or replace function public.create_prize_category(
  p_company_id uuid,
  p_name       text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(trim(p_name), '');
  v_id    uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', p_company_id) then
    raise log 'create_prize_category denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'category name is required' using errcode = '22023';
  end if;

  insert into public.prize_categories (organization_id, company_id, name)
  values (v_org, p_company_id, v_name)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_prize_category', 'prize_categories', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name));

  return v_id;
end;
$$;

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
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(trim(p_name), '');
  v_id    uuid;
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
  if p_category_id is not null and not exists (
    select 1 from public.prize_categories
    where id = p_category_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
  end if;

  insert into public.prizes
    (organization_id, company_id, category_id, name, internal_code, description,
     allows_return_to_stock, created_by)
  values
    (v_org, p_company_id, p_category_id, v_name, nullif(trim(coalesce(p_internal_code, '')), ''),
     nullif(trim(coalesce(p_description, '')), ''), coalesce(p_allows_return_to_stock, true), v_actor)
  returning id into v_id;

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
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_name    text := nullif(trim(p_name), '');
  v_before  jsonb;
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

  if p_category_id is not null and not exists (
    select 1 from public.prize_categories
    where id = p_category_id and company_id = v_company and deleted_at is null
  ) then
    raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
  end if;

  select jsonb_build_object(
           'name', name, 'category_id', category_id, 'internal_code', internal_code,
           'description', description, 'allows_return_to_stock', allows_return_to_stock)
    into v_before
  from public.prizes where id = p_prize_id;

  update public.prizes
     set name                   = v_name,
         category_id            = p_category_id,
         internal_code          = nullif(trim(coalesce(p_internal_code, '')), ''),
         description            = nullif(trim(coalesce(p_description, '')), ''),
         allows_return_to_stock = coalesce(p_allows_return_to_stock, true),
         updated_at             = now()
   where id = p_prize_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_prize', 'prizes', p_prize_id, v_org, v_company,
     jsonb_build_object(
       'before', v_before,
       'after', jsonb_build_object(
         'name', v_name, 'category_id', p_category_id,
         'internal_code', nullif(trim(coalesce(p_internal_code, '')), ''),
         'description', nullif(trim(coalesce(p_description, '')), ''),
         'allows_return_to_stock', coalesce(p_allows_return_to_stock, true))));
end;
$$;

create or replace function public.archive_prize(p_prize_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_company  uuid;
  v_physical integer;
begin
  select organization_id, company_id into v_org, v_company
  from public.prizes
  where id = p_prize_id and deleted_at is null;

  if not found then
    raise exception 'prize not found: %', p_prize_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'archive_prize denied: actor=% prize=%', v_actor, p_prize_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  -- Lock the balance row before counting. A movement racing this archival
  -- takes the same lock inside apply_inventory_movement, so the two serialize
  -- instead of the count below reading a stale zero while an entry is
  -- mid-flight.
  perform 1 from public.inventory_balances
   where company_id = v_company and prize_id = p_prize_id
     for update;

  -- Refused while stock exists. Archiving it would strand the units: the balance
  -- row survives, no screen shows it, and reconciliation still counts it. Same
  -- shape as delete_role refusing a role in use.
  select available + reserved + linked + awaiting_pickup + pending_return
    into v_physical
  from public.inventory_balances
  where company_id = v_company and prize_id = p_prize_id;

  if coalesce(v_physical, 0) > 0 then
    raise exception 'this prize still has % unit(s) in stock; move them out first', v_physical
      using errcode = '23503';
  end if;

  update public.prizes set deleted_at = now(), updated_at = now() where id = p_prize_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'archive_prize', 'prizes', p_prize_id, v_org, v_company);
end;
$$;

revoke execute on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text) from public;
revoke execute on function public.record_stock_exit(uuid, uuid, integer, text, text)                                  from public;
revoke execute on function public.adjust_stock(uuid, uuid, integer, text, text)                                       from public;
revoke execute on function public.reserve_stock(uuid, uuid, integer, text, text)                                      from public;
revoke execute on function public.release_reservation(uuid, uuid, integer, text, text)                                from public;
revoke execute on function public.create_prize_category(uuid, text)                                                   from public;
revoke execute on function public.create_prize(uuid, text, uuid, text, text, boolean)                                 from public;
revoke execute on function public.update_prize(uuid, text, uuid, text, text, boolean)                                 from public;
revoke execute on function public.archive_prize(uuid)                                                                 from public;

grant execute on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text) to authenticated;
grant execute on function public.record_stock_exit(uuid, uuid, integer, text, text)                                  to authenticated;
grant execute on function public.adjust_stock(uuid, uuid, integer, text, text)                                       to authenticated;
grant execute on function public.reserve_stock(uuid, uuid, integer, text, text)                                      to authenticated;
grant execute on function public.release_reservation(uuid, uuid, integer, text, text)                                to authenticated;
grant execute on function public.create_prize_category(uuid, text)                                                   to authenticated;
grant execute on function public.create_prize(uuid, text, uuid, text, text, boolean)                                 to authenticated;
grant execute on function public.update_prize(uuid, text, uuid, text, text, boolean)                                 to authenticated;
grant execute on function public.archive_prize(uuid)                                                                  to authenticated;
