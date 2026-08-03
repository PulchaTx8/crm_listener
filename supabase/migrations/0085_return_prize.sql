-- Block 6b, Task 4: back to stock, or written off, and the prize decides which.
--
-- The core gains its other two transitions. Replaced rather than extended in
-- place because plpgsql has no other way, and the two branches 0084 shipped are
-- byte-identical below.

create or replace function public.apply_winner_transition(
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

  elsif p_to = 'AWAITING_PICKUP' then
    if v_from <> 'DELIVERED' then
      raise exception 'a prize that is % cannot have its delivery undone', v_from
        using errcode = '22023';
    end if;
    perform public.apply_inventory_movement(
      v_company, v_prize, 'DELIVERY_CANCEL'::public.inventory_movement_type, 1,
      'delivered'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
      v_reason, v_history::text, v_link);

  elsif p_to = 'RETURNED' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot be returned to stock', v_from
        using errcode = '22023';
    end if;

    -- allows_return_to_stock's first reader in this schema. 0025 set it at
    -- registration by the person who knows the answer and called it deliberate
    -- debt; this is the debt coming due. The check lives HERE, beside the
    -- transition it governs, rather than in the door: it is a fact about the
    -- prize and not about the caller.
    if not v_allows then
      raise exception
        'the prize "%" is registered as one that cannot go back to stock; write it off instead',
        v_name using errcode = '22023';
    end if;

    -- Two movements, one transaction. The ledger has no shortcut from
    -- awaiting_pickup to available (0026), and pending_return is a bucket this
    -- passes THROUGH rather than rests in -- which is what lets winner_status
    -- keep the five values 6a froze, with no sixth for "being inspected".
    perform public.apply_inventory_movement(
      v_company, v_prize, 'RETURN_PENDING'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'pending_return'::public.inventory_bucket,
      v_reason, v_history::text || ':pending', v_link);
    perform public.apply_inventory_movement(
      v_company, v_prize, 'RETURN_TO_STOCK'::public.inventory_movement_type, 1,
      'pending_return'::public.inventory_bucket, 'available'::public.inventory_bucket,
      v_reason, v_history::text || ':stock', v_link);

  elsif p_to = 'WRITTEN_OFF' then
    if v_from <> 'AWAITING_PICKUP' then
      raise exception 'a prize that is % cannot be written off here', v_from
        using errcode = '22023';
    end if;
    -- Straight out of awaiting_pickup: 0026 admits that arm, so a prize that is
    -- never coming back does not have to pretend to travel through a return
    -- first.
    perform public.apply_inventory_movement(
      v_company, v_prize, 'WRITE_OFF'::public.inventory_movement_type, 1,
      'awaiting_pickup'::public.inventory_bucket, 'written_off'::public.inventory_bucket,
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

comment on function public.apply_winner_transition(uuid, public.winner_status, text) is
  'Moves a winner from one status to the next: locks the row, refuses a transition that is not in its table, writes the history row, emits the ledger movements through apply_inventory_movement and writes the new status -- all in one transaction. NEVER touches deadline_at: it was frozen at the draw (6a D5). The history row''s id is the movements'' idempotency key, because a key built from the winner and the status would collide with itself on a second delivery of the same prize, and apply_inventory_movement treats a repeated key as a replay -- so the collision would not raise, it would silently fail to move the stock. A return emits TWO movements, because the ledger has no shortcut from awaiting_pickup to available and pending_return is a bucket this passes through rather than rests in. The allows_return_to_stock refusal lives here rather than in the door because it is a fact about the prize, not about the caller. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';

revoke execute on function public.apply_winner_transition(uuid, public.winner_status, text) from public;

-- ---------------------------------------------------------------------------
-- The two remaining doors.

create function public.return_prize(p_winner_id uuid, p_reason text)
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

  if not public.has_permission('winners.return', v_company) then
    raise log 'return_prize denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.return required' using errcode = '42501';
  end if;

  perform public.apply_winner_transition(p_winner_id, 'RETURNED', p_reason);
end;
$$;

comment on function public.return_prize(uuid, text) is
  'Takes an uncollected prize back and puts the unit into available stock. Gated on winners.return, which does NOT grant winners.write_off: recovering a unit and destroying one are different authorisations, the separation Block 2 already made between inventory.entry and inventory.exit. Refused with 22023 when the prize is registered as one that cannot go back to stock, naming it, because that is a fact the operator can act on -- write_off_prize is the exit that remains.';

revoke execute on function public.return_prize(uuid, text) from public;
grant execute on function public.return_prize(uuid, text) to authenticated;

create function public.write_off_prize(p_winner_id uuid, p_reason text)
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

  if not public.has_permission('winners.write_off', v_company) then
    raise log 'write_off_prize denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.write_off required' using errcode = '42501';
  end if;

  perform public.apply_winner_transition(p_winner_id, 'WRITTEN_OFF', p_reason);
end;
$$;

comment on function public.write_off_prize(uuid, text) is
  'Writes off a prize that is not coming back: the unit leaves stock for written_off and the promotion keeps counting it, because it was this promotion that consumed it. Gated on winners.write_off, its own code because this one destroys value. Available for any uncollected prize, not only for those that cannot be returned -- a prize that COULD have gone back may still have been damaged, and the operator is the one who knows.';

revoke execute on function public.write_off_prize(uuid, text) from public;
grant execute on function public.write_off_prize(uuid, text) to authenticated;
