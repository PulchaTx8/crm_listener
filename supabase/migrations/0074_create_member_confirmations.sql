-- Block 5b, closing the gap Task 10's own isolation case found.
--
-- The owner's ruling (design spec D3) is that data an operator typed counts as
-- confirmed on the day they typed it. Three doors write a listener's fields and
-- only two of them honoured it: the backfill (0065) covered every record that
-- existed when it ran, update_member (0073) covers every save, and create_member
-- -- the door an operator uses to type a NEW listener -- wrote nothing.
--
-- The consequence, which is small and wrong in an obvious way: a record typed
-- today has no confirmation for anything, so the bot asks that listener for the
-- address the operator entered an hour ago. It self-heals -- the listener
-- answers once and the confirmation exists from then on -- which is exactly why
-- it would have survived a long time unreported.
--
-- NOT added to apply_member_creation, which is the core the BOT registers
-- through, and the distinction is the whole point: the bot supplies a phone and
-- a WhatsApp profile name, and a profile name is not the listener confirming
-- their name. Only what somebody typed on purpose counts.

create or replace function public.create_member(
  p_company_id            uuid,
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
  p_discovery_source      text default null,
  p_first_contact_at      timestamptz default null,
  p_first_contact_origin  text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(trim(p_full_name), '');
  v_id    uuid;
begin
  -- FOR SHARE: member_links_company_org_fk (0031) cannot see deleted_at — a
  -- composite foreign key cannot reference a partial index — so without this lock a
  -- concurrent write to this Station's deleted_at, between this check and the
  -- member_company_links insert below, could let the link be written against a
  -- Station that is archived by the time this transaction commits. Same reasoning
  -- assign_company_role (0017) gives for its FOR SHARE on roles.
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('members.create', p_company_id) then
    raise log 'create_member denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: members.create required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'listener name is required' using errcode = '22023';
  end if;

  -- Four independent partial unique indexes (phone, e-mail, CPF hash, passport;
  -- 0031_members.sql) can each be the one that collides. find_member_by_identifier
  -- (0033) is the friendly pre-submission path; this is what makes a duplicate
  -- unrepresentable even if a caller skips it or loses a race.
  begin
    insert into public.members
      (organization_id, full_name, phone, email, cpf_hash, cpf_last_digits, passport,
       birth_date, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, discovery_source, first_contact_at, first_contact_origin,
       created_by)
    values
      (v_org, v_name,
       nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''),
       -- Normalised the same way 0033's find_member_by_identifier normalises them
       -- (Task 3 review, Important 4): an empty string — what an HTML/JSON client
       -- sends for a blank field — would otherwise reach 0031's cpf_hash format
       -- CHECK and surface as a raw 23514 outside the unique_violation handler
       -- below, instead of simply being treated as "not supplied".
       nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''), nullif(trim(coalesce(p_cpf_last_digits, '')), ''),
       nullif(trim(coalesce(p_passport, '')), ''),
       p_birth_date,
       nullif(trim(coalesce(p_address_line, '')), ''), nullif(trim(coalesce(p_address_number, '')), ''),
       nullif(trim(coalesce(p_address_complement, '')), ''), nullif(trim(coalesce(p_neighbourhood, '')), ''),
       nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_state, '')), ''),
       nullif(trim(coalesce(p_postal_code, '')), ''), nullif(trim(coalesce(p_discovery_source, '')), ''),
       p_first_contact_at, nullif(trim(coalesce(p_first_contact_origin, '')), ''),
       v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (v_id, p_company_id, v_org, v_actor);

  -- Block 5b, D3. Everything the operator actually typed is confirmed as of now.
  -- An empty "before" against the record as it now stands, which is the same
  -- comparison a save makes -- so the rule lives in one function and this door
  -- does not carry a second copy of it.
  perform public.apply_member_field_confirmations(
    v_id, v_org, '{}'::jsonb, public.member_field_values(v_id));

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));

  return v_id;
end;
$$;
