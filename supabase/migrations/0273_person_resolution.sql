-- supabase/migrations/0273_person_resolution.sql

-- Nullable here and made NOT NULL in 0275, once the backfill has run and the
-- doors have been proved. A NOT NULL taken before either would refuse every
-- registration the moment one door was missed, and taken alongside the backfill
-- it would report the symptom of a backfill that did not finish rather than the
-- door that skipped resolution.
alter table public.members
  add column person_id uuid references public.people (id);

create index members_person_idx
  on public.members (person_id) where deleted_at is null;

comment on column public.members.person_id is
  'The platform person this Station profile is about (design D2). Two profiles of one human in different Organizations point at the same row, which is what makes them knowably the same human without either Station learning anything about the other.';

-- THE ONE PLACE A PLATFORM PERSON IS RESOLVED. Every door that registers a
-- listener reaches it through apply_member_creation, so there is no second
-- implementation to drift from this one -- which is the reason the resolution
-- cores were gathered into one body in the first place (0061).
--
-- SECURITY INVOKER, reachable only from inside a SECURITY DEFINER body that has
-- already checked whatever gate applies: apply_participation's convention
-- (0054), which the cores themselves follow.
--
-- NORMALISED THROUGH normalize_phone / normalize_email, never by an expression
-- written here. 0031's comment on those two is a standing warning about exactly
-- this: a normalisation applied by whoever remembers is one that drifts, and
-- these values ARE identity -- two spellings normalising differently means
-- deduplication silently stops working and the duplicates look legitimate.
create or replace function public.resolve_or_attach_person(
  p_phone     text default null,
  p_email     text default null,
  p_cpf_hash  text default null,
  p_passport  text default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_claims  jsonb := '[]'::jsonb;
  v_person  uuid;
  v_keep    uuid;
  v_kind    text;
  v_value   text;
begin
  -- Every value this call carries, normalised and shaped like a claim. Built
  -- once so the lookup and the insert below cannot disagree about what was
  -- handed in.
  if public.normalize_phone(p_phone) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PHONE', 'value', public.normalize_phone(p_phone)));
  end if;

  if public.normalize_email(p_email) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'EMAIL', 'value', public.normalize_email(p_email)));
  end if;

  if nullif(lower(btrim(coalesce(p_cpf_hash, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'CPF', 'value', lower(btrim(p_cpf_hash))));
  end if;

  if nullif(lower(btrim(coalesce(p_passport, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PASSPORT', 'value', lower(btrim(p_passport))));
  end if;

  -- WHO ALREADY HOLDS ANY OF THEM. More than one answer is a BRIDGE: this caller
  -- names two rows that are one human, and the cheapest true thing to do is make
  -- them one. Merging is two updates and a delete because exactly two columns
  -- reference people -- 0272's comment says why that emptiness is not an
  -- accident. It is also what makes the owner's D20 fallback unnecessary here:
  -- nobody is retired, because nothing had to be refused.
  for v_person in
    select distinct pi.person_id
      from public.person_identifiers pi
      join lateral jsonb_array_elements(v_claims) c on true
     where pi.valid_to is null
       and pi.kind::text = c.value ->> 'kind'
       and pi.value      = c.value ->> 'value'
     order by 1
  loop
    if v_keep is null then
      v_keep := v_person;
    else
      update public.person_identifiers set person_id = v_keep where person_id = v_person;
      update public.members            set person_id = v_keep where person_id = v_person;
      delete from public.people where id = v_person;
    end if;
  end loop;

  if v_keep is null then
    insert into public.people default values returning id into v_keep;
  end if;

  -- Record what is not recorded yet. ON CONFLICT DO NOTHING against the live
  -- index rather than a prior select: two doors meeting one stranger at once is
  -- the ordinary case under load and not an exotic one (0063), and losing that
  -- race must not raise. The conflict can only be a claim this person already
  -- holds, since any claim held by somebody ELSE was merged into v_keep above.
  for v_kind, v_value in
    select c.value ->> 'kind', c.value ->> 'value'
      from jsonb_array_elements(v_claims) c
  loop
    insert into public.person_identifiers (person_id, kind, value)
    values (v_keep, v_kind::public.person_identifier_kind, v_value)
    on conflict do nothing;
  end loop;

  return v_keep;
end;
$$;

revoke execute on function public.resolve_or_attach_person(text, text, text, text) from public;

comment on function public.resolve_or_attach_person(text, text, text, text) is
  'The one place a platform person is resolved (design D2). Finds whoever holds any of these values live, MERGES them when the values name two rows -- one human with a profile in two Organizations is the ordinary case, and merging costs two updates because only person_identifiers and members reference people -- mints one when they name none, and records every value handed in as a live claim. Normalises through normalize_phone/normalize_email rather than repeating their expressions, for the reason 0031 gives about identity that drifts. Because it merges rather than refuses, the owner''s D20 fallback -- retire the profile with fewer requests and participations -- is never reached from here; it stays written for a future door that attaches a claim without coming through this function. SECURITY INVOKER, called only from inside a SECURITY DEFINER body that has already checked its own gate, apply_participation''s convention (0054). Losing a race to another door is not an error: the claim insert is ON CONFLICT DO NOTHING against the live-uniqueness index.';

create or replace function public.apply_member_creation(
  p_company_id         uuid,
  p_full_name          text,
  p_phone              text,
  p_email              text,
  p_cpf_hash           text,
  p_cpf_last_digits    text,
  p_passport           text,
  p_birth_date         date,
  p_address_line       text,
  p_address_number     text,
  p_address_complement text,
  p_neighbourhood      text,
  p_city               text,
  p_state              text,
  p_postal_code        text,
  p_discovery_source   text,
  p_first_contact_at   timestamptz,
  p_first_contact_origin text,
  p_actor              uuid,
  p_country            text default null
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org  uuid;
  v_name text := nullif(trim(p_full_name), '');
  v_id   uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Four independent partial unique indexes (phone, e-mail, CPF hash, passport;
  -- 0031_members.sql) can each be the one that collides. find_member_by_identifier
  -- (0033) is the friendly pre-submission path; this is what makes a duplicate
  -- unrepresentable even if a caller skips it or loses a race.
  begin
    -- P2. The person is resolved BEFORE the profile is written, so a profile
    -- never exists without one -- which is what lets 0275 make the column NOT
    -- NULL. Resolved from the same four values this insert stores, so the claims
    -- and the profile cannot end up describing different people.
    insert into public.members
      (organization_id, full_name, phone, email, cpf_hash, cpf_last_digits, passport,
       birth_date, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, country, discovery_source, first_contact_at,
       first_contact_origin, created_by, person_id)
    values
      (v_org, v_name,
       nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''),
       -- Normalised the same way 0033's find_member_by_identifier normalises them
       -- (Task 3 review, Important 4): an empty string -- what an HTML/JSON client
       -- sends for a blank field -- would otherwise reach 0031's cpf_hash format
       -- CHECK and surface as a raw 23514 outside the unique_violation handler
       -- below, instead of simply being treated as "not supplied".
       nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''), nullif(trim(coalesce(p_cpf_last_digits, '')), ''),
       nullif(trim(coalesce(p_passport, '')), ''),
       p_birth_date,
       nullif(trim(coalesce(p_address_line, '')), ''), nullif(trim(coalesce(p_address_number, '')), ''),
       nullif(trim(coalesce(p_address_complement, '')), ''), nullif(trim(coalesce(p_neighbourhood, '')), ''),
       nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_state, '')), ''),
       nullif(trim(coalesce(p_postal_code, '')), ''),
       -- Through the resolver, for the reason apply_member_field_values gives:
       -- members_country_shape refuses anything that is not two upper-case
       -- letters, and this door is reachable from three callers that have never
       -- validated one.
       public.country_alpha2(p_country),
       nullif(trim(coalesce(p_discovery_source, '')), ''),
       p_first_contact_at, nullif(trim(coalesce(p_first_contact_origin, '')), ''),
       p_actor,
       public.resolve_or_attach_person(p_phone, p_email, p_cpf_hash, p_passport))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  -- A plain insert, not ON CONFLICT: create_member has just created v_id, so
  -- there cannot be a prior link for it. apply_member_link is the idempotent
  -- one, because it is the one that can be handed a listener already linked.
  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (v_id, p_company_id, v_org, p_actor);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (p_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));

  return v_id;
end;
$$;
