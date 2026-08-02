-- Block 5b, Task 10, spec §9. What an operator's save does to the freshness
-- record.
--
-- THE RULE, and the reason it is not "refresh everything": a save refreshes the
-- confirmation only for fields whose value ACTUALLY CHANGED. Refreshing them all
-- reintroduces D2's frequent-participant problem at operator scale -- somebody
-- who opens a record to correct a phone number and saves it would mark the
-- address, the CPF and everything else fresh, so the bot would stop asking for
-- them, for exactly the listeners staff touch most. The feature would switch
-- itself off where it is used hardest, which is the same failure D2 rejected a
-- single per-record timestamp for.
--
-- The owner's ruling stands behind the other half: data an operator typed counts
-- as confirmed on the day they typed it. This is where that becomes true for
-- every save after the first.

-- The eight fields as one object, built on member_field_value (0065) so the
-- enum-to-column mapping still lives in exactly one place. A field the record
-- holds nothing for is ABSENT rather than null -- "absent" is the shape the
-- comparison below wants, and a null would have to be told apart from a value
-- of null everywhere it is read.
create function public.member_field_values(p_member_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(
    jsonb_object_agg(f.field, v.value) filter (where v.value is not null),
    '{}'::jsonb)
  from unnest(enum_range(null::public.promotion_requested_field)) as f(field)
  cross join lateral (
    select public.member_field_value(p_member_id, f.field) as value
  ) v;
$$;

revoke execute on function public.member_field_values(uuid) from public;

comment on function public.member_field_values(uuid) is
  'The eight requested fields of one listener, as a jsonb object, absent where the record holds nothing. Built on member_field_value (0065), which is the single home of the enum-to-column mapping -- a ninth requested field is still one edit there and none here. Used to compare a record before and after a save, so the confirmations refresh only where a value really moved. PRIVATE: EXECUTE for nobody.';

create function public.apply_member_field_confirmations(
  p_member_id      uuid,
  p_organization_id uuid,
  p_before         jsonb,
  p_after          jsonb
)
returns void
language sql
set search_path = pg_catalog, public
as $$
  with changed as (
    select key, value
    from jsonb_each_text(coalesce(p_after, '{}'::jsonb))
    where value is distinct from (coalesce(p_before, '{}'::jsonb) ->> key)
  ),
  refreshed as (
    insert into public.member_field_confirmations
      (member_id, organization_id, field, confirmed_at)
    select p_member_id, p_organization_id,
           key::public.promotion_requested_field, now()
    from changed
    on conflict (member_id, field) do update set confirmed_at = excluded.confirmed_at
    returning 1
  ),
  -- A field cleared to blank loses its confirmation outright. Empty is asked
  -- whatever the validity says (D1), so a confirmation for a field that now
  -- holds nothing is a claim about nothing -- and left behind it would be a
  -- claim that gets OLDER rather than being re-earned, which is worse than
  -- absent because it looks like evidence.
  cleared as (
    delete from public.member_field_confirmations c
    where c.member_id = p_member_id
      and not coalesce(p_after, '{}'::jsonb) ? c.field::text
    returning 1
  )
  select null::void
  from (select count(*) from refreshed) r, (select count(*) from cleared) d;
$$;

revoke execute on function public.apply_member_field_confirmations(uuid, uuid, jsonb, jsonb) from public;

comment on function public.apply_member_field_confirmations(uuid, uuid, jsonb, jsonb) is
  'Moves the freshness record to match a save: a confirmation refreshed for every field whose value changed, and removed for every field the save left empty. Fields whose value did not move are UNTOUCHED, which is the whole rule (spec §9) -- refreshing all of them on every save would mark a record fresh because somebody opened it, and the bot would stop asking exactly the listeners staff handle most. PRIVATE: SECURITY INVOKER, EXECUTE for nobody, called from update_member inside its SECURITY DEFINER body, after the permission check and the write.';

-- update_member, unchanged except that it now records what it changed. The whole
-- body is restated because create or replace takes no patch; the only new lines
-- are the two reads around the UPDATE and the call after it.
create or replace function public.update_member(
  p_member_id             uuid,
  p_full_name             text,
  p_phone                 text default null,
  p_email                 text default null,
  p_cpf_hash              text default null,
  p_cpf_last_digits       text default null,
  p_passport              text default null,
  p_birth_date            date default null,
  p_address_line          text default null,
  p_address_number        text default null,
  p_address_complement    text default null,
  p_neighbourhood         text default null,
  p_city                  text default null,
  p_state                 text default null,
  p_postal_code           text default null,
  p_discovery_source      text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_name   text := nullif(trim(p_full_name), '');
  v_before jsonb;
begin
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.edit') then
    raise log 'update_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.edit required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'listener name is required' using errcode = '22023';
  end if;

  -- Read BEFORE the write and after the permission check, so a refused save
  -- costs nothing and a successful one has something to compare against.
  v_before := public.member_field_values(p_member_id);

  -- deleted_at and anonymized_at are re-checked HERE, inside the UPDATE's own WHERE
  -- clause, not only via the earlier SELECT: a plain read-then-write would leave a
  -- window where archive_member or anonymize_member commits between the read and
  -- this write, and this call would then either silently succeed on an
  -- already-archived row or -- the single worst thing this function could do --
  -- silently re-plant a name/phone/e-mail onto a row anonymize_member just erased.
  -- The WHERE clause makes the check and the write one atomic statement, so no
  -- window exists for either race.
  begin
    update public.members
       set full_name          = v_name,
           phone               = nullif(trim(coalesce(p_phone, '')), ''),
           email               = nullif(trim(coalesce(p_email, '')), ''),
           -- Same normalisation as create_member, for the same reason: an empty
           -- string must be treated as "not supplied", not hit the cpf_hash format
           -- CHECK (0031) as a raw 23514.
           cpf_hash            = nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''),
           cpf_last_digits     = nullif(trim(coalesce(p_cpf_last_digits, '')), ''),
           passport            = nullif(trim(coalesce(p_passport, '')), ''),
           birth_date          = p_birth_date,
           address_line        = nullif(trim(coalesce(p_address_line, '')), ''),
           address_number      = nullif(trim(coalesce(p_address_number, '')), ''),
           address_complement  = nullif(trim(coalesce(p_address_complement, '')), ''),
           neighbourhood       = nullif(trim(coalesce(p_neighbourhood, '')), ''),
           city                = nullif(trim(coalesce(p_city, '')), ''),
           state               = nullif(trim(coalesce(p_state, '')), ''),
           postal_code         = nullif(trim(coalesce(p_postal_code, '')), ''),
           discovery_source    = nullif(trim(coalesce(p_discovery_source, '')), ''),
           updated_at          = now()
     where id = p_member_id and deleted_at is null and anonymized_at is null;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  -- The two flags share one WHERE clause above for atomicity, but a caller deserves
  -- to be told WHICH one stopped the write, not a message that guesses. Re-read
  -- deliberately rather than trusted from the SELECT at the top of this function,
  -- since that read is exactly what could now be stale (see the comment above).
  if not found then
    if exists (select 1 from public.members where id = p_member_id and anonymized_at is not null) then
      raise exception 'this listener has been anonymised and cannot be edited' using errcode = '22023';
    else
      raise exception 'this listener has been archived and cannot be edited' using errcode = '22023';
    end if;
  end if;

  -- Block 5b, spec §9. Only what moved.
  perform public.apply_member_field_confirmations(
    p_member_id, v_org, v_before, public.member_field_values(p_member_id));

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id));
end;
$$;
