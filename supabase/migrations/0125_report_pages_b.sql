-- supabase/migrations/0125_report_pages_b.sql

-- Block 8b, Task 6: the remaining three page functions.
--
-- Same contract as 0124, same reasons. Each mirrors the list RPC of its screen
-- and carries EVERY permission term that RPC carries -- which for two of the
-- three means a domain code gating the listing and members.view gating the
-- listener identity inside it, and for the third means one code and no identity
-- at all.

-- ---------------------------------------------------------------------------
-- 1. Winners and deliveries. Mirrors list_pickups (0095): promotions.view gates
-- it, members.view carries the identity.
--
-- The deadline is the column this report exists for, so met_deadline ships
-- computed rather than left to a spreadsheet formula -- and it is computed HERE
-- rather than in Node because the comparison is against now() on the database's
-- clock, which is the clock every other deadline in this system is judged by
-- (0094, 0112).
--
-- THREE-VALUED ON PURPOSE. Null is not "no": null means the question does not
-- yet have an answer -- no deadline was set, or the deadline has not passed and
-- the prize has not been collected. Collapsing that to false would print a
-- column of "missed" beside prizes nobody is late for.
-- ---------------------------------------------------------------------------

create function public.report_page_winners(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_promotion uuid        := nullif(p_filters ->> 'promotion_id', '')::uuid;
  v_status    text        := nullif(p_filters ->> 'status', '');
  v_names     boolean := true;
  v_withheld  text[]  := '{}';
  v_company   uuid;
  v_now       timestamptz := now();
begin
  perform public.report_guard(p_user_id, p_company_ids, 'promotions.view');

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;
  if not v_names then
    v_withheld := array['name', 'phone'];
  end if;

  return query
  with matched as (
    select
      w.created_at as k_at,
      w.id         as k_id,
      c.name  as company_name,
      pr.name as promotion_name,
      pz.name as prize_name,
      w.awarded_rank, w.status, w.deadline_at,
      m.full_name, m.phone
    from public.winners w
    join public.draws d on d.id = w.draw_id
    join public.companies c on c.id = w.company_id
    join public.promotion_prizes pp
      on pp.id = w.promotion_prize_id and pp.company_id = w.company_id
    join public.promotions pr
      on pr.id = pp.promotion_id and pr.company_id = w.company_id
    join public.prizes pz on pz.id = pp.prize_id
    join public.members m on m.id = w.member_id
    where w.company_id = any(p_company_ids)
      -- 0097: a cancelled draw awards nothing, so its winners are not winners.
      -- 8a's D12 states the same rule for the panels, and it matters more here,
      -- because a file is believed over a screen.
      and d.status <> 'CANCELLED'
      -- 0044's rule, through 0044's helper's explicit-identity sibling.
      and (pr.deleted_at is null
           or public.is_owner_of_company_for(p_user_id, pr.company_id))
      and (v_from      is null or w.created_at >= v_from)
      and (v_to        is null or w.created_at <  v_to)
      and (v_promotion is null or pr.id = v_promotion)
      and (v_status    is null or w.status::text = v_status)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'winner_id',   mt.k_id,
      'station',     mt.company_name,
      'promotion',   mt.promotion_name,
      'prize',       mt.prize_name,
      'rank',        mt.awarded_rank,
      'status',      mt.status,
      'deadline_at', mt.deadline_at,
      'drawn_at',    mt.k_at,
      'met_deadline', case
        when mt.deadline_at is null   then null
        when mt.status = 'DELIVERED'  then true
        when v_now > mt.deadline_at   then false
        else null
      end
    )
    || case when v_names then jsonb_build_object('name', mt.full_name, 'phone', mt.phone)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the winners-and-deliveries export, mirroring list_pickups (0095). promotions.view gates the listing; members.view carries the listener identity, withheld by absence otherwise. A cancelled draw''s winners appear nowhere (0097), the rule 8a''s D12 applies to the panels. met_deadline is three-valued on purpose: null means the question has no answer yet -- no deadline set, or not yet passed and not yet collected -- and collapsing it to false would print "missed" beside prizes nobody is late for.';

-- ---------------------------------------------------------------------------
-- 2. Music requests. Mirrors list_music_requests (0107): music.view gates it,
-- members.view carries the identity. An archived song's title is RETURNED with
-- song_archived true rather than hidden, for 0107's reason: archive_song is
-- deliberately never refused over a live request naming it, so such rows exist
-- and would otherwise be illegible.
-- ---------------------------------------------------------------------------

create function public.report_page_music_requests(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from     timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to       timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_song     uuid        := nullif(p_filters ->> 'song_id', '')::uuid;
  v_show     uuid        := nullif(p_filters ->> 'show_id', '')::uuid;
  v_channel  text        := nullif(p_filters ->> 'channel', '');
  v_names    boolean := true;
  v_withheld text[]  := '{}';
  v_company  uuid;
begin
  perform public.report_guard(p_user_id, p_company_ids, 'music.view');

  foreach v_company in array p_company_ids loop
    if not public.has_permission_for(p_user_id, 'members.view', v_company) then
      v_names := false;
    end if;
  end loop;
  if not v_names then
    v_withheld := array['name', 'phone'];
  end if;

  return query
  with matched as (
    select
      r.requested_at as k_at,
      r.id           as k_id,
      c.name  as company_name,
      s.title as song_title,
      (s.deleted_at is not null) as song_archived,
      a.name  as artist_name,
      sh.name as show_name,
      r.channel,
      m.full_name, m.phone
    from public.music_requests r
    join public.companies c on c.id = r.company_id
    left join public.songs s on s.id = r.song_id
    left join public.artists a on a.id = s.artist_id
    left join public.shows sh on sh.id = r.show_id
    left join public.members m on m.id = r.member_id
    where r.company_id = any(p_company_ids)
      and r.deleted_at is null
      and (v_from    is null or r.requested_at >= v_from)
      and (v_to      is null or r.requested_at <  v_to)
      and (v_song    is null or r.song_id = v_song)
      and (v_show    is null or r.show_id = v_show)
      and (v_channel is null or r.channel::text = v_channel)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',       mt.company_name,
      'song',          mt.song_title,
      'song_archived', mt.song_archived,
      'artist',        mt.artist_name,
      'show',          mt.show_name,
      'channel',       mt.channel,
      'requested_at',  mt.k_at
    )
    || case when v_names then jsonb_build_object('name', mt.full_name, 'phone', mt.phone)
       else '{}'::jsonb end,
    counted.n,
    v_withheld
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the music-requests export, mirroring list_music_requests (0107). music.view gates it; members.view carries the requester identity. An archived song ships with song_archived true rather than being hidden, for 0107''s reason: archive_song is never refused over a live request naming it, so such rows exist and would otherwise be illegible.';

-- ---------------------------------------------------------------------------
-- 3. Inventory movements. Mirrors list_movements (0096): inventory.view alone.
--
-- NO SECOND PERMISSION, and 0096 says why explicitly: promotions.view buys
-- nothing here, because promotion_name is returned to inventory.view alone. But
-- the ARCHIVAL rule still applies to the name, through 0044's helper, exactly
-- as 0096 applies it.
--
-- THE ACTOR IS TWO COLUMNS, NOT ONE, and this is 0096's hardest-won detail.
-- actor_name is public.profiles.full_name -- nullable in production -- so a
-- null there does NOT mean "the clock did it": it can equally be a real
-- operator with no display name. actor_id is what tells them apart, and it
-- ships on the same row for that reason. A coalesce onto the profile's e-mail
-- was written into 0096 once and removed in review; it is not reintroduced
-- here.
--
-- No listener identity anywhere in this report, so there is no withheld set.
-- ---------------------------------------------------------------------------

create function public.report_page_movements(
  p_user_id     uuid,
  p_company_ids uuid[],
  p_filters     jsonb,
  p_cursor_at   timestamptz,
  p_cursor_id   uuid,
  p_limit       integer
)
returns table (
  sort_at     timestamptz,
  sort_id     uuid,
  row_data    jsonb,
  total_count bigint,
  withheld    text[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from      timestamptz := nullif(p_filters ->> 'from', '')::timestamptz;
  v_to        timestamptz := nullif(p_filters ->> 'to', '')::timestamptz;
  v_prize     uuid        := nullif(p_filters ->> 'prize_id', '')::uuid;
  v_promotion uuid        := nullif(p_filters ->> 'promotion_id', '')::uuid;
  v_type      text        := nullif(p_filters ->> 'movement_type', '');
begin
  perform public.report_guard(p_user_id, p_company_ids, 'inventory.view');

  return query
  with matched as (
    select
      im.created_at as k_at,
      im.id         as k_id,
      c.name  as company_name,
      pz.name as prize_name,
      im.movement_type, im.quantity, im.from_bucket, im.to_bucket, im.note,
      im.actor_id,
      pf.full_name as actor_name,
      case
        when pp.promotion_id is null then null
        when pr.deleted_at is null
          or public.is_owner_of_company_for(p_user_id, pr.company_id) then pr.name
        else null
      end as promotion_name,
      -- False, never null, when there is no promotion at all: this column
      -- answers "is the null beside it the archival null", and a movement
      -- naming no promotion has no such null to explain (0096's wording).
      (pp.promotion_id is not null and pr.deleted_at is not null) as promotion_archived
    from public.inventory_movements im
    join public.companies c on c.id = im.company_id
    join public.prizes pz on pz.id = im.prize_id
    left join public.promotion_prizes pp
      on pp.id = im.promotion_prize_id and pp.company_id = im.company_id
    left join public.promotions pr
      on pr.id = pp.promotion_id and pr.company_id = im.company_id
    left join public.profiles pf on pf.id = im.actor_id
    where im.company_id = any(p_company_ids)
      and (v_from      is null or im.created_at >= v_from)
      and (v_to        is null or im.created_at <  v_to)
      and (v_prize     is null or im.prize_id = v_prize)
      and (v_promotion is null or pp.promotion_id = v_promotion)
      and (v_type      is null or im.movement_type::text = v_type)
  ),
  counted as (select count(*) as n from matched)
  select
    mt.k_at,
    mt.k_id,
    jsonb_build_object(
      'station',            mt.company_name,
      'moved_at',           mt.k_at,
      'prize',              mt.prize_name,
      'promotion',          mt.promotion_name,
      'promotion_archived', mt.promotion_archived,
      'movement_type',      mt.movement_type,
      'quantity',           mt.quantity,
      'from_bucket',        mt.from_bucket,
      'to_bucket',          mt.to_bucket,
      'actor_id',           mt.actor_id,
      'actor',              mt.actor_name,
      'note',               mt.note
    ),
    counted.n,
    '{}'::text[]
  from matched mt, counted
  where p_cursor_at is null
     or (mt.k_at, mt.k_id) < (p_cursor_at, p_cursor_id)
  order by mt.k_at desc, mt.k_id desc
  limit p_limit;
end;
$$;

comment on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) is
  'One keyset page of the inventory-movements export, mirroring list_movements (0096). inventory.view alone gates it -- 0096 explains why promotions.view buys nothing here -- and there is no withheld set, because a movement carries no listener identity. The actor ships as TWO columns: actor_name is profiles.full_name and is nullable, so a null there does not mean "the clock did it"; actor_id is what tells a clock-made movement (0094, no auth.uid()) from a human with no display name.';

revoke execute on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
revoke execute on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) from public;
grant execute on function public.report_page_winners(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_music_requests(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
grant execute on function public.report_page_movements(uuid, uuid[], jsonb, timestamptz, uuid, integer) to authenticated, service_role;
