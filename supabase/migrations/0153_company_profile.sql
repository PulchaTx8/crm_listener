-- supabase/migrations/0153_company_profile.sql

-- Block 15, design D9, D11 and D12. A Station gets the record a radio station
-- actually has.
--
-- Until now `companies` carried a name, a status and a timezone, and the card at
-- /app showed three fields because there were only three fields. No address, no
-- dial frequency, no picture -- and no way for the platform to record any of it.
--
-- EVERY ONE OF THESE IS EDITED FROM /admin/customers AND NOWHERE ELSE (D9). The
-- card DISPLAYS; the console EDITS. That is 0130's argument for the WhatsApp
-- integration applied unchanged: the account being configured belongs to the
-- platform. Name and timezone are deliberately NOT among these columns' company
-- (D10) -- they stay exactly where and how they were.

-- ---------------------------------------------------------------------------
-- The frequency. D11.
--
-- ONE UNIT, kHz, AS AN INTEGER. FM 98.5 MHz stores 98500; AM 1200 kHz stores
-- 1200. Chosen over a numeric in MHz because an integer has no rounding to
-- argue about, and over free text because free text cannot be sorted, cannot be
-- validated, and ends up holding "98.5", "98,5 FM" and "98.5FM" in one column
-- -- which is only fixable by reading it line by line.
--
-- WEB is a band, not an absence: a station that broadcasts only online has an
-- honest answer here, and a null frequency beside it rather than a made-up one.
-- ---------------------------------------------------------------------------

create type public.broadcast_band as enum ('FM', 'AM', 'WEB');

comment on type public.broadcast_band is
  'How a Station reaches its listeners. WEB is a real answer rather than a gap: an online-only station has no dial frequency, and frequency_khz is null beside it.';

alter table public.companies
  -- The same seven names members (0031) already uses, so there is not a second
  -- address shape in one database and any formatter can serve both.
  add column address_line       text,
  add column address_number     text,
  add column address_complement text,
  add column neighbourhood      text,
  add column city               text,
  add column state              text,
  add column postal_code        text,
  add column broadcast_band     public.broadcast_band,
  add column frequency_khz      integer,
  -- numeric(9,6): six decimal places is about a tenth of a metre, which is far
  -- more than "where is this Station" needs and costs nothing.
  --
  -- NOT PostGIS, deliberately. Two columns answer the question being asked. The
  -- extension earns its place the day there is a distance query -- "Stations
  -- within X km" -- and that is a migration then, not a debt now.
  add column latitude           numeric(9,6),
  add column longitude          numeric(9,6),
  add column thumb_url          text;

comment on column public.companies.thumb_url is
  'The Station''s picture, shown on its card at /app. Server-generated; no form posts it. Written only by set_company_thumb -- update_company_profile replaces every field it takes, and a picture on that list would be cleared by every ordinary save (the defect 0144 and 0145 both document).';
comment on column public.companies.frequency_khz is
  'Always kHz, whatever the band: FM 98.5 MHz is 98500, AM 1200 kHz is 1200. One unit, an integer, so nothing rounds and everything sorts.';
comment on column public.companies.latitude is
  'Block 15, D12. Recorded, not shown on the card. Both coordinates or neither -- companies_coordinates_pair. Typed or pasted; there is no geocoding, which would be another external service with a key, a cost and a quota.';

alter table public.companies
  -- Mirrors prizes_photo_shape (0145). The column never holds something that
  -- would land verbatim in an <img src> without at least being an address.
  add constraint companies_thumb_shape
    check (thumb_url is null or thumb_url ~ '^https?://'),

  -- Half a coordinate is worse than none: it puts a pin in the Atlantic, or
  -- drops the Station off a map with no way to say why. The pair shape every
  -- archival column in this schema already uses.
  add constraint companies_coordinates_pair
    check ((latitude is null) = (longitude is null)),
  add constraint companies_latitude_range
    check (latitude is null or latitude between -90 and 90),
  add constraint companies_longitude_range
    check (longitude is null or longitude between -180 and 180),

  add constraint companies_frequency_positive
    check (frequency_khz is null or frequency_khz > 0);

-- ---------------------------------------------------------------------------
-- update_company_profile.
--
-- EVERY FIELD IS WRITTEN ON EVERY CALL, NEVER MERGED -- the convention
-- update_prize, update_role and update_song all follow, so a partial submission
-- blanks what it omits and there is one rule rather than a per-field guess.
--
-- IT TAKES NO p_thumb_url, AND MUST NEVER GAIN ONE. That convention is exactly
-- why: a picture uploaded before a Save would be cleared BY that Save. 0144 and
-- 0145 each document the defect and each answer it the same way, with a setter
-- of its own. This is the third time, and the reasoning has not changed.
--
-- Name, timezone and status are absent too (D10): this block does not move who
-- may change them.
-- ---------------------------------------------------------------------------

