-- supabase/migrations/0154_organization_profile.sql

-- Block 16, design D2, D7, D8 and D5. The Organization gets a record of its own.
--
-- Until now `organizations` held a name and a timestamp, and the console showed
-- neither -- every row of the customers screen was a STATION, and the word
-- Organization appeared nowhere in the interface built entirely on it. The owner
-- found this on 2026-08-09, looking at four rows and being unable to tell four
-- customers from two customers with four radios without opening SQL.
--
-- The columns below are what a group needs to be a customer: an invoicing
-- identity, an address to invoice from, and a lock.

-- ---------------------------------------------------------------------------
-- Who issues the invoice. Design D7.
--
-- IT SAYS WHO EMITS, NEVER WHO HAS, and that distinction is the whole design.
-- A Station keeps its own razao social and CNPJ whatever this column says --
-- a radio has a legal identity of its own even when the group is the one that
-- bills, and blanking that field to model a preference would throw away a true
-- fact to store a setting. Nothing in this schema may read this value as
-- permission to clear a column.
-- ---------------------------------------------------------------------------

create type public.billing_entity as enum ('ORGANIZATION', 'STATIONS');

comment on type public.billing_entity is
  'Block 16, D7. Which record a human reads when billing this customer: the group''s, or each radio''s. It answers who emits and never who has -- both carry the data, always.';

alter table public.organizations
  -- The invoicing identity. `legal_name` is the razao social, which is not the
  -- `name` above it: one is what the group is called, the other is what it is
  -- called on a document.
  add column legal_name             text,
  add column tax_id                 text,
  add column municipal_registration text,
  add column fiscal_email           text,

  -- NOT NULL with a default, because every existing row needs an answer and
  -- STATIONS is the one that is true: nothing has ever been recorded at the
  -- group level, so the group cannot be the emitter until somebody says so.
  add column billing_entity public.billing_entity not null default 'STATIONS',

  -- The same seven names `members` (0031) and `companies` (0153) already use,
  -- so there is not a third address shape in one database and any formatter
  -- serves all three.
  add column address_line       text,
  add column address_number     text,
  add column address_complement text,
  add column neighbourhood      text,
  add column city               text,
  add column state              text,
  add column postal_code        text,

  -- Design D5. A NULLABLE TIMESTAMP RATHER THAN A SECOND STATUS ENUM.
  -- `companies` carries a `status` because it has since 0003; mirroring that
  -- shape here would mean a second enum with the same two values, named for the
  -- wrong table, and two things to keep in step for no gain.
  -- `suspended_at is not null` is the whole of the rule.
  add column suspended_at      timestamptz,
  add column suspended_by      uuid references auth.users (id),
  add column suspension_reason text;

comment on column public.organizations.legal_name is
  'The razao social, which is not `name`: one is what the group is called, the other is what it is called on a document.';

comment on column public.organizations.tax_id is
  'Block 16. Fourteen digits, punctuation stripped by the caller (src/lib/tax-id.ts), the way normalize_phone (0031) treats a telephone. The CHECK asserts the shape and DOES NOT verify the check digits: that is a mod-11 calculation, it belongs in the application, and a well-formed-but-wrong CNPJ is a data-entry problem a human notices rather than a corruption the database must prevent.';

comment on column public.organizations.municipal_registration is
  'The inscricao municipal, not a state one. Radio advertising is a servico, so it is the municipal registration that appears on an NFS-e; a state registration would be the field for goods, and this product sells none.';

comment on column public.organizations.suspended_at is
  'Block 16, D5. Set means the whole group is blocked -- the owner and every member, across every Station under it. Enforced in 0156, in BOTH has_company_access_for and is_owner_of_company_for; the second is the door the owner reaches a Station by, and it checked no status at all before that migration.';

alter table public.organizations
  add constraint organizations_tax_id_shape
    check (tax_id is null or tax_id ~ '^[0-9]{14}$'),

  -- The same pair shape every archival column in this schema uses (0148's
  -- revocation, 0057's deletion): a time AND a person, or neither. A block with
  -- no author is a block nobody can be asked about afterwards.
  add constraint organizations_block_shape
    check ((suspended_at is null) = (suspended_by is null)),

  -- Deliberately weak: an address is the only thing this checks for, because a
  -- stricter pattern refuses valid addresses and this column is typed by an
  -- operator reading it off a contract. `companies_thumb_shape` (0153) is weak
  -- for the same reason.
  add constraint organizations_fiscal_email_shape
    check (fiscal_email is null or fiscal_email like '%@%');
