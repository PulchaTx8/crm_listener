-- supabase/migrations/0265_listener_locale.sql

-- Block 30d, item 2 (D6, D7). The language a Station's widget renders in for
-- its LISTENERS, distinct from the language its own operators read the
-- console in.
--
-- NAMED listener_locale AND NOT locale, on purpose. profiles.locale (0135)
-- keeps painting the console, by the owner's ruling of 2026-08-21: a Station
-- decides what its listeners read, not what its operators read. A column
-- called `locale` sitting on companies is an invitation for the next person
-- to wire the console to it, and the name is the cheapest guard against that.
--
-- Nullable, and null means today's behaviour -- the widget falls back to the
-- ordinary resolution. A Station that never chooses is not broken by this.
alter table public.companies
  add column listener_locale text
  constraint companies_listener_locale_supported
    check (listener_locale is null or listener_locale in ('en', 'pt', 'es'));

comment on column public.companies.listener_locale is
  'The language this Station''s widget renders in, ISO 639-1, restricted to the catalogues that exist (the same set profiles_locale_supported names, 0135). Block 30d, item 2. It governs what a LISTENER reads and nothing an operator reads: the console stays on profiles.locale. Null means the widget resolves language the way it did before this block -- cookie, then Accept-Language.';

-- The door, mirroring set_service_hashtags (0177:41-59): security definer,
-- gated on templates.manage -- the same permission the system texts and the
-- two service hashtags on the same screen carry, because /messages/promo is
-- already where what a listener reads is decided.
--
-- NO P0002 HERE, unlike set_service_hashtags. That door fails with P0002
-- because widget_installations is a row a Station may not have (creating one
-- is a console act, 0159) -- but this column sits on companies itself, and
-- has_permission already refused any p_company_id the caller does not hold
-- templates.manage at, so an UPDATE that reaches this line always has a row
-- to match: a Station always exists.
create function public.set_listener_locale(p_company_id uuid, p_locale text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_locale text := nullif(btrim(coalesce(p_locale, '')), '');
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'set_listener_locale denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- The CHECK above is the backstop for any writer that is not this door. This
  -- raise exists so the screen has a sentence to show: a constraint violation
  -- surfaces as raw Postgres text naming companies_listener_locale_supported,
  -- and the promo screen maps 42501/22023 to sentences an operator reads.
  if v_locale is not null and v_locale not in ('en', 'pt', 'es') then
    raise exception 'that language has no catalogue' using errcode = '22023';
  end if;

  update public.companies set listener_locale = v_locale, updated_at = now()
   where id = p_company_id;
end;
$$;

revoke execute on function public.set_listener_locale(uuid, text) from public;
grant execute on function public.set_listener_locale(uuid, text) to authenticated;

comment on function public.set_listener_locale(uuid, text) is
  'Sets the language this Station''s widget renders in. Gated on templates.manage, the same permission the system texts and the two service hashtags on the same screen carry -- that screen is where what a listener reads is decided. An empty value clears the choice, which returns the widget to the ordinary resolution.';

-- ---------------------------------------------------------------------------
-- widget_frame_context, recreated from its LIVE body (0164:83-107 -- the only
-- create-or-replace since 0161 introduced it; 0178, 0185 and 0263 reference
-- the function in comments but never redefine it). Confirmed by dumping
-- `pg_get_functiondef('public.widget_frame_context'::regproc)` against the
-- local database rather than trusted from this sentence, on Block 30d's own
-- rule that a re-derived body silently reverts every repair made since.
--
-- ONE KEY ADDED: listenerLocale. This is the door and not
-- widget_station_identity (0185), which already answers the Station's name
-- and logo -- because src/app/(widget)/w/[publicKey]/page.tsx:129 calls the
-- identity door ONLY when the presentation is 'app', so an embedded widget,
-- the product's whole point, would never receive a language carried there.
-- widget_frame_context is what installationExists calls on EVERY widget
-- request in BOTH presentations, which makes it the only door that always
-- runs.
--
-- Adding this key is safe for the Edge middleware that also reads this
-- answer: src/lib/widget/frame-cache.ts's readOrigins destructures only
-- `found` and `origins` out of the body and never enumerates the object's
-- keys, so a third key present in the JSON is invisible to it.
--
-- A REFUSAL CARRIES A NULL LANGUAGE, the same way it carries an empty origins
-- list: one answer for five causes (an unknown key, a disabled installation,
-- an archived one, a SUSPENDED Station, a BLOCKED Organization) is still the
-- rule this function exists to keep, and a language leaking out of that
-- refusal branch would be a sixth, distinguishable answer.
-- ---------------------------------------------------------------------------
create or replace function public.widget_frame_context(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'origins', to_jsonb(w.allowed_origins),
              'listenerLocale', c.listener_locale)
       from public.widget_installations w
       join public.companies c
         on c.id = w.company_id
        and c.deleted_at is null
        and c.status = 'active'
       join public.organizations o
         on o.id = w.organization_id
        and o.suspended_at is null
      where w.public_key = p_public_key
        and w.enabled
        and w.deleted_at is null),
    jsonb_build_object('found', false, 'origins', '[]'::jsonb, 'listenerLocale', null));
$$;

comment on function public.widget_frame_context(text) is
  'The origins one installation may be framed by, for the Edge middleware to build frame-ancestors from, and (Block 30d, D7) the language its widget renders in for listeners. Answers {"found": false, "origins": [], "listenerLocale": null} for an unknown key, a disabled installation, an archived one, a SUSPENDED Station and a BLOCKED Organization alike -- one answer for five causes, so probing learns nothing (a distinct reason here would publish a customer''s billing status to anybody loading their home page), and so the caller has exactly one refusal branch to get right. The last two joins are 0164: without them a Station suspended for non-payment went on being framed until somebody remembered to disable the installation by hand. listenerLocale rides here rather than on widget_station_identity (0185) because this is the door installationExists calls on EVERY widget request in BOTH presentations -- page.tsx calls the identity door only when the presentation is app, so an embedded widget, the whole point of the product, would never receive a language carried there. A null listenerLocale -- an unset choice, same as a refusal -- means the widget resolves language the way it did before this block. GRANTED TO anon deliberately (spec Sec.4.3): the middleware holds the anon key and runs before any session exists.';
