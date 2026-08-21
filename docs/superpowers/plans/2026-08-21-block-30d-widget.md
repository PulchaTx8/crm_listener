# Block 30d — Widget Question, Phone Form, Station Language and the Entry That Needs No Walk

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The widget shows a quiz question's text, a telephone number means the same thing whichever door wrote it, the widget renders in the Station's language rather than the operator's, and a promotion that asks nothing takes the entry immediately on both channels.

**Architecture:** One new pair of SQL functions turns any telephone number into the international form, decided by **national length** and not by prefix; every door that writes a phone calls it. The Station gains `listener_locale`, edited on `/messages/promo` and carried to the widget on `widget_frame_context` — the one door that runs in both widget presentations. The fast entry is the mirror of a branch `ingest_whatsapp_event` already has: it applies the participation and enqueues one reply, now through a template when one is registered and every variable is known.

**Tech Stack:** PostgreSQL 17 (RLS, pgTAP), Next.js 15 App Router (Server Actions, `typedRoutes`), TypeScript, Zod, next-intl, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-block-30d-widget-design.md`

## Global Constraints

- Comments explain WHY, never WHAT. **A comment that states something false is a defect of the same severity as false code.** Blocks 30a–30c closed more than a dozen of these, every one in text a plan supplied. Read each sentence you write as a claim; if you cite a `file:line`, resolve it before you write it.
- **If your change falsifies a comment you did not touch, that comment is yours to fix.**
- No new user-facing English strings outside `messages/{en,pt,es}.json`. All three catalogues get every key; `catalogue.test.ts` is the guard. A duplicate key in one JSON object is not a compiler error — the later one silently wins.
- `src/lib/supabase/database.types.ts` is generated, never hand-edited. Regenerate with `npm run db:types`.
- One string literal for a PostgREST `.select(...)`, never a concatenation.
- pgTAP `plan(N)` is the file's **running total**.
- Migrations already merged are never edited in place. Next free migration number: **0260**. Next free pgTAP file number: **72**.
- Gate order is `npm run db:reset` → `npm run db:test` → `npm run test:isolation`, then `npm run seed:branding` → `npm run test:e2e`. `db:reset` wipes the storage bucket, which is why `seed:branding` precedes any e2e run.
- **Run the e2e suite whole and once.** `playwright.config.ts` pins one worker locally because `next dev` compiles each route on first visit and the test paying for it blows its budget, reporting as a broken sign-in. Sharding multiplies that by restarting the server per shard.
- Every conditionally rendered `<Button>` gets a distinct `key`.
- **Never run a suite that touches the database while a dispatched agent is running.** There is one local database.

## Run every suite in the FOREGROUND

Never background a suite and never poll for one. **If a command is auto-backgrounded on you, stop immediately and report `NEEDS_CONTEXT` naming it** — the controller runs it and hands you the result.

## The trap that dominates this plan

**Nine of the objects this block rewrites are not where they were introduced.** The first draft of the spec cited two of them wrongly, which is the trap demonstrating itself on the document meant to warn about it.

| Function | Introduced | **Live definition** |
| --- | --- | --- |
| `widget_frame_context` | 0161 | **0164** |
| `widget_promotions` | 0171 | **0186** |
| `widget_enter_promotion` | 0171 | **0234** |
| `ingest_whatsapp_event` | 0062 | **0179** |
| `create_member` / `update_member` | 0034 | **0220** |
| `enqueue_whatsapp_outbound` | 0071 | **0224** |
| `import_participations` | 0054 | **0056** |
| `resolve_or_create_member` | 0054 | 0054 |
| `whatsapp_conversation_steps` | 0066 | 0066 |

**Every recreation starts from the LIVE body**, dumped from the database, never from the migration text:

```sql
select pg_get_functiondef('public.widget_enter_promotion'::regproc);
```

Re-deriving from an older migration silently reverts every repair made since, and **nothing turns red**. `0172`'s own header names the incident: *"Retyping a shipped body is how 0168 silently reverted 0163's public-key pin one block ago."*

**Adding a parameter is a `drop` + `create`, not a replace.** `create or replace` with a different argument list creates an **overload**: the old function survives beside the new one and every caller that was not edited keeps reaching it. `drop` destroys the ACL, so restate every grant and check afterwards:

```sql
select proacl from pg_proc where proname = 'international_phone';
```

## Facts verified before this plan was written

- **The hosted database holds 1 014 members: 1 005 with a 13-digit phone opening `55`, 8 with 11 digits, 1 with 10.** All eight 11-digit rows are `first_contact_origin = 'WHATSAPP'`. Measured 2026-08-21 through PostgREST with `Prefer: count=exact`.
- **All six `companies` rows carry `country = null`.**
- `normalize_phone` (0031) is digits-only and `members.phone_normalized` is GENERATED from it. The repair therefore writes `phone`.
- `whatsapp_local_phone` (0062:47-60) strips `55` only at lengths 12 and 13 — the length rule this block reads in the other direction.
- `whatsapp_conversation_steps` (0066:80-85) builds a question step as `jsonb_build_object('kind','question','questionId',q.id,'questionKind',q.kind)`. `promotion_questions.prompt` is `not null` with a non-blank CHECK (0041:11).
- `widget_promotions` passes the step list straight through (`0186:57`); `widget_enter_promotion` recomputes it (`0186:186`, still present in 0234).
- **`widget_frame_context` runs on every widget request in both presentations**, because `installationExists` (`src/services/widget-installations.ts:66`) calls it. `stationIdentity` does not: `page.tsx:129` calls it only when the presentation is `app`.
- `ingest_whatsapp_event` (0179:239-261) already applies the participation and enqueues a reply for the **non-VALID** pre-check, writing straight into `outbox_messages` rather than through `enqueue_whatsapp_outbound`.
- `enqueue_whatsapp_outbound` (live on 0224) takes `(uuid, text, text, jsonb, text, template_purpose default null, jsonb default null)`, renders the body from the approved template itself, raises **P0002** when no live registration exists for the purpose and **22023** when the variable count disagrees with the body.
- `message_templates` (0110:19-38) is keyed by `(company_id, purpose)` and soft-deleted through `deleted_at`.
- The `rules` consent insert is at `0234:154-157` and leaves `promotion_id` null; the marketing consent inserts a hundred lines below (`0234:254`, `0234:269`) fill it.
- `set_service_hashtags` (0177:41-59) is the door shape to mirror: `security definer`, `has_permission('templates.manage', p_company_id)`, `42501` on refusal, `22023` on a bad value.
- `AVAILABLE_LOCALES` is `['en','pt','es']` and `profiles_locale_supported` (0135:14) is the CHECK to mirror.
- The `templates` catalogue namespace already holds `pickupReminder` and `webVerification` — the two existing purpose labels.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0260_international_phone.sql` | `country_phone_rule`, `international_phone` |
| `supabase/migrations/0261_station_country_backfill.sql` | `'BR'` on every `companies` row with none |
| `supabase/migrations/0262_member_phone_international.sql` | the local-form members, re-runnably |
| `supabase/migrations/0263_phone_doors_international.sql` | the six doors that write a phone |
| `supabase/migrations/0264_question_prompt_step.sql` | `whatsapp_conversation_steps` carries `prompt` |
| `supabase/migrations/0265_listener_locale.sql` | the column, `set_listener_locale`, `widget_frame_context` |
| `supabase/migrations/0266_template_purpose_participation.sql` | four enum values, and nothing else |
| `supabase/migrations/0267_whatsapp_fast_entry.sql` | `whatsapp_reply_envelope`, `ingest_whatsapp_event` |
| `supabase/migrations/0268_widget_fast_entry.sql` | `widget_enter_promotion`'s fast path and both consent rows |
| `supabase/tests/72_international_phone.test.sql` | the phone rule, the repairs, the doors |
| `supabase/tests/73_fast_entry.test.sql` | both fast paths and the template rule |
| `src/lib/widget/promotion-mapping.ts` | `prompt` on the step; `needsNoWalk` |
| `src/app/(widget)/w/[publicKey]/enter-promotion.tsx` | draws the prompt; skips the walk |
| `src/app/(widget)/w/[publicKey]/page.tsx` | the widget's own `NextIntlClientProvider` |
| `src/services/widget-installations.ts` | `installationContext` replacing `installationExists` |
| `src/app/(app)/messages/promo/listener-language.tsx` | the field, beside the hashtags |
| `src/app/(app)/messages/promo/actions.ts` | `saveListenerLocaleAction` |

