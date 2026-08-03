-- Block 6a, Task 4, first half: teaching the ledger what a draw is.
--
-- 0045 admitted promotion_prize_id on exactly two movement types and said, in
-- its own comment, that DRAW and the rest were "deliberately NOT admitted here:
-- this block has no way to write one, and a check admitting a column no caller
-- can fill is a rule that cannot be tested. Block 6 widens this check;
-- apply_inventory_movement (0047) raises if it is widened without teaching that
-- function what the new type projects to."
--
-- This is that block, and this file does both halves together, which is the
-- whole point of the tripwire: widening the constraint without the projection
-- would append movements that the per-promotion figures never hear about.
--
-- DELIVERY and the return types stay out. 6a cannot write one, and the rule
-- 0045 stated -- do not admit a value no caller can fill -- is not one to break
-- on the way past.

alter table public.inventory_movements
  drop constraint inventory_movements_promotion_reference;

alter table public.inventory_movements
  add constraint inventory_movements_promotion_reference check (
    (movement_type in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL')
       and promotion_prize_id is not null)
    or (movement_type not in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL')
       and promotion_prize_id is null)
  );

comment on column public.inventory_movements.promotion_prize_id is
  'Which promotion link this movement is part of. Required for PROMOTION_LINK, PROMOTION_UNLINK, DRAW and DRAW_CANCEL, and forbidden everywhere else — see inventory_movements_promotion_reference. DELIVERY and the return types will need it in Block 6b and are still deliberately not admitted, for the reason 0045 gave: a check admitting a column no caller can fill is a rule that cannot be tested.';

-- ---------------------------------------------------------------------------
-- The projection, lifted out of apply_inventory_movement into its own body.
--
-- It was four lines inline; it is now a function because 6b adds DELIVERY,
-- RETURN_PENDING, RETURN_TO_STOCK and WRITE_OFF to it, and doing that inline
-- would mean re-stating the ledger's whole 180-line body a second time to
-- change four of its lines. The rule still has exactly one home -- this is the
-- home moving, not a copy being made.
--
-- It reads movement_type and NOT the bucket pair, which is 0047's reasoning
-- kept verbatim: `linked` here is not the `linked` bucket. It counts units
-- committed to the promotion and is NOT decremented when one is drawn -- drawn
-- is its own counter and "Resto" is linked - drawn (0045's column comments).

create function public.project_promotion_prize_movement(
  p_promotion_prize_id uuid,
  p_type               public.inventory_movement_type,
  p_quantity           integer
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_type = 'PROMOTION_LINK' then
    update public.promotion_prize_balances
       set linked = linked + p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'PROMOTION_UNLINK' then
    update public.promotion_prize_balances
       set linked = linked - p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'DRAW' then
    update public.promotion_prize_balances
       set drawn = drawn + p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'DRAW_CANCEL' then
    update public.promotion_prize_balances
       set drawn = drawn - p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  else
    -- 0047's tripwire, moved here with the rest of the branch and still doing
    -- the same job for Block 6b: a movement type that reaches the projection
    -- without a rule fails loudly instead of being appended to the ledger and
    -- silently skipped by the per-promotion figures. Reached in
    -- 04_promotion_prizes.test.sql by dropping the constraint above inside a
    -- transaction that rolls back.
    raise exception
      'apply_inventory_movement cannot project movement type % onto a promotion prize', p_type
      using errcode = 'XX000';
  end if;
end;
$$;

comment on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) is
  'Moves the per-promotion figures for one movement. The ONE home of the rule that says which movement type touches linked and which touches drawn, called only from apply_inventory_movement (0047) and lifted out of its body in 0077 so Block 6b adds its four types here rather than re-stating a 180-line function to change four of its lines. Driven by movement_type and never by the bucket pair: linked on this projection counts units committed to the promotion and is not decremented by a draw. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody — it writes promotion_prize_balances with no permission check of its own, exactly as the inline branch it replaces did.';

revoke execute on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) from public;

-- ---------------------------------------------------------------------------
-- The ledger's single writer, unchanged except that its projection branch now
-- calls the function above. Every lock, every refusal, the replay path and the
-- audit row are byte-identical to 0047's; only the four lines named above moved.
--
-- create or replace, not drop and create: the argument list is the same, so
-- 0047's reason for dropping (an eight-argument overload left behind would make
-- every call ambiguous) does not apply, and replacing preserves the ACL that
-- 0047's own revoke established.

create or replace function public.apply_inventory_movement(
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
  -- inventory_movements_promotion_reference (0045, widened in 0077) is what
  -- refuses the two ways that can be wrong: a link or draw movement naming no
  -- promotion, and any other movement type naming one.
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
  -- does not. The reasoning, and the tripwire for an unknown type, now live in
  -- project_promotion_prize_movement (0077).
  if p_promotion_prize_id is not null then
    perform public.project_promotion_prize_movement(p_promotion_prize_id, p_type, p_quantity);
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
