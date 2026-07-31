-- supabase/migrations/0054_participation_rpcs.sql
--
-- Each function checks its own permission beside the operation rather than
-- inside a shared helper, for the reason 0027's own comment gives: a reader
-- looking for "who may do this" finds it next to the thing being done.

-- ---------------------------------------------------------------------------
-- Resolution, shared by both doors so they cannot drift. SECURITY INVOKER and
-- granted to authenticated: it holds no privileges of its own because both
-- functions it calls are SECURITY DEFINER and re-check the caller against
-- auth.uid() themselves. Making it DEFINER would grant it rights it never uses.
--
-- find_member_by_identifier answers one of three things and all three have a
-- destination here. `elsewhere` means an identifier matches somebody this
-- caller may not reach: it deliberately returns no id, and registering anyway
-- is impossible because 0031's per-Organization unique indexes on phone,
-- e-mail, CPF and passport would refuse the duplicate. That outcome is passed
-- back for the caller to report, which for the import means a skipped row.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_or_create_member(
  p_company_id      uuid,
  p_full_name       text,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_cpf_last_digits text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_found   jsonb;
  v_id      uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  v_found := public.find_member_by_identifier(
    v_org, p_phone, p_email, p_cpf_hash, p_passport);

  if v_found ->> 'outcome' = 'visible' then
    return jsonb_build_object(
      'outcome', 'resolved', 'member_id', (v_found ->> 'member_id')::uuid);
  end if;

  if v_found ->> 'outcome' = 'elsewhere' then
    return jsonb_build_object('outcome', 'elsewhere');
  end if;

  v_id := public.create_member(
    p_company_id, p_full_name, p_phone, p_email,
    p_cpf_hash, p_cpf_last_digits, p_passport);

  return jsonb_build_object('outcome', 'created', 'member_id', v_id);
end;
$$;

revoke execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) from public;
grant execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) to authenticated;

comment on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) is
  'Finds a listener through Block 3''s deduplication or registers one, and is the single resolution path both the manual form and the import use — one rule with two entrances is the shape Block 4b was sent back to fix twice. SECURITY INVOKER: find_member_by_identifier (0033) gates on members.view across the Organization and create_member (0034) on members.create, both against auth.uid(), so this function needs no privileges of its own. Returns resolved, created, or elsewhere — the last meaning an identifier matches a listener this caller may not reach, which is not an error and not a registration: 0031''s unique indexes would refuse the duplicate, so the caller reports it and moves on.';

-- ---------------------------------------------------------------------------
-- One place where the participation mechanics live: the repetition rules, the
-- lock they are decided under, the row, its answers and the audit entry. The
-- permission check deliberately stays OUT of here and in each public function,
-- for the reason apply_inventory_movement's own comment gives (0027) — a reader
-- looking for "who may do this" finds it beside the operation rather than
-- inside a shared helper.
--
-- Two doors reach these mechanics and they do not hold the same code:
-- record_participation is participations.create, import_participations is
-- participations.import (plus members.create, D10). An earlier draft of this
-- file kept one function and picked the code from p_source, which put the gate
-- inside the shared body and let a caller-supplied label choose which
-- permission was checked. Extracted here instead: the source goes back to being
-- what it is, a note of how the row arrived, and it decides nothing about who
-- may write it.
--
-- This function holds EXECUTE for nobody. It is SECURITY INVOKER: it is only
-- ever called from inside a SECURITY DEFINER body, where it already runs with
-- the definer's privileges. Making it DEFINER too would let a future GRANT turn
-- it into an unchecked write path — the one that skips both gates above.
-- ---------------------------------------------------------------------------
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
  v_min_hours integer;
  v_ceiling   integer;
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
         min_hours_between_entries, max_entries_per_member,
         cancelled_at, deleted_at, starts_at, ends_at
    into v_org, v_company, v_multiple,
         v_min_hours, v_ceiling,
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
  -- caller can act on — the same reasoning apply_inventory_movement (0047)
  -- gives for its own sufficiency check.
  if not exists (
    select 1 from public.member_company_links
    where member_id = p_member_id and company_id = v_company
  ) then
    raise exception 'listener not found in this station: %', p_member_id using errcode = 'P0002';
  end if;

  -- N3. An advisory lock over the pair rather than a row lock, for two reasons
  -- the alternatives cannot answer. FOR UPDATE on the promotion would serialise
  -- every entry in it against every other — tolerable for an operator typing
  -- one at a time and ruinous once Block 5's bot is receiving messages. Locking
  -- the participation rows for this pair locks nothing at all the first time
  -- somebody enters, which is precisely the case the rule governs; Block 4b hit
  -- the identical problem when archive_prize needed to lock a balance row that
  -- did not exist yet.
  --
  -- The cost, stated: the pair is hashed into a bigint, so two different pairs
  -- can collide and serialise against each other for no reason. That makes a
  -- collision slow, never wrong.
  perform pg_advisory_xact_lock(
    hashtextextended(p_promotion_id::text || ':' || p_member_id::text, 0));

  if not v_multiple and exists (
    select 1 from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
  ) then
    v_status := 'DUPLICATE';
  elsif v_min_hours is not null and exists (
    select 1 from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
      and participated_at > v_when - make_interval(hours => v_min_hours)
  ) then
    v_status := 'TOO_SOON';
  elsif v_ceiling is not null and (
    select count(*) from public.participations
    where promotion_id = p_promotion_id and member_id = p_member_id
      and status = 'VALID'
  ) >= v_ceiling then
    v_status := 'OVER_LIMIT';
  else
    v_status := 'VALID';
  end if;

  insert into public.participations
    (promotion_id, member_id, organization_id, company_id, allows_multiple,
     status, source, participated_at, created_by)
  values
    (p_promotion_id, p_member_id, v_org, v_company, v_multiple,
     v_status, p_source, v_when, v_actor)
  returning id into v_id;

  -- The answers are stored whatever the status. What somebody said is a fact
  -- about the attempt; whether it counted is a different fact, and the status
  -- already carries that one. Block 5 will want the answer of a duplicate
  -- message for the same reason.
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
    -- 23503 and a constraint name — which is exactly what this function's own
    -- comment promises a caller is spared. The composite key still holds the
    -- floor structurally, whether or not this predicate is here; what the
    -- predicate does is turn the refusal into a sentence naming the question,
    -- the same reasoning link_prize_to_promotion (0049) gives for its own
    -- sufficiency check against a prize from another Station.
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

