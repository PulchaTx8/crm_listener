begin;
select plan(10);

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e4f1', 'Org templates');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e4c1', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates', 'America/Sao_Paulo');

-- 1: ten keys, and the order is pinned. Eight are the requested fields
-- FIELD_PROMPTS covers; two are the standalone messages.
select is(
  enum_range(null::public.system_message_key)::text[],
  array['REFUSAL', 'ABANDON', 'FULL_NAME', 'ADDRESS', 'CITY', 'NEIGHBOURHOOD',
        'AGE', 'CPF', 'PASSPORT', 'DISCOVERY_SOURCE'],
  'system_message_key is the ten texts engine.ts hard-codes');

-- 2: a blank override is not an override. '   ' would satisfy NOT NULL and
-- send a listener an empty message, which is worse than the default.
select throws_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', '   ')
$$, '23514', null, 'a blank body is refused by the check constraint');

-- 3: one override per key per Station.
insert into public.station_message_templates
  (organization_id, company_id, key, body)
values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
        'REFUSAL', 'Beleza! Fica pra próxima.');

select throws_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', 'Outro texto')
$$, '23505', null, 'a second live override for the same key is refused');

-- 4: and archiving the first frees the key, because the unique index is
-- partial on deleted_at. Without this an operator who cleared an override
-- could never set another.
update public.station_message_templates set deleted_at = now()
 where company_id = '00000000-0000-0000-0000-00000000e4c1' and key = 'REFUSAL';

select lives_ok($$
  insert into public.station_message_templates
    (organization_id, company_id, key, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'REFUSAL', 'Texto novo')
$$, 'clearing an override frees the key for a new one');

-- 5-6: the two permissions exist, and there is no third.
select is(
  (select count(*)::int from public.permissions where module = 'templates'),
  2, 'templates ships exactly two permission codes');
select is(
  (select array_agg(code order by display_order) from public.permissions where module = 'templates'),
  array['templates.view', 'templates.manage'],
  'the two are view and manage — nothing here destroys the way a merge does');

-- 7-8: RLS. authenticated reads under templates.view and writes nothing
-- directly; the doors are SECURITY DEFINER.
select ok(
  not has_table_privilege('authenticated', 'public.station_message_templates', 'INSERT'),
  'authenticated cannot insert an override directly');
select ok(
  has_table_privilege('authenticated', 'public.station_message_templates', 'SELECT'),
  'authenticated may read overrides, gated by the policy');

-- 9: service_role reads — the conversation engine resolves through it — and
-- cannot truncate. 0059's lesson, applied before anybody finds it again.
select ok(
  has_table_privilege('service_role', 'public.station_message_templates', 'SELECT'),
  'service_role reads overrides, which is how the engine resolves them');
select ok(
  not has_table_privilege('service_role', 'public.station_message_templates', 'TRUNCATE'),
  'service_role cannot truncate the overrides');

select * from finish();
rollback;
