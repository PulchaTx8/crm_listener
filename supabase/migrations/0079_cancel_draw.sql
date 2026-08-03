-- Block 6a, Task 6: cancelling a draw.
--
-- D7: cancelling reverses the inventory and marks the draw, and DELETES
-- NOTHING. The hat, the seed and the winners stay, because the record of a
-- cancelled draw is the evidence that it was cancelled, who cancelled it and
-- why. A reason is mandatory for the same reason.
--
-- The winners are left AWAITING_PICKUP rather than given a new status: 6a has
-- no vocabulary for "un-awarded", and SUPERSEDED means something else that 6b
-- will define. draws.status is what says the draw is void, and it is the only
-- thing that says so.

create function public.cancel_draw(p_draw_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_status    public.draw_status;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_promotion uuid;
  v_undelivered integer;
  r           record;
begin
  -- FOR UPDATE before anything is decided, so two cancellations of one draw
  -- cannot both read it as COMPLETED and both put the units back.
  select organization_id, company_id, status, promotion_id
    into v_org, v_company, v_status, v_promotion
  from public.draws
  where id = p_draw_id
    for update;

  if not found then
    raise exception 'draw not found: %', p_draw_id using errcode = 'P0002';
  end if;

  if not public.has_permission('draws.cancel', v_company) then
    raise log 'cancel_draw denied: actor=% draw=%', v_actor, p_draw_id;
    raise exception 'permission denied: draws.cancel required' using errcode = '42501';
  end if;

  if v_status = 'CANCELLED' then
    raise exception 'this draw has already been cancelled' using errcode = '22023';
  end if;

  -- Mandatory, and checked here rather than left to draws_cancellation_shape:
  -- the constraint would refuse this with a constraint name, and somebody
  -- undoing a draw is owed a sentence.
  if v_reason is null then
    raise exception 'a cancellation needs a reason' using errcode = '22023';
  end if;

  -- The guard 6b needs from the start. 6a cannot produce a winner that is not
  -- AWAITING_PICKUP, so this is unreachable today through the application --
  -- and it exists now precisely so that 6b, which CAN, cannot introduce the
  -- hole by forgetting it. Putting a delivered prize back into linked would
  -- invent stock the Station does not have.
  select count(*) into v_undelivered
  from public.winners w
  where w.draw_id = p_draw_id
    and w.status <> 'AWAITING_PICKUP';

  if v_undelivered > 0 then
    raise exception
      'this draw has % prize(s) that are no longer awaiting pickup and cannot be undone here',
      v_undelivered
      using errcode = '22023';
  end if;

  -- One movement per winner, back through the ledger's single writer. The
  -- idempotency key mirrors the draw's own and cannot collide with it.
  for r in
    select w.awarded_rank, w.promotion_prize_id, l.prize_id
    from public.winners w
    join public.promotion_prizes l on l.id = w.promotion_prize_id
    where w.draw_id = p_draw_id
    order by w.awarded_rank
  loop
    perform public.apply_inventory_movement(
      v_company, r.prize_id,
      'DRAW_CANCEL'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'linked'::public.inventory_bucket,
      null, p_draw_id::text || ':cancel:' || r.awarded_rank::text, r.promotion_prize_id);
  end loop;

  update public.draws
     set status = 'CANCELLED',
         cancelled_at = now(),
         cancelled_by = v_actor,
         cancellation_reason = v_reason
   where id = p_draw_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_draw', 'draws', p_draw_id, v_org, v_company,
     jsonb_build_object(
       'draw_id', p_draw_id,
       'promotion_id', v_promotion,
       'units_returned', (select count(*) from public.winners where draw_id = p_draw_id)));
end;
$$;

comment on function public.cancel_draw(uuid, text) is
  'Undoes a draw: every awarded unit goes back from awaiting_pickup to linked through apply_inventory_movement, and the draw is marked CANCELLED with when, by whom and why. Gated on draws.cancel, which is NOT draws.execute (spec 4.3): cancelling un-awards prizes somebody has already been told they won, and whoever may run a draw is not thereby somebody who may undo one. DELETES NOTHING (D7) -- the hat, the seed and the winners survive, because the record of a cancelled draw is the evidence it was cancelled, and a cancelled draw stays reproducible. Refuses a draw holding any winner that is no longer AWAITING_PICKUP: 6a cannot create one, and the guard exists from the start so 6b cannot introduce the hole by forgetting it.';

revoke execute on function public.cancel_draw(uuid, text) from public;
grant execute on function public.cancel_draw(uuid, text) to authenticated;
