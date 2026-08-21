-- supabase/migrations/0269_promotion_show_schedule.sql

-- Block 30e, item 18. A promotion's Programme schedule, read by a caller who
-- administers Promotions.
--
-- WHY THIS EXISTS AT ALL. `shows` and `show_schedules` each carry exactly one
-- select policy, and both are gated on `music.view` (0099, 0175). The
-- Participations screen needs a Programme's bands to offer the window item 18
-- describes, and the operator who works that screen need not hold anything in
-- the Music section. Left to RLS the band combo would be permanently EMPTY for
-- exactly those operators -- and an empty combo does not say "you may not see
-- this", it says "this Programme never airs". A filter that silently answers
-- nothing is worse than one that refuses.
--
-- Block 30c met the identical mismatch on the Programme combobox of a
-- promotion's own record (listShowOptions), where it reads as an empty list
-- rather than as a broken link. This is its third recorded surface, and
-- docs/PERMISSIONS.md carries why the gate itself is not being moved: a
-- shows.view/shows.manage pair is a permissions migration, the roles screen,
-- every seeded role and EVERY ROLE A CUSTOMER HAS ALREADY CONFIGURED, none of
-- which would grant it.
--
-- SECURITY DEFINER, so it must re-check by hand what RLS would have checked. It
-- checks `participations.view` at the promotion's own Station: this is a read in
-- service of that screen, and it grants nothing else in Music.
--
-- IT RETURNS ROWS, NOT A WINDOW. Rejoining a band from its rows and turning a
-- wall-clock into an instant are both already written and already tested on the
-- other side (`toBands` in src/lib/shows/bands.ts, `fromZonedWallClock` in
-- src/app/(app)/promotions/zone.ts), and Block 30e's week grid draws from that
-- same rejoining. A second implementation here would be a second thing to keep
-- in step with save_show, which is the writer both would have to agree with.

create function public.promotion_show_schedule(p_promotion_id uuid)
returns table (
  show_id   uuid,
  show_name text,
  band      smallint,
  weekday   smallint,
  starts_at time,
  ends_at   time
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_show    uuid;
begin
  select p.company_id, p.show_id
    into v_company, v_show
    from public.promotions p
   where p.id = p_promotion_id
     and p.deleted_at is null;

  -- No such promotion: nothing to say, and nothing said about whether it exists
  -- somewhere this caller cannot reach.
  if v_company is null then
    return;
  end if;

  if not public.has_permission('participations.view', v_company) then
    raise exception 'participations.view is required to read this promotion''s programme'
      using errcode = '42501';
  end if;

  -- A promotion with no Programme is the ordinary case, and it is NOT the same
  -- answer as the refusal above: the screen keeps its two date filters and never
  -- mentions a Programme at all.
  if v_show is null then
    return;
  end if;

  -- ARCHIVED PROGRAMMES INCLUDED, deliberately. 0258's own comment on
  -- promotions.show_id says the link survives archiving "so that a promotion
  -- which ran inside a Programme still says so and Block 30e can still read that
  -- Programme's schedule". Filtering deleted_at here would break that promise for
  -- exactly the promotions most likely to be looked back at.
  --
  -- The company_id in the join is belt and braces over a composite FK that
  -- already makes a cross-Station Programme impossible to store (0258): it costs
  -- nothing and it means this body does not depend on that constraint staying.
  return query
    select s.id, s.name, sc.band, sc.weekday, sc.starts_at, sc.ends_at
      from public.shows s
      join public.show_schedules sc on sc.show_id = s.id
     where s.id = v_show
       and s.company_id = v_company
     order by sc.band, sc.weekday, sc.starts_at;
end;
$$;

comment on function public.promotion_show_schedule(uuid) is
  'Block 30e, item 18. The weekly schedule of the Programme a promotion belongs to, for a caller holding participations.view at that promotion''s Station. SECURITY DEFINER because shows and show_schedules are gated on music.view, which the Participations operator need not hold; without this door the band combo would be permanently empty for them, which reads as "this Programme never airs" rather than as a permission they lack. Returns no rows for a promotion that does not exist and for one with no Programme -- two ordinary answers -- and raises 42501 for a caller without the permission, so that "may not" and "does not air" never look alike. Archived Programmes are included, because promotions.show_id outlives the archive by design (0258). It returns ROWS rather than a window: toBands and fromZonedWallClock already rejoin bands and convert wall-clock to instants on the other side.';

revoke execute on function public.promotion_show_schedule(uuid) from public;
grant execute on function public.promotion_show_schedule(uuid) to authenticated;