---

### Task 1: One shape for a telephone number

**Files:**
- Create: `supabase/migrations/0260_international_phone.sql`
- Create: `supabase/tests/72_international_phone.test.sql`

**Interfaces:**
- Produces: `public.country_phone_rule(p_alpha2 text) returns table (calling_code text, national_min integer, national_max integer)` and `public.international_phone(p_phone text, p_country text) returns text`, both `immutable`.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/72_international_phone.test.sql`:

```sql
begin;
select plan(10);

-- The ordinary Brazilian mobile, typed as an operator types it.
select is(public.international_phone('(11) 99999-8888', 'BR'), '+5511999998888',
  'a national number gains its country code');

-- Already international: unchanged, not double-prefixed.
select is(public.international_phone('+55 11 99999-8888', 'BR'), '+5511999998888',
  'an international number is left alone');

-- IDEMPOTENT, asserted rather than assumed: 0262 re-runs this over stored
-- values, and a function that grew a second '+55' on the second pass would
-- corrupt every row it had already repaired.
select is(public.international_phone(public.international_phone('11999998888', 'BR'), 'BR'),
  '+5511999998888',
  'running it over its own output changes nothing');

-- THE COLLISION THIS FUNCTION EXISTS FOR. 55 is Santa Maria's area code as well
-- as Brazil's country code, so a prefix test would call this international and
-- leave a ten-digit number that can never be dialled.
select is(public.international_phone('(55) 9999-8888', 'BR'), '+555599998888',
  'an area code that equals the country code is still a national number');

select is(public.international_phone('99999-8888', 'BR'), '999998888',
  'a length no rule explains is returned unchanged, and WITHOUT a plus');

select is(public.international_phone('912 345 678', 'PT'), '+351912345678',
  'Portugal is a second country with a verified rule');

select is(public.international_phone('11999998888', 'ZZ'), '11999998888',
  'a country with no rule leaves the digits alone');

select is(public.international_phone('11999998888', null), '11999998888',
  'no country at all leaves the digits alone');

select is(public.international_phone(null, 'BR'), null,
  'no phone is no phone');

select is(public.international_phone('não é telefone', 'BR'), null,
  'text with no digits is null, exactly as normalize_phone answers');

