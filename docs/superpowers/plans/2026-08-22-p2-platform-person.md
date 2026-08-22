# P2 — the platform person: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One row per human across the whole platform, holding identifiers and
nothing else, with every Station profile pointing at one — so that two profiles
of the same person in different Organizations are knowably the same person.

**Architecture:** `people` holds identity and no attributes. `person_identifiers`
holds each identifier as a **claim row** with a validity, because D2 calls them
"identifying claims" and D13 opens with "a claim is a row" — building them as
columns here and converting them in P3 would be building and demolishing.
`members` gains `person_id` and keeps everything else exactly as it is: the name
that Station knows, the birthday it confirmed, the consent it collected. All four
doors that register a listener already funnel through one body,
`apply_member_creation` — named for the file that introduced it, `0061`, and
actually defined in `0213_country.sql:210` since that migration dropped and
recreated it — so attaching a person lands in one place and cannot drift.

**Tech Stack:** PostgreSQL / PL/pgSQL, Supabase migrations, pgTAP.

**Spec:** `docs/superpowers/specs/2026-08-22-station-root-and-platform-identity-design.md`
— block **P2** of §11; decisions **D2**, **D13** and **D20**.

## Global Constraints

- **Everything in English** — identifiers, comments, error messages, docs, commit
  messages.
- **Never edit a merged migration in place.** Corrections are re-issued from the
  new migration. Where a function must change, its body is copied forward from
  the migration holding the **live** definition, never from the first one.
- **`people` and `person_identifiers` name a listener**, so both follow the rule
  `0178_widget_link_tokens.sql:49` states for every listener-bearing table here:
  **RLS on, no policy at all, ACL revoked**, reachable only from inside a
  `SECURITY DEFINER` body.
- **No personal attribute reaches `people`.** No name, no birthday, no address,
  no discovery source. If a later block wants one there, it is contradicting D2
  and must say so.
- **Migration numbers `0272`–`0275`.** The highest on `main` is
  `0271_suspended_station_gate.sql`.
- **Run `npm run db:reset` before `npm run db:test`.** The e2e and isolation
  suites leave the local database dirty and produce false reds otherwise.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/0272_platform_person.sql` (create) | `people`, `person_identifiers`, the kind enum, the live-uniqueness index, RLS and ACL. Nothing reads them yet. |
| `supabase/migrations/0273_person_resolution.sql` (create) | `members.person_id`, `resolve_or_attach_person`, and `apply_member_creation` copied forward with one call added. |
| `supabase/migrations/0274_person_backfill.sql` (create) | Every live profile gets a person; bridging profiles merge two person rows into one. D20's rule lives here. |
| `supabase/migrations/0275_person_id_required.sql` (create) | `members.person_id` becomes `not null`. The guarantee, taken only once the three above have proved themselves. |
| `supabase/tests/76_platform_person.test.sql` (create) | The whole block's assertions. New file rather than appended to `06_whatsapp`, because this is not the bot's door — it is identity, and four doors share it. |

**No TypeScript changes.** Nothing in `src/` reads `people`, and
`apply_member_creation` keeps its signature and its return type, so every caller
is untouched. `npm run db:types` will add the two tables to
`database.types.ts`; regenerate it in Task 4 so the file matches the schema.

---

## Design decisions this plan fixes, and why

**A person with no claims is still a person.** A profile carrying no telephone,
no e-mail, no CPF and no passport still gets a row — it is simply one nobody can
recognise later. Without this, `person_id` could never become `not null` and
Task 4 would be impossible.

**Multiple live claims of one kind are allowed.** A person may hold two
telephones; D13 says so. They may also, in bad data, hold two CPFs — and this
plan **permits that rather than refusing it**, because refusing means retiring a
profile and D20 says keep both wherever possible. A second live CPF is wrong data
worth reporting; it is not worth destroying a Station's history over.

**What the unique index actually forbids is two PEOPLE claiming one live value.**
That is the only real contradiction, and the backfill never has to refuse it: a
profile that matches person A by telephone and person B by CPF **merges A and
B**, which is cheap here because exactly two columns reference `people` —
`person_identifiers.person_id` and `members.person_id`. This is the payoff of
keeping attributes out of `people`.

**So D20's retire branch should never fire in the backfill**, and Task 3 asserts
the positive form of that: both colliding profiles survive and share one person.
It asserts survival rather than "nothing was retired", because a post-hoc count
of retired rows inside a pgTAP transaction cannot tell this migration's doing
from any other file's. What would make the branch fire is a future door that
attaches a claim without going through resolution; it stays written for that day.

---

### Task 1: The two tables

**Files:**
- Create: `supabase/migrations/0272_platform_person.sql`
- Create: `supabase/tests/76_platform_person.test.sql`

**Interfaces:**
- Produces: `public.people (id uuid pk, created_at timestamptz, updated_at timestamptz)`
- Produces: `public.person_identifier_kind` enum with values `PHONE`, `EMAIL`, `CPF`, `PASSPORT`
- Produces: `public.person_identifiers (id uuid pk, person_id uuid → people(id), kind person_identifier_kind, value text, valid_from timestamptz, valid_to timestamptz, created_at timestamptz)`
- Produces: unique index `person_identifiers_live_unique on (kind, value) where valid_to is null`

- [x] **Step 1: Write the failing test**

Create `supabase/tests/76_platform_person.test.sql`:

```sql
begin;
select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures. This file owns them: it needs TWO Organizations with a Station each,
-- which is a shape no other suite has a reason to build, and the cross-
-- Organization collision in Task 3 is the whole subject here.
-- ---------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000076f1', 'Org P2 one'),
  ('00000000-0000-0000-0000-0000000076f2', 'Org P2 two');