create function public.update_company_profile(
  p_company_id        uuid,
  p_address_line      text default null,
  p_address_number    text default null,
  p_address_complement text default null,
  p_neighbourhood     text default null,
  p_city              text default null,
  p_state             text default null,
  p_postal_code       text default null,
  p_broadcast_band    public.broadcast_band default null,
  p_frequency_khz     integer default null,
  p_latitude          numeric default null,
  p_longitude         numeric default null
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

  select jsonb_build_object(
           'address_line', address_line, 'address_number', address_number,
           'address_complement', address_complement, 'neighbourhood', neighbourhood,
           'city', city, 'state', state, 'postal_code', postal_code,
           'broadcast_band', broadcast_band, 'frequency_khz', frequency_khz,
           'latitude', latitude, 'longitude', longitude)
    into v_before
  from public.companies where id = p_company_id;

  update public.companies
     set address_line       = nullif(btrim(coalesce(p_address_line, '')), ''),
         address_number     = nullif(btrim(coalesce(p_address_number, '')), ''),
         address_complement = nullif(btrim(coalesce(p_address_complement, '')), ''),
         neighbourhood      = nullif(btrim(coalesce(p_neighbourhood, '')), ''),
         city               = nullif(btrim(coalesce(p_city, '')), ''),
         state              = nullif(btrim(coalesce(p_state, '')), ''),
         postal_code        = nullif(btrim(coalesce(p_postal_code, '')), ''),
         broadcast_band     = p_broadcast_band,
         frequency_khz      = p_frequency_khz,
         latitude           = p_latitude,
         longitude          = p_longitude,
         updated_at         = now()
   where id = p_company_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_company_profile', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('before', v_before, 'after', jsonb_build_object(
       'address_line', p_address_line, 'address_number', p_address_number,
       'address_complement', p_address_complement, 'neighbourhood', p_neighbourhood,
       'city', p_city, 'state', p_state, 'postal_code', p_postal_code,
       'broadcast_band', p_broadcast_band, 'frequency_khz', p_frequency_khz,
       'latitude', p_latitude, 'longitude', p_longitude)));
end;
$$;

comment on function public.update_company_profile is
  'Block 15. Replaces a Station''s address, band, frequency and coordinates wholesale -- every field on every call, the convention update_prize and update_song follow. Takes NO p_thumb_url and must never gain one: that is precisely how a picture uploaded before a save would be cleared by it (0144, 0145). Name, timezone and status are not here either (D10). Gated on is_platform_admin(), the gate the /admin console already requires.';

revoke execute on function public.update_company_profile(
  uuid, text, text, text, text, text, text, text,
  public.broadcast_band, integer, numeric, numeric) from public;
grant execute on function public.update_company_profile(
  uuid, text, text, text, text, text, text, text,
  public.broadcast_band, integer, numeric, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- set_company_thumb. Modelled on set_prize_photo (0145) line for line.
-- ---------------------------------------------------------------------------

create function public.set_company_thumb(p_company_id uuid, p_url text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_current text;
  v_url     text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select organization_id, thumb_url into v_org, v_current
  from public.companies
  where id = p_company_id and deleted_at is null
  for update;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.is_platform_admin() then
    raise log 'set_company_thumb denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  -- Clearing QUEUES the object rather than deleting it: the bucket has no
  -- delete policy for `authenticated`, deliberately, and the worker tick drains
  -- the queue as service_role. Without this the column empties and the object
  -- stays in the bucket for ever.
  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'station-thumbs/' || p_company_id || '/thumb');
  end if;

  update public.companies
     set thumb_url = v_url, updated_at = now()
   where id = p_company_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'set_company_thumb', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('cleared', v_url is null));
end;
$$;

comment on function public.set_company_thumb(uuid, text) is
  'Block 15. The only writer of companies.thumb_url. Separate from update_company_profile because that one replaces every field it takes, and a picture on that list would be cleared by every ordinary save. Clearing enqueues the storage object for erasure rather than deleting it, the shape 0145 established.';

revoke execute on function public.set_company_thumb(uuid, text) from public;
grant execute on function public.set_company_thumb(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- may_write_artwork gains a slot.
--
-- 0143's whole body is restated because `create or replace` needs it, and its
-- own closing comment asked for exactly this: "An unknown prefix is refused, so
-- adding a slot means adding it here."
-- ---------------------------------------------------------------------------

create or replace function public.may_write_artwork(p_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_parts   text[] := storage.foldername(p_name);
  v_slot    text   := v_parts[1];
  v_company text   := v_parts[2];
begin
  if v_company is null
     or v_company !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then
    return false;
  end if;

  -- A promotion's two pictures take the same permission because they are two
  -- fields of one record: somebody who may edit a promotion may set both.
  if v_slot in ('promotion-thumbs', 'promotion-banners') then
    return public.has_permission('promotions.edit', v_company::uuid);
  end if;

  -- The prize's takes the catalogue permission rather than the promotions one.
  -- Somebody who runs promotions is not thereby somebody who edits the stock
  -- catalogue, and 0027 already draws that line for every other prize field.
  if v_slot = 'prize-photos' then
    return public.has_permission('inventory.catalogue', v_company::uuid);
  end if;

  -- Block 15. The Station's own picture, and the ONE branch here that does not
  -- ask has_permission: there is no Company permission that could mean "may
  -- change what this Station is called and looks like", and inventing one would
  -- put a customer role in charge of a record the platform owns (design D9).
  -- The console that edits it is /admin/customers, behind the same gate.
  if v_slot = 'station-thumbs' then
    return public.is_platform_admin();
  end if;

  -- An unknown prefix is refused rather than allowed. Adding a slot means
  -- adding it here, which is the point.
  return false;
end;
$$;

comment on function public.may_write_artwork(text) is
  'Whether the caller may write the named object in the artwork bucket, decided from the path alone. SECURITY INVOKER deliberately: has_permission and is_platform_admin both answer about auth.uid(). Guards the uuid cast rather than attempting it. Since Block 15 it carries a station-thumbs branch gated on is_platform_admin() rather than a permission code, because that picture belongs to the platform''s record of the Station (D9). An unknown prefix is refused, so adding a slot means adding it here.';
