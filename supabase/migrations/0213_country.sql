-- supabase/migrations/0213_country.sql

-- Block 28. A country on the Station and on the listener, and the four doors
-- that carry one.
--
-- Both columns are ISO 3166-1 alpha-2 by CHECK. That is easy to hold on
-- companies, where a platform admin picks from a select, and it is the whole
-- difficulty on members, where the value can arrive from a WhatsApp
-- conversation in which somebody typed "Portugal". country_alpha2 below is what
-- reconciles the two; see its own comment for why the alternative — free text
-- on members — was rejected.

alter table public.companies add column country text;
alter table public.members   add column country text;

alter table public.companies add constraint companies_country_shape
  check (country is null or country ~ '^[A-Z]{2}$');
alter table public.members add constraint members_country_shape
  check (country is null or country ~ '^[A-Z]{2}$');

comment on column public.companies.country is
  'ISO 3166-1 alpha-2. Block 28: it qualifies every geocode for this Station''s listeners and decides where its map opens. Nullable, because every Station that exists predates it — a Station without one has its listeners geocoded without a country hint, which is worse but not broken.';
comment on column public.members.country is
  'ISO 3166-1 alpha-2, and OPTIONAL in every sense: the promotion decides whether to ask (promotion_requested_field ''country''), and a listener without one inherits their Station''s. Block 28, D10 — the diaspora case is real but rare, and a question nobody needs is a listener who stops answering. Written from a conversation only through country_alpha2, never raw: this column is a KEY the map groups by, and a column holding both ''BR'' and ''Brasil'' would count one city twice.';

-- ---------------------------------------------------------------------------
-- The resolver.
--
-- THE ALTERNATIVE WAS FREE TEXT ON members.country, and it was rejected on what
-- the column is FOR. Block 28's maps group listeners by place, and the place key
-- (src/lib/places/normalise.ts) begins with the country: a Station stored as
-- 'BR' and a listener who typed 'Brasil' would produce two keys for one city,
-- so the same São Luís would appear twice on the map with its listeners split
-- between the two. A code is not decoration here; it is what makes the grouping
-- true.
--
-- UNRECOGNISED INPUT RETURNS NULL AND DOES NOT RAISE. The caller
-- (apply_member_field_values) coalesces, so an answer nobody can resolve leaves
-- the column as it was rather than failing the whole participation — and a
-- participation refused because a listener wrote a country we do not know would
-- be the worst possible trade for an optional question.
--
-- `unaccent` is NOT used and cannot be: 0001 installs pgcrypto only, and adding
-- an extension for this would be a large decision taken sideways (0137 records
-- the same ruling). The fold below is an explicit translate() over the vowels
-- these names actually use.
-- ---------------------------------------------------------------------------

