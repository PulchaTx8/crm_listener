-- Block 5b, D8. The conversation has to ask the entry question TWICE: once when
-- the hashtag arrives, so nobody answers five questions before being told they
-- had already used their chances, and once at the end, where the answer is
-- authoritative. The two can disagree if the listener enters by another route in
-- between, and the final write is the truth.
--
-- That second reader is why the rules move out of apply_participation and into a
-- function of their own. The alternative -- a pre-check that re-states "no two
-- entries closer together than N hours" in a second place -- is the defect this
-- schema has been returned for more than once: two copies of one rule drift, and
-- the one that drifts is always the copy nobody's test names. The rules now have
-- exactly one home, and apply_participation reads them from it.

create function public.participation_status_for(
  p_promotion_id uuid,
  p_member_id    uuid,
  p_when         timestamptz
)
returns public.participation_status
language sql
stable
set search_path = pg_catalog, public
as $$
  with promo as (
    select allow_multiple_entries, min_hours_between_entries, max_entries_per_member
    from public.promotions
    where id = p_promotion_id
  ),
  -- Only VALID entries count against any of the three rules. A DUPLICATE row is
  -- a record that somebody tried, not an entry, and counting it would make the
  -- second attempt bar the third.
  taken as (
    select participated_at
    from public.participations
    where promotion_id = p_promotion_id
      and member_id = p_member_id
      and status = 'VALID'
  )
  select case
    when not (select allow_multiple_entries from promo) and exists (select 1 from taken)
      then 'DUPLICATE'

    -- THE INTERVAL IS A WINDOW AROUND p_when, NOT A FLOOR UNDER IT, and the
    -- second bound is the one this rule shipped without in Block 4c.
    --
    -- The rule is "this person may not have two entries closer together than N
    -- hours", which is symmetric in time: |existing - p_when| < N. Written with
    -- the lower bound alone it read "is there a VALID entry LATER than N hours
    -- before this one" -- true of every entry after that instant, including ones
    -- arbitrarily far in the FUTURE of p_when. Measured with N = 6: an entry at
    -- 20:00Z, then one at 08:00Z the same day -- twelve hours EARLIER -- came
    -- back TOO_SOON, while the control twelve hours later came back VALID.
    --
    -- Silent and wrong in the direction that costs somebody a prize: the row is
    -- not VALID, so Block 6's draw leaves out a listener who was entitled to be
    -- in it, and nothing anywhere says so. It is reachable through the ordinary
    -- path -- import_participations walks a file in row order, and a spreadsheet
    -- exported newest-first marked every row after the first TOO_SOON.
    when (select min_hours_between_entries from promo) is not null and exists (
      select 1 from taken, promo
      where taken.participated_at
              > p_when - make_interval(hours => promo.min_hours_between_entries)
        and taken.participated_at
              < p_when + make_interval(hours => promo.min_hours_between_entries)
    ) then 'TOO_SOON'

    when (select max_entries_per_member from promo) is not null
     and (select count(*) from taken) >= (select max_entries_per_member from promo)
      then 'OVER_LIMIT'

    else 'VALID'
  end::public.participation_status;
$$;

-- PRIVATE, like every other core in this schema: SECURITY INVOKER, EXECUTE for
-- nobody, called only from inside a SECURITY DEFINER body that has already
-- checked its own permission.
revoke execute on function public.participation_status_for(uuid, uuid, timestamptz) from public;

comment on function public.participation_status_for(uuid, uuid, timestamptz) is
  'Which of the four statuses an entry by this listener, in this promotion, at this instant would get. The ONE home of the three rules -- repeat, minimum interval, ceiling -- read by apply_participation under its advisory lock, where the answer is authoritative, and by the conversation''s opening pre-check (Block 5b, D8), where it is advisory and may be overtaken by an entry made through another door. It answers about ENTRY FREQUENCY only: a promotion that is cancelled, deleted or outside its window is not a fact about the person and is refused by the caller with an exception, never given a status here (Block 4c''s ruling, which is also why there is no fifth status). A promotion id that names nothing returns VALID rather than raising, because every caller has already resolved the promotion before it gets here; it is not a validation door.';

