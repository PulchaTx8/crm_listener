-- supabase/migrations/0199_vendor_doors.sql

-- The two ways a vendor is written. Both SECURITY DEFINER, because 0198 grants
-- `authenticated` nothing but SELECT.
--
-- NO NEW PERMISSION, and that is a decision rather than an omission (design D6).
-- `inventory.view` reads and `inventory.catalogue` writes — the same pair that
-- already governs prizes and prize categories, which is what a vendor sits
-- beside. A `vendors.*` pair is not two rows in a table: it is a permissions
-- migration, the roles screen, every seeded role, PERMISSIONS.md, and above all
-- EVERY ROLE A CUSTOMER HAS ALREADY CONFIGURED, none of which would grant it.
-- Shipping this screen behind a permission nobody holds would hide it from
-- everyone. Block 18 recorded the same reasoning for /shows.

-- The catalogue permission now covers one more kind of record, so it says so.
-- The roles screen reads these two columns directly, so a description left
-- behind would promise a narrower power than the code grants.
update public.permissions
   set description = 'Register, edit and archive prizes, categories and vendors',
       label       = 'Register, edit and archive prizes, categories and vendors'
 where code = 'inventory.catalogue';

create function public.save_vendor(
  p_company_id   uuid,
  p_name         text,
  p_legal_name   text default null,
  p_document     text default null,
  p_contact_name text default null,
  p_phone        text default null,
  p_email        text default null,
  p_address_line text default null,
  p_city         text default null,
  p_state        text default null,
  p_postal_code  text default null,
  p_website      text default null,
  p_notes        text default null,
  -- Last and defaulted, so omitting it is what means "register a new one" —
  -- the commoner call, and the one whose intent should read at the call site
  -- rather than as a bare null in the middle of thirteen arguments. The shape
  -- save_promotion_question and save_show both use.
  p_vendor_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid := p_vendor_id;
  v_name  text := nullif(btrim(coalesce(p_name, '')), '');
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Permission before existence, the house order: a caller who may not write
  -- here learns that, and learns nothing about which vendors this Station has.
  if not public.has_permission('inventory.catalogue', p_company_id) then
    raise log 'save_vendor denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the vendor needs a name' using errcode = '22023';
  end if;

  if v_id is null then
    insert into public.vendors
      (organization_id, company_id, name, legal_name, document, contact_name,
       phone, email, address_line, city, state, postal_code, website, notes,
       created_by)
    values
      (v_org, p_company_id, v_name,
       nullif(btrim(coalesce(p_legal_name, '')), ''),
       nullif(btrim(coalesce(p_document, '')), ''),
       nullif(btrim(coalesce(p_contact_name, '')), ''),
       nullif(btrim(coalesce(p_phone, '')), ''),
       nullif(btrim(coalesce(p_email, '')), ''),
       nullif(btrim(coalesce(p_address_line, '')), ''),
       nullif(btrim(coalesce(p_city, '')), ''),
       nullif(btrim(coalesce(p_state, '')), ''),
       nullif(btrim(coalesce(p_postal_code, '')), ''),
       nullif(btrim(coalesce(p_website, '')), ''),
       nullif(btrim(coalesce(p_notes, '')), ''),
       v_actor)
    returning id into v_id;
  else
    -- WHOLESALE REPLACE, the convention update_prize, update_role and save_show
    -- already use: every field is written from what arrived, so a box the
    -- operator cleared is cleared rather than kept. The screen posts the whole
    -- record on every save, which is what makes that safe.
    --
    -- `deleted_at is null` in the WHERE rather than as a separate check: an
    -- archived vendor is not editable, and the P0002 below is the same answer an
    -- unknown id gets. `company_id` in the WHERE is the tenancy proof — a
    -- caller-supplied uuid naming another Station's vendor must not match, and
    -- checking it here rather than trusting the permission above is what makes
    -- that true rather than merely unlikely.
    update public.vendors set
      name         = v_name,
      legal_name   = nullif(btrim(coalesce(p_legal_name, '')), ''),
      document     = nullif(btrim(coalesce(p_document, '')), ''),
      contact_name = nullif(btrim(coalesce(p_contact_name, '')), ''),
      phone        = nullif(btrim(coalesce(p_phone, '')), ''),
      email        = nullif(btrim(coalesce(p_email, '')), ''),
      address_line = nullif(btrim(coalesce(p_address_line, '')), ''),
      city         = nullif(btrim(coalesce(p_city, '')), ''),
      state        = nullif(btrim(coalesce(p_state, '')), ''),
      postal_code  = nullif(btrim(coalesce(p_postal_code, '')), ''),
      website      = nullif(btrim(coalesce(p_website, '')), ''),
      notes        = nullif(btrim(coalesce(p_notes, '')), ''),
      updated_at   = now()
    where id = v_id and company_id = p_company_id and deleted_at is null;

    if not found then
      raise exception 'vendor not found: %', v_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_vendor', 'vendors', v_id, v_org, p_company_id,
     jsonb_build_object('created', p_vendor_id is null));

  return v_id;
end;
$$;

comment on function public.save_vendor is
  'Registers or edits a prize supplier. Gated on inventory.catalogue. Wholesale replace on edit, so a cleared box clears the column — the screen posts the whole record every time. The name is the one required field; 22023 without it, and 23505 from vendors_name_unique when another live vendor of this Station already has it. An archived vendor is not editable and answers P0002, the same as an unknown id.';

create function public.archive_vendor(p_vendor_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  -- The Station is READ FROM THE ROW rather than accepted from the caller, so
  -- there is no argument to disagree with the row it names — the shape
  -- archive_promotion and remove_promotion_question both use, and the reason
  -- this door takes one argument where save_vendor takes fourteen.
  select organization_id, company_id into v_org, v_company
    from public.vendors
   where id = p_vendor_id and deleted_at is null
     for update;

  if not found then
    raise exception 'vendor not found: %', p_vendor_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.catalogue', v_company) then
    raise log 'archive_vendor denied: actor=% vendor=%', v_actor, p_vendor_id;
    raise exception 'permission denied: inventory.catalogue required' using errcode = '42501';
  end if;

  -- NOT REFUSED OVER THE ENTRIES THAT NAME IT, deliberately. A purchase from a
  -- supplier the Station has stopped using is a historical fact that outlives
  -- the relationship, exactly as a request outlives the song it names (0101's
  -- own comment). The movements go on pointing at the row and the ledger goes on
  -- reading; what changes is that nobody can choose it for a new entry.
  update public.vendors
     set deleted_at = now(),
         updated_at = now()
   where id = p_vendor_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_vendor', 'vendors', p_vendor_id, v_org, v_company, '{}'::jsonb);
end;
$$;

comment on function public.archive_vendor(uuid) is
  'Archives a supplier. Gated on inventory.catalogue, resolved from the row rather than from an argument. Never refused over the entries that name it — a purchase outlives the relationship, and those movements go on pointing at the row; what changes is that the picker stops offering it. An already-archived vendor answers P0002, because 0198''s select policy hides it from every ordinary read too.';

revoke execute on function public.save_vendor(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, uuid
) from public;
revoke execute on function public.archive_vendor(uuid) from public;

grant execute on function public.save_vendor(
  uuid, text, text, text, text, text, text, text, text, text, text, text, text, uuid
) to authenticated;
grant execute on function public.archive_vendor(uuid) to authenticated;
