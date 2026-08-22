-- supabase/migrations/0272_platform_person.sql

-- THE PLATFORM PERSON. One row per human, across every Organization.
--
-- IT HOLDS NO ATTRIBUTE, and that is the decision the whole model rests on
-- (design D2). A name here would be a golden record two Stations could disagree
-- about -- "João" at one and "Joãozinho da Padaria" at the other -- and the
-- product would then need a rule for who wins, plus a screen for exercising it.
-- With identity here and everything descriptive on the Station's own profile,
-- there is nothing to disagree about and no rule to write.
--
-- It also means exactly TWO columns in this database reference this table:
-- person_identifiers.person_id and members.person_id (0273). That is what makes
-- merging two person rows cheap, which is what lets the backfill (0274) merge
-- instead of retiring anybody -- the owner's ruling D20 asks for exactly that,
-- and this table's emptiness is what makes it free rather than expensive.
create table public.people (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.people is
  'One human, platform-wide. Identity only: every attribute lives on the Station profile that collected it (design D2), so there is no golden record for two Stations to disagree about. Exactly two columns in this database reference it, which is what makes merging two rows cheap enough that the backfill never has to retire a profile instead.';

create type public.person_identifier_kind as enum ('PHONE', 'EMAIL', 'CPF', 'PASSPORT');

-- AN IDENTIFIER IS A CLAIM, not a column (design D13). As a column, two people
-- end up asserting one telephone and the unique index decides by accident of
-- arrival -- the one who got there first wins, even when they are the one who
-- left. As a row with a validity, the old number closes with a date, the new
-- holder enters clean, and the closed row goes on explaining the past without
-- competing for the present.
--
-- P3 adds the WhatsApp identity key against these rows. Built as rows here
-- rather than as columns to be converted there, because both D2 and D13 already
-- describe an identifier as a claim: columns first would be built and demolished.
create table public.person_identifiers (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id),
  kind        public.person_identifier_kind not null,
  value       text not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),

  constraint person_identifiers_value_shape
    check (btrim(value) <> ''),
  constraint person_identifiers_validity_shape
    check (valid_to is null or valid_to >= valid_from)
);

-- THE ONE CONTRADICTION THIS MODEL REFUSES: two PEOPLE holding one live value.
-- Everything else is permitted, including one person holding two live telephones
-- (ordinary -- D13 exists because people change numbers) and one person holding
-- two live CPFs (bad data, and D20 says keep both rather than retire a profile
-- over it: a second CPF is worth reporting, not worth destroying a Station's
-- history for).
--
-- Partial on valid_to, the same shape 0031's own identity indexes take against
-- deleted_at, and for the same reason: a claim that has ended has no identity
-- left to defend and no business occupying an index built to catch collisions.
create unique index person_identifiers_live_unique
  on public.person_identifiers (kind, value)
  where valid_to is null;

create index person_identifiers_person_idx
  on public.person_identifiers (person_id)
  where valid_to is null;

comment on table public.person_identifiers is
  'One claim: this person asserted this telephone, e-mail, CPF hash or passport, from this instant until that one. Several live claims of one kind are allowed -- a person changes telephone (design D13), and bad data gives one person two CPFs, which D20 says to keep rather than retire a profile over. Two PEOPLE holding one live value is the single thing person_identifiers_live_unique forbids, and merging the two into one is how resolution answers it (0273).';

comment on column public.person_identifiers.valid_to is
  'When this claim stopped being the person''s. Null means live. Set rather than deleted, so the row goes on explaining a number that changed hands without competing for it -- which is the whole difference between a claim and a column.';

-- Both tables name a listener, so both follow the rule 0178_widget_link_tokens
-- states for every table here that does: RLS on with NO POLICY and the ACL
-- revoked, reachable only from inside a SECURITY DEFINER body.
alter table public.people enable row level security;
alter table public.person_identifiers enable row level security;

revoke all on public.people from anon, authenticated;
revoke all on public.person_identifiers from anon, authenticated;
