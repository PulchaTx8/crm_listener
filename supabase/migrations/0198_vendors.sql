-- supabase/migrations/0198_vendors.sql

-- Block 24, item 7: who the prizes came from.
--
-- An entry has carried an invoice number, a unit price and a total since Block
-- 23 and no supplier — so "what did we buy from Camisetas do Sul in July" is a
-- question the ledger holds every part of except the name. This table is that
-- name, as a record rather than as text retyped onto every entry.
--
-- STATION-SCOPED, like `prizes` and `prize_categories` beside it. A supplier is
-- somebody a particular radio buys from; two stations under one Organization
-- negotiating with the same company still each keep their own contact, their
-- own history and their own paperwork.

create table public.vendors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,

  -- The only required field. Everything else is paperwork that arrives at a
  -- different time from the supplier: an operator recording an entry at eight in
  -- the evening should be able to write down who it came from without first
  -- finding their CNPJ.
  name          text not null,
  legal_name    text,
  -- CNPJ or CPF, as typed. Unvalidated and unformatted ON PURPOSE: this product
  -- already learned on `members.cpf` that a document column with a format rule
  -- refuses the foreign supplier, the one whose paperwork is still coming, and
  -- the one whose number was typed with a stray space. What it is FOR is
  -- matching an invoice by eye, and a human reads a stray space fine.
  document      text,

  contact_name  text,
  phone         text,
  email         text,

  address_line  text,
  city          text,
  state         text,
  postal_code   text,
  website       text,

  notes         text,

  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft, and it has to be: an entry points at a vendor, and a supplier that
  -- vanished would take a purchase's history with it. Archiving is refused for
  -- nothing — a vendor with a hundred entries behind it archives fine and those
  -- entries go on naming it, the same way archive_song is never refused over a
  -- live request (0101).
  deleted_at timestamptz,

  constraint vendors_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  constraint vendors_name_not_blank check (btrim(name) <> '')
);

comment on table public.vendors is
  'Who a Station buys or barters prizes from. Named by inventory_movements.vendor_id on entry movements (0200). Station-scoped like prizes; soft-deleted, because a movement points at one.';
comment on column public.vendors.document is
  'CNPJ or CPF as typed. Deliberately unvalidated and unformatted: its purpose is matching an invoice by eye, and a format rule refuses the foreign supplier and the one whose paperwork has not arrived.';

-- Two live suppliers with the same name in one Station is a data-entry error
-- rather than a case, and the operator who is about to create the second one is
-- the person best placed to notice. Partial, so archiving one frees its name.
create unique index vendors_name_unique
  on public.vendors (company_id, lower(name))
  where deleted_at is null;

create index vendors_company_idx on public.vendors (company_id) where deleted_at is null;

-- For 0200's composite foreign key: a movement cannot name a vendor belonging to
-- another Station. Non-partial, because a foreign key cannot reference a partial
-- index — which is exactly why archival needs its own explicit check inside the
-- door, the same pairing 0025 spells out for prizes.
alter table public.vendors add constraint vendors_id_company_unique unique (id, company_id);

-- RLS ------------------------------------------------------------------------

alter table public.vendors enable row level security;

revoke all on public.vendors from anon, authenticated;

-- READ GATE ONLY. Every write goes through 0199's two doors, so there is no
-- insert, update or delete policy — a grant here would be a second, unaudited
-- way to rewrite a Station's supplier list.
--
-- `deleted_at is null` at the POLICY, the convention every soft-deleted table in
-- this project uses (0006's companies, 0019's roles, 0029's prizes), so an
-- ordinary PostgREST select cannot list archived rows because whoever writes the
-- next screen forgot to filter them.
--
-- ITS CONSEQUENCE IS THE SAME ONE 0099 RECORDS: an archived vendor is not merely
-- hidden, it is UNREADABLE through RLS for every caller. So this block ships no
-- "show archived" filter on the Vendors screen — the same choice the inventory
-- and catalogue screens already make — and archive_vendor reads its own row from
-- inside a SECURITY DEFINER body, where this policy never applies.
grant select on public.vendors to authenticated;

create policy vendors_select_inventory_view on public.vendors
  for select to authenticated
  using (deleted_at is null and public.has_permission('inventory.view', company_id));

-- service_role needs an explicit grant: the default ACL gives it only Dxtm and
-- BYPASSRLS does not substitute for a GRANT (Block 1a §3.9) — a table missing
-- this fails at runtime rather than at deploy time. Read-only, because both
-- doors are SECURITY DEFINER and run as the table owner.
grant select on public.vendors to service_role;

-- `revoke all` above only ran against anon/authenticated, so service_role kept
-- the default ACL's TRUNCATE grant: no INSERT, UPDATE or DELETE, so nothing
-- above closes it, and one statement would empty a Station's supplier list.
-- 0029 closed exactly this on the inventory ledger and 0099 on the catalogue;
-- it is closed here before anybody has to find it a third time.
revoke truncate on public.vendors from service_role;
