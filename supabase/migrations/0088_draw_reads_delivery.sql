-- Block 6b, Task 7: what the draw screen needs to decide with.
--
-- get_draw (0080) already returns the winners; this adds the three facts that
-- decide which buttons a winner's row offers and whether there is a receipt to
-- show. Without allows_return_to_stock the screen would have to guess, and a
-- guess here means offering a button that return_prize (0085) then refuses --
-- which teaches operators that the buttons lie.
--
-- Everything else about this function is 0080's and unchanged, including the
-- ruling that names come back to anybody holding promotions.view.

create or replace function public.get_draw(p_draw_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_draw    jsonb;
begin
  select d.company_id into v_company
  from public.draws d
  where d.id = p_draw_id;

  if not found then
    raise exception 'draw not found: %', p_draw_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.view', v_company) then
    raise log 'get_draw denied: actor=% draw=%', auth.uid(), p_draw_id;
    raise exception 'permission denied: promotions.view required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', d.id,
    'promotion_id', d.promotion_id,
    'seed', d.seed,
    'algorithm_version', d.algorithm_version,
    'entry_count', d.entry_count,
    'runner_up_count', d.runner_up_count,
    'status', d.status,
    'drawn_at', d.drawn_at,
    'cancelled_at', d.cancelled_at,
    'cancellation_reason', d.cancellation_reason,
    'winners', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id,
               'awarded_rank', w.awarded_rank,
               'member_id', w.member_id,
               -- Nullable in members (0031), so a null here means this listener
               -- has no name on record -- an erased one, most likely -- and
               -- never "not yours to see".
               'member_name', m.full_name,
               'participation_id', w.participation_id,
               'promotion_prize_id', w.promotion_prize_id,
               'prize_name', pz.name,
               -- Block 6b: which buttons this winner's row may offer.
               'allows_return_to_stock', pz.allows_return_to_stock,
               'receipt_path', w.receipt_path,
               'receipt_erased_at', w.receipt_erased_at,
               'deadline_at', w.deadline_at,
               'status', w.status)
             order by w.awarded_rank)
      from public.winners w
      join public.promotion_prizes l on l.id = w.promotion_prize_id
      join public.prizes pz on pz.id = l.prize_id
      join public.members m on m.id = w.member_id
      where w.draw_id = d.id), '[]'::jsonb),
    'runners_up', coalesce((
      select jsonb_agg(jsonb_build_object(
               'position', r.position,
               'member_id', r.member_id,
               'member_name', m.full_name,
               'participation_id', r.participation_id)
             order by r.position)
      from public.draw_runners_up r
      join public.members m on m.id = r.member_id
      where r.draw_id = d.id), '[]'::jsonb))
  into v_draw
  from public.draws d
  where d.id = p_draw_id;

  return v_draw;
end;
$$;

comment on function public.get_draw(uuid) is
  'One draw with its winners and its runner-up queue, in one round trip. Gated on promotions.view and nothing else: whoever may see a draw may see who won it (owner''s ruling, 2026-08-02). This DOES make the function a second, narrow door onto audience data — it is SECURITY DEFINER, so a caller holding promotions.view without members.view reads names here that members_select_reachable (0035) would refuse them, limited to the winners and the runner-up queue of a draw they may already see. A null member_name means the listener has no name on record (members.full_name is nullable, 0031), never that the caller may not see it. Extended in 0088 with allows_return_to_stock, receipt_path and receipt_erased_at, which are what let the screen offer the right buttons rather than guess and be refused. The seed and the algorithm version are returned to everyone who may see the draw at all — a proof nobody can see is not a proof.';
