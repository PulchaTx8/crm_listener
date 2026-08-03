-- Block 6d, Task 12: a cancelled draw awards nothing.
--
-- cancel_draw (0079) undoes a draw by returning its units from
-- awaiting_pickup to linked and marking draws.status = 'CANCELLED', but
-- deliberately leaves its winners AWAITING_PICKUP -- 6a had no vocabulary for
-- "un-awarded" and said so in that migration's own comments. Those rows are a
-- record of what was cancelled, not a claim on stock. Nothing read them as
-- live, so the hole was inert. Block 6d then added two readers that do --
-- list_pickups and sweep_pickup_deadlines -- and Task 5 shut both.
--
-- A third door was open before this block and stayed open: apply_winner_
-- transition never consulted draws.status, so DELIVERED, RETURN_PENDING,
-- RETURNED and WRITTEN_OFF all moved a unit that was no longer where the
-- winner's row implied it was -- failing on the balance CHECK when no other
-- winner of the same prize held one, and SUCCEEDING against that other
-- winner's own unit when one did. The second is silent, and is exactly what
-- Task 5's reviewer reproduced on a live database with Task 5's fix already
-- in place: delivering the phantom moved the balance to delivered, after
-- which the genuinely live winner of that same prize failed to be delivered
-- with "only 0 unit(s) are in awaiting_pickup".
--
-- The guard sits in this core function rather than in deliver_prize or any
-- other door: a screen or a door that forgets to ask is then merely
-- inconvenient, not a silent transfer of somebody else's prize.
--
-- apply_winner_transition's signature does not change -- the same (uuid,
-- winner_status, text, timestamptz) it has had since 0092 -- so create or
-- replace is enough. No drop, and the ACL and comment 0092 issued survive.

