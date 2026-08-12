-- supabase/migrations/0185_widget_station_identity.sql

-- Block 19b, Task 1. Who a widget belongs to, for the header the application
-- presentation draws above the panels.
--
-- WHY A DOOR AND NOT A TABLE READ. `widget_installations` carries RLS with no
-- policy and its ACL revoked (0159, whose own comment records that even
-- `createServiceClient().from('widget_installations')` fails with 42501), so
-- every reader of it is inside a SECURITY DEFINER body. `companies` is
-- readable, but resolving a public key to a company is precisely the step that
-- needs the revoked table.
--
-- THE FIVE JOINS ARE 0164's, COPIED RATHER THAN SUMMARISED. An unknown key, a
-- disabled installation, an archived one, a SUSPENDED Station and a BLOCKED
-- Organization all answer `found: false`. A distinct reason per cause would
-- publish a customer's billing status to anybody who loads their home page --
-- 0164's argument, and it applies here unchanged because this door answers the
-- same anonymous visitor from the same public key.
--
-- WHAT THIS PUBLISHES, STATED RATHER THAN ASSUMED: a caller holding a public
-- key learns a Station's name, its picture and its WhatsApp number. All three
-- are already on the Station's own website -- the website whose page carries
-- that public key in an <iframe src> (0159's column comment says the key
-- travels there). The key proves nothing here it did not already prove.

create function public.widget_station_identity(p_public_key text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(
    (select jsonb_build_object(
              'found', true,
              'name', c.name,
              'thumb_url', c.thumb_url,
              -- A SCALAR SUBQUERY RATHER THAN A SIXTH JOIN, because a Station
              -- with no integration must still be found: joining would turn
              -- "no WhatsApp number" into "no such widget", which is the one
              -- direction this must not fail in. At most one row can match --
              -- integrations_one_per_company (0057) is unique on
              -- (company_id, provider) where deleted_at is null.
              'whatsapp_number', (
                select i.display_phone_number
                  from public.integrations i
                 where i.company_id = c.id
                   and i.provider = 'WHATSAPP'
                   and i.enabled
                   and i.deleted_at is null))
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
    jsonb_build_object(
      'found', false, 'name', null, 'thumb_url', null, 'whatsapp_number', null));
$$;

revoke execute on function public.widget_station_identity(text) from public;
grant execute on function public.widget_station_identity(text) to anon, service_role;

comment on function public.widget_station_identity(text) is
  'The Station name, picture and WhatsApp number behind one public key, for the header the widget draws when it is opened outside an iframe (Block 19b, D2). Answers {"found": false} with every field null for an unknown key, a disabled installation, an archived one, a SUSPENDED Station and a BLOCKED Organization alike -- one answer for five causes, so probing learns nothing and the caller has one refusal branch to get right; a distinct reason would publish a customer''s billing status to anybody loading their home page (0164). whatsapp_number is null when the Station has no WhatsApp integration, when it is switched off, and when the operator never typed a number in -- the header still draws, and the farewell simply omits its button back to the conversation. GRANTED TO anon deliberately: the caller is the widget page serving an anonymous visitor, the same reason widget_frame_context is (0161).';
