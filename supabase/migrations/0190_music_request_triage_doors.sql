-- supabase/migrations/0190_music_request_triage_doors.sql

-- Block 22, Task 2: the doors that write 0189's stamps, and the one that
-- discloses a telephone number.
--
-- ALL THREE WRITERS ARE GATED ON participations.view, and that is the owner's
-- decision of 2026-08-13 over a code of this block's own (design D5). The
-- objection was made at design time and overruled, and is recorded here because
-- the next reader will otherwise assume it was an oversight: participations.view
-- is a READ code for a different domain, so whoever may see promotion entries
-- acquires the power to mark songs played, and taking that power away means
-- taking the promotion screen away with it. Changing it later is one line in
-- each function below plus one row in public.permissions.
--
-- IDEMPOTENT, NOT AN ERROR (D4). A presenter double-tapping a button on a phone
-- is the ordinary case, not an exception to report. Each writer re-reads its own
-- stamp under the row lock and returns without writing when it is already set,
-- so the FIRST stamp -- the true one -- survives, and exactly one audit row is
-- written per fact.

create function public.mark_music_request_read(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_read      timestamptz;
  v_cancelled timestamptz;
begin
  -- 0093's one-gated-query idiom: no such id, an id in a Station this caller
  -- holds nothing in, and an already-withdrawn row all answer 42501 alike.
  --
  -- FOR UPDATE because two presenters pressing the same button is this screen's
  -- ordinary case, not its exotic one: without the lock both pass the check and
  -- both write, and the second overwrites the first stamp with a later time.
  select organization_id, company_id, read_at, cancelled_at
    into v_org, v_company, v_read, v_cancelled
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('participations.view', company_id)
   for update;

  if v_company is null then
    raise log 'mark_music_request_read denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: participations.view required' using errcode = '42501';
  end if;

  if v_cancelled is not null then
    raise exception 'this request was called off and cannot be marked read'
      using errcode = '22023';
  end if;

  -- Already read: the first stamp is the true one. No write, no audit row.
  if v_read is not null then
    return;
  end if;

  update public.music_requests
     set read_at = now(), read_by = v_actor, updated_at = now()
   where id = p_request_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'mark_music_request_read', 'music_requests', p_request_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.mark_music_request_read(uuid) is
  'Records that a request has been read out. Gated on participations.view (Block 22 D5 -- the owner''s choice over a code of its own). Refuses a request that was called off. Marking twice keeps the first stamp and writes no second audit row.';

create function public.mark_music_request_played(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_played    timestamptz;
  v_cancelled timestamptz;
begin
  select organization_id, company_id, played_at, cancelled_at
    into v_org, v_company, v_played, v_cancelled
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('participations.view', company_id)
   for update;

  if v_company is null then
    raise log 'mark_music_request_played denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: participations.view required' using errcode = '42501';
  end if;

  if v_cancelled is not null then
    raise exception 'this request was called off and cannot be marked played'
      using errcode = '22023';
  end if;

  -- NO read_at REQUIREMENT, deliberately (D3). Two people do these two jobs and
  -- sometimes in either order; a door that insisted on the sequence would refuse
  -- the ordinary case of a song going out while the note is still being read.
  if v_played is not null then
    return;
  end if;

  update public.music_requests
     set played_at = now(), played_by = v_actor, updated_at = now()
   where id = p_request_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'mark_music_request_played', 'music_requests', p_request_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.mark_music_request_played(uuid) is
  'Records that the song asked for went to air. Gated on participations.view. Does NOT require the request to have been read first (Block 22 D3). Refuses a request that was called off; marking twice keeps the first stamp.';

create function public.cancel_music_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_played    timestamptz;
  v_cancelled timestamptz;
begin
  select organization_id, company_id, played_at, cancelled_at
    into v_org, v_company, v_played, v_cancelled
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('participations.view', company_id)
   for update;

  if v_company is null then
    raise log 'cancel_music_request denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: participations.view required' using errcode = '42501';
  end if;

  -- THE ONE REFUSAL THAT IS ABOUT THE DERIVATION, NOT ABOUT THE DOMAIN (D2).
  -- cancelled_at outranks played_at in 0189's CASE, so cancelling a played
  -- request would take a play that really happened off every screen. The screen
  -- does not offer the button in that state, so this is reachable only by a race
  -- -- two people, two buttons, one request.
  if v_played is not null then
    raise exception 'this request has already played and cannot be called off'
      using errcode = '22023';
  end if;

  if v_cancelled is not null then
    return;
  end if;

  update public.music_requests
     set cancelled_at = now(), cancelled_by = v_actor, updated_at = now()
   where id = p_request_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_music_request', 'music_requests', p_request_id, v_org, v_company,
     '{}'::jsonb);
end;
$$;

comment on function public.cancel_music_request(uuid) is
  'Calls a request off. One stamp, and BOTH derived statuses read CANCELLED (Block 22 D2 -- the owner chose one button over two). Refused once the song has played, because the derivation would otherwise erase it. Never a delete: the row stays on the list, marked.';

-- ---------------------------------------------------------------------------
-- The disclosure. 0191 stops returning the whole telephone number to the
-- browser and returns four digits instead (D8); this is how the whole number is
-- asked for, one request at a time, with the asking recorded.
--
-- members.view, NOT participations.view: this door discloses a listener's
-- identity, which is the boundary 0107's RULE 2 already draws for the name and
-- the number together. Attending a request and reading somebody's telephone
-- number are different powers.
--
-- The audit row is written BEFORE the number is returned and on every call,
-- including a second call for the same request. A disclosure log that skipped
-- repeats would answer "who has seen this number" with a smaller set than the
-- truth.
-- ---------------------------------------------------------------------------

create function public.reveal_request_phone(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_member  uuid;
  v_phone   text;
begin
  select organization_id, company_id, member_id
    into v_org, v_company, v_member
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('members.view', company_id);

  if v_company is null then
    raise log 'reveal_request_phone denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- Null for a listener who has since exercised erasure: anonymize_member (0034)
  -- scrubs the number, and there is nothing to disclose. The audit row is still
  -- written -- somebody asked, and that is the fact being recorded.
  --
  -- FOR SHARE, NOT A BARE READ. anonymize_member (0034) erases through a plain
  -- UPDATE, which takes no lock a reader is obliged to respect; under READ
  -- COMMITTED an unlocked select is never blocked by one, so without this lock
  -- a disclosure racing an erasure could read the row a moment before the scrub
  -- commits and hand a human the live number anyway -- seen once, unseeable
  -- after, at the exact instant the erasure existed to prevent it. 0107:77-84
  -- closed this identical race on this identical table for create_music_request,
  -- and its header argues the case in full; this is the same lock for the same
  -- reason one door over.
  --
  -- FOR SHARE, NOT FOR UPDATE: it conflicts with FOR UPDATE and nothing weaker,
  -- so it serialises against the erasure and against nothing else -- two people
  -- revealing the same listener's number in the same instant never queue behind
  -- each other, which matters on a door that runs once per click.
  select phone into v_phone
    from public.members
   where id = v_member and anonymized_at is null
   for share;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reveal_request_phone', 'music_requests', p_request_id, v_org, v_company,
     jsonb_build_object('member_id', v_member));

  return v_phone;
end;
$$;

comment on function public.reveal_request_phone(uuid) is
  'Returns one listener''s whole telephone number for one request, and writes an audit row for the asking. Exists because 0191 stops sending the number to the browser with the list (Block 22 D8) -- four digits travel, and the rest is asked for. Gated on members.view, the boundary 0107''s RULE 2 already draws. Null for a listener who has exercised erasure; the audit row is written either way.';

revoke execute on function public.mark_music_request_read(uuid) from public;
revoke execute on function public.mark_music_request_played(uuid) from public;
revoke execute on function public.cancel_music_request(uuid) from public;
revoke execute on function public.reveal_request_phone(uuid) from public;

grant execute on function public.mark_music_request_read(uuid) to authenticated;
grant execute on function public.mark_music_request_played(uuid) to authenticated;
grant execute on function public.cancel_music_request(uuid) to authenticated;
grant execute on function public.reveal_request_phone(uuid) to authenticated;
