# Block 3 — Members Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the audience — an Organization-scoped Member with per-Station access, deduplication that cannot leak across the visibility boundary, append-only consents, dated blocks that expire without a job, and erasure that survives an immutable audit trail.

**Architecture:** `members` is Organization-scoped; `member_company_links` is what RLS reads. Deduplication is one `SECURITY DEFINER` function that resolves at Organization scope and returns only what the caller is entitled to know, backed by partial unique indexes that make a duplicate unrepresentable even without it. Every write is an RPC; every audit entry records the `member_id` and no personal value.

**Tech Stack:** PostgreSQL 15 (Supabase), PL/pgSQL `SECURITY DEFINER` RPCs, Next.js 15 App Router, Zod, Vitest, pgTAP, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-28-block-3-members-design.md`

## Global Constraints

- Everything in English: identifiers, comments, error messages, UI copy, docs.
- Vocabulary: `organizations` (Organization), `companies` (**Station** in prose and UI), **`members` is the audience** — internal panel users are `company_memberships`, never confused with these.
- Every new table: RLS enabled, `revoke all from anon, authenticated`, explicit grants per role, explicit `service_role` grant. `BYPASSRLS` is not a substitute for a `GRANT`.
- **No `insert`, `update` or `delete` grant to any role on any Member table**, including `service_role`. Every write is a `SECURITY DEFINER` RPC.
- Every business uniqueness rule is a partial unique index `where deleted_at is null`.
- `USING (true)` is forbidden.
- Every `SECURITY DEFINER` function re-checks the caller in its own body, resolves the Organization from the row rather than a caller-supplied id, and on denial uses `RAISE LOG` then `RAISE EXCEPTION`.
- Cross-tenant integrity is declarative: composite foreign keys sharing the tenant column.
- Migrations numbered sequentially from `0031`.
- Commands: `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:isolation`, `npm run test:e2e`, `npx supabase db reset`, `npx supabase test db`, `npm run db:types`.

## The two rules this block lives or dies by

**1. An audit entry about a Member records the `member_id` and no personal value.** Not masked — absent. Every RPC here honours it, or anonymisation scrubs the source table while the audit trail keeps a copy and the product's erasure promise is false in the one place nobody looks. Task 7 tests it by seeding distinctive values, exercising every write path, anonymising, and searching.

**2. The raw CPF never reaches the database.** It is hashed in Node, exactly as Block 1b hashes an invitation token, and only the hash and the last digits are sent. A value passed as an RPC argument appears in query logs and in backups; hashing at the edge is what makes "the raw CPF is stored nowhere" true rather than aspirational.

## Lessons carried from Blocks 1c and 2 — requirements, not advice

1. **Every UI scenario and every e2e journey is driven by a non-owner delegate.** The owner's bypass hides the delegate's failure; Block 1c shipped two defects that way.
2. **A test that passes for the wrong reason is worse than a missing one.** Pin the error code or the message. Block 2 shipped a falsifiability table with two rows that overstated what the suite covered.
3. **Where a refusal must come from permission resolution rather than the access gate**, the subject must hold a live membership in the other Station under a role granting nothing — otherwise the test passes one layer above the one it names.
4. **A composite foreign key cannot see a partial index**, so it cannot see `deleted_at`. Anywhere archival must be respected, the check is explicit and takes a row lock.
5. **Read the form copy and the SQL together.** Block 2's Critical existed only between two files no reviewer read as a pair.

---

### Task 1: The Member, and the indexes that define identity

**Files:**
- Create: `supabase/migrations/0031_members.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

**Interfaces:**
- Produces: `public.members`, `public.member_company_links`; permission codes `members.view`, `members.create`, `members.edit`, `members.block`, `members.archive`, `members.erase`; `members_id_org_unique`.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Assert what makes identity work**

Append to `supabase/tests/02_permissions.test.sql`, setting the plan count from the runner.

