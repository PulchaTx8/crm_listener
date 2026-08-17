-- supabase/migrations/0218_station_whatsapp_status.sql

-- Block 29a, and the one thing the pairing card could not do from its new home.
--
-- The card that starts Meta's Embedded Signup moved off /templates/whatsapp and
-- into the Station's own record on /app, where the Organization OWNER can reach
-- it. That much needed no migration. What did: an owner who finishes the flow
-- at Meta and comes back has no way to tell whether it landed.
--
-- integrations (0057) has RLS enabled and NO POLICIES, deliberately -- it is
-- reachable only through SECURITY DEFINER functions -- and every one of 0130's
-- three doors opens on is_platform_admin(). So before this file, the answer to
-- "is this Station connected?" existed in the database and was readable by
-- nobody except the platform operator. The owner clicked a button, was sent to
-- Meta, came back to the same screen unchanged, and had to ask support whether
-- it had worked.
--
-- THAT SILENCE IS THE FAILURE MODE THIS PRODUCT KEEPS PAYING FOR. A pairing that
-- did not happen and a pairing nobody reports look identical, and the cost lands
-- days later on a listener whose message is never answered.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN. Not phone_number_id and not waba_id:
-- both are Meta's internal identifiers, both are what an operator would paste
-- into a support ticket rather than read, and neither answers the owner's
-- question. The console keeps showing them (list_integrations, 0130) because
-- diagnosing a mis-typed id is exactly the platform operator's job. What an
-- owner needs is three facts: is there a connection, which number is it, and is
-- it switched on.
--
-- NO SECRET IS RETURNED, and none could be: 0057 stores none. The three Meta
-- credentials are installation-wide environment variables (0130, D5/D7), which
-- is the same reason this function can be safe for an owner to call at all.

create function public.station_whatsapp_status(p_company_id uuid)
returns table (
  connected            boolean,
  display_phone_number text,
  enabled              boolean,
  updated_at           timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  -- THE SAME PREDICATE THE CARD IS GATED ON, and it must stay the same one.
  -- is_owner_of_company (0044) is true for the Organization owner and for the
  -- platform admin -- the house convention every other caller of it accepts,
  -- and the reading Block 29a's screen relies on: support reaching this on a
  -- customer's behalf is intended, not a leak. A screen that shows the button
  -- but refuses the status would be worse than either alone.
  if not public.is_owner_of_company(p_company_id) then
    raise log 'station_whatsapp_status denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: organization owner required'
      using errcode = '42501';
  end if;

  -- ONE ROW ALWAYS, never zero. A Station with no integration is the ordinary
  -- state of every Station before somebody pairs it, and it is the state this
  -- screen exists to help leave -- so it is answered with connected = false
  -- rather than with an empty result the caller has to interpret. An empty
  -- result and a failed call look the same from TypeScript, and that is exactly
  -- the confusion this block is closing at the other end.
  --
  -- LEFT JOIN off `companies` rather than selecting from `integrations`, for
  -- that reason: the row that always exists is the Station's.
  return query
  select
    i.id is not null,
    i.display_phone_number,
    -- coalesce, so the column means "sending is switched on" and never "unknown".
    -- A Station with no integration is not enabled, and null here would put a
    -- third state into a boolean that has no third state on screen.
    coalesce(i.enabled, false),
    i.updated_at
  from public.companies c
  left join public.integrations i
    on i.company_id = c.id
   and i.provider = 'WHATSAPP'
   and i.deleted_at is null
  where c.id = p_company_id
    and c.deleted_at is null;
end;
$$;

comment on function public.station_whatsapp_status(uuid) is
  'Block 29a. Whether this Station is paired with WhatsApp, which number, and whether sending is switched on -- for the ORGANIZATION OWNER, gated on is_owner_of_company (0044) rather than on is_platform_admin like 0130''s three doors. It exists because the pairing card moved into the owner''s reach in Block 29a and the status did not follow: integrations (0057) has RLS with no policies, so before this the owner could start a pairing and never learn whether it succeeded. Returns exactly one row for a live Station, connected = false when nothing is paired, because an empty result is indistinguishable from a failed call at the caller. Deliberately withholds phone_number_id and waba_id: they answer the platform operator''s question, not the owner''s, and list_integrations (0130) still carries them for that.';

revoke execute on function public.station_whatsapp_status(uuid) from public;
grant execute on function public.station_whatsapp_status(uuid) to authenticated;
