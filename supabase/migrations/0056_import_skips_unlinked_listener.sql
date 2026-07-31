-- supabase/migrations/0056_import_skips_unlinked_listener.sql
--
-- One row could destroy a whole file, and nothing in this block noticed.
--
-- resolve_or_create_member (0054) searches the whole ORGANIZATION, because
-- find_member_by_identifier (0033) is Organization-scoped and is Block 3's
-- deduplication — that is deliberate and it is not what changes here.
-- apply_participation, one line later, requires the listener to be linked to
-- the PROMOTION's Station, and raises P0002 when they are not. Both are right on
-- their own. Together, in a loop, they mean this:
--
--   a listener registered only at a sister Station resolves perfectly, the
--   entry is then refused, the raise propagates out of import_participations,
--   and the transaction rolls back — so a three-hundred-row file writes NOTHING
--   because of row 47, and the operator is told a promotion or a listener was
--   not found.
--
-- That contradicts design spec D6, which is the whole shape of this import: it
-- writes what it can and reports what it skipped, with the line number and the
-- reason. And it contradicts the treatment the neighbouring case already gets —
-- `elsewhere` is a skipped row, not an abort, for exactly the same kind of fact:
-- this listener cannot be used here.
--
-- So: a listener who resolves but is not linked to this Station is a SKIPPED
-- ROW with a reason of its own.
--
-- THREE REASONS, NOT TWO, and the third is not a synonym of either:
--
--   'no identifier'                 — the row carries no phone and no CPF. The
--                                     operator fixes their spreadsheet.
--   'listener is out of reach'      — the identifier matches somebody this
--                                     caller may not see. Nobody can fix this
--                                     from a file; it needs access to the
--                                     Station that holds them.
--   'listener is at another station' — the identifier matches somebody this
--                                     caller CAN see, registered elsewhere in
--                                     this Organization and not linked here.
--                                     Fixable, and by this operator: link them
--                                     to this Station and import again.
--
-- Collapsing the third into the second would tell an operator to go and ask for
-- permission they already hold, for a listener sitting in front of them. This
-- branch has spent two rounds on refusals that answered with the wrong sentence.
--
-- DETECTED BEFORE apply_participation IS CALLED, not by catching its raise. A
-- begin/exception block around the call would catch P0002 and would then have no
-- way to tell this case from the other three things that raise it — a promotion
-- deleted mid-import, a stale id, an answer naming a foreign question — so a
-- genuinely broken call would be reported per row as "at another station" and
-- the file would go on writing. The check is one index lookup on
-- member_company_links' primary key, per row, which is what the composite
-- foreign key would have cost anyway.
--
-- WHAT THIS DOES NOT DO, and both are deliberate:
--
--   - It does not widen or narrow resolve_or_create_member's search. Block 3's
--     deduplication is Organization-wide by design, and a listener who exists
--     must not be registered twice; 0031's unique indexes would refuse it in any
--     case.
--   - It does not link the listener to this Station. Whether taking part
--     somewhere should attach somebody there is a real product question with an
--     LGPD answer attached, and it belongs to the owner, not to an import.
--
-- The MANUAL door is unchanged. record_participation still raises P0002 for the
-- same listener, and that is right: one person is in front of one operator, who
-- can be told to their face and given the fix. A file cannot be told anything —
-- it can only be reported on.
--
-- create or replace, not drop and recreate: the argument list is unchanged, so
-- there is no second signature for old call sites to resolve to and the ACL
-- survives. 0055 needed the other treatment for the opposite reason.

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

    -- The check this migration exists for. Placed AFTER the members_created
    -- counter on purpose: create_member (0034) inserts the link in the same
    -- statement as the listener, so a 'created' outcome can never reach this
    -- branch — but if it ever did, a listener really would have been registered,
    -- and reporting one fact (skipped) while suppressing the other (registered)
    -- would make the summary disagree with the table.
    --
    -- Not filtered to the 'resolved' outcome for the same reason: a check that
    -- trusts another function's invariant stops holding the moment that function
    -- changes, silently, and the thing it stops holding is the abort this
    -- migration removes.
    if not exists (
      select 1 from public.member_company_links
      where member_id = v_member and company_id = v_company
    ) then
      v_skipped := v_skipped + 1;
      v_result := v_result || jsonb_build_object(
        'line', (v_row ->> 'line')::integer, 'outcome', 'skipped',
        'reason', 'listener is at another station');
      continue;
    end if;

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

-- Restated because the behaviour it describes changed. 0054's version named two
-- skip reasons and there are now three, and a comment that lists two of three is
-- how the next reader concludes the third is a defect.
comment on function public.import_participations(uuid, jsonb) is
  'One call per file. The rules, the lock and the writes are apply_participation''s, shared with record_participation so the manual door and the file cannot drift; the gates are this function''s own and nothing downstream re-checks them. Gated on participations.import AND members.create — import registers listeners, and without the second this would be a side door that registers six hundred people for somebody who may not register one; both are checked before the first row is written rather than halfway through. Returns per-row outcomes with the line number from the file, so the screen can name what it skipped. THREE reasons a row is skipped, and they are three different instructions to the operator: no phone and no CPF ("no identifier"), fix the file; an identifier matching a listener this caller may not see ("listener is out of reach"), ask for access to the Station holding them, since find_member_by_identifier deliberately returns no id and 0031''s unique indexes would refuse a duplicate anyway; and an identifier matching a listener this caller CAN see who is registered elsewhere in the Organization and not linked here ("listener is at another station"), link them and import again. That third one was an ABORT until 0056 — resolution is Organization-wide and apply_participation requires the Station''s own link, so one such row rolled the whole file back and reported a missing promotion. It is detected before apply_participation is called rather than by catching P0002, which cannot be told apart from the three other things that raise it. Repeats are not skipped — they are recorded with the status that says so. The CPF is hashed in Node before it reaches here (0031).';