```sql
-- Block 3: the raw CPF has nowhere to live.
select hasnt_column('public', 'members', 'cpf', 'there is no raw CPF column');

-- Normalisation IS identity. If these stop being generated, dedup stops working and
-- the duplicates look legitimate.
select is(
  (select is_generated from information_schema.columns
    where table_name = 'members' and column_name = 'phone_normalized'),
  'ALWAYS',
  'phone_normalized is generated, not hand-maintained'
);

-- Two Members with no e-mail must not collide. A partial unique index that omits the
-- not-null term makes the second one impossible to register.
insert into public.organizations (id, name) values ('eeeeeeee-0000-0000-0000-000000000001', 'Org M');
insert into public.members (organization_id, full_name) values
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact One'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'No Contact Two');
select pass('two Members without an e-mail can both exist');

select is(
  (select count(*)::int from public.permissions where module = 'members' and scope = 'company'),
  6,
  'six Member permissions, all Company-scoped'
);
```

- [ ] **Step 3: Prove normalisation collapses the spellings it must**

Run `npx supabase db reset`, then insert one Member with `+55 (11) 98765-4321` and attempt a second with `5511987654321` in the same Organization. Expect the second to be refused by `members_phone_unique`. Record the verbatim error. If it succeeds, the normalisation is wrong and every dedup guarantee in this block rests on it.

- [ ] **Step 4: Run the database suite and commit**

```bash
git add supabase/migrations/0031_members.sql supabase/tests/02_permissions.test.sql
git commit -m "feat(db): add the Member and the indexes that define identity"
```

---

### Task 2: Consents, notes, blocks — and a block that expires by date

**Files:**
- Create: `supabase/migrations/0032_member_lifecycle_tables.sql`

**Interfaces:**
- Produces: `public.member_consents`, `public.member_notes`, `public.member_blocks`; `public.member_consent_type`, `public.member_block_kind`; `public.is_member_blocked(uuid, uuid)`.

- [ ] **Step 1: Write the migration**

The three tables are **append-only in spirit**: a withdrawn consent is a new row, a lifted block is a new row. Say so in the comments, and give none of them an `updated_at`.

`member_consents`: `member_id`, `company_id`, `consent_type`, `granted boolean`, `granted_at`, `origin`, `promotion_id uuid` (nullable, no FK yet — promotions do not exist; say so in a comment), `recorded_by`.

`member_blocks`: `member_id`, `company_id` **nullable** (null means the whole Organization), `kind`, `reason not null`, `starts_at not null default now()`, `ends_at` nullable, `created_by`, `lifted_at`, `lifted_by`, `lift_reason`.

Then the function that makes §6 of the spec true:

```sql
-- A dated suspension ends because the date passed, not because a job ran. The owner
-- fixed this principle in Block 2 for the uncollected prize and it applies unchanged:
-- no cron marks a block expired, so no cron can fail to. Nothing maintains a status
-- column, because a status column nobody maintains lies.
create or replace function public.is_member_blocked(p_member_id uuid, p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.member_blocks b
    where b.member_id = p_member_id
      and (b.company_id is null or b.company_id = p_company_id)
      and b.lifted_at is null
      and b.starts_at <= now()
      and (b.ends_at is null or b.ends_at > now())
  );
$$;
```

`revoke execute … from public`, `grant execute … to authenticated`.

- [ ] **Step 2: Run the database suite; commit**

---

### Task 3: Deduplication — the one place that reads across the boundary

**Files:**
- Create: `supabase/migrations/0033_member_dedup.sql`

**Interfaces:**
- Produces: `public.find_member_by_identifier(uuid, text, text, text, text) returns jsonb`.

This is the block's most sensitive function and the hardest thing in it to get right.

- [ ] **Step 1: Write it**

