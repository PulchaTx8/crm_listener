-- supabase/migrations/0155_company_contact_and_fiscal.sql

-- Block 16, design D7 and D8. The Station gets the other half of its record.
--
-- 0153 gave `companies` an address, a band, a frequency and a picture. What it
-- did not give is the two things the console needs before a Station can be
-- billed or contacted: a way to reach the radio, and an invoicing identity of
-- its own.
--
-- THE SECOND HALF IS THE ONE THAT MAKES D7 CORRECT. `organizations.billing_
-- entity` (0154) answers who EMITS the invoice. It does not answer who HAS a
-- razao social, and it must never be read as permission to clear these columns:
-- a radio has a legal identity whether or not the group is the one that bills,
-- and blanking a true fact to model a preference is how a database loses data it
-- cannot get back. The two records are independent; only the reading of them is
-- a choice.

alter table public.companies
  -- How a listener, an advertiser or the platform reaches the radio. These are
  -- the Station's public face, not the owner's contact details -- the owner is
  -- reached through profiles, and has been since 0002.
  add column contact_email text,
  add column contact_phone text,
  add column website_url   text,
  add column instagram_url text,
  add column facebook_url  text,
  add column youtube_url   text,

  -- The two lines a radio describes itself with. `tagline` is the slogan that
  -- sits under the name on the card; `description` is the paragraph. Separate
  -- rather than one field truncated at display time, because a slogan cut out of
  -- a paragraph reads as a sentence that stops.
  add column tagline     text,
  add column description text,

  -- The invoicing identity. Mirrors 0154's four names exactly, so a formatter,
  -- a form and a report all serve both tables without a translation table in
  -- between.
  add column legal_name             text,
  add column tax_id                 text,
  add column municipal_registration text,
  add column fiscal_email           text;

comment on column public.companies.tax_id is
  'Block 16, D7. The Station''s OWN CNPJ. Fourteen digits, punctuation stripped by the caller (src/lib/tax-id.ts), the same contract organizations.tax_id (0154) carries. It survives any value of organizations.billing_entity: that column says who emits the invoice, never who has a legal identity, and nothing in this schema may read it as permission to clear this one.';

comment on column public.companies.contact_phone is
  'Stored as typed, unlike members.phone (0031), which carries a generated digits-only twin. Nothing matches a Station by telephone -- this number is read by a human off a screen -- so the formatting an operator types is the value worth keeping.';

comment on column public.companies.tagline is
  'The slogan under the name. Separate from `description` rather than the first line of it: a slogan cut out of a paragraph reads as a sentence that stops.';

alter table public.companies
  -- Identical to organizations_tax_id_shape (0154), down to the reasoning: the
  -- shape is asserted and the check digits are NOT. Mod-11 belongs in the
  -- application, and a well-formed-but-wrong CNPJ is a data-entry problem a
  -- human notices rather than a corruption the database must prevent.
  add constraint companies_tax_id_shape
    check (tax_id is null or tax_id ~ '^[0-9]{14}$'),

  -- Deliberately weak, exactly as organizations_fiscal_email_shape is: an
  -- address is all this asserts, because a stricter pattern refuses valid
  -- addresses and these columns are typed by an operator reading a contract.
  add constraint companies_fiscal_email_shape
    check (fiscal_email is null or fiscal_email like '%@%'),
  add constraint companies_contact_email_shape
    check (contact_email is null or contact_email like '%@%'),

  -- The four typed addresses take companies_thumb_shape's rule (0153, itself
  -- 0144's and 0145's), and for a reason that is not only tidiness: these four
  -- land in an href on the Station's card. A scheme-less value there is a
  -- relative link, and a `javascript:` one is worse. The caller prepends
  -- https:// when an operator omits it -- the same division of labour tax_id
  -- uses, where the application normalises and the database asserts.
  add constraint companies_website_shape
    check (website_url is null or website_url ~ '^https?://'),
  add constraint companies_instagram_shape
    check (instagram_url is null or instagram_url ~ '^https?://'),
  add constraint companies_facebook_shape
    check (facebook_url is null or facebook_url ~ '^https?://'),
  add constraint companies_youtube_shape
    check (youtube_url is null or youtube_url ~ '^https?://');

-- ---------------------------------------------------------------------------
-- update_company_profile gains the twelve.
--
-- DROP AND CREATE, NEVER `create or replace`. Twelve new parameters change the
-- signature, and `create or replace` cannot alter one: Postgres would keep BOTH
-- functions, and every existing eleven-argument caller would silently resolve to
-- the old body and write nothing new. 0047, 0055, 0102 and 0138 each hit that
-- trap and each answered it the same way.
--
-- Dropping resets the ACL, so the revoke/grant pair is restated below rather
-- than assumed to have survived.
--
-- The new twelve go AFTER the existing eleven, each `default null`. Order is
-- forced: a parameter with a default cannot precede one without, and every
-- caller that names its arguments is unaffected either way.
--
-- IT STILL TAKES NO p_thumb_url, AND STILL MUST NEVER GAIN ONE. Every field on
-- this list is written on every call, so a picture here would be cleared by the
-- next ordinary Save (0144, 0145, 0153). set_company_thumb remains its writer.
-- ---------------------------------------------------------------------------

drop function public.update_company_profile(
  uuid, text, text, text, text, text, text, text,
  public.broadcast_band, integer, numeric, numeric);

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
  p_fiscal_email           text default null
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

  select jsonb_build_object(
           'address_line', address_line, 'address_number', address_number,
           'address_complement', address_complement, 'neighbourhood', neighbourhood,
           'city', city, 'state', state, 'postal_code', postal_code,
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

comment on function public.update_company_profile is
  'Block 15, extended by Block 16. Replaces a Station''s address, band, frequency, coordinates, contact details, self-description and invoicing identity wholesale -- every field on every call, the convention update_prize and update_song follow. Takes NO p_thumb_url and must never gain one: that is precisely how a picture uploaded before a save would be cleared by it (0144, 0145). Name, timezone and status are not here either (D10). The invoicing fields are the Station''s own and are independent of organizations.billing_entity, which says who emits an invoice and never who has a legal identity (Block 16, D7). Gated on is_platform_admin().';

revoke execute on function public.update_company_profile(
  uuid, text, text, text, text, text, text, text,
  public.broadcast_band, integer, numeric, numeric,
  text, text, text, text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.update_company_profile(
  uuid, text, text, text, text, text, text, text,
  public.broadcast_band, integer, numeric, numeric,
  text, text, text, text, text, text, text, text, text, text, text, text) to authenticated;