create function public.country_alpha2(p_input text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  with cleaned as (
    select nullif(btrim(coalesce(p_input, '')), '') as raw
  ),
  folded as (
    select
      raw,
      translate(lower(raw),
                'áàâãäéèêëíìîïóòôõöúùûüçñ',
                'aaaaaeeeeiiiiooooouuuucn') as key
    from cleaned
  )
  select case
    -- Already a code. Upper-cased rather than rejected: an operator or an API
    -- client sending 'br' means BR, and the CHECK would refuse it.
    when raw ~ '^[A-Za-z]{2}$' then upper(raw)
    else (
      select code from (values
        ('brasil','BR'), ('brazil','BR'),
        ('portugal','PT'),
        ('espanha','ES'), ('espana','ES'), ('spain','ES'),
        ('argentina','AR'),
        ('uruguai','UY'), ('uruguay','UY'),
        ('paraguai','PY'), ('paraguay','PY'),
        ('chile','CL'),
        ('bolivia','BO'),
        ('peru','PE'),
        ('colombia','CO'),
        ('venezuela','VE'),
        ('equador','EC'), ('ecuador','EC'),
        ('mexico','MX'),
        ('estados unidos','US'), ('eua','US'), ('united states','US'), ('usa','US'),
        ('canada','CA'),
        ('reino unido','GB'), ('inglaterra','GB'), ('united kingdom','GB'),
        ('irlanda','IE'), ('ireland','IE'),
        ('franca','FR'), ('france','FR'),
        ('italia','IT'), ('italy','IT'),
        ('alemanha','DE'), ('germany','DE'),
        ('suica','CH'), ('switzerland','CH'),
        ('holanda','NL'), ('paises baixos','NL'), ('netherlands','NL'),
        ('belgica','BE'), ('belgium','BE'),
        ('japao','JP'), ('japan','JP'),
        ('australia','AU'),
        ('angola','AO'),
        ('mocambique','MZ'), ('mozambique','MZ'),
        ('cabo verde','CV'), ('cape verde','CV'),
        ('guine-bissau','GW'), ('guine bissau','GW')
      ) as names(name, code)
      where name = folded.key
    )
  end
  from folded;
$$;

revoke execute on function public.country_alpha2(text) from public;

comment on function public.country_alpha2(text) is
  'A country an operator or a listener named, as ISO 3166-1 alpha-2, or null when it cannot be resolved. IMMUTABLE, EXECUTE granted to nobody — it is only ever called from inside another function''s body. The name list is deliberately short and covers what this product serves plus the diaspora destinations D10 names; it is not a world gazetteer and is not meant to become one. Null rather than a raise, because its caller coalesces: an unrecognised answer must cost the answer, never the participation.';

-- ---------------------------------------------------------------------------
-- The two field helpers the conversation runs through.
--
-- WITHOUT BOTH OF THESE, adding 'country' to promotion_requested_field would
-- make the bot ask the question, write a member_field_confirmations row saying
-- it was answered, and store nothing — an answer lost in the one place the loss
-- is invisible, because the confirmation makes the record look complete.
-- ---------------------------------------------------------------------------

create or replace function public.member_field_value(p_member_id uuid, p_field public.promotion_requested_field)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(coalesce(
    case p_field
      when 'full_name'        then m.full_name
      when 'address'          then m.address_line
      when 'city'              then m.city
      when 'neighbourhood'    then m.neighbourhood
      when 'age'                then m.birth_date::text
      when 'cpf'               then m.cpf_hash
      when 'passport'          then m.passport
      when 'discovery_source' then m.discovery_source
      when 'country'           then m.country
    end,
    '')), '')
  from public.members m
  where m.id = p_member_id;
$$;

create or replace function public.apply_member_field_values(p_member_id uuid, p_fields jsonb)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.members where id = p_member_id;
  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- coalesce per field so an unanswered one is left alone rather than blanked:
  -- the step list only contains what was asked, and a walk re-run could carry
  -- fewer answers than the record already holds. 0071's own reasoning.
  update public.members m set
    full_name        = coalesce(nullif(btrim(p_fields ->> 'full_name'), ''), m.full_name),
    address_line     = coalesce(nullif(btrim(p_fields ->> 'address'), ''), m.address_line),
    city             = coalesce(nullif(btrim(p_fields ->> 'city'), ''), m.city),
    neighbourhood    = coalesce(nullif(btrim(p_fields ->> 'neighbourhood'), ''), m.neighbourhood),
    birth_date       = coalesce((nullif(btrim(p_fields ->> 'age'), ''))::date, m.birth_date),
    cpf_hash         = coalesce(nullif(btrim(p_fields ->> 'cpf'), ''), m.cpf_hash),
    passport         = coalesce(nullif(btrim(p_fields ->> 'passport'), ''), m.passport),
    discovery_source = coalesce(nullif(btrim(p_fields ->> 'discovery_source'), ''), m.discovery_source),
    -- Block 28. THROUGH country_alpha2, and inside the same coalesce as the
    -- rest: the listener typed "Portugal" into WhatsApp and this column stores
    -- 'PT'. An answer the resolver does not know returns null, which coalesce
    -- turns into "leave what was there" — so the failure mode of an unknown
    -- country is a country not recorded, never a participation refused by a
    -- CHECK constraint at the far end of somebody's entry.
    country          = coalesce(public.country_alpha2(p_fields ->> 'country'), m.country),
    updated_at       = now()
  where m.id = p_member_id;

  -- ONE CONFIRMATION PER FIELD THE LISTENER ACTUALLY ANSWERED, stamped now
  -- rather than with any time the caller supplied: the confirmation records
  -- when we were told.
  insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
  select p_member_id, v_org, k::public.promotion_requested_field, now()
  from jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
  on conflict (member_id, field) do update set confirmed_at = excluded.confirmed_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- The four doors. ALL FOUR ARE DROP + CREATE: a new parameter changes the