-- EXECUTE for nobody, and no grant follows this line. Reachable only from
-- inside the two SECURITY DEFINER bodies below, each of which has already
-- checked its own permission.
revoke execute on function public.apply_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) from public;

comment on function public.apply_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) is
  'The participation mechanics, shared by the manual door and the import so the two cannot drift. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from record_participation and import_participations, which check participations.create and participations.import respectively — the permission check stays out of here for the reason apply_inventory_movement (0027) gives, and because a gate inside a shared body would have to pick its code from p_source, letting a caller-supplied label choose which permission it faced. Repeating, coming in early and passing the ceiling are NOT refusals — they are written down with the status that says so, because Block 5 will have no choice about recording what happened to a message it received. A cancelled promotion, one outside its window, a listener this Station is not linked to and an answer naming a question from another promotion ARE refusals, because none of them is a fact about how often this person entered. The rules are applied under pg_advisory_xact_lock over (promotion, member); the partial unique index on participations (0052) holds the same floor whether or not this function took it, which is what makes the concurrency test meaningful rather than circular.';

-- ---------------------------------------------------------------------------
-- The manual door. It resolves the promotion only far enough to know which
-- Station to ask about, checks its own permission beside its own operation, and
-- hands the work to the shared body. The promotion is read twice — once here
-- for the company, once inside apply_participation for the rules — and that is
-- one extra primary-key lookup against having the gate somewhere a reader has
-- to go looking for it.
-- ---------------------------------------------------------------------------
create or replace function public.record_participation(
  p_promotion_id    uuid,
  p_member_id       uuid,
  p_participated_at timestamptz,
  p_source          public.participation_source,
  p_answers         jsonb default '[]'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
begin
  select company_id into v_company
  from public.promotions
  where id = p_promotion_id and deleted_at is null;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('participations.create', v_company) then
    raise log 'record_participation denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: participations.create required' using errcode = '42501';
  end if;

  return public.apply_participation(
    p_promotion_id, p_member_id, p_participated_at, p_source, p_answers);
end;
$$;

revoke execute on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) from public;
grant execute on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) to authenticated;

comment on function public.record_participation(uuid, uuid, timestamptz, public.participation_source, jsonb) is
  'Records one attempt by hand and returns what happened to it. Gated on participations.create, checked here beside the operation; the rules, the lock and the writes are apply_participation''s, shared with import_participations so the manual door and the file cannot drift. p_source is recorded, not consulted — it says how the row arrived and decides nothing about who may write it, so mislabelling a hand-typed entry as IMPORT changes the column and not the check.';