insert into public.companies (id, organization_id, name, timezone, country, status) values
  ('00000000-0000-0000-0000-0000000076c1', '00000000-0000-0000-0000-0000000076f1',
   'Station P2 one', 'America/Sao_Paulo', 'BR', 'active'),
  ('00000000-0000-0000-0000-0000000076c2', '00000000-0000-0000-0000-0000000076f2',
   'Station P2 two', 'America/Sao_Paulo', 'BR', 'active');

-- ---------------------------------------------------------------------------
-- P2. THE PLATFORM PERSON.
--
-- people holds identity and NOTHING ELSE. The name a Station knows, the birthday
-- it confirmed and the consent it collected stay on that Station's profile
-- (design D2), which is what keeps this table from becoming a golden record two
-- Stations can disagree about.
-- ---------------------------------------------------------------------------

select has_table('public', 'people', 'the platform person exists');
select has_table('public', 'person_identifiers', 'and its identifiers are rows, not columns');

-- D2, held structurally. A future block that wants a name here has to add the
-- column and break this, which is the point.
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'people'
      and column_name not in ('id', 'created_at', 'updated_at')),
  0,
  'and people carries no attribute at all: no name, no birthday, no address');

-- The rule 0178 states for every listener-bearing table here.
select is(
  (select relrowsecurity from pg_class where oid = 'public.people'::regclass),
  true, 'people has RLS on');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename in ('people', 'person_identifiers')),
  0, 'and neither table has a policy: reachable only from a SECURITY DEFINER body');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('people', 'person_identifiers')
      and grantee in ('anon', 'authenticated')),
  0, 'and neither is granted to anon or authenticated');

-- The index that makes deduplication exact, and the only real contradiction.
insert into public.people (id) values
  ('00000000-0000-0000-0000-0000000076a1'),
  ('00000000-0000-0000-0000-0000000076a2');

insert into public.person_identifiers (person_id, kind, value) values
  ('00000000-0000-0000-0000-0000000076a1', 'PHONE', '5511900000001');

select throws_ok($$
  insert into public.person_identifiers (person_id, kind, value)
  values ('00000000-0000-0000-0000-0000000076a2', 'PHONE', '5511900000001')
$$, '23505', null, 'two people cannot hold one live telephone');

select lives_ok($$
  insert into public.person_identifiers (person_id, kind, value, valid_to)
  values ('00000000-0000-0000-0000-0000000076a2', 'PHONE', '5511900000001', now())
$$, 'but a CLOSED claim on the same number is fine: that is what a number changing hands looks like');