select * from finish();
rollback;
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run db:test`
Expected: FAIL — `function public.international_phone(unknown, unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0260_international_phone.sql`:

```sql
-- supabase/migrations/0260_international_phone.sql

-- Block 30d, item 1b. One canonical shape for a telephone number: the
-- international form, digits only.
--
-- THE PREFIX CANNOT DECIDE, AND THAT IS THE WHOLE DESIGN. Brazil's country
-- code is 55 and Santa Maria's area code is also 55, so '5599998888' is a
-- NATIONAL number that opens with its own country's code. Only the length
-- separates the two, which is the rule whatsapp_local_phone (0062) already
-- applies in the other direction: it strips 55 at lengths 12 and 13 and never
-- at 10 or 11.
--
-- A ROW EXISTS ONLY FOR A COUNTRY WHOSE NATIONAL NUMBERING WAS VERIFIED, and
-- everything else is returned unchanged. That is deliberate and it is the safe
-- direction: an untouched number is no worse than what this database stores
-- today, while a wrong prefix would create exactly the duplicate listener this
-- item exists to stop. Adding a country is one row here plus its case in
-- supabase/tests/72_international_phone.test.sql.
create or replace function public.country_phone_rule(p_alpha2 text)
returns table (calling_code text, national_min integer, national_max integer)
language sql
immutable
set search_path = pg_catalog, public
as $$
  select r.calling_code, r.national_min, r.national_max
  from (values
    ('BR', '55',  10, 11),
    ('PT', '351',  9,  9),
    ('ES', '34',   9,  9),
    ('US', '1',   10, 10),
    ('CA', '1',   10, 10)
  ) as r(alpha2, calling_code, national_min, national_max)
  where r.alpha2 = upper(btrim(coalesce(p_alpha2, '')));
$$;

comment on function public.country_phone_rule(text) is
  'The calling code and the national length range for one ISO 3166-1 alpha-2 country, or no row. Holds only countries whose national numbering has been verified -- international_phone returns the digits unchanged for every other, which is why an absent row is a safe answer rather than a gap. US and CA share calling code 1 on purpose: this function composes numbers and never decomposes them, so the many-to-one is not an ambiguity here.';

-- The digits as the Cloud API wants them, or the digits unchanged when no rule
-- can decide.
--
-- THE INTERNATIONAL RANGE IS TESTED FIRST. For every rule here the two ranges
-- are disjoint (Brazil: 12-13 international against 10-11 national), so the
-- order is not load-bearing today -- it is stated so that a country added later
-- with overlapping ranges fails towards leaving a number alone rather than
-- towards prefixing one that already has a prefix.
create or replace function public.international_phone(p_phone text, p_country text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_digits text := public.normalize_phone(p_phone);
  v_rule   record;
begin
  if v_digits is null then
    return null;
  end if;

  select * into v_rule from public.country_phone_rule(p_country);
  if not found then
    return v_digits;
  end if;

  if length(v_digits) between length(v_rule.calling_code) + v_rule.national_min
                          and length(v_rule.calling_code) + v_rule.national_max
     and left(v_digits, length(v_rule.calling_code)) = v_rule.calling_code then
    return '+' || v_digits;
  end if;

  if length(v_digits) between v_rule.national_min and v_rule.national_max then
    return '+' || v_rule.calling_code || v_digits;
  end if;

  return v_digits;
end;
$$;
```

**The leading `+` is the house form, measured rather than chosen.** Every
`members.phone` in the hosted database reads `+5541900000006` — `+`, then
digits, no other punctuation. Returning bare digits would leave the eight rows
0262 repairs looking unlike the thousand around them. `normalize_phone` strips
the `+` for `phone_normalized`, so identity is unaffected either way, and
`whatsappHref` (`station-identity.ts`) already reduces a display number to
digits before building a `wa.me` address.

**A number no rule can place keeps its bare digits and gets no `+`** — a plus
in front of a number whose country nobody established would be a claim this
function has not earned.

```sql

comment on function public.international_phone(text, text) is
  'One telephone number in the form this database already stores: a leading plus, then the country code, then the national number, and no other punctuation -- the shape every members.phone row in production already carries. Goes through normalize_phone (0031) for the comparison rather than stripping punctuation itself, so it cannot drift from members.phone_normalized, the generated column whose value decides who is who; that column drops the plus, so identity is unaffected by it. IDEMPOTENT: running this over its own output returns the same string, which is what makes the 0262 repair safe to re-run. Returns the digits UNCHANGED AND UNPREFIXED when country_phone_rule has no row for the country and when the length matches neither range -- refusing would stop a listener registering because an administrator left a select empty, guessing would split one person into two rows, and a plus in front of a number whose country nobody established would be a claim this function has not earned. Block 30d, item 1b: the doors that write a phone all call this, so the widget, the console, the spreadsheet and the bot cannot come to disagree about what a number is.';

revoke execute on function public.country_phone_rule(text) from public;
revoke execute on function public.international_phone(text, text) from public;
grant execute on function public.country_phone_rule(text) to authenticated, service_role;
grant execute on function public.international_phone(text, text) to authenticated, service_role;
```

- [ ] **Step 4: Run the suite and watch it pass**

Run: `npm run db:reset` then `npm run db:test`
Expected: file 72 PASSES, 10 of 10.

- [ ] **Step 5: Prove the collision case actually discriminates**

Temporarily change the international test in the function body from the length range to `left(v_digits, length(v_rule.calling_code)) = v_rule.calling_code` alone, re-run `npm run db:test`, and confirm the Santa Maria assertion **fails**. Restore the body and re-run.

**This step is not optional.** A test that passes with and without the rule proves nothing, and this project has shipped exactly that mistake (Block 30c's isolation case). Record the observed failure message in the commit body.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0260_international_phone.sql supabase/tests/72_international_phone.test.sql
git commit -m "feat(30d): one shape for a phone number, decided by length because the prefix cannot"
```

---

### Task 2: The country on the Station, and the rows that carry the minority form

**Files:**
- Create: `supabase/migrations/0261_station_country_backfill.sql`
- Create: `supabase/migrations/0262_member_phone_international.sql`
- Modify: `supabase/tests/72_international_phone.test.sql`

**Interfaces:**
- Consumes: `public.international_phone` from Task 1.
- Produces: every `companies` row carries a country; no member row carries a form `international_phone` would change.

- [ ] **Step 1: Extend the pgTAP file with the two repairs**

Append to `supabase/tests/72_international_phone.test.sql` and raise `plan(10)` to `plan(13)`:

```sql
-- 0261. Every Station that predates the column has a country, so the doors can
-- prefix. Asserted as "none left without one" rather than as a count, which
-- would go stale the first time a Station is created.
select is((select count(*) from public.companies where country is null), 0::bigint,
  'no Station is left without a country');

-- 0262. The repair is expressed as a property, not as a row count: after it,
-- no member carries a phone that international_phone would still change.
--
-- COMPARED AGAINST `phone`, NOT `phone_normalized`. The function answers the
-- display form (with its leading plus) and phone_normalized is digits only, so
-- comparing against the generated column would report every correctly repaired
-- row as still needing repair -- a predicate that never settles.
select is(
  (select count(*)
     from public.members m
     join public.member_company_links l on l.member_id = m.id
     join public.companies c on c.id = l.company_id
    where m.phone is not null
      and public.international_phone(m.phone, c.country) is distinct from m.phone),
  0::bigint,
  'no member is left in a form the sanitation would change');

-- Re-running the repair changes nothing, which is what makes it safe to ship
-- twice (a migration re-applied by hand after a failed deploy is ordinary here).
select lives_ok($$
  update public.members m
     set phone = public.international_phone(m.phone, c.country)
    from public.member_company_links l
    join public.companies c on c.id = l.company_id
   where l.member_id = m.id
     and m.phone is not null
     and public.international_phone(m.phone, c.country) is distinct from m.phone
$$, 'the repair is re-runnable and finds nothing to do');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL on the first of the three — the seed's Stations have no country.

- [ ] **Step 3: Write 0261**

```sql
-- supabase/migrations/0261_station_country_backfill.sql

-- Block 30d, D5. Prefixing a national telephone number needs a country, and
-- every Station that exists predates companies.country (0213, Block 28) -- all
-- six carried null when this block was written, measured 2026-08-21.
--
-- 'BR' ON THE OWNER'S CONFIRMATION of 2026-08-21 that all six are Brazilian
-- radios. It is a fact about this deployment, not a default: a Station created
-- after this gets its country from the console's select, and one that somehow
-- has none stores phone numbers exactly as it does today (international_phone
-- returns the digits unchanged), which is a smaller harm than refusing a
-- listener's registration.
update public.companies
   set country = 'BR'
 where country is null;
```

- [ ] **Step 4: Write 0262**

```sql
-- supabase/migrations/0262_member_phone_international.sql

-- Block 30d, D5. The listeners already stored in the local form.
--
-- EIGHT ROWS IN THE HOSTED DATABASE when this was written, every one of them
-- first_contact_origin = 'WHATSAPP' -- the one path that converted an inbound
-- number to the local form before resolving the listener. The other 1 005 were
-- already international, which is why this block chose that form (D2) and why
-- this repair is eight rows rather than a thousand.
--
-- WRITES `phone`, NOT `phone_normalized`: the latter is GENERATED from the
-- former through normalize_phone (0031) and follows on its own.
--
-- THE PREDICATE IS THE REPAIR'S OWN DEFINITION, which is what makes a second
-- run a no-op: it selects exactly the rows whose stored digits differ from what
-- the sanitation would produce. A migration re-applied by hand after a failed
-- deploy is an ordinary event in this project.
--
-- The country comes from a Station the listener is linked to. A listener linked
-- to none, or to one with no country, is left alone -- see the function's own
-- comment for why leaving a number alone is the safe direction.
update public.members m
   set phone = public.international_phone(m.phone, c.country)
  from public.member_company_links l
  join public.companies c on c.id = l.company_id
 where l.member_id = m.id
   and m.phone is not null
   and public.international_phone(m.phone, c.country) is distinct from m.phone;
```

- [ ] **Step 5: Run the suite and watch it pass**

Run: `npm run db:reset` then `npm run db:test`
Expected: file 72 PASSES, 13 of 13.

- [ ] **Step 6: Confirm the unique index did not reject anything**

Run:

```bash
npx supabase db reset 2>&1 | grep -iE "duplicate key|members_phone_unique" || echo "no collision"
```

Expected: `no collision`. **If a collision appears, stop and report it.** It means two rows became the same number, which is a merge decision and explicitly out of scope for this block (spec §2).

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0261_station_country_backfill.sql supabase/migrations/0262_member_phone_international.sql supabase/tests/72_international_phone.test.sql
git commit -m "fix(30d): a country on every Station, and the eight listeners stored in the local form"
```

---

### Task 3: Every door that writes a phone calls the function

**Files:**
- Create: `supabase/migrations/0263_phone_doors_international.sql`
- Modify: `supabase/tests/72_international_phone.test.sql`

**Interfaces:**
- Consumes: `public.international_phone` from Task 1.
- Produces: no behaviour change to any signature. Every door stores the international form.

- [ ] **Step 1: Re-derive the door list rather than trusting this plan**

Run:

```bash
grep -rln "p_phone" supabase/migrations/*.sql
```

The doors this task rewrites are, with their **live** definitions: `widget_verify_code` (0164), `create_member` and `update_member` (0220), `resolve_or_create_member` (0054), `import_participations` (0056), `api_record_music_request` (0152) and `withdraw_marketing_by_phone` (0231).

**If the grep names a door this list does not, add it.** A door introduced between this plan and its execution is precisely the one that would keep writing the raw value, and it would do so silently.

- [ ] **Step 2: Write the failing pgTAP cases**

Append to `supabase/tests/72_international_phone.test.sql`, raising the plan by 3:

```sql
-- The widget's door is the one the owner reported. A visitor typing the local
-- form must become the SAME listener the bot already knows, not a second row.
select is(
  (select m.phone_normalized
     from public.members m
    where m.id = public.resolve_or_create_member(
      '00000000-0000-0000-0000-0000000030e1'::uuid,   -- organization
      '00000000-0000-0000-0000-0000000030e2'::uuid,   -- company, country 'BR'
      '11 98888-7777', 'Ouvinte Local')),
  '5511988887777',
  'the manual entry door stores the international form');

select is(
  (select count(*)
     from public.members
    where organization_id = '00000000-0000-0000-0000-0000000030e1'
      and phone_normalized = '5511988887777'),
  1::bigint,
  'the local and international spellings resolve to ONE listener');

select is(public.international_phone('+55 11 98888-7777', 'BR'), '5511988887777',
  'and the international spelling of the same number agrees');
```

Seed the organization, the company with `country = 'BR'`, and a member holding `5511988887777` above these assertions, following the seeding style already in `supabase/tests/71_promotion_rules_gate.test.sql`.

- [ ] **Step 3: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — the door stores `11988887777`, so the second assertion reports **2** listeners.

- [ ] **Step 4: Write 0263**

For each door: dump the live body, apply the single change, restate every grant.

```sql
select pg_get_functiondef('public.resolve_or_create_member'::regproc);
```

The change in every case is the same shape — the phone is sanitised **once, on entry**, before it is compared or stored:

```sql
  -- Block 30d, item 1b. Sanitised HERE, at the door, and not inside
  -- apply_member_lookup: that function resolves and never writes, so a door
  -- that looked up the clean number and inserted the raw one would find the
  -- right listener and still store the wrong form -- the same split, one layer
  -- deeper. The country comes from the Station this door already resolved.
  v_phone := public.international_phone(p_phone, v_country);
```

and every later use of `p_phone` in that body becomes `v_phone`.

**The country per door:**

| Door | Country from |
| --- | --- |
| `widget_verify_code` | the installation's `companies.country` — already joined for the suspension gate (0164) |
| `create_member` / `update_member` | `p_company_id`'s `companies.country` |
| `resolve_or_create_member` / `import_participations` | the `p_company_id` argument they already take |
| `api_record_music_request` | the Station the API token resolves (0152) |
| `withdraw_marketing_by_phone` | the integration's `company_id` |

**`widget_verify_code` sanitises for the LOOKUP and the INSERT only.** The verification row and the send keep the number the visitor typed: `widget_verifications.phone` is matched against what the browser posts on the second call, and changing one side without the other breaks code entry outright.

- [ ] **Step 5: Run the suite and watch it pass**

Run: `npm run db:reset` then `npm run db:test`
Expected: file 72 PASSES.

- [ ] **Step 6: Check the ACLs survived**

Run:

```sql
select proname, proacl from pg_proc
 where proname in ('resolve_or_create_member','import_participations','create_member',
                   'update_member','widget_verify_code','api_record_music_request',
                   'withdraw_marketing_by_phone')
 order by proname;
```

Expected: every row carries the grants it carried before. **A `drop` destroys the ACL and this is how Block 24 lost one.**

- [ ] **Step 7: Run the isolation suite**

Run: `npm run test:isolation`
Expected: no new failures. Note that this suite never completes all 49 files on this machine — different files drop each run — so judge it by *new* failures naming these doors, not by completion.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/0263_phone_doors_international.sql supabase/tests/72_international_phone.test.sql
git commit -m "fix(30d): every door that writes a phone writes the same shape"
```

---

### Task 4: The question you can read

**Files:**
- Create: `supabase/migrations/0264_question_prompt_step.sql`
- Modify: `src/lib/widget/promotion-mapping.ts`
- Modify: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx:547-590`
- Modify: `tests/unit/widget-promotion-mapping.test.ts`
- Modify: `tests/e2e/widget.spec.ts`

**There is no `widget-promotions.spec.ts`.** The widget journey is
`tests/e2e/widget.spec.ts`, it runs the widget **inside an iframe** (`:199`),
and its `beforeAll` already seeds an installation, a promotion carrying a
question through `save_promotion_question` (`:550`), and two more promotions.
Extend it; do not build a second seeding.

**Interfaces:**
- Produces: `WidgetStep` question variant gains `prompt: string`. `readSteps` keeps it.

- [ ] **Step 1: Write the failing unit test**

Append to `tests/unit/widget-promotion-mapping.test.ts`, which already covers this module:

```ts
import { describe, expect, it } from 'vitest';
import { readSteps } from '@/lib/widget/promotion-mapping';

describe('readSteps', () => {
  it('keeps the prompt the door now sends', () => {
    const steps = readSteps([
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
    ]);

    expect(steps).toEqual([
      { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
    ]);
  });

  // The door and the browser ship separately: a bundle held from before 0264
  // must not start dropping every question because a key it never sent is
  // absent. Dropping the step would blank the walk, which is worse than a
  // question drawn without its text.
  it('keeps a question that carries no prompt', () => {
    const steps = readSteps([{ kind: 'question', questionId: 'q1', questionKind: 'ESSAY' }]);

    expect(steps).toEqual([
      { kind: 'question', questionId: 'q1', questionKind: 'ESSAY', prompt: '' },
    ]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/widget-promotion-mapping.test.ts`
Expected: FAIL — the returned object has no `prompt`.

- [ ] **Step 3: Widen the type and the reader**

In `src/lib/widget/promotion-mapping.ts`, change the question variant:

```ts
  | {
      kind: 'question';
      questionId: string;
      questionKind: string;
      /**
       * The text the operator wrote (`promotion_questions.prompt`, 0041, which
       * is `not null` with a non-blank CHECK). Block 30d, item 1: until 0264
       * the step carried the question's id and kind and no words at all, so the
       * panel drew alternatives under nothing.
       *
       * EMPTY STRING WHEN THE DOOR DID NOT SEND ONE, rather than dropping the
       * step: a browser holding a bundle from before 0264 would otherwise lose
       * every question, which turns a missing sentence into a blank walk.
       */
      prompt: string;
    };
```

and in `readSteps`, in the question branch:

```ts
      steps.push({
        kind: 'question',
        questionId: step.questionId,
        questionKind: step.questionKind,
        prompt: typeof step.prompt === 'string' ? step.prompt : '',
      });
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run tests/unit/widget-promotion-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Write 0264**

Recreate `whatsapp_conversation_steps` from its live body (0066 is live), adding one key:

```sql
                            'kind', 'question',
                            'questionId', q.id,
                            'questionKind', q.kind,
                            'prompt', q.prompt) order by q.position)
