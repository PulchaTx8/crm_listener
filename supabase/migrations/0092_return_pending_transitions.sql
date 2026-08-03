-- Block 6d, Task 2: the ledger learns to rest a unit in pending_return, and the
-- winner state machine learns the clock's transition and the way back out of
-- it.
--
-- Three things change and nothing else does: the CHECK constraint gains one
-- arm, apply_winner_transition's signature gains a fourth parameter, and four
-- of its branches change. The DELIVERED branch and the AWAITING_PICKUP-from-
-- DELIVERED half of the reopen branch are copied byte-identical from 0085;
-- plpgsql has no way to extend a function in place, and 0085 said the same
-- about 0084.

-- ---------------------------------------------------------------------------
-- (a) The CHECK constraint gains one arm -- the surgery 0083 performed once,
-- reproducing every branch of 0026/0083 verbatim rather than retyping them
-- from memory, which is how an arm goes missing without announcing itself.

alter table public.inventory_movements
  drop constraint inventory_movements_legal_transition;

alter table public.inventory_movements
  add constraint inventory_movements_legal_transition check (
       (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'ADJUSTMENT_POSITIVE')
          and from_bucket is null and to_bucket = 'available')
    or (movement_type in ('MANUAL_EXIT', 'ADJUSTMENT_NEGATIVE')
          and from_bucket = 'available' and to_bucket is null)
    or (movement_type = 'RESERVATION'
          and from_bucket = 'available' and to_bucket = 'reserved')
    or (movement_type = 'RESERVATION_RELEASE'
          and from_bucket = 'reserved' and to_bucket = 'available')
    or (movement_type = 'PROMOTION_LINK'
          and from_bucket = 'available' and to_bucket = 'linked')
    or (movement_type = 'PROMOTION_UNLINK'
          and from_bucket = 'linked' and to_bucket = 'available')
    or (movement_type = 'DRAW'
          and from_bucket = 'linked' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'DRAW_CANCEL'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'linked')
    or (movement_type = 'DELIVERY'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'delivered')
    or (movement_type = 'DELIVERY_CANCEL'
          and from_bucket = 'delivered' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'RETURN_PENDING'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return')
    or (movement_type = 'RETURN_TO_STOCK'
          and from_bucket = 'pending_return' and to_bucket = 'available')
    or (movement_type = 'WRITE_OFF'
          and from_bucket in ('pending_return', 'awaiting_pickup') and to_bucket = 'written_off')
    -- The one this block adds. RETURN_PENDING_CANCEL is the inverse of
    -- RETURN_PENDING exactly as DELIVERY_CANCEL is the inverse of DELIVERY: the
    -- way back for a listener who turns up late while the prize is still on the
    -- shelf (0091's D2).
    or (movement_type = 'RETURN_PENDING_CANCEL'
          and from_bucket = 'pending_return' and to_bucket = 'awaiting_pickup')
  );

-- ---------------------------------------------------------------------------
-- (a2) Two more surfaces the new movement type has to clear, found by running
-- the reopen branch below rather than named in the plan: it names its
-- winner's own promotion_prize_id (v_link) on RETURN_PENDING_CANCEL, exactly
-- as RETURN_PENDING itself already must (0083's inventory_movements_promotion_
-- reference), and apply_inventory_movement (0077) hands every movement that
-- names a link to project_promotion_prize_movement, whose else branch is
-- 0047's tripwire for a type nobody taught it. Skipping either one does not
-- fail quietly: the first refuses the reopen with the wrong CHECK name, the
-- second raises XX000 out of a function this migration does not otherwise
-- touch.

alter table public.inventory_movements
  drop constraint inventory_movements_promotion_reference;

alter table public.inventory_movements
  add constraint inventory_movements_promotion_reference check (
    (movement_type in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL',
                       'DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING',
                       'RETURN_PENDING_CANCEL', 'RETURN_TO_STOCK', 'WRITE_OFF')
       and promotion_prize_id is not null)
    or (movement_type not in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL',
                              'DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING',
                              'RETURN_PENDING_CANCEL', 'RETURN_TO_STOCK', 'WRITE_OFF')
       and promotion_prize_id is null)
  );

comment on column public.inventory_movements.promotion_prize_id is
  'Which promotion link this movement is part of. Required for the ten types that move a promotion''s own units -- PROMOTION_LINK, PROMOTION_UNLINK, DRAW, DRAW_CANCEL, DELIVERY, DELIVERY_CANCEL, RETURN_PENDING, RETURN_PENDING_CANCEL, RETURN_TO_STOCK and WRITE_OFF -- and forbidden for every other, none of which is about a promotion at all.';