-- D13 and D20 together: a person may hold two live telephones, and -- in bad
-- data -- two live CPFs. Permitted rather than refused, because refusing means
-- retiring a profile and D20 says keep both wherever possible.
select lives_ok($$
  insert into public.person_identifiers (person_id, kind, value) values
    ('00000000-0000-0000-0000-0000000076a1', 'PHONE', '5511900000002'),
    ('00000000-0000-0000-0000-0000000076a1', 'CPF',
     '1111111111111111111111111111111111111111111111111111111111111111')
$$, 'and one person may hold several live claims, including a second of one kind');

select * from finish();
rollback;
```

- [x] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` fails at the first assertion —
`has_table('public','people')` reports the table does not exist. Everything after
it errors out of the same cause.

- [x] **Step 3: Write the migration**

Create `supabase/migrations/0272_platform_person.sql`:

```sql
-- supabase/migrations/0272_platform_person.sql

-- THE PLATFORM PERSON. One row per human, across every Organization.
--
-- IT HOLDS NO ATTRIBUTE, and that is the decision the whole model rests on
-- (design D2). A name here would be a golden record two Stations could disagree
-- about -- "João" at one and "Joãozinho da Padaria" at the other -- and the
-- product would then need a rule for who wins. With identity here and everything
-- descriptive on the Station's own profile, there is nothing to disagree about
-- and no rule to write.
--
-- It also means exactly TWO columns in this database reference this table:
-- person_identifiers.person_id and members.person_id. That is what makes merging
-- two person rows cheap, which is what lets the backfill (0274) merge instead of
-- retiring anybody.
create table public.people (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.people is
  'One human, platform-wide. Identity only: every attribute lives on the Station profile that collected it (design D2). Two columns in this database reference it, which is what makes merging two rows cheap.';

create type public.person_identifier_kind as enum ('PHONE', 'EMAIL', 'CPF', 'PASSPORT');

-- AN IDENTIFIER IS A CLAIM, not a column (design D13). As a column, two people
-- end up asserting one telephone and the unique index decides by accident of
-- arrival -- the one who got there first wins, even when they are the one who
-- left. As a row with a validity, the old number closes with a date, the new
-- holder enters clean, and the closed row goes on explaining the past without
-- competing for the present.
create table public.person_identifiers (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.people (id),
  kind        public.person_identifier_kind not null,
  value       text not null,
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  created_at  timestamptz not null default now(),

  constraint person_identifiers_value_shape check (btrim(value) <> ''),
  constraint person_identifiers_validity_shape check (valid_to is null or valid_to >= valid_from)
);

-- THE ONE CONTRADICTION THIS MODEL REFUSES: two PEOPLE holding one live value.
-- Everything else is permitted, including one person holding two live telephones
-- (ordinary, D13) and one person holding two live CPFs (bad data, and D20 says
-- keep both rather than retire a profile over it -- a second CPF is worth
-- reporting, not worth destroying a Station's history for).
create unique index person_identifiers_live_unique
  on public.person_identifiers (kind, value)
  where valid_to is null;

create index person_identifiers_person_idx
  on public.person_identifiers (person_id) where valid_to is null;

comment on table public.person_identifiers is
  'One claim: this person asserted this telephone, e-mail, CPF hash or passport, from this instant until that one. Several live claims of one kind are allowed (design D13); two PEOPLE holding one live value are not, and that is the whole of what person_identifiers_live_unique forbids.';

-- Both tables name a listener, so both follow the rule 0178 states for every
-- table here that does: RLS on with NO POLICY and the ACL revoked, reachable
-- only from inside a SECURITY DEFINER body.
alter table public.people enable row level security;
alter table public.person_identifiers enable row level security;

revoke all on public.people from anon, authenticated;
revoke all on public.person_identifiers from anon, authenticated;
```

- [x] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` passes all 9, and every other file is unchanged —
nothing reads these tables yet.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/0272_platform_person.sql supabase/tests/76_platform_person.test.sql
git commit -m "feat(p2): the platform person, holding identity and no attribute at all"
```