```sql
-- supabase/migrations/0033_member_dedup.sql

-- THE ONE PLACE IN THIS PROJECT THAT READS ACROSS THE VISIBILITY BOUNDARY BY DESIGN.
-- Everywhere else, a cross-tenant read is a defect; here it is the feature, which
-- makes it the thing to review hardest.
--
-- A Member is Organization-scoped but visibility is per Station. So when someone
-- registers a phone number that already exists at a Station they cannot reach, the
-- system must refuse the duplicate WITHOUT revealing who holds it.
--
-- Three answers, and only three:
--   none      — no Member in this Organization carries that identifier.
--   visible   — there is one, and the caller may see it: the id comes back.
--   elsewhere — there is one, and the caller may NOT see it: existence only.
--
-- The third leaks that SOMEBODY holds the identifier. That is unavoidable — any
-- system preventing duplicates across a boundary leaks the existence of what is on
-- the other side. What it must never leak is WHO: no id, no name, no Station name,
-- no count. The message says what to do next so the answer is a workflow, not a
-- dead end.
create or replace function public.find_member_by_identifier(
  p_organization_id uuid,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_phone   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email   text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_id      uuid;
  v_visible boolean;
begin
  -- The caller must hold members.view somewhere in this Organization. Without this
  -- the function is an Organization-wide existence oracle for anyone with a session.
  if not public.has_org_permission('members.view', p_organization_id) then
    raise log 'find_member_by_identifier denied: actor=% org=%', auth.uid(), p_organization_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  if v_phone is null and v_email is null and p_cpf_hash is null and p_passport is null then
    raise exception 'give at least one identifier to search by' using errcode = '22023';
  end if;

  select m.id into v_id
  from public.members m
  where m.organization_id = p_organization_id
    and m.deleted_at is null
    and (
         (v_phone     is not null and m.phone_normalized = v_phone)
      or (v_email     is not null and m.email_normalized = v_email)
      or (p_cpf_hash  is not null and m.cpf_hash = p_cpf_hash)
      or (p_passport  is not null and lower(m.passport) = lower(p_passport))
    )
  limit 1;

  if v_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;

  -- Can the caller reach any Station this Member is linked to?
  select exists (
    select 1
    from public.member_company_links l
    where l.member_id = v_id
      and public.has_permission('members.view', l.company_id)
  ) into v_visible;

  if v_visible then
    return jsonb_build_object('outcome', 'visible', 'member_id', v_id);
  end if;

  -- Existence, and nothing else. Returning the id here would hand a caller a handle
  -- to a record every policy in this block exists to keep from them.
  return jsonb_build_object('outcome', 'elsewhere');
end;
$$;
```

`revoke`/`grant` as usual.

- [ ] **Step 2: Read it back against the three answers**

Before running anything, re-read the function and state, in your report, what each of the three branches returns **field by field**. The `elsewhere` branch must contain exactly one key. A stray `member_id`, name or count there is the defect this whole block is arranged to prevent.

- [ ] **Step 3: Run the database suite; commit**

---

### Task 4: The write RPCs, and erasure

**Files:**
- Create: `supabase/migrations/0034_member_rpcs.sql`

**Interfaces:**
- Produces: `create_member`, `update_member`, `link_member_to_company`, `archive_member`, `record_member_consent`, `add_member_note`, `block_member`, `lift_member_block`, `anonymize_member`.

- [ ] **Step 1: Write them**

Each follows the house shape from `0017_role_rpcs.sql` and `0027_inventory_rpcs.sql`: resolve the Organization from the row, check its own permission with `has_permission`, `RAISE LOG` then `RAISE EXCEPTION` on denial, audit on success.

**The rule that binds every one of them:**

```sql
  -- An audit entry about a Member records the member_id and NO personal value. Not
  -- masked — absent. Otherwise anonymize_member scrubs the source table while the
  -- audit trail quietly keeps a copy, and this product's erasure promise is false in
  -- exactly the place nobody looks.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));
```

Never `jsonb_build_object('name', p_full_name)` or `'phone', p_phone`. Task 7 searches for exactly that.

