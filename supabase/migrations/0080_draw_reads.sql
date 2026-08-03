-- Block 6a, Task 7: the two reads the screen makes.
--
-- Both are gated on promotions.view, because reading a draw is reading a
-- promotion. The four tables carry select policies saying the same thing
-- (0075), and these functions exist alongside them rather than instead of
-- them: the screen wants a draw and its winners in ONE round
-- trip with the counts already computed, and four PostgREST reads plus a
-- client-side join is not that.
--
-- THE NAMES, AND WHAT RETURNING THEM COSTS. Owner's ruling, 2026-08-02:
-- whoever may see a draw may see who won it. get_draw returns the winners'
-- names to any caller holding promotions.view, and asks nothing further.
--
-- The consequence, written down rather than left to be discovered: this makes
-- get_draw a SECOND door onto audience data. members_select_reachable (0035)
-- refuses a listener's name to a caller without members.view, and this function
-- is SECURITY DEFINER, so it hands over what that policy would have withheld.
-- The door is narrow -- only the winners of a draw the caller may already
-- see, never the audience at large, never a phone number or
-- an e-mail or a note -- but it is a door, and "promotions.view implies the
-- names of a few listeners" is now true where it was not before.
--
-- The first version of this file did the opposite: it asked for members.view
-- separately and returned null names without it. That was the implementer's
-- reading of Block 3's gate, not a decision anybody had made, and the owner
-- reversed it. This comment replaces the one arguing the other way rather than
-- sitting beside it.

create function public.list_draws(p_promotion_id uuid)
returns table (
  id                  uuid,
  drawn_at            timestamptz,
  status              public.draw_status,
  entry_count         integer,
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
  select d.id, d.drawn_at, d.status, d.entry_count,
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
               'deadline_at', w.deadline_at,
               'status', w.status)
             order by w.awarded_rank)
      from public.winners w
      join public.promotion_prizes l on l.id = w.promotion_prize_id
      join public.prizes pz on pz.id = l.prize_id
      join public.members m on m.id = w.member_id
      where w.draw_id = d.id), '[]'::jsonb))
  into v_draw
  from public.draws d
  where d.id = p_draw_id;

  return v_draw;
end;
$$;

comment on function public.get_draw(uuid) is
  'One draw with its winners, in one round trip. Gated on promotions.view and nothing else: whoever may see a draw may see who won it (owner''s ruling, 2026-08-02). This DOES make the function a second, narrow door onto audience data — it is SECURITY DEFINER, so a caller holding promotions.view without members.view reads names here that members_select_reachable (0035) would refuse them, limited to the winners of a draw they may already see. A null member_name means the listener has no name on record (members.full_name is nullable, 0031), never that the caller may not see it. The seed and the algorithm version are returned to everyone who may see the draw at all — a proof nobody can see is not a proof.';

revoke execute on function public.get_draw(uuid) from public;
grant execute on function public.get_draw(uuid) to authenticated;
