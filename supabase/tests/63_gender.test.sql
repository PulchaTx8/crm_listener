begin;
select plan(27);

-- The gender block. The tenth requested field, its column, and its resolver.
--
-- The shape of this file is 60_country_and_places.test.sql's, deliberately: that
-- block added the NINTH field five weeks ago, and everything this one does has
-- an exact counterpart there. Where the two differ is the point of the block —
-- this field is answered by pressing rather than by typing — and the assertions
-- that hold the difference are marked.

-- ---------------------------------------------------------------------------
-- 1. The column, and the fourth state that is its absence.
-- ---------------------------------------------------------------------------
select has_column('public', 'members', 'gender', 'members.gender exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'members' and column_name = 'gender') = 'YES',
  'gender is nullable -- NULL is "nobody asked", which is not any of the three codes');

select col_has_check('public', 'members', 'gender',
  'gender carries a check constraint rather than accepting any string');

-- Asserted on the constraint's DEFINITION rather than by inserting rows, the
-- reason 55_profile_theme states for its own: members has four partial unique
-- indexes and an organization_id foreign key, so a made-up row fails on one of
-- those first and an insert-based test would pass for the wrong reason.
select ok(
  exists (
    select 1 from pg_constraint
     where conname = 'members_gender_shape'
       and pg_get_constraintdef(oid) like '%''M''%'
       and pg_get_constraintdef(oid) like '%''F''%'
       and pg_get_constraintdef(oid) like '%''N''%'),
  'the constraint names all three storable codes');

-- The negative half, and it is not symmetry: without it a constraint widened to
-- `gender is null or length(gender) = 1` would satisfy every assertion above
-- while letting 'X' into a column a campaign filters on.
select ok(
  not exists (
    select 1 from public.members where gender is not null and gender not in ('M','F','N')),
  'no row holds a code outside the three');

-- ---------------------------------------------------------------------------
-- 2. The resolver. IMMUTABLE and reachable by nobody -- country_alpha2's shape.
-- ---------------------------------------------------------------------------
select has_function('public', 'gender_normalize', array['text'],
  'gender_normalize(text) exists');

select is(
  (select provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'gender_normalize'),
  'i'::"char",
  'it is IMMUTABLE -- it reads no table and no clock, so it stays usable in an index or a generated column later');

select ok(
  not has_function_privilege('authenticated', 'public.gender_normalize(text)', 'execute'),
  'authenticated may NOT call it -- it is only ever called from inside another function');

select ok(
  not has_function_privilege('anon', 'public.gender_normalize(text)', 'execute'),
  'anon may not either');

-- What it actually answers. These are the assertions that would catch a
-- rewritten vocabulary, and they are grouped by the three outcomes.
select is(public.gender_normalize('Masculino'), 'M', 'prose resolves, case and accents ignored');
select is(public.gender_normalize('HOMEM'), 'M', 'and so does the word people actually type');
select is(public.gender_normalize('Mulher'), 'F', 'the same on the other side');

-- THE ASSERTION THE WHOLE DESIGN TURNS ON. A listener who PRESSES a button has
-- the code itself arrive here; one who TYPES has prose. Both must converge, or
-- the same audience splits by how each person answered.
select is(public.gender_normalize('M'), 'M', 'a code resolves to itself -- a pressed button and a typed word converge');
select is(public.gender_normalize('N'), 'N', 'including the decline');

select is(public.gender_normalize('prefiro não informar'), 'N', 'a declining sentence resolves to the decline');
select is(public.gender_normalize('Outro'), 'N',
  'and so does "outro" -- three storable values, and somebody who sees themselves in neither of two has declined the question in the only sense the filter can act on');

-- A bare "não" is NOT a considered refusal, it is somebody who did not read the
-- question. Recording it as 'N' would be inventing an answer.
select is(public.gender_normalize('não'), null, 'a bare "no" resolves to nothing');
select is(public.gender_normalize('banana'), null, 'and so does anything else');
select is(public.gender_normalize(null), null, 'null in, null out -- the caller coalesces');

-- ---------------------------------------------------------------------------
-- 3. The vocabulary, and WHERE in it -- which is not decoration.
-- ---------------------------------------------------------------------------
-- whatsapp_conversation_steps (0066) orders the stale fields by this enum's
-- DECLARATION order and nothing else, so this assertion is the only thing that
-- holds where in the conversation the question falls.
select is(
  (select array_position(enum_range(null::public.promotion_requested_field)::text[], 'gender')),
  (select array_position(enum_range(null::public.promotion_requested_field)::text[], 'age') + 1),
  'gender is asked immediately after the birth date, which is what 0219 placed it for');

select ok(
  'GENDER' = any(enum_range(null::public.system_message_key)::text[]),
  'a Station can be given its own wording for the question');

-- ---------------------------------------------------------------------------
-- 4. The five functions that had to learn about it.
-- ---------------------------------------------------------------------------
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'member_field_value')
    like '%when ''gender''%',
  'member_field_value reads the column -- without this the conversation asks for it every time, because the step list would see it as never answered');

select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_member_field_values')
    like '%gender_normalize%',
  'apply_member_field_values writes it THROUGH the resolver, never raw');

-- Both columns, and `country` is Block 28's omission rather than this block's
-- work: it added the column and left it out of the erasure list, beside a nulled
-- city and postal code. 0220 closes it while editing the same statement.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'anonymize_member')
    like '%gender = null%',
  'an erasure clears the gender');

select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'anonymize_member')
    like '%country = null%',
  'and the country, which Block 28 added to the table and not to this list');

-- THE ACL TRAP, and the reason these two are here at all. Both doors were
-- DROPPED and recreated to take one more argument, and a dropped function takes
-- its ACL with it. Without the reissued grants every save from the member form
-- answers 42501 -- and no test calling them as the OWNER would notice, because
-- has_permission's owner bypass opens the door for the one identity that never
-- needed the grant. Block 24 lost an ACL exactly this way.
select ok(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_member', 'update_member')) = 2,
  'exactly one create_member and one update_member -- a new signature must REPLACE, never overload');

select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_member', 'update_member')),
  'authenticated still holds EXECUTE on both after the drop and recreate');

select * from finish();
rollback;