---

### Task 2: Resolution, in the one body all four doors share

**Files:**
- Create: `supabase/migrations/0273_person_resolution.sql`
- Modify: `supabase/tests/76_platform_person.test.sql`
- Read (do not modify): `supabase/migrations/0213_country.sql:210` — `apply_member_creation`, **whose live definition this is, and it is not `0061`**

**Interfaces:**
- Consumes: `public.people`, `public.person_identifiers` from Task 1
- Consumes: `public.normalize_phone(text)`, `public.normalize_email(text)` — `0031_members.sql:15,23`, the same two functions the generated columns delegate to
- Produces: `public.resolve_or_attach_person(p_phone text, p_email text, p_cpf_hash text, p_passport text) returns uuid` — finds the person holding any of these live, merges if they name two, creates one if they name none, and records every value handed to it as a live claim
- Produces: `public.members.person_id uuid references public.people (id)`, nullable at this stage
- Preserves: `apply_member_creation`'s signature and return type exactly, so its four callers are untouched

- [x] **Step 1: Write the failing test**

Raise `select plan(9);` to `select plan(15);` and append before `select * from finish();`:

```sql
-- ---------------------------------------------------------------------------
-- RESOLUTION. The four doors that register a listener -- console, WhatsApp, the
-- Block 15 API and the widget -- all pass through apply_member_creation, which
-- is why attaching a person lands in one place and cannot drift.
-- ---------------------------------------------------------------------------

-- A stranger: no claim matches, so a person is minted and the claims recorded.
select isnt(
  public.resolve_or_attach_person('5511900000010', null, null, null),
  null,
  'a telephone nobody claims mints a person');

select is(
  (select count(*)::int from public.person_identifiers
    where kind = 'PHONE' and value = '5511900000010' and valid_to is null),
  1,
  'and records the claim, once');

-- The same number again is the same person, which is the whole point.
select is(
  public.resolve_or_attach_person('5511900000010', null, null, null),
  public.resolve_or_attach_person('5511900000010', null, null, null),
  'the same telephone twice is the same person');

-- NORMALISED, the same way members.phone_normalized is: a number typed with
-- punctuation must not mint a second person for one human.
select is(
  public.resolve_or_attach_person('+55 11 90000-0010', null, null, null),
  public.resolve_or_attach_person('5511900000010', null, null, null),
  'and a number typed differently resolves to the same person');

-- THE BRIDGE, and the case that would be a contradiction if people held
-- attributes. One profile matches person A by telephone and person B by e-mail.
-- Two columns reference people, so merging them is cheap and nobody is retired.
select public.resolve_or_attach_person('5511900000020', null, null, null);
select public.resolve_or_attach_person(null, 'bridge@example.com', null, null);
select is(
  (select count(distinct person_id)::int from public.person_identifiers
    where value in ('5511900000020', 'bridge@example.com') and valid_to is null),
  1,
  'a caller naming two people merges them rather than refusing or retiring one');

-- And the door attaches what it resolved.
select is(
  (select m.person_id is not null
     from public.members m
    where m.id = public.apply_member_creation(
      '00000000-0000-0000-0000-0000000076c1', 'Pessoa P2', '5511900000030',
      null, null, null, null, null, null, null, null, null, null, null,
      null, null, null, null, null, null)),  -- twenty: 0213 added p_country
  true,
  'and a listener registered through the shared core comes out with a person attached');
```

- [x] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` fails from the first new assertion with
`function public.resolve_or_attach_person(...) does not exist`.

- [x] **Step 3: Write the migration**

Create `supabase/migrations/0273_person_resolution.sql`. Two parts.

First, the column and the resolver:

```sql
-- supabase/migrations/0273_person_resolution.sql

-- Nullable here and made NOT NULL in 0275, once the backfill has run and the
-- doors have been proved. A NOT NULL taken before either would refuse every
-- registration the moment one door was missed.
alter table public.members
  add column person_id uuid references public.people (id);

create index members_person_idx on public.members (person_id) where deleted_at is null;

comment on column public.members.person_id is
  'The platform person this Station profile is about (design D2). Two profiles of one human in different Organizations point at the same row; that is what makes them knowably the same human without either Station learning about the other.';

