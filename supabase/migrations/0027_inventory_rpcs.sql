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
  -- FOR SHARE holds this row against archive_prize's FOR UPDATE on the same
  -- prize. archive_prize's own guard reads inventory_balances, which does not
  -- exist yet for a prize's first-ever movement — locking a row that is not
  -- there locks nothing — so without a lock on the prize itself, a movement
  -- could read the prize as live here, archive_prize could see zero stock and
  -- archive it, and this call could still go on to write stock onto a prize
  -- that is now archived. This lock, plus archive_prize's, closes that
  -- regardless of whether a balance row exists.
  select organization_id into v_org
  from public.prizes
  where id = p_prize_id and company_id = p_company_id and deleted_at is null
    for share;

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

    -- The bootstrap insert above guarantees the row exists, so this is never
    -- actually NULL today — but that guarantee is implicit, and NULL < integer
    -- is NULL, not true, which would let the sufficiency check below fall
    -- through silently and the subsequent UPDATE touch zero rows: a movement
    -- recorded in the ledger that never reached the projection.
    v_current := coalesce(v_current, 0);

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

comment on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text) is
  'Private ledger mechanics shared by every movement RPC: locks the balance row, appends the movement (a replay is detected via ON CONFLICT on the partial unique index over (company_id, idempotency_key) and returns the original movement with the balance untouched), moves the buckets, and writes the audit row. SECURITY INVOKER, EXECUTE granted to nobody — only reachable from inside a SECURITY DEFINER body, where it runs with that body''s privileges. Idempotency keys are scoped to the Station (company_id), not to a prize: a client that reuses a key such as "retry-1" across two different prizes in the same Station will silently get the first prize''s movement back on the second call. Takes FOR SHARE on the prize row; archive_prize takes FOR UPDATE on that same row before it counts physical stock — this is what stops a movement and an archival interleaving into stranded stock when the prize has no balance row yet.';

-- ---------------------------------------------------------------------------
-- Movement RPCs. Each confirms the Company exists (never trusting a
-- caller-supplied Organization id), checks its own permission with
-- has_permission, then delegates every mechanic to apply_inventory_movement —
-- which is what actually resolves the Organization, from the prize, which is
-- the stricter proof. See apply_inventory_movement's comment for how an
-- idempotency_key is scoped (to the Station, not to a prize).
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
begin
  -- Existence only: apply_inventory_movement re-resolves the Organization from
  -- the prize itself, which also proves the prize belongs to THIS Station —
  -- the stricter fact. Resolving it again here would just be a second, weaker
  -- copy of that same proof.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

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

comment on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text) is
  'Adds available stock. Gated on inventory.entry. Restricted to INITIAL_ENTRY, PURCHASE_ENTRY and MANUAL_ENTRY — any other type is refused with 22023. The only one of the five movement RPCs with an optional note.';

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
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

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

comment on function public.record_stock_exit(uuid, uuid, integer, text, text) is
  'Removes available stock (MANUAL_EXIT). Gated on inventory.exit. Note is mandatory.';

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

comment on function public.adjust_stock(uuid, uuid, integer, text, text) is
  'Reconciles available stock to a physical count. Gated on inventory.adjust. Takes the counted figure, not a delta: it reads current available under the balance row''s lock and derives ADJUSTMENT_POSITIVE or ADJUSTMENT_NEGATIVE of the difference. A NULL return is a well-defined success meaning the count matched and nothing was recorded — every failure path raises, so NULL never means an error. Because a zero-delta count records nothing, its idempotency_key is never persisted, so that one call is not a guaranteed replay: if the balance changes between an original zero-delta call and a retry with the same key, the retry recomputes against the new figure instead of reproducing the original (non-)result. Accepted as an open item — quantity > 0 makes a zero-quantity ledger row unrepresentable, the window is narrow, and the operator''s mandatory note keeps the outcome auditable either way. A genuine non-zero replay IS handled correctly: see the idempotency check immediately after the balance lock above.';

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
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

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

comment on function public.reserve_stock(uuid, uuid, integer, text, text) is
  'Moves available stock into reserved (RESERVATION). Gated on inventory.reserve. Note is mandatory.';

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
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

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

comment on function public.release_reservation(uuid, uuid, integer, text, text) is
  'Moves reserved stock back to available (RESERVATION_RELEASE). Gated on inventory.reserve — the same code reserve_stock uses. Note is mandatory.';

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

  begin
    insert into public.prize_categories (organization_id, company_id, name)
    values (v_org, p_company_id, v_name)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a category named "%" already exists in this station', v_name
        using errcode = '23505';
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_prize_category', 'prize_categories', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name));

  return v_id;
end;
$$;

comment on function public.create_prize_category(uuid, text) is
  'Registers a category. Gated on inventory.catalogue. Category names are unique per Station while live; a duplicate is refused with 23505 and the name in the message, not a bare constraint-name error.';

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
  if p_category_id is not null and not exists (
    select 1 from public.prize_categories
    where id = p_category_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'category not found in this station: %', p_category_id using errcode = 'P0002';
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

comment on function public.create_prize(uuid, text, uuid, text, text, boolean) is
  'Registers a prize with zero stock — quantity lives only in inventory_balances, written by the movement RPCs. Gated on inventory.catalogue. A category_id must belong to the same Station (prize_categories carries no composite foreign key to companies). internal_code is optional but unique per Station while live; a duplicate is refused with 23505 and the code in the message, not a bare constraint-name error.';

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

comment on function public.update_prize(uuid, text, uuid, text, text, boolean) is
  'Replaces a prize''s catalogue fields wholesale (same convention as update_role in 0017): every field is set on every call, not merged with what was there. The Organization and Company are resolved from the prize row, never from a parameter, so a caller cannot redirect the permission check to a Station they do not hold inventory.catalogue in. Gated on inventory.catalogue. A duplicate internal_code is refused with 23505 and the code in the message.';

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
  -- FOR UPDATE on the prize itself, not the balance: a prize that has never
  -- moved has no balance row, and locking a row that does not exist locks
  -- nothing. apply_inventory_movement takes FOR SHARE on this same prize row
  -- before it ever touches the balance, so the two block on each other
  -- whether or not a balance row exists: a concurrent movement either
  -- committed before this lock was granted (in which case the count below
  -- already includes it) or blocks here until this transaction ends (in which
  -- case it will re-read deleted_at afterward and find the prize archived).
  -- Either way, no movement can land after this transaction commits without
  -- first re-proving the prize is still live.
  select organization_id, company_id into v_org, v_company
  from public.prizes
  where id = p_prize_id and deleted_at is null
    for update;

  if not found then
    raise exception 'prize not found: %', p_prize_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'archive_prize denied: actor=% prize=%', v_actor, p_prize_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  -- No separate lock on inventory_balances is needed here: holding the prize
  -- row's lock above already means no apply_inventory_movement call can be
  -- concurrently writing this balance (it would first have to acquire FOR
  -- SHARE on the prize, which blocks until this transaction ends), so this
  -- plain read is stable for the rest of the transaction.
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

comment on function public.archive_prize(uuid) is
  'Soft-deletes a prize. Gated on inventory.catalogue. Refused while any physical bucket (available, reserved, linked, awaiting_pickup, pending_return) is non-zero, naming the count. Takes FOR UPDATE on the prize row itself, not the balance: apply_inventory_movement takes FOR SHARE on that same row before it ever touches the balance, so the two serialise whether or not a balance row exists yet — locking the balance row here would lock nothing for a prize that has never moved.';

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