-- ---------------------------------------------------------------------------
-- One call per file. Per row: resolve the listener, then hand the row to
-- apply_participation. The rules are NOT repeated here, and the plan's own
-- comment above this function said they were — corrected here rather than left
-- to disagree with the code under it. One rule with two entrances is the shape
-- Block 4b was sent back to fix twice; a second copy of the repetition block
-- would be a second thing to keep in step with the first, and the manual door
-- and the file would drift the first time only one of them was edited.
--
-- The two gates below are the whole of this function's permission story, and
-- they are here rather than inside the shared body on purpose (0027). Nothing
-- downstream re-checks: apply_participation holds no gate at all, which is why
-- it holds EXECUTE for nobody.
--
-- What sharing the body costs, stated rather than assumed, because the plan's
-- version of this paragraph was wrong about it in a way worth writing down.
-- pg_advisory_xact_lock is TRANSACTION-scoped: nothing releases it at the end of
-- a row, so every pair a file touches is locked from the row that first reaches
-- it until this whole call commits. Hoisting one lock out of the loop would not
-- shorten that by a single millisecond. Nor is re-acquiring expensive: a session
-- that already holds an advisory lock is granted it again immediately, so the
-- same person appearing forty times in a file queues for nothing after the first
-- row. The real price is the read, not the lock — apply_participation re-reads
-- the promotion's rules per row, so a promotion edited by another transaction
-- mid-import is read as it stands when each row is reached. That is a hundred
-- index lookups on one row and an operator's edit landing between two rows of
-- one file, against keeping the four statuses in one place. The rules stay in
-- one place.
--
-- The CPF never arrives here raw — 0031's comment is explicit that the hash is
-- computed in Node, because an argument passed to an RPC lands in query logs
-- and in backups. This function takes cpf_hash and cpf_last_digits.
-- ---------------------------------------------------------------------------
create or replace function public.import_participations(
  p_promotion_id uuid,
  p_rows         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_company   uuid;
  v_row       jsonb;
  v_resolved  jsonb;
  v_member    uuid;
  v_outcome   jsonb;
  v_result    jsonb := '[]';
  v_recorded  integer := 0;
  v_duplicate integer := 0;
  v_too_soon  integer := 0;
  v_over      integer := 0;
  v_skipped   integer := 0;
  v_created   integer := 0;
begin
  select company_id into v_company
  from public.promotions
  where id = p_promotion_id and deleted_at is null;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('participations.import', v_company) then
    raise log 'import_participations denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: participations.import required' using errcode = '42501';
  end if;

  -- D10. Import registers listeners, so it needs the right to register one.
  -- Checked here rather than left to create_member's own gate so the file is
  -- refused before a single row is written, instead of halfway through.
  if not public.has_permission('members.create', v_company) then
    raise log 'import_participations denied (members.create): actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: members.create required to import participations'
      using errcode = '42501';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_rows, '[]'))
  loop
    if coalesce(btrim(v_row ->> 'phone'), '') = ''
       and coalesce(btrim(v_row ->> 'cpf_hash'), '') = '' then
      v_skipped := v_skipped + 1;
      v_result := v_result || jsonb_build_object(
        'line', (v_row ->> 'line')::integer, 'outcome', 'skipped',
        'reason', 'no identifier');
      continue;
    end if;

    v_resolved := public.resolve_or_create_member(
      v_company,
      v_row ->> 'full_name',
      nullif(btrim(coalesce(v_row ->> 'phone', '')), ''),
      null,
      nullif(btrim(coalesce(v_row ->> 'cpf_hash', '')), ''),
      nullif(btrim(coalesce(v_row ->> 'cpf_last_digits', '')), ''),
      null);

    if v_resolved ->> 'outcome' = 'elsewhere' then
      v_skipped := v_skipped + 1;
      v_result := v_result || jsonb_build_object(
        'line', (v_row ->> 'line')::integer, 'outcome', 'skipped',
        'reason', 'listener is out of reach');
      continue;
    end if;

    if v_resolved ->> 'outcome' = 'created' then
      v_created := v_created + 1;
    end if;

    v_member := (v_resolved ->> 'member_id')::uuid;

    v_outcome := public.apply_participation(
      p_promotion_id, v_member,
      (v_row ->> 'participated_at')::timestamptz,
      'IMPORT', '[]');

    v_recorded := v_recorded + 1;
    case v_outcome ->> 'status'
      when 'DUPLICATE'  then v_duplicate := v_duplicate + 1;
      when 'TOO_SOON'   then v_too_soon  := v_too_soon  + 1;
      when 'OVER_LIMIT' then v_over      := v_over      + 1;
      else null;
    end case;

    v_result := v_result || jsonb_build_object(
      'line', (v_row ->> 'line')::integer, 'outcome', 'recorded',
      'status', v_outcome ->> 'status');
  end loop;

  return jsonb_build_object(
    'recorded', v_recorded, 'duplicate', v_duplicate, 'too_soon', v_too_soon,
    'over_limit', v_over, 'skipped', v_skipped, 'members_created', v_created,
    'rows', v_result);
end;
$$;

revoke execute on function public.import_participations(uuid, jsonb) from public;
grant execute on function public.import_participations(uuid, jsonb) to authenticated;

comment on function public.import_participations(uuid, jsonb) is
  'One call per file. The rules, the lock and the writes are apply_participation''s, shared with record_participation so the manual door and the file cannot drift; the gates are this function''s own and nothing downstream re-checks them. Gated on participations.import AND members.create — import registers listeners, and without the second this would be a side door that registers six hundred people for somebody who may not register one; both are checked before the first row is written rather than halfway through. Returns per-row outcomes with the line number from the file, so the screen can name what it skipped. A row with no phone and no CPF is skipped; so is one whose identifier matches a listener this caller cannot reach, because find_member_by_identifier deliberately returns no id for that case and 0031''s unique indexes would refuse the duplicate anyway. Repeats are not skipped — they are recorded with the status that says so. The CPF is hashed in Node before it reaches here (0031).';