-- THE ONE PLACE A PERSON IS RESOLVED. Every door reaches it through
-- apply_member_creation, so there is no second implementation to drift from
-- this one -- the reason 0061 exists at all.
--
-- SECURITY INVOKER, and reachable only from inside a SECURITY DEFINER body that
-- has already checked whatever gate applies: apply_participation's convention
-- (0054), which 0061's own cores follow.
--
-- NORMALISED THROUGH normalize_phone / normalize_email, never by an expression
-- written here. 0031's comment on those two is a standing warning about exactly
-- this: a normalisation applied by whoever remembers is one that drifts, and
-- these values ARE identity -- two spellings normalising differently means
-- deduplication silently stops working and the duplicates look legitimate.
create or replace function public.resolve_or_attach_person(
  p_phone     text default null,
  p_email     text default null,
  p_cpf_hash  text default null,
  p_passport  text default null
)
returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_claims  jsonb;
  v_person  uuid;
  v_other   uuid;
  v_kind    text;
  v_value   text;
begin
  -- Every value this call carries, normalised and shaped like a claim. Built
  -- once so the lookup and the insert below cannot disagree about what was
  -- handed in.
  v_claims := '[]'::jsonb;

  if public.normalize_phone(p_phone) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PHONE', 'value', public.normalize_phone(p_phone)));
  end if;

  if public.normalize_email(p_email) is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'EMAIL', 'value', public.normalize_email(p_email)));
  end if;

  if nullif(lower(btrim(coalesce(p_cpf_hash, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'CPF', 'value', lower(btrim(p_cpf_hash))));
  end if;

  if nullif(lower(btrim(coalesce(p_passport, ''))), '') is not null then
    v_claims := v_claims || jsonb_build_array(
      jsonb_build_object('kind', 'PASSPORT', 'value', lower(btrim(p_passport))));
  end if;

  -- WHO ALREADY HOLDS ANY OF THEM. More than one answer is a BRIDGE: this
  -- caller names two rows that are one human, and the cheapest true thing to do
  -- is make them one. Merging is two updates because exactly two columns
  -- reference people -- 0272's comment says why that is not an accident.
  for v_person in
    select distinct pi.person_id
      from public.person_identifiers pi
      join lateral jsonb_array_elements(v_claims) c on true
     where pi.valid_to is null
       and pi.kind::text = c.value ->> 'kind'
       and pi.value = c.value ->> 'value'
     order by 1
  loop
    if v_other is null then
      v_other := v_person;
    else
      update public.person_identifiers set person_id = v_other where person_id = v_person;
      update public.members            set person_id = v_other where person_id = v_person;
      delete from public.people where id = v_person;
    end if;
  end loop;

  v_person := v_other;

  if v_person is null then
    insert into public.people default values returning id into v_person;
  end if;

  -- Record what is not recorded yet. ON CONFLICT DO NOTHING against the live
  -- index rather than a prior select: two doors meeting one stranger at once is
  -- the ordinary case under load, not an exotic one (0063), and losing that race
  -- must not raise.
  for v_kind, v_value in
    select c.value ->> 'kind', c.value ->> 'value' from jsonb_array_elements(v_claims) c
  loop
    insert into public.person_identifiers (person_id, kind, value)
    values (v_person, v_kind::public.person_identifier_kind, v_value)
    on conflict do nothing;
  end loop;

  return v_person;
end;
$$;

revoke execute on function public.resolve_or_attach_person(text, text, text, text) from public;

comment on function public.resolve_or_attach_person(text, text, text, text) is
  'The one place a platform person is resolved (design D2). Finds whoever holds any of these values live, MERGES them when the values name two rows -- one human with a profile in two Organizations is the ordinary case, and merging is two updates because only person_identifiers and members reference people -- mints one when they name none, and records every value handed in as a live claim. Normalises through normalize_phone/normalize_email rather than repeating their expressions, for the reason 0031 gives about identity that drifts. SECURITY INVOKER, called only from inside a SECURITY DEFINER body that has already checked its own gate, apply_participation''s convention (0054). Losing a race to another door is not an error: the claim insert is ON CONFLICT DO NOTHING against the live-uniqueness index.';
```

Second, `apply_member_creation` copied forward. Extract the live definition and
add one call:

```bash
sed -n '/^create function public.apply_member_creation/,/^\$\$;/p' \
  supabase/migrations/0213_country.sql \
  >> supabase/migrations/0273_person_resolution.sql
```

Then in the copy, add `person_id` to the insert's column list and
`public.resolve_or_attach_person(p_phone, p_email, p_cpf_hash, p_passport)` to
its values list, immediately after `created_by` / `p_actor`, with this comment
above the insert:

```sql
    -- P2. The person is resolved BEFORE the profile is written, so a profile
    -- never exists without one -- which is what lets 0275 make the column NOT
    -- NULL. Resolved from the same four values this insert stores, so the claims
    -- and the profile cannot describe different people.
```

Verify the copy reverted nothing:

```bash
diff \
  <(sed -n '/^create function public.apply_member_creation/,/^\$\$;/p' supabase/migrations/0213_country.sql) \
  <(sed -n '/^create or replace function public.apply_member_creation/,/^\$\$;/p' supabase/migrations/0273_person_resolution.sql)
```

Change the copied `create function` to `create or replace function`: `0213`
needed a drop because it changed the signature; this does not change it.

Expected: two hunks — that keyword, and the comment plus the column plus the
value. Nothing removed.

- [x] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` passes all 15. **Every other file must also pass** —
`apply_member_creation` keeps its signature, so `06_whatsapp`, `73_fast_entry`,
`34_api_intake` and the widget suites exercise the new call without knowing it.
A failure anywhere else means the copy lost something; diff before changing
anything.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/0273_person_resolution.sql supabase/tests/76_platform_person.test.sql
git commit -m "feat(p2): every door attaches a person, in the one body all four share"
```

---

### Task 3: The backfill

**Files:**
- Create: `supabase/migrations/0274_person_backfill.sql`
- Modify: `supabase/tests/76_platform_person.test.sql`

**Interfaces:**
- Consumes: `public.resolve_or_attach_person(text, text, text, text)` from Task 2
- Produces: every live `members` row carrying a `person_id`

- [x] **Step 1: Write the failing test**

Raise the plan to `select plan(19);` and append before `select * from finish();`:

```sql
-- ---------------------------------------------------------------------------
-- THE BACKFILL, and D20. Profiles that already existed get a person each, and
-- two profiles of one human in DIFFERENT Organizations get the SAME one -- which
-- is the entire reason this table exists.
--
-- Fixtures are built here rather than relying on the ones the rest of the suite
-- carries, because this needs a cross-Organization collision on purpose and no
-- other file has a reason to have one.
-- ---------------------------------------------------------------------------

-- THE COLLISION, BUILT RATHER THAN HUNTED. One human at two Organizations, put
-- there before the backfill migration is reached -- which is possible because a
-- pgTAP file runs after every migration has been applied, so these rows are
-- exactly what an existing production profile looks like: written by an earlier
-- door, carrying no person_id of its own.
update public.members set person_id = null
 where id in (
   public.apply_member_creation(
     '00000000-0000-0000-0000-0000000076c1', 'Mesma Pessoa', '5511900000040',
     null, null, null, null, null, null, null, null, null, null, null,
     null, null, null, null, null, null),
   public.apply_member_creation(
     '00000000-0000-0000-0000-0000000076c2', 'Mesma Pessoa', '5511900000040',
     null, null, null, null, null, null, null, null, null, null, null,
     null, null, null, null, null, null));

-- Re-run the backfill's body over what was just un-attached. The migration ran
-- before this file did, so re-running its statement is how a test reaches it.
update public.members m
   set person_id = public.resolve_or_attach_person(m.phone, m.email, m.cpf_hash, m.passport)
 where m.deleted_at is null and m.person_id is null;

select is(
  (select count(*)::int from public.members
    where deleted_at is null and person_id is null),
  0,
  'the backfill leaves no live profile without a person');

select is(
  (select count(distinct person_id)::int from public.members
    where phone_normalized = '5511900000040' and deleted_at is null),
  1,
  'and one telephone held in two Organizations resolves to ONE person');

select is(
  (select count(*)::int from public.members
    where phone_normalized = '5511900000040' and deleted_at is null),
  2,
  'while both profiles survive: D20 keeps both, and nothing was retired');

select is(
  (select count(*)::int from public.person_identifiers
    where kind = 'PHONE' and value = '5511900000040' and valid_to is null),
  1,
  'and the shared telephone is one live claim, not two');

- [x] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: the `resolve_or_attach_person` statement raises
`function ... does not exist` — no, it exists since Task 2; the failure is the
first assertion, reporting a non-zero count of live profiles with no person,
because `0274` has not been written and the two fixtures above were deliberately
detached.

- [x] **Step 3: Write the migration**

Create `supabase/migrations/0274_person_backfill.sql`:

```sql
-- supabase/migrations/0274_person_backfill.sql

-- EVERY LIVE PROFILE GETS A PERSON. Ordered by created_at so the oldest profile
-- mints the row and later ones join it -- arbitrary in effect, since merging
-- makes the outcome the same either way, and worth fixing anyway so two runs of
-- this migration on two databases produce the same shape.
--
-- ANONYMISED PROFILES ARE INCLUDED. They are live rows a Station still reads,
-- and 0031's own comment says the row survives so participations and deliveries
-- still reference something. Their identifiers are already gone, so they get a
-- person with no claim -- which 0272 permits deliberately: a person nobody can
-- recognise later is still a person, and without that 0275 could never take the
-- NOT NULL.
--
-- D20, THE OWNER'S RULING OF 2026-08-22: keep both profiles, and retire the one
-- with fewer music requests and participations only where a contradiction cannot
-- be represented. IT IS NOT REACHED HERE, and that is by construction rather
-- than by luck: resolve_or_attach_person MERGES when a profile names two people,
-- and the only thing person_identifiers_live_unique forbids is two people
-- holding one live value -- which merging is precisely the resolution of. The
-- branch stays written in the spec for a future door that attaches a claim
-- without going through resolution.
do $$
declare
  r record;
begin
  for r in
    select id, phone, email, cpf_hash, passport
      from public.members
     where deleted_at is null
       and person_id is null
     order by created_at, id
  loop
    update public.members
       set person_id = public.resolve_or_attach_person(
             r.phone, r.email, r.cpf_hash, r.passport)
     where id = r.id;
  end loop;
end $$;

-- Retired profiles keep no person. They are not read by any screen, their
-- identifiers no longer defend anything (0031's unique indexes are partial on
-- deleted_at), and giving them one would mean a claim competing with the live
-- profile that replaced them.
```

- [x] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` passes all 19, everything else unchanged.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/0274_person_backfill.sql supabase/tests/76_platform_person.test.sql
git commit -m "feat(p2): the backfill, which never reaches D20's fallback and says why"
```

---

### Task 4: The guarantee

**Files:**
- Create: `supabase/migrations/0275_person_id_required.sql`
- Modify: `supabase/tests/76_platform_person.test.sql`
- Modify: `src/lib/supabase/database.types.ts` (regenerated, not hand-edited)

**Interfaces:**
- Produces: `members.person_id` `not null`

- [x] **Step 1: Write the failing test**

Raise the plan to `select plan(20);` and append before `select * from finish();`:

```sql
-- The guarantee, taken last. Until now a door that forgot to resolve would leave
-- a profile with no person and nothing would say so; from here the insert is
-- refused, which is the difference between a convention and a rule.
select col_not_null('public', 'members', 'person_id',
  'and from here a profile cannot exist without a person');
```

- [x] **Step 2: Run it and watch it fail**

```bash
npm run db:reset && npm run db:test
```

Expected: the assertion reports the column is nullable.

- [x] **Step 3: Write the migration**

Create `supabase/migrations/0275_person_id_required.sql`:

```sql
-- supabase/migrations/0275_person_id_required.sql

-- THE GUARANTEE, and deliberately the last of the four. 0273 added the column
-- nullable and 0274 filled it; taking the constraint before either would have
-- refused every registration the moment one door was missed, and taking it in
-- the same migration as the backfill would make a failure impossible to read --
-- the constraint would report the symptom of a backfill that did not finish.
--
-- What it buys: a door that forgets to resolve a person now fails loudly at the
-- insert instead of leaving a profile nothing can recognise later, which nothing
-- else in this schema would notice.
alter table public.members
  alter column person_id set not null;
```

- [x] **Step 4: Run it and watch it pass**

```bash
npm run db:reset && npm run db:test
```

Expected: `76_platform_person` passes all 20, and every other file passes — which
is the real assertion here. Any file that fails now names a door that registers a
listener without going through `apply_member_creation`, and that door is the
finding.

- [x] **Step 5: Regenerate the types and run the rest of the gates**

```bash
npm run db:types
npm run lint && npm test && npm run build
```

Expected: `database.types.ts` gains `people` and `person_identifiers`; all three
gates pass. The types file is generated — never hand-edit it to make something
compile.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/0275_person_id_required.sql supabase/tests/76_platform_person.test.sql src/lib/supabase/database.types.ts
git commit -m "feat(p2): a profile cannot exist without a person, and now the schema says so"
```

---

## Closing checklist

- [ ] `npm run db:reset && npm run db:test` green from a clean database.
- [ ] The `apply_member_creation` diff in Task 2 is one hunk: a comment, a column
      and a value. Nothing removed.
- [ ] `git diff main --stat` names only the four migrations, the new test file
      and `database.types.ts`. No merged migration edited in place.
- [ ] `people` has no column beyond `id`, `created_at`, `updated_at`. Task 1's
      third assertion enforces it, and a future block that adds one is
      contradicting D2 and must say so in writing.
- [ ] **The four migrations are applied to the hosted database after the PR
      merges.** `0274` is a backfill and touches every live profile row — run it
      knowing that. This project has shipped code without its migrations three
      times.
- [ ] **Run P0's census against production before or just after this ships.** It
      no longer gates anything (D20), but the number of cross-Organization
      collisions is the size of what `0274` just did, and it is worth knowing
      what happened rather than inferring it.

---

## What execution changed, recorded because the plan was wrong about it

**The copy-forward was aimed at the wrong file, and then stopped being needed at
all.** `apply_member_creation`'s live definition is in `0213_country.sql:210`,
not `0061`: `0213` drops and recreates it with a twentieth parameter, using
`create function` rather than `create or replace`, so the grep that locates every
other copied-forward function in this repository misses it. Copying `0061`
forward would have reverted the country work with every test still green, and the
plan's own diff step would not have caught it because it diffed the same wrong
file. Settled against `pg_proc` rather than the migration list. Then the trigger
below removed the copy entirely, so the risk is gone rather than managed.

**Resolution moved from the shared core to a trigger, and the schema gained its
second one.** `0275`'s NOT NULL broke twenty-odd test files that insert into
`members` directly — 1349 assertions ran where 2556 had. Wiring resolution into
`apply_member_creation` makes the guarantee a convention, and a convention cannot
carry a NOT NULL. A column default was rejected as lighter and wrong: it satisfies
the constraint by minting a person with no claim, so an insert carrying a
telephone becomes invisible to deduplication, silently and permanently.

**The backfill became a function.** As a `DO` block it was untestable — on a fresh
database the migration has nothing to do, so a test re-typing its `UPDATE` passed
whether or not the file existed. `backfill_member_person_ids()` is callable from a
test and, because it is idempotent by its own predicate, resumable if a production
run stops on a statement timeout.

**Its test then had to recreate a world that no longer exists.** After `0275` the
state the backfill repairs is unreachable, so the test drops the NOT NULL inside
its own transaction and lets pgTAP's rollback restore it.

**Two of my own assertions measured nothing.** `apply_member_creation` writes, and
calling it inside a `where` clause ran it once per row of `members`, matching none
and reporting `have: NULL`. And the backfill assertion described above.

**Final state:** 2558 pgTAP, 1772 vitest, lint clean, build clean.