-- signature, and every grant is restated because DROP resets an ACL (0102).
--
-- p_country is LAST and DEFAULTED on each, so every existing positional call
-- keeps resolving: apply_member_creation is called positionally from
-- ingest_whatsapp_event (0062), widget_verify_code and api_record_music_request,
-- and none of them passes a country.
--
-- Each body is copied forward from its LIVE definition: create_member from
-- 0074, update_member from 0073, apply_member_creation from 0061,
-- update_company_profile from 0155. The spec named 0034 and 0153 for two of
-- them and was wrong; the live definitions were read out of pg_proc rather than
-- trusted from either.
-- ---------------------------------------------------------------------------

drop function public.apply_member_creation(uuid, text, text, text, text, text, text, date, text,
                                           text, text, text, text, text, text, text,
                                           timestamptz, text, uuid);

create function public.apply_member_creation(
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
    insert into public.members
      (organization_id, full_name, phone, email, cpf_hash, cpf_last_digits, passport,
       birth_date, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, country, discovery_source, first_contact_at,
       first_contact_origin, created_by)
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
       p_actor)
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

revoke execute on function public.apply_member_creation(uuid, text, text, text, text, text, text, date,
                                                        text, text, text, text, text, text, text, text,
                                                        timestamptz, text, uuid, text) from public;

drop function public.create_member(uuid, text, text, text, text, text, text, date, text, text,
                                   text, text, text, text, text, text, timestamptz, text);

create function public.create_member(
  p_company_id         uuid,
  p_full_name          text,
  p_phone              text default null,
  p_email              text default null,
  p_cpf_hash           text default null,
  p_cpf_last_digits    text default null,
  p_passport           text default null,
  p_birth_date         date default null,
  p_address_line       text default null,
  p_address_number     text default null,
  p_address_complement text default null,
  p_neighbourhood      text default null,
  p_city               text default null,
  p_state              text default null,
  p_postal_code        text default null,
  p_discovery_source   text default null,
  p_first_contact_at   timestamptz default null,
  p_first_contact_origin text default null,
  p_country            text default null
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
       city, state, postal_code, country, discovery_source, first_contact_at,
       first_contact_origin, created_by)
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
       nullif(trim(coalesce(p_postal_code, '')), ''),
       public.country_alpha2(p_country),
       nullif(trim(coalesce(p_discovery_source, '')), ''),
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

revoke execute on function public.create_member(uuid, text, text, text, text, text, text, date, text,
                                                text, text, text, text, text, text, text, timestamptz,
                                                text, text) from public;
grant execute on function public.create_member(uuid, text, text, text, text, text, text, date, text,
                                               text, text, text, text, text, text, text, timestamptz,
                                               text, text) to authenticated;

drop function public.update_member(uuid, text, text, text, text, text, text, date, text, text,
                                   text, text, text, text, text, text);