```

and amend the function's comment to say the step carries the question's text. **Both callers get it for free**: `widget_promotions` passes the answer straight through (`0186:57`) and `widget_enter_promotion` recomputes it — neither needs editing.

- [ ] **Step 6: Draw it**

In `enter-promotion.tsx`, in the `Question` component, above the `ESSAY` branch and the options list:

```tsx
      <p className="text-base font-medium" data-testid="widget-question-prompt">
        {step.prompt}
      </p>
```

**No `messages/*.json` key.** This is a Station's own words about its own promotion, not product copy — the same reason the rules text has no key.

- [ ] **Step 7: Write the e2e assertion**

In `tests/e2e/widget.spec.ts`, in the walk that reaches the question its
`beforeAll` seeds at `:550`, assert against the prompt that seeding actually
passes — read it out of the `save_promotion_question` call rather than retyping
a sentence that looks like it:

```ts
  await expect(framedWidget!.getByTestId('widget-question-prompt')).toHaveText(QUESTION_PROMPT);
```

Lift the seeded prompt into a `QUESTION_PROMPT` constant used by both the
`beforeAll` call and this assertion, so the two cannot drift into a test that
passes against the wrong string.

- [ ] **Step 8: Run the gates**

Run: `npm run db:reset` → `npm run db:test` → `npm run seed:branding` → `npm run test:e2e`
Expected: green.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0264_question_prompt_step.sql src/lib/widget/promotion-mapping.ts src/app/\(widget\)/w/\[publicKey\]/enter-promotion.tsx tests/unit/widget-promotion-mapping.test.ts tests/e2e/widget-promotions.spec.ts
git commit -m "fix(30d): the widget draws the question, not just its answers"
```

---

### Task 5: The Station carries the listener's language

**Files:**
- Create: `supabase/migrations/0265_listener_locale.sql`
- Modify: `src/services/templates.ts`
- Modify: `src/schemas/templates.ts`
- Modify: `src/app/(app)/messages/errors.ts`
- Modify: `src/app/(app)/messages/promo/actions.ts`
- Create: `src/app/(app)/messages/promo/listener-language.tsx`
- Modify: `src/app/(app)/messages/promo/page.tsx`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`
- Create: `supabase/tests/74_listener_locale.test.sql`

**Interfaces:**
- Produces: `companies.listener_locale text`; `public.set_listener_locale(p_company_id uuid, p_locale text) returns void`; `widget_frame_context` answers a `listenerLocale` key.

- [ ] **Step 1: Write the failing pgTAP cases**

Create `supabase/tests/74_listener_locale.test.sql` with `plan(4)`. **Its own file, not an appendix to 72** — that file is the phone rule, and a language assertion inside it is filed where nobody looking for it will read. Seed the organization, a company, and a widget installation the way `73_fast_entry.test.sql` does:

```sql
select has_column('public', 'companies', 'listener_locale', 'the Station carries a listener language');

select throws_ok($$ select public.set_listener_locale('00000000-0000-0000-0000-0000000030e2', 'de') $$,
  '22023', null, 'a language with no catalogue is refused');

select throws_ok($$ select public.set_listener_locale('00000000-0000-0000-0000-0000000030e2', 'pt') $$,
  '42501', null, 'a caller without templates.manage is refused');

-- The key rides on the door that runs in BOTH widget presentations. Asserted on
-- the door rather than on the column, because the column being right while the
-- door omits it is exactly the failure this block is fixing.
select is(
  public.widget_frame_context('pw_000000000000000000030e') ->> 'listenerLocale',
  'pt',
  'the frame door carries the language to the widget');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — no such column.

- [ ] **Step 3: Write 0265**

```sql
-- supabase/migrations/0265_listener_locale.sql

-- Block 30d, item 2. The language the LISTENER reads.
--
-- NAMED listener_locale AND NOT locale, on purpose. profiles.locale (0135)
-- keeps painting the console, by the owner's ruling of 2026-08-21: a Station
-- decides what its listeners read, not what its operators read. A column called
-- `locale` sitting on companies is an invitation for the next person to wire
-- the console to it, and the name is the cheapest guard against that.
--
-- Nullable, and null means today's behaviour -- the widget falls back to the
-- ordinary resolution. A Station that never chooses is not broken by this.
alter table public.companies
  add column listener_locale text
  constraint companies_listener_locale_supported
    check (listener_locale is null or listener_locale in ('en', 'pt', 'es'));

comment on column public.companies.listener_locale is
  'The language this Station''s widget renders in, ISO 639-1, restricted to the catalogues that exist (the same set profiles_locale_supported names, 0135). Block 30d, item 2. It governs what a LISTENER reads and nothing an operator reads: the console stays on profiles.locale. Null means the widget resolves language the way it did before this block -- cookie, then Accept-Language.';
```

then the door, mirroring `set_service_hashtags` (0177:41-59):

```sql
create function public.set_listener_locale(p_company_id uuid, p_locale text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_locale text := nullif(btrim(coalesce(p_locale, '')), '');
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'set_listener_locale denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  -- The CHECK above is the backstop for any writer that is not this door. This
  -- raise exists so the screen has a sentence to show: a constraint violation
  -- surfaces as raw Postgres text naming companies_listener_locale_supported,
  -- and the promo screen maps 42501/22023/P0002 to sentences an operator reads.
  if v_locale is not null and v_locale not in ('en', 'pt', 'es') then
    raise exception 'that language has no catalogue' using errcode = '22023';
  end if;

  update public.companies set listener_locale = v_locale, updated_at = now()
   where id = p_company_id;
end;
$$;

revoke execute on function public.set_listener_locale(uuid, text) from public;
grant execute on function public.set_listener_locale(uuid, text) to authenticated;

comment on function public.set_listener_locale(uuid, text) is
  'Sets the language this Station''s widget renders in. Gated on templates.manage, the same permission the system texts and the two service hashtags on the same screen carry -- that screen is where what a listener reads is decided. An empty value clears the choice, which returns the widget to the ordinary resolution.';
```

then `widget_frame_context`, recreated from its **live** body (0164:83-107) with one key added:

```sql
    (select jsonb_build_object(
              'found', true,
              'origins', to_jsonb(w.allowed_origins),
              'listenerLocale', c.listener_locale)
```

and the `false` branch gaining `'listenerLocale', null`. Amend the comment to say the key is there and that a refusal carries a null language like it carries an empty origins list.

**Why this door and not `widget_station_identity` (0185):** `page.tsx:129` calls the identity door only when the presentation is `app`, so an embedded widget — the product's whole point — would never receive the language. `widget_frame_context` is what `installationExists` calls on every widget request in both presentations. Put that sentence in the migration.

- [ ] **Step 4: Add the catalogue keys**

Three files, same keys:

```json
"listenerLanguage": "Listener language",
"listenerLanguageHelp": "The language this Station's widget is shown in. It does not change your own language.",
"listenerLanguageSystem": "Follow the visitor's browser",
```

pt: `"Idioma do ouvinte"`, `"O idioma em que o widget desta emissora aparece. Não muda o seu próprio idioma."`, `"Seguir o navegador do visitante"`.
es: `"Idioma del oyente"`, `"El idioma en que se muestra el widget de esta emisora. No cambia tu propio idioma."`, `"Seguir el navegador del visitante"`.

- [ ] **Step 5: Write the card and its action**

`listener-language.tsx`, a client component holding one `useActionState` form:

```tsx
export function ListenerLanguage({
  companyId,
  locale,
  canManage,
}: {
  companyId: string;
  locale: string | null;
  canManage: boolean;
}) {
  const t = useTranslations('templates');
  const [state, action, pending] = useActionState(saveListenerLocaleAction, INITIAL);

  return (
    <Card data-testid="listener-language-card">
      <CardContent>
        <form action={action}>
          <input type="hidden" name="companyId" value={companyId} />
          <label htmlFor="listener-locale">{t('listenerLanguage')}</label>
          <select
            id="listener-locale"
            name="locale"
            // Remounted on the saved value, so a successful save shows what was
            // saved rather than what was typed. `hashtag-fields.tsx:107` keys
            // its two inputs the same way and for the same reason.
            key={locale ?? ''}
            defaultValue={locale ?? ''}
            disabled={pending || !canManage}
            data-testid="listener-locale-select"
          >
            <option value="">{t('listenerLanguageSystem')}</option>
            <option value="pt">Português</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
          <p className="text-sm text-muted-foreground">{t('listenerLanguageHelp')}</p>
          <Button type="submit" disabled={pending || !canManage}>
            {pending ? t('saving') : t('save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

**The three language names are not catalogue keys.** A language is written in
its own language in a picker, which is what `settings-menu.tsx:15-17` already
does — translating "Português" into English helps nobody choosing it.

The action mirrors `saveServiceHashtagsAction` (`actions.ts:142`) exactly, and
the shape matters: **the raw PostgREST error never reaches a describer.** The
service function converts Postgres codes into this codebase's typed errors and
the describer maps those to sentences — `describeServiceHashtagsError`
(`errors.ts:111`) takes `ValidationError` / `NotFoundError` /
`UnauthorizedError`, never a `code` string.

```ts
export type ListenerLocaleState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

export async function saveListenerLocaleAction(
  _prev: ListenerLocaleState,
  formData: FormData,
): Promise<ListenerLocaleState> {
  const parsed = listenerLocaleFormSchema.safeParse({
    companyId: formData.get('companyId'),
    locale: formData.get('locale'),
  });

  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the language.' };
  }

  const token = await requireAccessToken();

  try {
    await setListenerLocale(parsed.data, token);
    revalidatePath('/messages/promo');
    return { status: 'saved' };
  } catch (cause) {
    logger.error(
      { err: cause, companyId: parsed.data.companyId },
      'save the listener locale failed',
    );
    return {
      status: 'error',
      message: describeListenerLocaleError(cause, await getTranslations('templates')),
    };
  }
}
```

`setListenerLocale` goes in `src/services/templates.ts` beside
`setServiceHashtags` and raises the same typed errors from 42501 and 22023.
`describeListenerLocaleError` goes in `errors.ts` beside its sibling and needs
**no `NotFoundError` branch**: `set_listener_locale` raises no P0002, because a
Station always exists — unlike the hashtag door, which fails when the Station
has no widget installation.

`listenerLocaleFormSchema` goes in `src/schemas/templates.ts` and accepts `''`
or one of the three locales — the same set the CHECK and the door accept, so the
three cannot disagree.

- [ ] **Step 6: Run the gates**

Run: `npm run db:reset` → `npm run db:test`, then `npx tsc --noEmit` and `npm run lint`.
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0265_listener_locale.sql src/services/templates.ts src/schemas/templates.ts "src/app/(app)/messages" messages supabase/tests/74_listener_locale.test.sql
git commit -m "feat(30d): the Station decides what language its listeners read"
```

---

### Task 6: The widget stops asking the browser

**Files:**
- Modify: `src/services/widget-installations.ts:55-78`
- Modify: `src/app/(widget)/w/[publicKey]/page.tsx`
- Modify: `tests/e2e/widget.spec.ts`

**Interfaces:**
- Consumes: `widget_frame_context`'s `listenerLocale` from Task 5.
- Produces: `installationContext(publicKey): Promise<{ found: boolean; listenerLocale: Locale | null }>`, **replacing** `installationExists`.

- [ ] **Step 1: Write the failing e2e test**

Add to `tests/e2e/widget.spec.ts`, which already holds `publicKey`, the host
page that frames the widget (`:199`) and the `framedWidget` lookup (`:920`).
Set the Station's language in the existing `beforeAll`, next to
`upsert_widget_installation`:

```ts
  const { error: localeError } = await ownerClient.rpc('set_listener_locale', {
    p_company_id: companyId,
    p_locale: 'pt',
  });
  expect(localeError).toBeNull();
```

then the test itself:

```ts
// THE COOKIE IS THE DEFECT, so this test plants one. Checked in a clean browser
// this passes with and without the change -- there is nothing for the Station's
// language to win against -- which is the shape of test this project has
// shipped before while believing it proved something.
//
// AND IT RUNS IN THE IFRAME, which is the presentation that matters: the
// obvious carrier for the language, widget_station_identity, is fetched only in
// the `app` presentation (page.tsx:129), so a test driving the standalone page
// would pass against a build where the embedded widget is still wrong.
test('the widget renders in the Station language even when the browser carries another', async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: 'locale', value: 'en', url: appOrigin }]);

  await page.goto(hostPageUrl);
  const framed = page.frames().find((candidate) => candidate.url().includes(`/w/${publicKey}`));

  await expect(framed!.getByRole('button', { name: 'Pedir música' })).toBeVisible();
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run seed:branding && npm run test:e2e -- widget`
Expected: FAIL — the button reads "Request a song", because the cookie won.

- [ ] **Step 3: Widen the service reader**

Replace `installationExists` with `installationContext`, keeping its existing rules — the empty-key short circuit, the anon client, the **throw** on a database error, and the shape check rather than an assertion:

```ts
export interface InstallationContext {
  found: boolean;
  /** Null when the Station never chose, which means the ordinary resolution. */
  listenerLocale: Locale | null;
}
```

`found` stays exactly as it was computed. `listenerLocale` is filtered through `isAvailable` from `@/i18n/locales` before it is returned — the value becomes an import path downstream, which is the reason `resolveLocale` filters too.

- [ ] **Step 4: Wrap the widget's own subtree**

In `page.tsx`, where `installationExists` was called, take the context and wrap the returned tree:

```tsx
  const messages = (await import(`../../../../../messages/${widgetLocale}.json`)).default;

  return (
    <NextIntlClientProvider locale={widgetLocale} messages={messages}>
      {body}
    </NextIntlClientProvider>
  );