`create_member` also inserts the `member_company_links` row for the Station it was called with, and sets `first_contact_at`/`first_contact_origin` when given.

`anonymize_member(member_id, reason)`:

```sql
  -- Erasure that survives an immutable audit trail. The row stays so participations
  -- and deliveries still reference something; the person does not. Every identifying
  -- column goes, including the address and the discovery source — a full address plus
  -- a birth date identifies a person as surely as a name does.
  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;
```

`phone_normalized` and `email_normalized` are generated, so nulling the sources clears them — **verify that rather than assume it**, and say so in your report. If a generated column retains its value, the partial unique index still holds the old identity and the erasure is incomplete.

The audit entry names the event, the actor and the reason, and no erased value.

- [ ] **Step 2: Run the database suite; commit**

---

### Task 5: RLS

**Files:**
- Create: `supabase/migrations/0035_rls_members.sql`
- Modify: `supabase/tests/02_permissions.test.sql`

- [ ] **Step 1: Write it**

Five tables. `members` is readable when the Member has a link to a Station the caller can reach:

```sql
create policy members_select_reachable on public.members
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from public.member_company_links l
      where l.member_id = members.id
        and public.has_permission('members.view', l.company_id)
    )
  );
```

`member_company_links`, `member_consents` and `member_blocks` under the same reachability test on their own `company_id` (and, for links, on the row's own Station). `member_notes` additionally scoped to the Station that wrote it.

No write grant to anyone. `service_role` gets `select` and nothing more, and `revoke truncate` — Block 2's final review established that the four inventory tables needed it explicitly, and the same reasoning applies to tables holding personal data.

- [ ] **Step 2: Assert the grid** — five tables × RLS enabled, `revoke all`, `select` grant, policy, `service_role` grant, no write grant, no `TRUNCATE`. Enumerate it in your report.

- [ ] **Step 3: Run; commit**

---

### Task 6: Types, schemas and the service

**Files:**
- Modify: `src/lib/supabase/database.types.ts` (generated)
- Create: `src/schemas/members.ts`, `src/services/members.ts`
- Test: `tests/unit/members-schema.test.ts`

- [ ] Regenerate the types and run the binding probe: add `await supabase.from('no_such_table').select('*')` to a server file, confirm `npm run typecheck` **FAILS** naming it, remove it, confirm it passes.

- [ ] **Hash the CPF in the service, never in the database.** `src/services/members.ts` normalises and hashes with `node:crypto`, exactly as `src/services/invitations.ts` hashes an invitation token, and sends only `cpf_hash` and `cpf_last_digits`. Add a unit test proving the same CPF written two ways — `123.456.789-09` and `12345678909` — produces the same hash, because that equality is what deduplication rests on.

- [ ] Schema, test-first. Cover: a phone that normalises to nothing is rejected; an e-mail is bounded and lowercased; a CPF is eleven digits after stripping; a birth date cannot be in the future; the address fields are optional; `consent_type` is one of the three.

- [ ] Map Postgres codes to the project's taxonomy: `23505` → `ConflictError`, `P0002` → `NotFoundError`, `42501` → `UnauthorizedError`, `22023` → `ValidationError`, `23503` → `BusinessRuleError`, anything else → `InternalError`. **Surface every read's error.**

- [ ] `npm run lint && npm run typecheck && npm test`; commit.

---

### Task 7: Isolation coverage — the block's proof

**Files:**
- Create: `tests/isolation/members.test.ts`
- Modify: `tests/isolation/harness.ts`

**Every case is driven by a non-owner delegate.** Labels from `Date.now()`.

- [ ] **Step 1: Write the suite**

1. **Deduplication returns `visible` with the id** when the caller can reach one of the Member's Stations.
2. **Deduplication returns `elsewhere` and nothing else** when they cannot. Assert the payload has **exactly one key** — not merely that `member_id` is undefined. A future field added carelessly would slip past a narrower assertion.
3. **The caller must hold `members.view`** somewhere in the Organization, or the function refuses — otherwise it is an existence oracle for anyone with a session.
4. **A Member linked only to Station B is invisible** to a delegate holding `members.view` in Station A **who also holds a live membership in B under a role granting nothing**, so the refusal comes from permission resolution and not from the access gate.
5. **"Stations they took part in" omits an unreachable Station** — read `member_company_links` as the delegate and assert the count.
6. **A block with a past `ends_at` no longer blocks; a future one does; an indefinite one does** — three calls to `is_member_blocked`, no job in between.
7. **Each of the six permissions is refused without it and allowed with it.**
8. **After anonymisation, no `audit_logs` row for that Member contains any erased value.** Seed the Member with distinctive values — a name, phone, e-mail and CPF that appear nowhere else — exercise **every** write RPC against them, anonymise, then search `audit_logs` for each value across `detail::text`. This is the test that makes rule 1 real; write it so it fails if any single RPC ever puts a personal value in its detail.
9. **Anonymisation clears the generated columns too**, so the partial unique index no longer holds the old identity: after erasing, register a new Member with the same phone and expect success.
10. **An archived Member's phone can be reused.**

- [ ] **Step 2: Run it; the whole suite; commit.** A failure is a real defect in Tasks 1–5, not a reason to soften an assertion.

---

### Task 8: The Members screens

**Files:**
- Create: `src/app/(app)/members/page.tsx`, `[memberId]/page.tsx`, and their components
- Modify: `src/lib/auth/shell.ts`, `src/components/layout/app-shell.tsx`

The list: search by name, phone, e-mail or the CPF's last digits, filtered **server-side**, with the block state visible in the list rather than one click away.

The detail: identity, consents with dates and origins, notes, block history, and the Stations they took part in **that the viewer can reach**.

Follow `src/app/(app)/inventory/` for the Server Component page plus minimal client component, and for turning typed service errors into sentences.

- [ ] Run lint, typecheck, build. **Then use both screens as a non-owner delegate** and report each step.

---

### Task 9: Registration, consent, blocking and erasure

**Files:**
- Modify: `src/app/(app)/members/` — the forms

Registration runs the deduplication check on the identifying fields **before** submission, so the person sees one of the three answers rather than a constraint violation after the fact. The `elsewhere` answer must read as a workflow — who to ask — not as a refusal.

Erasure sits behind `members.erase`, with a confirmation stating plainly **what survives** (the participation and delivery history, pointing at nobody) and **what does not**. No undo is offered, because none exists.

- [ ] Run lint, typecheck, build. **Walk it as a delegate**, including the `elsewhere` case, and report what you saw.

---

### Task 10: The end-to-end journey

**Files:**
- Create: `tests/e2e/members-flow.spec.ts`

The owner composes a role with `members.view`, `members.create`, `members.edit` and `members.block` — **not** `members.erase` — and assigns it in one Station. The delegate registers a listener, records the rules consent, blocks them until a date, sees the block in the list, and **finds no way to erase**.

A second delegate at another Station cannot find that listener at all.

- [ ] `npm run test:e2e` — the whole suite, at the default worker count.

---

### Task 11: Verification and the block report

- [ ] Every gate at real defaults, output captured verbatim.

- [ ] **Two mutations, each reverted, each with the test that caught it recorded:**
  1. Make `find_member_by_identifier` return the `member_id` in the `elsewhere` branch, and confirm case 2 fails.
  2. Put `p_full_name` into `create_member`'s audit detail, and confirm case 8 fails.

  If either passes anyway, that test is not a proof and the report must say so.

- [ ] Write `docs/block-3-report.md` following `docs/block-2-report.md`. §5 must carry: that `find_member_by_identifier` leaks the *existence* of an identifier by design, with the reasoning; that merging duplicate Members is deferred to Block 9; and that anonymising internal users remains unbuilt, with this block's pattern as the model.

- [ ] Commit, push, open the PR: `Block 3 — Members`.
