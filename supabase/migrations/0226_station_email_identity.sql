-- supabase/migrations/0226_station_email_identity.sql

-- Block 29b-1, Task 7. Who a Station's campaign mail comes from (design D4).
--
-- ON THE STATION, ONCE, rather than on every template. A Station with thirty
-- templates would otherwise carry thirty chances for the same address to be
-- wrong, and the operator creating the thirtieth would type it again. A
-- template may still override (message_templates.from_*, 0223); the ordinary
-- case sets nothing there.
--
-- NULLABLE, ALL THREE. A Station that has configured none falls back to the
-- installation's MAIL_FROM, which is already what invitations, password resets
-- and the health alert do.
--
-- NOT THE STATION'S EXISTING CONTACT E-MAIL, deliberately. They answer
-- different questions -- one is how to reach the radio, the other is what
-- address a campaign is sent from. They usually coincide and are not the same
-- thing, and the day a Station changes its commercial contact is not the day
-- thirty thousand e-mails should start arriving from a different sender.

alter table public.companies
  add column email_from_name    text,
  add column email_from_address text,
  add column email_reply_to     text;

-- Deliberately weak, and for companies_thumb_shape's (0153) reason: a stricter
-- pattern refuses valid addresses, and this column is typed by an operator
-- reading it off whatever their provider gave them.
alter table public.companies
  add constraint companies_email_from_shape
    check (email_from_address is null or email_from_address like '%@%'),
  add constraint companies_email_reply_to_shape
    check (email_reply_to is null or email_reply_to like '%@%');

comment on column public.companies.email_from_address is
  'What a campaign e-mail is sent AS for this Station, or null to fall back to the installation''s MAIL_FROM. DELIVERABILITY RESTS ON THE INSTALLATION''S DOMAIN (Block 29 brief, D5): the transport is one installation-wide SMTP, so an address on a domain the installation cannot sign with SPF and DKIM lands in spam. The warning belongs on the screen where this is chosen, which is why the field is here and not on thirty templates.';

-- ---------------------------------------------------------------------------
-- The door. THE GATE IS THE OWNER, not templates.manage.
--
-- templates.manage is a grant handed out for writing texts. This is the address
-- every campaign of the Station goes out as, and getting it wrong sends thirty
-- thousand e-mails from somewhere the recipients do not recognise. It is the
-- same predicate the pairing card is gated on (0218's own reasoning), and
-- is_owner_of_company (0044) is true for the platform admin as well, which is
-- the house convention and the intended reading for support.
-- ---------------------------------------------------------------------------
create function public.save_station_email_identity(
  p_company_id  uuid,
  p_from_name   text default null,
  p_from_address text default null,
  p_reply_to    text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  if not public.is_owner_of_company(p_company_id) then
    raise log 'save_station_email_identity denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: organization owner required' using errcode = '42501';
  end if;

  update public.companies
     set email_from_name    = nullif(btrim(p_from_name), ''),
         email_from_address = nullif(btrim(p_from_address), ''),
         email_reply_to     = nullif(btrim(p_reply_to), ''),
         updated_at         = now()
   where id = p_company_id and deleted_at is null
  returning organization_id into v_org;

  if v_org is null then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- The addresses themselves are in the detail: they are not secrets, they are
  -- what an audit reader asking "why did mail start arriving from there" needs.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_station_email_identity', 'companies', p_company_id, v_org, p_company_id,
     jsonb_build_object('from_address', nullif(btrim(p_from_address), ''),
                        'reply_to', nullif(btrim(p_reply_to), '')));
end;
$$;

revoke execute on function public.save_station_email_identity(uuid, text, text, text) from public;
grant execute on function public.save_station_email_identity(uuid, text, text, text) to authenticated;

comment on function public.save_station_email_identity(uuid, text, text, text) is
  'Sets who this Station''s campaign e-mail comes from. Gated on is_owner_of_company (0044) rather than on templates.manage: that grant is handed out for writing texts, and this is the address thirty thousand e-mails go out as. All three columns are clearable -- the form sets every field it takes on every call, so a blank means "fall back to the installation''s MAIL_FROM".';
