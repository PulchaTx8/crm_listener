-- Block 6d, Task 3: giving one person more time, on the record.

insert into public.permissions
  (code, description, introduced_by_block, module, label, scope, display_order)
values
  ('winners.reopen_deadline',
   'Give a listener more time to collect a prize whose deadline expired',
   '6d', 'promotions', 'Reopen a pickup deadline', 'company', 140);

-- Its own code rather than folded into winners.return, and the distinction is
-- not bureaucratic: returning a prize to stock CLOSES a matter, reopening a
-- deadline GRANTS a second chance at a unit the Station had already recovered.
-- Whoever may do the first should not acquire the second by implication -- the
-- same separation Block 2 made between inventory.entry and inventory.exit.

create function public.reopen_pickup_deadline(
  p_winner_id   uuid,
  p_deadline_at timestamptz,
  p_reason      text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare v_company uuid;
begin
  -- DELIBERATELY NOT SHAPED LIKE ITS 6b SIBLINGS. return_prize and
  -- write_off_prize read the winner, raise P0002 when it is missing, and only
  -- then ask about the permission -- which tells an unauthorised caller
  -- whether an id exists. That leak stands at eight migrations and Block 6d
  -- promised not to make it nine.
  --
  -- The winner id is this function's only input, so the Station cannot be
  -- named by the caller the way list_participations (0090) has it named. One
  -- gated query resolves it instead: an unknown id and a Station the caller
  -- holds nothing in are indistinguishable from out here, both 42501. The
  -- cost is that an operator who mistypes an id is told "permission denied";
  -- it is smaller than the alternative. This does not fix the eight before it.
  select company_id into v_company
    from public.winners
   where id = p_winner_id
     and public.has_permission('winners.reopen_deadline', company_id);

  if not found then
    raise log 'reopen_pickup_deadline denied: actor=% winner=%', auth.uid(), p_winner_id;
    raise exception 'permission denied: winners.reopen_deadline required'
      using errcode = '42501';
  end if;

  -- Mandatory, and for the reason the write-off's is: six months later this
  -- sentence is the only thing that explains why a recovered prize became
  -- live again.
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reopening a deadline needs a reason' using errcode = '22023';
  end if;

  perform public.apply_winner_transition(
    p_winner_id, 'AWAITING_PICKUP'::public.winner_status, p_reason, p_deadline_at);
end;
$$;

comment on function public.reopen_pickup_deadline(uuid, timestamptz, text) is
  'Gives a listener who turned up late another chance at a prize the clock had already parked in pending_return: the unit goes back to awaiting_pickup, the winner back to AWAITING_PICKUP, and deadline_at forward to the date the operator supplies. Gated on winners.reopen_deadline. The only path in the schema that writes deadline_at after the draw (Block 6d D3) -- 6a''s freeze is against a promotion''s configuration drifting into rows it was never agreed for, not against a named person being given more time on purpose. Refuses a source that is not RETURN_PENDING, a deadline at or before now, and an empty reason. Unlike return_prize and write_off_prize it answers 42501 for an unknown id rather than P0002, so it does not extend the existence leak those two carry.';

revoke execute on function public.reopen_pickup_deadline(uuid, timestamptz, text) from public;
grant execute on function public.reopen_pickup_deadline(uuid, timestamptz, text) to authenticated;
