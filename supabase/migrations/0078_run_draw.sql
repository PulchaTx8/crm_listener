-- Block 6a, Task 4: running the draw.
--
-- The hat is frozen in the transaction that consumes the stock. It has to be:
-- participations keep arriving, and two draws that both read the same
-- available stock would both spend it. The FOR UPDATE on the promotion row is
-- the same shape link_prize_to_promotion (0049) uses, and it serialises every
-- draw and every link against one promotion.

-- ---------------------------------------------------------------------------
-- The private core. SECURITY INVOKER, EXECUTE granted to nobody: the
-- permission check lives beside the operation in run_draw, for the reason
-- apply_inventory_movement (0027) and apply_participation (0054) both give.
--
-- It assumes its caller already holds FOR UPDATE on the promotion and has
-- already refused a cancelled or archived one. That is not a courtesy: nothing
-- here re-reads those, so calling this without the lock would reintroduce
-- exactly the race the lock exists to close.

create function public.apply_draw(
  p_promotion_id    uuid,
  p_organization_id uuid,
  p_company_id      uuid,
  p_units           jsonb,
  p_runner_up_count integer
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_draw        uuid;
  v_seed        text;
  v_now         timestamptz := now();
  v_actor       uuid := auth.uid();
  v_promo_days  integer;
  v_units       jsonb;
  v_total       integer;
  v_hat         jsonb;
  v_walk        jsonb;
  v_entry_count integer;
  v_awarded     integer;
  v_short       uuid;
  r             record;
begin
  select p.pickup_deadline_days into v_promo_days
  from public.promotions p
  where p.id = p_promotion_id;

  -- 1. The units. Null or empty means every unit still available on every live
  --    link -- linked minus drawn, which is what D8 lets the operator take a
  --    slice of. Ordered by link id so the sequence is deterministic and a
  --    reproduction consumes the units in the same order.
  if p_units is null or jsonb_typeof(p_units) <> 'array' or jsonb_array_length(p_units) = 0 then
    select coalesce(jsonb_agg(
             jsonb_build_object('promotion_prize_id', l.id, 'quantity', b.linked - b.drawn)
             order by l.id), '[]'::jsonb)
      into v_units
    from public.promotion_prizes l
    join public.promotion_prize_balances b on b.promotion_prize_id = l.id
    where l.promotion_id = p_promotion_id
      and l.deleted_at is null
      and b.linked - b.drawn > 0;
  else
    v_units := p_units;
  end if;

  -- A link this promotion does not own, or a quantity it cannot cover. Named
  -- rather than left to the balance CHECK, which would answer with a
  -- constraint name instead of a sentence.
  select u.promotion_prize_id into v_short
  from jsonb_to_recordset(v_units) as u(promotion_prize_id uuid, quantity integer)
  left join public.promotion_prizes l
    on l.id = u.promotion_prize_id
   and l.promotion_id = p_promotion_id
   and l.deleted_at is null
  left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
  where l.id is null
     or u.quantity is null
     or u.quantity <= 0
     or coalesce(b.linked, 0) - coalesce(b.drawn, 0) < u.quantity
  limit 1;

  if found then
    raise exception 'this promotion does not have that many units still to draw: link %', v_short
      using errcode = '22023';
  end if;

  select coalesce(sum(u.quantity), 0) into v_total
  from jsonb_to_recordset(v_units) as u(promotion_prize_id uuid, quantity integer);

  if v_total <= 0 then
    raise exception 'this promotion has no units left to draw' using errcode = '22023';
  end if;

  -- 2. The hat, read ONCE into a value. Counting it and then re-reading it to
  --    insert would be two reads of a table other transactions are still
  --    writing to, and entry_count would then be a claim about a hat that is
  --    not the one in draw_entries.
  select coalesce(jsonb_agg(
           jsonb_build_object('participation_id', e.participation_id, 'member_id', e.member_id)
           order by e.participated_at, e.participation_id), '[]'::jsonb)
    into v_hat
  from public.draw_eligible_participations(p_promotion_id) e;

  v_entry_count := jsonb_array_length(v_hat);

  -- Nothing happened, and a row saying it did is worse than none (spec 7).
  if v_entry_count = 0 then
    raise exception 'nobody is eligible for this draw' using errcode = '22023';
  end if;

  -- 3. The draw. The seed is two gen_random_uuid() values with their hyphens
  --    stripped: 64 hex characters, CSPRNG-backed, no extension required, and
  --    generated HERE rather than accepted as an argument (D3).
  v_seed := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.draws
    (promotion_id, organization_id, company_id, seed, algorithm_version,
     runner_up_count, entry_count, drawn_at, drawn_by)
  values
    (p_promotion_id, p_organization_id, p_company_id, v_seed, 1,
     p_runner_up_count, v_entry_count, v_now, v_actor)
  returning id into v_draw;

  insert into public.draw_entries (draw_id, company_id, participation_id, member_id, position)
  select v_draw, p_company_id,
         (h.e->>'participation_id')::uuid, (h.e->>'member_id')::uuid, h.ord
  from jsonb_array_elements(v_hat) with ordinality as h(e, ord);

  -- 4. The order, and the walk (spec 4.1 steps 3, 4, 6).
  --
  --    sha256(seed || ':' || participation_id) ascending as BYTES, ties broken
  --    by the frozen position. src/lib/draw/algorithm.ts is the same rule
  --    written a second time, and tests/isolation/draw.test.ts is what holds
  --    the two together.
  --
  --    DISTINCT ON (member_id) is the skip: the first time a listener appears
  --    in rank order is their best entry, and every later entry of theirs is
  --    exactly what the sequential walk would step over. One pass instead of a
  --    loop, and "one person, one prize" (D2) falls out of it.
  select coalesce(jsonb_agg(
           jsonb_build_object('participation_id', b.participation_id, 'member_id', b.member_id)
           order by b.rank_value, b.position), '[]'::jsonb)
    into v_walk
  from (
    select distinct on (e.member_id)
           e.participation_id,
           e.member_id,
           e.position,
           sha256(convert_to(v_seed || ':' || e.participation_id::text, 'UTF8')) as rank_value
    from public.draw_entries e
    where e.draw_id = v_draw
    order by e.member_id, rank_value, e.position
  ) b;

  -- 5. The winners. awarded_rank is the unit's position in the ordered unit
  --    sequence (spec 4.1 step 5), and the deadline is frozen now (D5):
  --    the promotion's days override the prize's, and null on both means the
  --    winner has no deadline at all.
  insert into public.winners
    (draw_id, company_id, promotion_prize_id, member_id, participation_id, awarded_rank, deadline_at)
  select
    v_draw,
    p_company_id,
    s.promotion_prize_id,
    (wk.e->>'member_id')::uuid,
    (wk.e->>'participation_id')::uuid,
    s.rank,
    case
      when coalesce(v_promo_days, pz.default_pickup_deadline_days) is null then null
      else v_now + make_interval(days => coalesce(v_promo_days, pz.default_pickup_deadline_days))
    end
  from (
    select u.promotion_prize_id,
           row_number() over (order by u.promotion_prize_id, g.n) as rank
    from jsonb_to_recordset(v_units) as u(promotion_prize_id uuid, quantity integer)
    cross join lateral generate_series(1, u.quantity) as g(n)
  ) s
  join jsonb_array_elements(v_walk) with ordinality as wk(e, ord) on wk.ord = s.rank
  join public.promotion_prizes l on l.id = s.promotion_prize_id
  join public.prizes pz on pz.id = l.prize_id;

  get diagnostics v_awarded = row_count;

  -- 6. The runners-up: the SAME walk, continued. Not a second draw -- with one
  --    prize per person in force, a per-prize queue would cross the winners
  --    and seat the same listener twice (D4).
  insert into public.draw_runners_up (draw_id, company_id, position, member_id, participation_id)
  select v_draw, p_company_id, (wk.ord - v_awarded)::integer,
         (wk.e->>'member_id')::uuid, (wk.e->>'participation_id')::uuid
  from jsonb_array_elements(v_walk) with ordinality as wk(e, ord)
  where wk.ord > v_awarded
    and wk.ord <= v_awarded + p_runner_up_count;

  -- 7. The stock, one unit at a time, through the ledger's single writer. The
  --    idempotency key is the draw and the rank, which is unique by
  --    construction and replays safely if this transaction is retried.
  for r in
    select w.awarded_rank, w.promotion_prize_id, l.prize_id
    from public.winners w
    join public.promotion_prizes l on l.id = w.promotion_prize_id
    where w.draw_id = v_draw
    order by w.awarded_rank
  loop
    perform public.apply_inventory_movement(
      p_company_id, r.prize_id,
      'DRAW'::public.inventory_movement_type, 1,
      'linked'::public.inventory_bucket, 'awaiting_pickup'::public.inventory_bucket,
      null, v_draw::text || ':' || r.awarded_rank::text, r.promotion_prize_id);
  end loop;

  return v_draw;
end;
$$;

comment on function public.apply_draw(uuid, uuid, uuid, jsonb, integer) is
  'The draw mechanics: resolve the units, freeze the hat, rank it by sha256(seed || '':'' || participation_id), walk it once skipping anybody already awarded, write the winners and the runner-up queue, and move one unit per winner through apply_inventory_movement. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from run_draw, which checks draws.execute beside its own operation. ASSUMES its caller already holds FOR UPDATE on the promotion and has already refused a cancelled or archived one -- nothing here re-reads either, so calling it without the lock reopens the race the lock exists to close. The hat is read into a value ONCE rather than counted and re-read, so entry_count is a claim about the same list draw_entries holds.';

revoke execute on function public.apply_draw(uuid, uuid, uuid, jsonb, integer) from public;

-- ---------------------------------------------------------------------------
-- The door.

create function public.run_draw(
  p_promotion_id    uuid,
  p_units           jsonb default null,
  p_runner_up_count integer default 3
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_deleted   timestamptz;
  v_draw      uuid;
begin
  -- FOR UPDATE before anything is read or decided, the shape 0049 uses. Two
  -- draws racing would otherwise both read the same linked - drawn and each
  -- spend units the other has already taken.
  select organization_id, company_id, cancelled_at, deleted_at
    into v_org, v_company, v_cancelled, v_deleted
  from public.promotions
  where id = p_promotion_id
    for update;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('draws.execute', v_company) then
    raise log 'run_draw denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: draws.execute required' using errcode = '42501';
  end if;

  -- A draw over a cancelled promotion would award prizes for something that is
  -- not happening. The design spec was silent about this; the same two
  -- refusals apply_participation (0054) makes, with the same two codes.
  if v_cancelled is not null then
    raise exception 'this promotion is cancelled and cannot be drawn' using errcode = '22023';
  end if;

  if p_runner_up_count is null or p_runner_up_count < 0 then
    raise exception 'the number of runners-up cannot be negative' using errcode = '22023';
  end if;

  v_draw := public.apply_draw(p_promotion_id, v_org, v_company, p_units, p_runner_up_count);

  -- Ids and counts. No member id and no name: Block 3's rule, absolute.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'run_draw', 'draws', v_draw, v_org, v_company,
     jsonb_build_object(
       'draw_id', v_draw,
       'promotion_id', p_promotion_id,
       'algorithm_version', (select algorithm_version from public.draws where id = v_draw),
       'entry_count', (select entry_count from public.draws where id = v_draw),
       'winner_count', (select count(*) from public.winners where draw_id = v_draw),
       'runner_up_count', (select count(*) from public.draw_runners_up where draw_id = v_draw)));

  return v_draw;
end;
$$;

comment on function public.run_draw(uuid, jsonb, integer) is
  'Runs a draw of one promotion and returns its id. Takes FOR UPDATE on the promotion first (the shape link_prize_to_promotion, 0049, established), then checks draws.execute, then refuses a cancelled promotion (22023) or an archived one (P0002) -- the same two codes apply_participation (0054) answers with, rather than a third dialect. p_units is [{"promotion_prize_id": ..., "quantity": N}]; null or empty means every unit still available on every live link, which is linked - drawn (D8). The audit row carries ids and counts and no listener.';

revoke execute on function public.run_draw(uuid, jsonb, integer) from public;
grant execute on function public.run_draw(uuid, jsonb, integer) to authenticated;