```

where `widgetLocale` is `context.listenerLocale ?? (await getLocale())`. Server-rendered strings in this subtree use `getTranslations({ locale: widgetLocale, namespace: 'widget' })`.

Add the comment that says why:

```tsx
  // Block 30d, D7. The root provider resolves from the `locale` cookie, and
  // src/middleware.ts:421 writes that cookie from the signed-in profile with
  // `path: '/'` -- a path that covers /w. An operator who set the console to
  // English then saw an English widget on the Station's own site. The Station's
  // choice has to win HERE, over a provider that has already resolved, which is
  // why this is a second provider rather than a change to src/i18n/request.ts:
  // that file serves every route and knows nothing about installations.
```

- [ ] **Step 5: Run the e2e test and watch it pass**

Run: `npm run test:e2e -- widget`
Expected: PASS.

- [ ] **Step 6: Prove the test discriminates**

Set the seeded Station's `listener_locale` to null, re-run, and confirm the test **fails**. Restore it.

- [ ] **Step 7: Run the whole e2e suite once**

Run: `npm run seed:branding && npm run test:e2e`
Expected: green. `installationExists` had one other caller path — confirm the rename left none behind with `grep -rn "installationExists" src/`.

- [ ] **Step 8: Commit**

```bash
git add src/services/widget-installations.ts "src/app/(widget)/w/[publicKey]/page.tsx" tests/e2e/widget.spec.ts
git commit -m "fix(30d): the widget resolves its own language instead of inheriting the operator's cookie"
```

---

### Task 7: Four purposes, alone in their file

**Files:**
- Create: `supabase/migrations/0266_template_purpose_participation.sql`
- Modify: `messages/en.json`, `messages/pt.json`, `messages/es.json`

**Interfaces:**
- Produces: `template_purpose` gains `PARTICIPATION_CONFIRMED`, `PARTICIPATION_DUPLICATE`, `PARTICIPATION_TOO_SOON`, `PARTICIPATION_OVER_LIMIT`.

- [ ] **Step 1: Write the migration, and put nothing else in it**

```sql
-- supabase/migrations/0266_template_purpose_participation.sql