create function public.update_member(
  p_member_id          uuid,
  p_full_name          text,
  p_phone              text default null,
  p_email              text default null,
  p_cpf_hash           text default null,
  p_cpf_last_digits    text default null,
  p_passport           text default null,
  p_birth_date         date default null,
  p_address_line       text default null,
  p_address_number     text default null,
  p_address_complement text default null,
  p_neighbourhood      text default null,
  p_city               text default null,
  p_state              text default null,
  p_postal_code        text default null,
  p_discovery_source   text default null,
  p_country            text default null
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
           -- Through the resolver, like every other write to this column, and
           -- CLEARABLE like its neighbours: this form sets every field it takes
           -- on every call, so a blank Country select means "no country" and
           -- country_alpha2 answers null for it.
           country             = public.country_alpha2(p_country),
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

revoke execute on function public.update_member(uuid, text, text, text, text, text, text, date, text,
                                                text, text, text, text, text, text, text, text) from public;
grant execute on function public.update_member(uuid, text, text, text, text, text, text, date, text,
                                               text, text, text, text, text, text, text, text) to authenticated;

drop function public.update_company_profile(uuid, text, text, text, text, text, text, text,
                                            public.broadcast_band, integer, numeric, numeric,
                                            text, text, text, text, text, text, text, text,
                                            text, text, text, text);

create function public.update_company_profile(
  p_company_id             uuid,
  p_address_line           text default null,
  p_address_number         text default null,
  p_address_complement     text default null,
  p_neighbourhood          text default null,
  p_city                   text default null,
  p_state                  text default null,
  p_postal_code            text default null,
  p_broadcast_band         public.broadcast_band default null,
  p_frequency_khz          integer default null,
  p_latitude               numeric default null,
  p_longitude              numeric default null,
  p_contact_email          text default null,
  p_contact_phone          text default null,
  p_website_url            text default null,
  p_instagram_url          text default null,
  p_facebook_url           text default null,
  p_youtube_url            text default null,
  p_tagline                text default null,
  p_description            text default null,
  p_legal_name             text default null,
  p_tax_id                 text default null,
  p_municipal_registration text default null,
  p_fiscal_email           text default null,
  p_country                text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_before jsonb;
begin
  if not public.is_platform_admin() then
    raise log 'update_company_profile denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Caught here rather than left to the CHECK, so the console can say which
  -- half is missing instead of showing a constraint name.
  if (p_latitude is null) <> (p_longitude is null) then
    raise exception 'a place needs both a latitude and a longitude' using errcode = '22023';
  end if;

  -- Same reason, for the field an operator is most likely to get wrong. The
  -- CHECK would refuse it with `companies_tax_id_shape`, which is a constraint
  -- name where the console needs a sentence.
  if nullif(btrim(coalesce(p_tax_id, '')), '') is not null
     and nullif(btrim(coalesce(p_tax_id, '')), '') !~ '^[0-9]{14}$' then
    raise exception 'a CNPJ has fourteen digits' using errcode = '22023';
  end if;

  -- Block 28, and the same reason as the two above rather than a silent null:
  -- this console renders a select of country NAMES, so a value arriving here
  -- that country_alpha2 cannot resolve did not come from the select, and
  -- storing null for it would leave the operator looking at a field that
  -- refused to save without saying so.
  if nullif(btrim(coalesce(p_country, '')), '') is not null
     and public.country_alpha2(p_country) is null then
    raise exception 'that is not a country this system knows: %', p_country using errcode = '22023';
  end if;

  select jsonb_build_object(
           'address_line', address_line, 'address_number', address_number,
           'address_complement', address_complement, 'neighbourhood', neighbourhood,
           'city', city, 'state', state, 'postal_code', postal_code, 'country', country,
           'broadcast_band', broadcast_band, 'frequency_khz', frequency_khz,
           'latitude', latitude, 'longitude', longitude,
           'contact_email', contact_email, 'contact_phone', contact_phone,
           'website_url', website_url, 'instagram_url', instagram_url,
           'facebook_url', facebook_url, 'youtube_url', youtube_url,
           'tagline', tagline, 'description', description,
           'legal_name', legal_name, 'tax_id', tax_id,
           'municipal_registration', municipal_registration,
           'fiscal_email', fiscal_email)
    into v_before
  from public.companies where id = p_company_id;

  update public.companies
     set address_line           = nullif(btrim(coalesce(p_address_line, '')), ''),
         address_number         = nullif(btrim(coalesce(p_address_number, '')), ''),
         address_complement     = nullif(btrim(coalesce(p_address_complement, '')), ''),
         neighbourhood          = nullif(btrim(coalesce(p_neighbourhood, '')), ''),
         city                   = nullif(btrim(coalesce(p_city, '')), ''),
         state                  = nullif(btrim(coalesce(p_state, '')), ''),
         postal_code            = nullif(btrim(coalesce(p_postal_code, '')), ''),
         country                = public.country_alpha2(p_country),
         broadcast_band         = p_broadcast_band,
         frequency_khz          = p_frequency_khz,
         latitude               = p_latitude,
         longitude              = p_longitude,
         contact_email          = nullif(btrim(coalesce(p_contact_email, '')), ''),
         contact_phone          = nullif(btrim(coalesce(p_contact_phone, '')), ''),
         website_url            = nullif(btrim(coalesce(p_website_url, '')), ''),
         instagram_url          = nullif(btrim(coalesce(p_instagram_url, '')), ''),
         facebook_url           = nullif(btrim(coalesce(p_facebook_url, '')), ''),
         youtube_url            = nullif(btrim(coalesce(p_youtube_url, '')), ''),
         tagline                = nullif(btrim(coalesce(p_tagline, '')), ''),
         description            = nullif(btrim(coalesce(p_description, '')), ''),
         legal_name             = nullif(btrim(coalesce(p_legal_name, '')), ''),
         tax_id                 = nullif(btrim(coalesce(p_tax_id, '')), ''),
         municipal_registration = nullif(btrim(coalesce(p_municipal_registration, '')), ''),
         fiscal_email           = nullif(btrim(coalesce(p_fiscal_email, '')), ''),
         updated_at             = now()
   where id = p_company_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_company_profile', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'address_line', p_address_line, 'address_number', p_address_number,
       'address_complement', p_address_complement, 'neighbourhood', p_neighbourhood,
       'city', p_city, 'state', p_state, 'postal_code', p_postal_code,
       -- The RESOLVED value, not the raw parameter: this is what the column now
       -- holds, and a trail whose "after" disagrees with the row is worse than
       -- no trail. Its siblings above are stored verbatim, so for them the two
       -- are the same string.
       'country', public.country_alpha2(p_country),
       'broadcast_band', p_broadcast_band, 'frequency_khz', p_frequency_khz,
       'latitude', p_latitude, 'longitude', p_longitude,
       'contact_email', p_contact_email, 'contact_phone', p_contact_phone,
       'website_url', p_website_url, 'instagram_url', p_instagram_url,
       'facebook_url', p_facebook_url, 'youtube_url', p_youtube_url,
       'tagline', p_tagline, 'description', p_description,
       'legal_name', p_legal_name, 'tax_id', p_tax_id,
       'municipal_registration', p_municipal_registration,
       'fiscal_email', p_fiscal_email)));
end;
$$;

revoke execute on function public.update_company_profile(uuid, text, text, text, text, text, text, text,
                                                         public.broadcast_band, integer, numeric, numeric,
                                                         text, text, text, text, text, text, text, text,
                                                         text, text, text, text, text) from public;
grant execute on function public.update_company_profile(uuid, text, text, text, text, text, text, text,
                                                        public.broadcast_band, integer, numeric, numeric,
                                                        text, text, text, text, text, text, text, text,
                                                        text, text, text, text, text) to authenticated;
