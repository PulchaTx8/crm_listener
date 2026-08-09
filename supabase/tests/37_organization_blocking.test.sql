begin;
select plan(6);

-- Block 16, design D5. Blocking a group, and the second door the owner uses.
--
-- pgTAP runs as superuser with a null auth.uid(), so RLS never applies to it and
-- it cannot prove the BEHAVIOUR. What it proves here is the SHAPE -- that the
-- condition reached both predicates -- and the doors' gate. The behaviour is
-- tests/isolation/organization-blocking.test.ts, and that is the test that
-- would actually catch the defect this migration exists to avoid.

select has_function('public', 'block_organization', array['uuid','text'],
  'the block door exists');
select has_function('public', 'unblock_organization', array['uuid'],
  'and its reverse');

-- THE ONE-LINE FIX THAT COVERS TWENTY POLICIES. `is_owner(organization_id)` is
-- used directly across the schema -- four times in 0035 alone, on `members`,
-- which is Organization-scoped and so never passes through
-- has_company_access. Patching each policy would have guaranteed a miss.
select ok(
  (select prosrc like '%organizations%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'is_owner_for'),
  'the owner predicate consults the group''s lock');

-- And the membership path, which does not go through is_owner_for at all.
select ok(
  (select prosrc like '%organizations%' from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'has_company_access_for'),
  'and so does access held through a role');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000f2', 'Org blocking');

-- No session, so is_platform_admin() is false. The gate is before the work.
select throws_ok(
  $$select public.block_organization('00000000-0000-0000-0000-0000000000f2', 'nope')$$,
  '42501', null, 'blocking a group requires the platform admin');

select throws_ok(
  $$select public.unblock_organization('00000000-0000-0000-0000-0000000000f2')$$,
  '42501', null, 'and so does releasing one');

select * from finish();
rollback;
