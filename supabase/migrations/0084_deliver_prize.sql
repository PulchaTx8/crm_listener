-- Block 6b, Task 3: the handover, and the undo that mirrors it.

-- ---------------------------------------------------------------------------
-- The private core. SECURITY INVOKER, EXECUTE granted to nobody: each door
-- checks its OWN permission beside its own operation, for the reason
-- apply_participation (0054) gives -- a gate inside a shared body would have to
-- choose its code from an argument, and a caller-supplied label must never
-- choose which permission it faces.
--
-- This version knows two transitions. 0085 replaces it with the other two,
-- when there are tests asking for them.

create function public.apply_winner_transition(
  p_winner_id uuid,
  p_to        public.winner_status,
  p_reason    text
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
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_history uuid;
begin
  -- FOR UPDATE before anything is read or decided. Two operators acting on one
  -- winner would otherwise both read the same status, both pass the transition
  -- check, and both move a unit that only exists once.
  select w.status, w.company_id, d.organization_id, w.promotion_prize_id, l.prize_id
    into v_from, v_company, v_org, v_link, v_prize
  from public.winners w
  join public.draws d on d.id = w.draw_id
  join public.promotion_prizes l on l.id = w.promotion_prize_id
  where w.id = p_winner_id
    for update of w;

  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  -- Mandatory everywhere except on the transition that was supposed to happen.
  -- winner_status_history carries the same rule as a CHECK (0081); this is the
  -- one that answers with a sentence instead of a constraint name.
  if p_to <> 'DELIVERED' and v_reason is null then
    raise exception 'this change needs a reason' using errcode = '22023';
  end if;

  if p_to = v_from then
    raise exception 'this prize is already %', v_from using errcode = '22023';
  end if;

  -- The history row goes in FIRST, and its id becomes the idempotency key of
  -- every movement below. A key built from the winner and the status alone
  -- would collide with itself the second time a prize is delivered, undone and
  -- delivered again -- and apply_inventory_movement treats a repeated key as a
  -- replay and silently returns the first movement, so the collision would not
  -- raise. It would simply fail to move the stock.
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

  elsif p_to = 'AWAITING_PICKUP' then
    if v_from <> 'DELIVERED' then
      raise exception 'a prize that is % cannot have its delivery undone', v_from
        using errcode = '22023';
    end if;
    perform public.apply_inventory_movement(
      v_company, v_prize, 'DELIVERY_CANCEL'::public.inventory_movement_type, 1,
      'delivered'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
      v_reason, v_history::text, v_link);

  else
    raise exception 'no rule for moving a winner to %', p_to using errcode = 'XX000';
  end if;

  -- deadline_at is NOT touched here, by any transition. It was frozen at the
  -- draw (6a's D5) and a delivery never moved it, so undoing one does not
  -- either: a winner whose deadline passed while the delivery stood comes back
  -- overdue, which is true, and 6c is what acts on it.
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

comment on function public.apply_winner_transition(uuid, public.winner_status, text) is
  'Moves a winner from one status to the next: locks the row, refuses a transition that is not in its table, writes the history row, emits the ledger movements through apply_inventory_movement and writes the new status -- all in one transaction. NEVER touches deadline_at: it was frozen at the draw (6a D5). The history row''s id is the movements'' idempotency key, because a key built from the winner and the status would collide with itself on a second delivery of the same prize, and apply_inventory_movement treats a repeated key as a replay -- so the collision would not raise, it would silently fail to move the stock. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody; each door checks its own permission.';

revoke execute on function public.apply_winner_transition(uuid, public.winner_status, text) from public;

-- ---------------------------------------------------------------------------
-- The two doors. Thin on purpose: find the Station, check the one permission
-- this operation needs, delegate.

create function public.deliver_prize(p_winner_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.winners where id = p_winner_id;
  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  if not public.has_permission('winners.deliver', v_company) then
    raise log 'deliver_prize denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.deliver required' using errcode = '42501';
  end if;

  perform public.apply_winner_transition(p_winner_id, 'DELIVERED', p_note);
end;
$$;

comment on function public.deliver_prize(uuid, text) is
  'Records that a prize was handed to the person who won it. Gated on winners.deliver. The note is OPTIONAL, unlike the reason every other transition requires: handing a prize to the person who won it is what was supposed to happen, and demanding a justification would teach operators to type a full stop. The receipt is attached afterwards by attach_delivery_receipt (0086) and is never a condition of this succeeding (D1) -- a prize that has physically left the operator''s hands must be recordable whether or not a photograph uploads.';

revoke execute on function public.deliver_prize(uuid, text) from public;
grant execute on function public.deliver_prize(uuid, text) to authenticated;

create function public.cancel_delivery(p_winner_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  select company_id into v_company from public.winners where id = p_winner_id;
  if not found then
    raise exception 'winner not found: %', p_winner_id using errcode = 'P0002';
  end if;

  if not public.has_permission('winners.deliver_cancel', v_company) then
    raise log 'cancel_delivery denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.deliver_cancel required' using errcode = '42501';
  end if;

  perform public.apply_winner_transition(p_winner_id, 'AWAITING_PICKUP', p_reason);
end;
$$;

comment on function public.cancel_delivery(uuid, text) is
  'Undoes a delivery recorded by mistake: the unit goes back from delivered to awaiting_pickup and the winner waits again. Gated on winners.deliver_cancel, which is NOT winners.deliver -- 6a separated draws.cancel from draws.execute on the same reasoning, that undoing is not doing. The reason is mandatory. The RECEIPT IS KEPT: clearing it would delete a photograph of a real handover because somebody corrected a record, and only erasure (0087) ever clears that slot. The deadline is untouched, so a winner whose deadline passed comes back overdue.';

revoke execute on function public.cancel_delivery(uuid, text) from public;
grant execute on function public.cancel_delivery(uuid, text) to authenticated;