-- Block 30d, D9. One purpose per answer apply_participation can give, because
-- the four sentences carry different variables -- a single template whose body
-- is nearly all placeholder is the shape Meta rejects.
--
-- ALONE IN THIS FILE, AND THAT IS THE POINT. Supabase runs each migration in
-- its own transaction, and a value added by `alter type ... add value` cannot
-- be USED in the transaction that added it. 0267 is where they are used.
alter type public.template_purpose add value if not exists 'PARTICIPATION_CONFIRMED';
alter type public.template_purpose add value if not exists 'PARTICIPATION_DUPLICATE';
alter type public.template_purpose add value if not exists 'PARTICIPATION_TOO_SOON';
alter type public.template_purpose add value if not exists 'PARTICIPATION_OVER_LIMIT';
```

- [ ] **Step 2: Add the four labels to all three catalogues**

Beside the existing `pickupReminder` and `webVerification` in the `templates` namespace:

```json
"participationConfirmed": "Entry confirmed",
"participationDuplicate": "Already entered",
"participationTooSoon": "Entered too recently",
"participationOverLimit": "No chances left",
```

pt: `"Participação confirmada"`, `"Já participava"`, `"Participou há pouco"`, `"Chances esgotadas"`.
es: `"Participación confirmada"`, `"Ya participaba"`, `"Participó hace poco"`, `"Sin oportunidades"`.

- [ ] **Step 3: Regenerate the types**

Run: `npm run db:reset && npm run db:types`
Expected: `template_purpose` in `database.types.ts` now lists six values.

- [ ] **Step 4: Run the catalogue guard and typecheck**

Run: `npx vitest run tests/unit/catalogue.test.ts` and `npx tsc --noEmit`
Expected: PASS. The registration screen's purpose select is driven by the enum, so the four appear there with the labels just added — check that screen renders before moving on.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0266_template_purpose_participation.sql messages src/lib/supabase/database.types.ts
git commit -m "feat(30d): four template purposes, one per answer a participation can give"
```

---

### Task 8: The hashtag that enters instead of linking

**Files:**
- Create: `supabase/migrations/0267_whatsapp_fast_entry.sql`
- Create: `supabase/tests/73_fast_entry.test.sql`

**Interfaces:**
- Consumes: the four purposes from Task 7.
- Produces: `public.whatsapp_reply_envelope(p_promotion_id uuid, p_member_id uuid, p_status text, p_company_id uuid) returns jsonb` — `{body, purpose, variables}`, `purpose` null when the sentence must go as a session message. `ingest_whatsapp_event` answers `outcome: 'recorded'` where it used to answer `outcome: 'link'`, whenever nothing is left to ask.

- [ ] **Step 1: Write the failing pgTAP file**

Create `supabase/tests/73_fast_entry.test.sql` with `plan(6)`:

```sql
-- A promotion with no question and a listener with nothing stale: the hashtag
-- enters them, and the answer says so instead of handing back a link.
select is(
  public.ingest_whatsapp_event('00000000-0000-0000-0000-0000000030f1', 3) ->> 'outcome',
  'recorded',
  'nothing left to ask means the entry is taken now');

select is(
  (select count(*) from public.participations
    where promotion_id = '00000000-0000-0000-0000-0000000030f2'
      and member_id = '00000000-0000-0000-0000-0000000030f3'
      and status = 'VALID'),
  1::bigint,
  'and the participation exists');

-- The same promotion, a listener who is missing a requested field: the link is
-- still the answer, because the bot cannot ask for a name any more (19a).
select is(
  public.ingest_whatsapp_event('00000000-0000-0000-0000-0000000030f4', 3) ->> 'outcome',
  'link',
  'a listener with a field still to fill gets the link');

-- D9, first half: no registration, so the sentence goes as a session message.
select is(
  (select template_name from public.outbox_messages
    where dedupe_key like '%:confirmation' order by created_at desc limit 1),
  null,
  'with no template registered the reply is a session message');

select like(
  (select body from public.outbox_messages
    where dedupe_key like '%:confirmation' order by created_at desc limit 1),
  'Pronto! Você está participando%',
  'and it carries the sentence whatsapp_reply_body already wrote');

-- D9, second half: registered and every variable known, so it goes as a
-- template and `body` is what the approved text rendered to.
select is(
  (select template_name from public.outbox_messages
    where dedupe_key like '%:confirmation2' order by created_at desc limit 1),
  'participacao_confirmada',
  'with a live registration the reply goes out as the template');
```

