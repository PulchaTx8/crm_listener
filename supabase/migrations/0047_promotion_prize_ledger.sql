-- supabase/migrations/0047_promotion_prize_ledger.sql

-- The bootstrap for the second projection, in its own function for the reason
-- ensure_inventory_balance_row's comment gives: the schema should hold exactly
-- one INSERT statement against a projection table, so that a future auditor
-- grepping for writers finds one. SECURITY INVOKER, EXECUTE granted to nobody
-- — reachable only from inside a SECURITY DEFINER body, where it runs with
-- that body's privileges.
create or replace function public.ensure_promotion_prize_balance_row(
  p_promotion_prize_id uuid,
  p_prize_id           uuid,
  p_company_id         uuid,
  p_org                uuid
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.promotion_prize_balances
    (promotion_prize_id, prize_id, company_id, organization_id)
  values (p_promotion_prize_id, p_prize_id, p_company_id, p_org)
  on conflict (promotion_prize_id) do nothing;
end;
$$;

revoke execute on function public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid) from public;

comment on function public.ensure_promotion_prize_balance_row(uuid, uuid, uuid, uuid) is
  'The only INSERT statement against promotion_prize_balances anywhere in the schema. Creates an all-zero row the first time a link is moved. Every arithmetic UPDATE against that table happens exclusively inside apply_inventory_movement, the same division ensure_inventory_balance_row (0030) has with it.';

-- ---------------------------------------------------------------------------
-- apply_inventory_movement, DROPPED and recreated rather than replaced.
--
-- create or replace cannot change a function's argument list: it would create a
-- second, nine-argument overload and leave the eight-argument one in place.
-- Every existing caller — record_stock_entry, record_stock_exit, adjust_stock,
-- reserve_stock, release_reservation — would keep resolving to the old body and
-- would silently never write the new projection, which is the exact defect this
-- block exists to prevent. Postgres does not track plpgsql body dependencies,
-- so the drop succeeds and those five re-resolve to this function, through the
-- default on the new parameter, at their next call.
--
-- Nothing else about this function changes. The lock order is now prize ->
-- inventory_balances -> promotion_prize_balances, taken in that order by every
-- caller, so two concurrent movements cannot deadlock against each other.
-- ---------------------------------------------------------------------------
drop function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text);

create function public.apply_inventory_movement(
  p_company_id         uuid,
  p_prize_id           uuid,
  p_type               public.inventory_movement_type,
  p_quantity           integer,
  p_from               public.inventory_bucket,
  p_to                 public.inventory_bucket,
  p_note               text,
  p_idempotency_key    text,
  p_promotion_prize_id uuid default null
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
  -- Shared with adjust_stock (0030) so there is exactly one INSERT statement
  -- against this table anywhere in the schema — see
  -- ensure_inventory_balance_row's own comment.
  perform public.ensure_inventory_balance_row(p_company_id, p_prize_id, v_org);

  perform 1 from public.inventory_balances
   where company_id = p_company_id and prize_id = p_prize_id
     for update;

  -- Taken here — immediately after the FOR UPDATE on inventory_balances and
  -- before the movement is appended — rather than beside the arithmetic below,
  -- so the lock order is the same for every caller; a replay that returns early
  -- will have bootstrapped an all-zero row and written nothing to it, which is
  -- exactly what ensure_inventory_balance_row already does on the same path.
  if p_promotion_prize_id is not null then
    perform public.ensure_promotion_prize_balance_row(
      p_promotion_prize_id, p_prize_id, p_company_id, v_org);

    perform 1 from public.promotion_prize_balances
     where promotion_prize_id = p_promotion_prize_id
       for update;
  end if;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  --
  -- promotion_prize_id travels on the movement itself, so the ledger — not only
  -- the projection — records which link the units moved under, and
  -- reconcile_inventory (0048) can rebuild one from the other.
  -- inventory_movements_promotion_reference (0045) is what refuses the two ways
  -- that can be wrong: a link movement naming no promotion, and any other
  -- movement type naming one.
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id, promotion_prize_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor,
     p_promotion_prize_id)
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

  -- Source sufficiency. The CHECK constraints would also refuse this, but
  -- they would refuse it with a constraint name; the caller deserves the number.
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

  -- This reads movement_type, which the bucket arithmetic above deliberately
  -- does not. It has to: `linked` on this projection is not the `linked`
  -- bucket. It counts units committed to the promotion and is NOT decremented
  -- when one is drawn — drawn is its own counter and Resto is linked - drawn
  -- (0045's column comments). Driving it from the bucket pair would be right
  -- today and wrong the moment Block 6's DRAW moves linked -> awaiting_pickup
  -- carrying a promotion reference.
  if p_promotion_prize_id is not null then
    if p_type = 'PROMOTION_LINK' then
      update public.promotion_prize_balances
         set linked = linked + p_quantity, updated_at = now()
       where promotion_prize_id = p_promotion_prize_id;
    elsif p_type = 'PROMOTION_UNLINK' then
      update public.promotion_prize_balances
         set linked = linked - p_quantity, updated_at = now()
       where promotion_prize_id = p_promotion_prize_id;
    else
      -- Unreachable while inventory_movements_promotion_reference (0045)
      -- admits promotion_prize_id on exactly those two types, and said so
      -- rather than left to look like protection. It is a tripwire for Block
      -- 6: that block widens the constraint to DRAW, DELIVERY and the return
      -- types, and this is what makes it fail loudly instead of appending a
      -- movement the projection never hears about. Reached in
      -- 04_promotion_prizes.test.sql by dropping that constraint inside a
      -- transaction that rolls back.
      raise exception
        'apply_inventory_movement cannot project movement type % onto a promotion prize', p_type
        using errcode = 'XX000';
    end if;
  end if;

  -- The detail gains promotion_prize_id as a final key rather than omitting it
  -- when there is none: it is null on every movement that names no promotion,
  -- so every row Block 2 already writes keeps the same shape and the audit log
  -- stays readable by one query instead of two.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to,
                        'promotion_prize_id', p_promotion_prize_id));

  return v_id;
end;
$$;

-- Load-bearing here, unlike the same line in 0030. That one was defensive: a
-- create OR REPLACE leaves the existing grants alone, and 0027's revoke had
-- already stripped PUBLIC's implicit EXECUTE. This is a plain create, and a
-- newly created function carries the default EXECUTE grant to PUBLIC — without
-- this line every role in the database could call the ledger's single writer
-- directly and bypass every permission check the five movement RPCs make.
revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid) from public;

comment on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid) is
  'Private ledger mechanics shared by every movement RPC: locks the balance row (bootstrap shared with adjust_stock via ensure_inventory_balance_row, 0030), locks the per-promotion balance row when the movement names one, appends the movement (a replay is detected via ON CONFLICT on the partial unique index over (company_id, idempotency_key) and returns the original movement with both projections untouched), moves the buckets, moves the per-promotion figure, and writes the audit row. Dropped and recreated in 0047 rather than replaced, because create or replace cannot change an argument list and the eight-argument overload left behind would have gone on being the one every existing caller resolved to. SECURITY INVOKER, EXECUTE granted to nobody. Lock order is prize (FOR SHARE), inventory_balances, promotion_prize_balances — the same order for every caller. Idempotency keys are scoped to the Station, not to a prize: a client reusing "retry-1" across two prizes in one Station silently gets the first movement back. p_promotion_prize_id is projected by movement_type, not by the bucket pair, because linked on that projection counts units committed to the promotion and is not decremented by a draw; a type it does not know is refused with XX000 rather than appended silently.';