create or replace function public.project_promotion_prize_movement(
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

  elsif p_type in ('DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING', 'RETURN_PENDING_CANCEL', 'WRITE_OFF') then
    -- Deliberately nothing, and written as a branch rather than left to fall
    -- through to the else below.
    --
    -- `linked` counts the units this promotion took out of stock and has not
    -- given back; `drawn` counts how many of those were drawn. A prize handed
    -- over, or handed over and un-handed, on its way back, brought back from
    -- there, or destroyed, was still spent BY this promotion -- none of those
    -- five is the promotion returning a unit to general stock, which is the
    -- only thing that changes either figure. RETURN_PENDING_CANCEL joins the
    -- other four here for exactly that reason: it undoes RETURN_PENDING's own
    -- bucket move and, like DELIVERY_CANCEL undoing DELIVERY, touches neither
    -- figure either.
    --
    -- The else raises XX000 on purpose (0047's tripwire, which fired on Block
    -- 6a's first DRAW and did its job). A silent fallthrough is exactly the
    -- failure it exists to catch, so "nothing happens here" has to be said out
    -- loud or it cannot be told apart from "nobody thought about this".
    null;

  elsif p_type = 'RETURN_TO_STOCK' then
    -- The one that does move them. The unit leaves the promotion for general
    -- stock, so it is neither linked nor drawn any more. Without BOTH
    -- decrements it would be counted twice -- once in inventory_balances.available
    -- and once in this promotion's Resto (linked - drawn) -- and the second
    -- count is the one nobody would notice.
    update public.promotion_prize_balances
       set linked = linked - p_quantity,
           drawn  = drawn  - p_quantity,
           updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;

  else
    raise exception
      'apply_inventory_movement cannot project movement type % onto a promotion prize', p_type
      using errcode = 'XX000';
  end if;
end;
$$;

comment on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) is
  'Moves the per-promotion figures for one movement. The ONE home of the rule that says which movement type touches linked and which touches drawn, called only from apply_inventory_movement (0047) and lifted out of its body in 0077 so that Block 6b could add its types here rather than restate a 180-line function. Driven by movement_type and never by the bucket pair: linked counts units committed to the promotion and is not decremented by a draw or by a delivery. RETURN_TO_STOCK is the only type that decrements either figure, because it is the only one that gives a unit back to general stock. DELIVERY, DELIVERY_CANCEL, RETURN_PENDING, RETURN_PENDING_CANCEL and WRITE_OFF have an explicit do-nothing branch rather than falling through to the XX000 the else raises -- a silent no-op is the failure that tripwire exists to catch. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';

revoke execute on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) from public;

-- ---------------------------------------------------------------------------
-- (b) and (c). apply_winner_transition, DROPPED and recreated rather than
-- replaced: create or replace cannot change an argument list, so the three-
-- argument overload has to go before the four-argument one can exist, exactly
-- as 0047 hit for apply_inventory_movement.
--
-- The fourth parameter defaults to null, which is what keeps the four existing
-- callers -- deliver_prize, cancel_delivery, return_prize, write_off_prize --
-- compiling and behaving unchanged: none of them passes it, and the reopen
-- branch below is the only one that reads it.

drop function public.apply_winner_transition(uuid, public.winner_status, text);

create function public.apply_winner_transition(
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
  v_actor   uuid := auth.uid();
  v_from    public.winner_status;
  v_company uuid;
  v_org     uuid;
  v_link    uuid;
  v_prize   uuid;
  v_name    text;
  v_allows  boolean;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_history uuid;
begin
  select w.status, w.company_id, d.organization_id, w.promotion_prize_id,
         l.prize_id, pz.name, pz.allows_return_to_stock
    into v_from, v_company, v_org, v_link, v_prize, v_name, v_allows
  from public.winners w
  join public.draws d on d.id = w.draw_id
  join public.promotion_prizes l on l.id = w.promotion_prize_id
  join public.prizes pz on pz.id = l.prize_id
  where w.id = p_winner_id
    for update of w;

  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
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

-- A dropped function takes its ACL and its comment with it, so both are
-- re-issued exactly as 0085 does.

revoke execute on function
  public.apply_winner_transition(uuid, public.winner_status, text, timestamptz) from public;

comment on function
  public.apply_winner_transition(uuid, public.winner_status, text, timestamptz) is
  'Moves a winner from one status to the next: locks the row, refuses a transition that is not in its table, writes the history row, emits the ledger movements through apply_inventory_movement and writes the new status -- all in one transaction. It touches deadline_at in exactly ONE case, the reopen from RETURN_PENDING, which is the only transition permitted to pass p_deadline_at -- passing one to any other transition is refused with 22023 rather than silently accepted and ignored; every other transition leaves the column frozen where the draw put it (6a D5, Block 6d D3). The history row''s id is the movements'' idempotency key, because a key built from the winner and the status would collide with itself on a second delivery of the same prize, and apply_inventory_movement treats a repeated key as a replay -- so the collision would not raise, it would silently fail to move the stock. A return from AWAITING_PICKUP emits TWO movements because the ledger has no shortcut from awaiting_pickup to available; a return from RETURN_PENDING emits one, because the clock already moved the unit halfway. The allows_return_to_stock refusal lives here rather than in the door because it is a fact about the prize, not about the caller. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';