Seed above these: an organization, a company with `country = 'BR'`, an enabled integration, a widget installation, a promotion with a hashtag and rules and **no questions**, two listeners (one complete, one missing `full_name`), and — for the last assertion only — one `message_templates` row for `PARTICIPATION_CONFIRMED` whose body uses `{{1}}`.

- [ ] **Step 2: Run and watch it fail**

Run: `npm run db:test`
Expected: FAIL — the first assertion answers `link`.

- [ ] **Step 3: Write the envelope function**

In `0267`, before touching the door:

```sql
-- Block 30d, D9. Which envelope one reply travels in.
--
-- ONE RULE COVERS BOTH WAYS A TEMPLATE CAN BE MISSING: it goes as a template
-- when a live registration exists for the purpose at this Station AND every
-- variable that template needs is known; otherwise the same sentence goes as a
-- session message. The second half is not hypothetical -- whatsapp_reply_body
-- (0062) has a branch for a listener with no computable next chance and one for
-- a promotion with no ceiling, and those sentences have no value to put in
-- {{2}}. enqueue_whatsapp_outbound refuses a short variable list with 22023
-- (0111), so choosing the template there would turn a working reply into a
-- failed event.
--
-- THE SESSION MESSAGE IS LEGITIMATE HERE AND ONLY HERE: the listener sent the
-- hashtag seconds earlier, so Meta's 24-hour window is open by their own act.
-- It is also what keeps every Station working on the day this ships, when none
-- of them has registered anything yet.
create function public.whatsapp_reply_envelope(
  p_promotion_id uuid,
  p_member_id    uuid,
  p_status       text,
  p_company_id   uuid
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  v_name      text;
  v_ceiling   integer;
  v_min_hours integer;
  v_timezone  text;
  v_last      timestamptz;
  v_next      text;
  v_body      text;
  v_purpose   public.template_purpose;
  v_vars      jsonb;
begin
  select p.name, p.max_entries_per_member, p.min_hours_between_entries, c.timezone
    into v_name, v_ceiling, v_min_hours, v_timezone
  from public.promotions p
  join public.companies c on c.id = p.company_id
  where p.id = p_promotion_id;

  if not found then
    return jsonb_build_object('body', null, 'purpose', null, 'variables', '[]'::jsonb);
  end if;

  if p_status = 'VALID' then
    v_body    := format('Pronto! Você está participando de %s. Boa sorte!', v_name);
    v_purpose := 'PARTICIPATION_CONFIRMED';
    v_vars    := jsonb_build_array(v_name);

  elsif p_status = 'DUPLICATE' then
    v_body    := format('Você já está participando de %s.', v_name);
    v_purpose := 'PARTICIPATION_DUPLICATE';
    v_vars    := jsonb_build_array(v_name);

  elsif p_status = 'TOO_SOON' then
    if v_min_hours is not null then
      select max(participated_at) into v_last
      from public.participations
      where promotion_id = p_promotion_id
        and member_id = p_member_id
        and status = 'VALID';
    end if;

    v_purpose := 'PARTICIPATION_TOO_SOON';
    if v_last is null then
      -- 0062's own branch: a promotion edited between the entry and the reply,
      -- or a TOO_SOON decided under a lock this function does not hold. There
      -- is NO TIME to put in {{2}}, so a null variable list is what sends this
      -- as a session message a few lines below.
      v_body := 'Você já participou há pouco. Tente novamente mais tarde.';
      v_vars := null;
    else
      v_next := to_char(
        (v_last + make_interval(hours => v_min_hours)) at time zone v_timezone, 'HH24:MI');
      v_body := format('Você já participou há pouco. Sua próxima chance é às %s.', v_next);
      v_vars := jsonb_build_array(v_name, v_next);
    end if;

  elsif p_status = 'OVER_LIMIT' then
    v_purpose := 'PARTICIPATION_OVER_LIMIT';
    if v_ceiling is null then
      v_body := 'Você já usou todas as suas chances nesta promoção.';
      v_vars := null;
    else
      v_body := format('Você já usou suas %s chances nesta promoção.', v_ceiling);
      v_vars := jsonb_build_array(v_name, v_ceiling::text);
    end if;

  else
    return jsonb_build_object('body', null, 'purpose', null, 'variables', '[]'::jsonb);
  end if;

  if v_vars is null
     or p_company_id is null
     or not exists (select 1 from public.message_templates
                     where company_id = p_company_id
                       and purpose = v_purpose
                       and deleted_at is null) then
    return jsonb_build_object('body', v_body, 'purpose', null, 'variables', '[]'::jsonb);
  end if;

  return jsonb_build_object('body', v_body, 'purpose', v_purpose::text, 'variables', v_vars);
end;
$$;
```

**Then `whatsapp_reply_body` becomes a wrapper over it, and that is the point of
doing it this way:**

```sql
create or replace function public.whatsapp_reply_body(
  p_promotion_id uuid, p_member_id uuid, p_status text)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select public.whatsapp_reply_envelope(p_promotion_id, p_member_id, p_status, null) ->> 'body';
$$;
```

The four sentences and the values inside them are computed **once**. Writing the
envelope beside `whatsapp_reply_body` instead would have put the next-chance
clock and the ceiling in two places, and 0062's header already states the rule
this codebase keeps: one rule, one entrance. Passing a null company is what
makes the wrapper answer a sentence and never a template — it has no Station to
look a registration up for, and its existing callers want the words.

- [ ] **Step 4: Rewrite the two branches in `ingest_whatsapp_event`**

Recreate the door from its **live** body (0179) and change exactly two things.

The existing non-VALID branch (`0179:239-261`) stops writing `outbox_messages` by hand and calls the envelope instead:

```sql
    v_env := public.whatsapp_reply_envelope(v_promo.id, v_member, v_status, v_integ.company_id);
    if v_env ->> 'body' is not null then
      perform public.enqueue_whatsapp_outbound(
        v_integ.id, v_from, v_env ->> 'body', null,
        v_event.external_id || ':confirmation',
        (v_env ->> 'purpose')::public.template_purpose,
        v_env -> 'variables');
    end if;
```

and a new branch, immediately after it, for the VALID case:

```sql
  -- Block 30d, D8. Nothing left to ask means the entry is taken NOW, without a
  -- link. The test is on the RECOMPUTED step list and therefore on the pair
  -- (promotion, listener): a promotion with no quiz still asks a newcomer for
  -- the fields it declares, and the bot has not been able to ask a question
  -- since 19a. So a newcomer still gets the link, fills the form once, and
  -- every entry after that is immediate.
  --
  -- 'consent' IS NOT COUNTED. Sending the hashtag is asking to take part --
  -- 0179's own comment on the rules gate says exactly that -- and this path
  -- has never written a consent row, which is the divergence from the web door
  -- that 0186's comment already records.
  if v_promo.id is not null
     and not exists (
       select 1
         from jsonb_array_elements(
                public.whatsapp_conversation_steps(v_promo.id, v_member)) as s
        where s ->> 'kind' in ('field', 'question'))
  then
    v_result := public.apply_participation(
      v_promo.id, v_member, v_when, 'WHATSAPP', '[]'::jsonb);

    v_status := v_result ->> 'status';
    v_part   := (v_result ->> 'participation_id')::uuid;
    v_env    := public.whatsapp_reply_envelope(
                  v_promo.id, v_member, v_status, v_integ.company_id);

    if v_env ->> 'body' is not null then
      perform public.enqueue_whatsapp_outbound(
        v_integ.id, v_from, v_env ->> 'body', null,
        v_event.external_id || ':confirmation',
        nullif(v_env ->> 'purpose', '')::public.template_purpose,
        v_env -> 'variables');
    end if;

    return public.finish_whatsapp_event(v_event.id, 'recorded', v_status, v_part);
  end if;
```