-- apply_participation, now reading its rules from the function above rather than
-- carrying a second copy of them. Everything else is unchanged: the same
-- refusals in the same order, the same advisory lock over (promotion, member)
-- immediately before the decision, the same writes after it.
create or replace function public.apply_participation(
  p_promotion_id    uuid,
  p_member_id       uuid,
  p_participated_at timestamptz,
  p_source          public.participation_source,
  p_answers         jsonb default '[]'
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_multiple  boolean;
  v_cancelled timestamptz;
  v_deleted   timestamptz;
  v_starts    timestamptz;
  v_ends      timestamptz;
  v_status    public.participation_status;
  v_id        uuid;
  v_when      timestamptz := coalesce(p_participated_at, now());
  v_answer    jsonb;
begin
  select organization_id, company_id, allow_multiple_entries,
         cancelled_at, deleted_at, starts_at, ends_at
    into v_org, v_company, v_multiple,
         v_cancelled, v_deleted, v_starts, v_ends
  from public.promotions
  where id = p_promotion_id;

  if not found or v_deleted is not null then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is cancelled and is not taking entries'
      using errcode = '22023';
  end if;

  -- Refused rather than recorded with a status, and the distinction is the
  -- point: the four statuses are all about one person entering too often. A
  -- promotion that is not open is not a fact about the person, and inventing a
  -- fifth status for it would let the draw's "VALID only" filter go on looking
  -- complete while hiding a different kind of problem.
  if v_when < v_starts or v_when >= v_ends then
    raise exception 'this promotion was not taking entries at %', v_when
      using errcode = '22023';
  end if;

  -- The composite key on participations would refuse a listener this Station is
  -- not linked to anyway, but with a constraint name rather than the sentence a
  -- caller can act on -- the same reasoning apply_inventory_movement (0047)
  -- gives for its own sufficiency check.
  if not exists (
    select 1 from public.member_company_links
    where member_id = p_member_id and company_id = v_company
  ) then
    raise exception 'listener not found in this station: %', p_member_id using errcode = 'P0002';
  end if;

  -- N3. An advisory lock over the pair rather than a row lock, for two reasons
  -- the alternatives cannot answer. FOR UPDATE on the promotion would serialise
  -- every entry in it against every other -- tolerable for an operator typing
  -- one at a time and ruinous once the bot is receiving messages. Locking the
  -- participation rows for this pair locks nothing at all the first time
  -- somebody enters, which is precisely the case the rule governs; Block 4b hit
  -- the identical problem when archive_prize needed to lock a balance row that
  -- did not exist yet.
  --
  -- The cost, stated: the pair is hashed into a bigint, so two different pairs
  -- can collide and serialise against each other for no reason. That makes a
  -- collision slow, never wrong.
  --
  -- IT IS TAKEN BEFORE THE STATUS IS ASKED FOR, and that ordering is the whole
  -- mechanism: participation_status_for reads rows this transaction is about to
  -- add to, so two near-simultaneous entries evaluating the ceiling outside the
  -- lock would both see the count below it.
  perform pg_advisory_xact_lock(
    hashtextextended(p_promotion_id::text || ':' || p_member_id::text, 0));

  v_status := public.participation_status_for(p_promotion_id, p_member_id, v_when);

  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at, created_by)
  values
    (p_promotion_id, p_member_id, v_org, v_company, v_multiple,
     v_status, p_source, v_when, v_actor)
  returning id into v_id;

  -- The answers are stored whatever the status. What somebody said is a fact
  -- about the attempt; whether it counted is a different fact, and the status
  -- already carries that one. Block 5 wants the answer of a duplicate message
  -- for the same reason.
  for v_answer in select * from jsonb_array_elements(coalesce(p_answers, '[]'))
  loop
    insert into public.participation_answers
      (participation_id, promotion_id, question_id, kind, option_id, answer_text,
       organization_id, company_id)
    select v_id, p_promotion_id, q.id, q.kind,
           nullif(v_answer ->> 'option_id', '')::uuid,
           nullif(btrim(coalesce(v_answer ->> 'answer_text', '')), ''),
           v_org, v_company
    from public.promotion_questions q
    -- The promotion predicate is not decoration. Matching on the id alone FINDS
    -- a question that belongs to a different promotion, the insert then goes
    -- ahead, and participation_answers_question_fk (0052) refuses it with a bare
    -- 23503 and a constraint name -- which is exactly what this function's own
    -- comment promises a caller is spared.
    where q.id = (v_answer ->> 'question_id')::uuid
      and q.promotion_id = p_promotion_id;

    if not found then
      raise exception 'question not found in this promotion: %', v_answer ->> 'question_id'
        using errcode = 'P0002';
    end if;
  end loop;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'record_participation', 'participations', v_id, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'member_id', p_member_id,
                        'status', v_status, 'source', p_source));

  return jsonb_build_object('participation_id', v_id, 'status', v_status);
end;
$$;

revoke execute on function public.apply_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) from public;
