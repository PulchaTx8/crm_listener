-- Block 6a, Task 7: the two reads the screen makes.
--
-- Both are gated on promotions.view, because reading a draw is reading a
-- promotion. The four tables carry select policies saying the same thing
-- (0075), and these functions exist alongside them rather than instead of
-- them: the screen wants a draw and its winners and its queue in ONE round
-- trip with the counts already computed, and four PostgREST reads plus a
-- client-side join is not that.
--
-- THE NAMES ARE THE CAREFUL PART. A winner is a listener, and a listener's name
-- is audience data that members_select_reachable (0035) refuses to anybody
-- without members.view. These functions are SECURITY DEFINER and would hand it
-- over regardless, so they ask for that permission SEPARATELY and return null
-- names when it is absent. An operator who may draw but may not read the
-- audience sees the ranks, the deadlines, the seed and the queue -- everything
-- the draw itself is -- and no names. Block 3's gate is not something a
-- convenience read gets to spend.

create function public.list_draws(p_promotion_id uuid)
returns table (
  id                  uuid,
  drawn_at            timestamptz,
  status              public.draw_status,
  entry_count         integer,
  runner_up_count     integer,
  algorithm_version   integer,
  seed                text,
  winner_count        integer,
  cancelled_at        timestamptz,
  cancellation_reason text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
begin
  select p.company_id into v_company
  from public.promotions p
  where p.id = p_promotion_id and p.deleted_at is null;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.view', v_company) then
    raise log 'list_draws denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: promotions.view required' using errcode = '42501';
  end if;

  return query
  select d.id, d.drawn_at, d.status, d.entry_count, d.runner_up_count,
         d.algorithm_version, d.seed,
         (select count(*)::integer from public.winners w where w.draw_id = d.id),
         d.cancelled_at, d.cancellation_reason
  from public.draws d
  where d.promotion_id = p_promotion_id
  order by d.drawn_at desc;
end;
$$;

comment on function public.list_draws(uuid) is
  'Every draw of one promotion, newest first, with its winner count already computed. Gated on promotions.view: reading a draw is reading a promotion. Carries no listener at all — the names question does not arise on a list of draws, and get_draw is where it is answered.';

revoke execute on function public.list_draws(uuid) from public;
grant execute on function public.list_draws(uuid) to authenticated;

create function public.get_draw(p_draw_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_names   boolean;
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

  -- Asked once for the whole draw rather than per winner: the question is
  -- "may this caller read this Station's audience", which is a fact about the
  -- Station and not about each listener.
  v_names := public.has_permission('members.view', v_company);

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
    'shows_names', v_names,
    'winners', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id,
               'awarded_rank', w.awarded_rank,
               'member_id', w.member_id,
               'member_name', case when v_names then m.full_name else null end,
               'participation_id', w.participation_id,
               'promotion_prize_id', w.promotion_prize_id,
               'prize_name', pz.name,
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
               'member_name', case when v_names then m.full_name else null end,
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
  'One draw with its winners and its runner-up queue, in one round trip. Gated on promotions.view. Listener NAMES are returned only when the caller ALSO holds members.view, and the answer travels back as shows_names so the screen can say "not visible to you" rather than render a blank that looks like missing data: this function is SECURITY DEFINER and would otherwise hand audience data to a caller members_select_reachable (0035) refuses it to. The seed and the algorithm version are returned to everyone who may see the draw at all — a proof nobody can see is not a proof.';

revoke execute on function public.get_draw(uuid) from public;
grant execute on function public.get_draw(uuid) to authenticated;