`v_env jsonb` joins the `declare` block. **The entry is written before the reply
is chosen**, and nothing about which envelope carries the sentence can undo it —
`enqueue_whatsapp_outbound` returning null is a dedupe hit, which 0071's comment
calls success rather than conflict.

**Placed AFTER the pre-check and AFTER the `no_installation` / `no_rules` gates**, so a promotion with no rules text still sends nothing and a Station with no installation still finishes under its own name.

- [ ] **Step 5: Run the suite and watch it pass**

Run: `npm run db:reset` then `npm run db:test`
Expected: files 72 and 73 PASS.

- [ ] **Step 6: Prove the fast path is gated**

Delete the `and not exists (...)` guard, re-run, and confirm the third assertion — the listener missing a field — **fails** by entering them anyway. Restore it.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0267_whatsapp_fast_entry.sql supabase/tests/73_fast_entry.test.sql
git commit -m "feat(30d): the hashtag enters a promotion that asks nothing, and the reply picks its envelope"
```

---

### Task 9: The web path that needs no walk

**Files:**
- Create: `supabase/migrations/0268_widget_fast_entry.sql`
- Modify: `src/lib/widget/promotion-mapping.ts`
- Modify: `src/app/(widget)/w/[publicKey]/enter-promotion.tsx`
- Modify: `tests/unit/widget-promotion-mapping.test.ts`
- Modify: `supabase/tests/73_fast_entry.test.sql`
- Modify: `tests/e2e/widget-promotions.spec.ts`

**Interfaces:**
- Produces: `needsNoWalk(steps: WidgetStep[]): boolean` in `promotion-mapping.ts`. `widget_enter_promotion` writes the `rules` consent with `promotion_id` on both paths and a distinct `origin` on the fast one.

- [ ] **Step 1: Write the failing unit test**

Append to `tests/unit/widget-promotion-mapping.test.ts`:

```ts
import { needsNoWalk } from '@/lib/widget/promotion-mapping';

describe('needsNoWalk', () => {
  it('is true when consent is the only step left', () => {
    expect(needsNoWalk([{ kind: 'consent' }])).toBe(true);
  });

  it('is false when a field is still to fill', () => {
    expect(needsNoWalk([{ kind: 'consent' }, { kind: 'field', field: 'full_name' }])).toBe(false);
  });

  it('is false when a question is still to answer', () => {
    expect(
      needsNoWalk([
        { kind: 'consent' },
        { kind: 'question', questionId: 'q1', questionKind: 'QUIZ', prompt: 'Quem canta?' },
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/unit/widget-promotion-mapping.test.ts`
Expected: FAIL — `needsNoWalk` is not exported.

- [ ] **Step 3: Write it**

```ts
/**
 * Whether this promotion asks this listener nothing at all.
 *
 * Block 30d, D8 and D10. Consent is not counted: by the owner's ruling of
 * 2026-08-21 the rules screen does not appear on this path, and the door
 * records the consent from the act of entering instead.
 *
 * A COURTESY, NEVER A GUARD -- the same standing `firstUnansweredScreen` has.
 * `widget_enter_promotion` recomputes the step list and remains the only
 * authority on what a promotion asks; this function decides which screen a
 * browser draws, and a disagreement between the two shows up as a refusal the
 * panel already renders rather than as an entry nobody checked.
 */
export function needsNoWalk(steps: WidgetStep[]): boolean {
  return !steps.some((step) => step.kind === 'field' || step.kind === 'question');
}
```

- [ ] **Step 4: Run the unit test**

Run: `npx vitest run tests/unit/widget-promotion-mapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Write 0268**

Recreate `widget_enter_promotion` from its **live** body (**0234**, not 0186 and not 0171) and change two statements.

The `rules` consent insert at `0234:154-157` gains the promotion and a truthful origin:

```sql
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin,
     promotion_id, recorded_by)
  values
    (v.o_org, p_member_id, v.o_company, 'rules', true,
     case when v_fast then 'web-widget-entry' else 'web-widget' end,
     p_promotion_id, null);
```

with the comment:

```sql
  -- Block 30d, D10. TWO CHANGES, and both are about what this row can prove.
  --
  -- promotion_id was null, on a consent whose whole content is "which rules".
  -- 0032's comment says the column is for exactly this. That it is an oversight
  -- rather than a policy is settled inside this same function: the marketing
  -- consent a hundred lines below has always filled it.
  --
  -- The origin distinguishes the two paths for ever. On the fast path nobody
  -- clicked a rules screen -- the consent comes from the act of entering, the
  -- way sending a hashtag does on WhatsApp -- and a row that cannot be told
  -- apart from a clicked one would be a record claiming something that did not
  -- happen.
```

`v_fast` is computed from the step list the function **already recomputes**, with the same predicate the WhatsApp door uses.

- [ ] **Step 6: Draw the short path**

In `enter-promotion.tsx`, when `needsNoWalk(promotion.steps)` the panel submits on the listener's tap and renders the entered state; it draws no consent screen. Keep the rules text reachable — render it on the confirmation, so somebody who wants to read what they agreed to still can.

- [ ] **Step 7: Extend the pgTAP file**

Add to file 73, raising the plan by 3: the fast entry through `widget_enter_promotion`; the consent row carrying `promotion_id`; and the consent row's `origin` being `'web-widget-entry'` on the fast path and `'web-widget'` on the walk.

- [ ] **Step 8: Extend the e2e walk**

A promotion with no questions and a known listener: after the code, the widget shows the entered state without a rules screen.

- [ ] **Step 9: Run every gate, in order**

Run: `npm run db:reset` → `npm run db:test` → `npm run test:isolation` → `npm run seed:branding` → `npm run test:e2e`
Expected: green. Judge `test:isolation` by new failures naming this block's doors, not by completion.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/0268_widget_fast_entry.sql src/lib/widget/promotion-mapping.ts "src/app/(widget)/w/[publicKey]/enter-promotion.tsx" tests supabase/tests/73_fast_entry.test.sql
git commit -m "feat(30d): a promotion that asks nothing takes the entry on the web too"
```

---

### Task 10: The documents, and what the owner has to do

**Files:**
- Modify: `docs/WIDGET.md`
- Modify: `docs/DATABASE.md`
- Modify: `docs/API.md`

- [ ] **Step 1: `docs/WIDGET.md`**

A section on the Station's language: where it is set (`/messages/promo`), what null means, and D7's known limit — `<html lang>` still names the cookie's locale, because the root layout cannot know which installation is being served.

- [ ] **Step 2: `docs/DATABASE.md`**

`companies.listener_locale`, `country_phone_rule`, `international_phone`, and the four new `template_purpose` values with the sentence that they are Utility-category templates the Station registers at Meta, and that a Station with none still replies as a session message.

- [ ] **Step 3: `docs/API.md`**

That the intake doors now store the international form, and that a caller sending a national number for a Station with a country gets it prefixed rather than a second listener.

- [ ] **Step 4: Verify every file the PR body will claim**

Run: `git diff --name-only main...HEAD`

The PR body lists **that** output, not a remembered list. Block 30c shipped a file list that disagreed with its own diff.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs
git commit -m "docs(30d): the Station's language, the phone's one shape, and the four Utility templates"
git push -u origin block-30d-widget
```

The PR body states plainly: **four Utility templates per Station have to be registered at Meta** before any fast-path reply travels as a template, and until then it travels as a session message.

---

## What this plan does not do, on purpose

- **It does not merge listeners who are already two rows.** 0262 repairs the rows carrying the minority form; a pair that already split stays split, and fusing them is the merge screen's job (spec §2).
- **It does not translate the bot's Portuguese constants** (spec §2).
- **It does not touch `profiles.locale` or the settings gear** — the owner's ruling of 2026-08-21.
- **It does not add a national numbering rule for the other 24 countries** in `COUNTRY_CODES`. Each needs its national length verified, and a guess there is a wrong prefix, which is the duplicate this block exists to stop.