create or replace function public.apply_winner_transition(
  p_winner_id   uuid,
  p_to          public.winner_status,
  p_reason      text,
  p_deadline_at timestamptz default null
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor       uuid := auth.uid();
  v_from        public.winner_status;
  v_company     uuid;
  v_org         uuid;
  v_link        uuid;
  v_prize       uuid;
  v_name        text;
  v_allows      boolean;
  v_reason      text := nullif(btrim(coalesce(p_reason, '')), '');
  v_history     uuid;
  v_draw_status public.draw_status;
begin
  select w.status, w.company_id, d.organization_id, w.promotion_prize_id,
         l.prize_id, pz.name, pz.allows_return_to_stock, d.status
    into v_from, v_company, v_org, v_link, v_prize, v_name, v_allows, v_draw_status
  from public.winners w
  join public.draws d on d.id = w.draw_id
  join public.promotion_prizes l on l.id = w.promotion_prize_id
  join public.prizes pz on pz.id = l.prize_id
  where w.id = p_winner_id
    for update of w;

  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  -- 0079 cancels a draw by returning its units to `linked` and marking the
  -- draw CANCELLED, while deliberately leaving its winners AWAITING_PICKUP.
  -- Those rows are a record of what was cancelled, not a claim on stock, and
  -- every transition below would move a unit that is no longer there --
  -- failing on the balance CHECK when no other winner holds one, and
  -- SUCCEEDING against somebody else's unit when one does. The second is
  -- silent, and is the reason this refusal is in the core rather than in the
  -- doors: a screen that forgets to ask is then merely inconvenient.
  if v_draw_status = 'CANCELLED' then
    raise exception 'this prize was un-awarded when its draw was cancelled'
      using errcode = '22023';
  end if;

  -- The reopen is the only transition allowed to touch deadline_at (D3). A
  -- caller passing p_deadline_at to any other transition used to have it
  -- silently ignored -- which this function's own comment overclaimed as
  -- refused. Enforced here, before p_to is ever dispatched to a branch that
  -- would not so much as look at the argument.
  if p_deadline_at is not null and not (p_to = 'AWAITING_PICKUP' and v_from = 'RETURN_PENDING') then
    raise exception 'p_deadline_at is accepted only when reopening RETURN_PENDING to AWAITING_PICKUP'
      using errcode = '22023';
  end if;

  if p_to <> 'DELIVERED' and v_reason is null then
    raise exception 'this change needs a reason' using errcode = '22023';
  end if;

  if p_to = v_from then
    raise exception 'this prize is already %', v_from using errcode = '22023';
  end if;

  insert into public.winner_status_history
    (winner_id, company_id, from_status, to_status, reason, changed_by)
  values (p_winner_id, v_company, v_from, p_to, v_reason, v_actor)
  returning id into v_history;

  if p_to = 'DELIVERED' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot be handed over', v_from using errcode = '22023';
    end if;
    perform public.apply_inventory_movement(
      v_company, v_prize, 'DELIVERY'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'delivered'::public.inventory_bucket,
      v_reason, v_history::text, v_link);

  elsif p_to = 'RETURN_PENDING' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot have its deadline expire', v_from
        using errcode = '22023';
    end if;
    -- ONE movement, not the pair a return emits. This is the whole of D1: the
    -- unit stops in pending_return and stays there until an operator finishes,
    -- which is why winner_status needed a value for it.
    perform public.apply_inventory_movement(
      v_company, v_prize, 'RETURN_PENDING'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'pending_return'::public.inventory_bucket,
      v_reason, v_history::text, v_link);

  elsif p_to = 'AWAITING_PICKUP' then
    if v_from = 'DELIVERED' then
      perform public.apply_inventory_movement(
        v_company, v_prize, 'DELIVERY_CANCEL'::public.inventory_movement_type, 1,
        'delivered'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
        v_reason, v_history::text, v_link);

    elsif v_from = 'RETURN_PENDING' then
      -- THE ONE PLACE IN THIS FUNCTION THAT WRITES deadline_at (D3).
      --
      -- 6a's D5 froze the column at the draw and this does not thaw it. What
      -- D5 forbids is the PROMOTION's configuration reaching rows it was never
      -- agreed for -- editing pickup_deadline_days in September must not
      -- shorten the deadline of somebody who won in August. Giving one named
      -- person more time, on purpose, with an actor and a reason on the
      -- history row, is the opposite of drift.
      if p_deadline_at is null then
        raise exception 'reopening a deadline needs the new deadline'
          using errcode = '22023';
      end if;
      if p_deadline_at <= now() then
        raise exception 'the new deadline must be in the future'
          using errcode = '22023';
      end if;
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_PENDING_CANCEL'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
        v_reason, v_history::text, v_link);
      update public.winners set deadline_at = p_deadline_at where id = p_winner_id;

    else
      raise exception 'a prize that is % cannot be moved back to awaiting pickup', v_from
        using errcode = '22023';
    end if;

  elsif p_to = 'RETURNED' then
    if v_from not in ('AWAITING_PICKUP', 'RETURN_PENDING') then
      raise exception 'a prize that is % cannot be returned to stock', v_from
        using errcode = '22023';
    end if;

    if not v_allows then
      raise exception
        'the prize "%" is registered as one that cannot go back to stock; write it off instead',
        v_name using errcode = '22023';
    end if;

    if v_from = 'AWAITING_PICKUP' then
      -- TWO movements, one transaction: the ledger has no shortcut from
      -- awaiting_pickup to available (0026). This is the operator returning a
      -- prize whose deadline has NOT expired -- the listener declined it, or
      -- said they cannot come -- and the unit passes through pending_return
      -- without stopping.
      --
      -- The comment that used to stand here argued this traversal was what let
      -- winner_status have no RETURN_PENDING. Block 6d withdrew that argument
      -- (D1): the bucket is now also rested in. It also said the enum kept
      -- "the five values 6a froze", which has been wrong since 6c withdrew
      -- SUPERSEDED and left four.
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_PENDING'::public.inventory_movement_type, 1,
        'awaiting_pickup'::public.inventory_bucket, 'pending_return'::public.inventory_bucket,
        v_reason, v_history::text || ':pending', v_link);
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_TO_STOCK'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'available'::public.inventory_bucket,
        v_reason, v_history::text || ':stock', v_link);
    else
      -- Already resting in pending_return, put there by the clock. One
      -- movement finishes the journey.
      perform public.apply_inventory_movement(
        v_company, v_prize, 'RETURN_TO_STOCK'::public.inventory_movement_type, 1,
        'pending_return'::public.inventory_bucket, 'available'::public.inventory_bucket,
        v_reason, v_history::text, v_link);
    end if;

  elsif p_to = 'WRITTEN_OFF' then
    if v_from not in ('AWAITING_PICKUP', 'RETURN_PENDING') then
      raise exception 'a prize that is % cannot be written off here', v_from
        using errcode = '22023';
    end if;
    -- 0026 admits WRITE_OFF out of BOTH buckets, so the source is whichever
    -- one the unit is actually in. Getting this wrong would not raise -- it
    -- would move a unit that is not there and fail on the balance CHECK,
    -- which is a worse error to read.
    perform public.apply_inventory_movement(
      v_company, v_prize, 'WRITE_OFF'::public.inventory_movement_type, 1,
      case v_from when 'RETURN_PENDING'
        then 'pending_return'::public.inventory_bucket
        else 'awaiting_pickup'::public.inventory_bucket end,
      'written_off'::public.inventory_bucket,
      v_reason, v_history::text, v_link);

  else
    raise exception 'no rule for moving a winner to %', p_to using errcode = 'XX000';
  end if;

  update public.winners
     set status = p_to, updated_at = now()
   where id = p_winner_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'winner_transition', 'winners', p_winner_id, v_org, v_company,
     jsonb_build_object('winner_id', p_winner_id, 'from', v_from, 'to', p_to));
end;
$$;

comment on function
  public.apply_winner_transition(uuid, public.winner_status, text, timestamptz) is
  'Moves a winner from one status to the next: locks the row, refuses a transition that is not in its table, writes the history row, emits the ledger movements through apply_inventory_movement and writes the new status -- all in one transaction. Refuses EVERY transition, immediately after the not-found check and before any other guard, when the winner''s own draw is CANCELLED: cancel_draw (0079) leaves a cancelled draw''s winners AWAITING_PICKUP on purpose -- it has no vocabulary for "un-awarded" -- and returns their units to linked, so those rows are a record of what was cancelled, not a claim on stock (Block 6d Task 12). It touches deadline_at in exactly ONE case, the reopen from RETURN_PENDING, which is the only transition permitted to pass p_deadline_at -- passing one to any other transition is refused with 22023 rather than silently accepted and ignored; every other transition leaves the column frozen where the draw put it (6a D5, Block 6d D3). The history row''s id is the movements'' idempotency key, because a key built from the winner and the status would collide with itself on a second delivery of the same prize, and apply_inventory_movement treats a repeated key as a replay -- so the collision would not raise, it would silently fail to move the stock. A return from AWAITING_PICKUP emits TWO movements because the ledger has no shortcut from awaiting_pickup to available; a return from RETURN_PENDING emits one, because the clock already moved the unit halfway. The allows_return_to_stock refusal lives here rather than in the door because it is a fact about the prize, not about the caller. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';
