-- supabase/migrations/0031_members.sql

-- The audience. Organization-scoped: the same person entering a promotion at two of
-- the group's Stations is one row, deduplicated once. Which Stations may see them is
-- member_company_links' business, not this table's.
create table public.members (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id),

  full_name           text,
  phone               text,
  email               text,
  -- Generated, never hand-maintained. A normalisation applied by whoever remembers
  -- is a normalisation that drifts, and these columns ARE identity — if two
  -- spellings of one number normalise differently, deduplication silently stops
  -- working and the duplicates look legitimate.
  phone_normalized    text generated always as (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) stored,
  email_normalized    text generated always as (nullif(lower(trim(coalesce(email, ''))), '')) stored,

  -- The raw CPF is hashed in Node before it ever reaches here, the same way Block 1b
  -- handles an invitation token: an argument passed to an RPC lands in query logs and
  -- in backups. cpf_last_digits is what a person confirms against out loud.
  cpf_hash            text,
  cpf_last_digits     text check (cpf_last_digits is null or cpf_last_digits ~ '^[0-9]{3}$'),
  passport            text,

  birth_date          date,

  address_line        text,
  address_number      text,
  address_complement  text,
  neighbourhood       text,
  city                text,
  state               text,
  postal_code         text,

  discovery_source    text,

  -- The evidence behind the owner's decision that a Member who messages the Station
  -- first has authorised the reply. Block 5 reads this; nothing else does yet.
  first_contact_at    timestamptz,
  first_contact_origin text,

  anonymized_at       timestamptz,

  created_by          uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

comment on table public.members is 'The audience. Organization-scoped identity; per-Station visibility lives in member_company_links.';
comment on column public.members.cpf_hash is 'SHA-256 of the normalised CPF, hashed in Node. The raw number is stored nowhere and appears in no query log.';
comment on column public.members.anonymized_at is 'Set by anonymize_member. The row survives so participations and deliveries still reference something; the person does not.';

-- Identity, per Organization. Each carries `and <column> is not null` so two Members
-- without an e-mail do not collide with each other — the trap a bare partial index
-- on a nullable column walks into.
create unique index members_phone_unique
  on public.members (organization_id, phone_normalized)
  where deleted_at is null and phone_normalized is not null;
create unique index members_email_unique
  on public.members (organization_id, email_normalized)
  where deleted_at is null and email_normalized is not null;
create unique index members_cpf_unique
  on public.members (organization_id, cpf_hash)
  where deleted_at is null and cpf_hash is not null;
create unique index members_passport_unique
  on public.members (organization_id, lower(passport))
  where deleted_at is null and passport is not null;

create index members_org_idx on public.members (organization_id) where deleted_at is null;
create index members_name_idx on public.members (organization_id, lower(full_name)) where deleted_at is null;

alter table public.members add constraint members_id_org_unique unique (id, organization_id);

-- What RLS reads. The composite keys make a link between a Member of one
-- Organization and a Station of another unrepresentable.
create table public.member_company_links (
  member_id       uuid not null,
  company_id      uuid not null,
  organization_id uuid not null,
  linked_at       timestamptz not null default now(),
  linked_by       uuid references auth.users (id),
  primary key (member_id, company_id),
  constraint member_links_member_org_fk
    foreign key (member_id, organization_id) references public.members (id, organization_id),
  constraint member_links_company_org_fk
    foreign key (company_id, organization_id) references public.companies (id, organization_id)
);

create index member_links_company_idx on public.member_company_links (company_id);

insert into public.permissions (code, description, introduced_by_block, module, label, scope, display_order) values
  ('members.view',    'Read the audience and their history',        '3', 'members', 'See the audience and their history',            'company', 10),
  ('members.create',  'Register a listener and link them here',     '3', 'members', 'Register a listener and link them to this Station', 'company', 20),
  ('members.edit',    'Edit a listener, record consent, add notes', '3', 'members', 'Edit a listener, record consent and add notes', 'company', 30),
  ('members.block',   'Bar a listener from draws, or suspend them', '3', 'members', 'Bar a listener from draws, or suspend them',    'company', 40),
  ('members.archive', 'Archive a listener',                         '3', 'members', 'Archive a listener',                            'company', 50),
  ('members.erase',   'Erase a listener''s personal data',          '3', 'members', 'Erase a listener''s personal data permanently',  'company', 60);
