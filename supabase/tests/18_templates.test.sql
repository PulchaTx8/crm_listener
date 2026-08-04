begin;
select plan(17);

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

-- Task 2: the approved-template registry. Same fixtures (org ...e4f1,
-- company ...e4c1) — this table references the same Station, not a new one.

-- 11: the purpose enum is pinned to PICKUP_REMINDER alone. Task 4 depends on
-- that exact value; a later block adds a second purpose rather than renaming
-- this one.
select is(
  enum_range(null::public.template_purpose)::text[],
  array['PICKUP_REMINDER'],
  'template_purpose has exactly PICKUP_REMINDER');

-- 12: a blank name, language or body is refused. '   ' would satisfy NOT
-- NULL and register a template nobody can send — name and language must
-- match what Meta approved exactly, and a body a listener cannot read is
-- worse than no template at all. One assertion, three sub-checks: each
-- insert is expected to fail with check_violation, and the DO block only
-- raises (failing this assertion) if one of them is wrongly accepted.
select lives_ok($$
  do $do$
  begin
    begin
      insert into public.message_templates
        (organization_id, company_id, purpose, name, language, body)
      values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
              'PICKUP_REMINDER', '   ', 'pt_BR', 'Oi {{1}}, seu prêmio te espera!');
      raise exception 'a blank name was not refused';
    exception when check_violation then null;
    end;
    begin
      insert into public.message_templates
        (organization_id, company_id, purpose, name, language, body)
      values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
              'PICKUP_REMINDER', 'Lembrete de retirada', '   ', 'Oi {{1}}, seu prêmio te espera!');
      raise exception 'a blank language was not refused';
    exception when check_violation then null;
    end;
    begin
      insert into public.message_templates
        (organization_id, company_id, purpose, name, language, body)
      values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
              'PICKUP_REMINDER', 'Lembrete de retirada', 'pt_BR', '   ');
      raise exception 'a blank body was not refused';
    exception when check_violation then null;
    end;
  end
  $do$;
$$, 'a blank name, language or body is refused by its check constraint');

-- 13: variables must be a JSON array. Task 3's enqueue indexes it
-- positionally by {{1}}..{{n}}; an object here would fail only at send time,
-- not at write time.
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body, variables)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Lembrete de retirada', 'pt_BR', 'Oi {{1}}, seu prêmio te espera!',
          '{"1": "nome"}'::jsonb)
$$, '23514', null, 'variables must be a JSON array, not an object');

insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body)
values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
        'PICKUP_REMINDER', 'Lembrete de retirada', 'pt_BR', 'Oi {{1}}, seu prêmio te espera!');

-- 14: one live template per (company_id, purpose).
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Outro nome', 'pt_BR', 'Outro corpo')
$$, '23505', null, 'a second live template for the same purpose is refused');

-- 15: and archiving the first frees the purpose — the same partial-index
-- shape as Task 1's station_message_templates, for the same reason: without
-- it an operator who archived a template could never register its
-- replacement.
update public.message_templates set deleted_at = now()
 where company_id = '00000000-0000-0000-0000-00000000e4c1' and purpose = 'PICKUP_REMINDER';

select lives_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Lembrete novo', 'pt_BR', 'Novo corpo {{1}}')
$$, 'archiving a template frees its purpose for a new registration');

-- 16: authenticated cannot write directly — Task 2 opens no door at all yet;
-- a later registration screen adds one as SECURITY DEFINER. service_role
-- reads (Task 3's enqueue_whatsapp_outbound resolves the row under
-- service_role) and cannot truncate (0059's lesson, applied again).
select ok(
  not has_table_privilege('authenticated', 'public.message_templates', 'INSERT')
  and has_table_privilege('service_role', 'public.message_templates', 'SELECT')
  and not has_table_privilege('service_role', 'public.message_templates', 'TRUNCATE'),
  'authenticated cannot write directly; service_role reads and cannot truncate');

-- 17: no status column, deliberately (spec §3.2). This table records what
-- the operator was told at registration; it cannot know whether Meta still
-- approves the template, so a status column here would look like live truth
-- and actually be a stale memory. A revoked approval is discovered by the
-- first rejected send, not by reading a column. Argue with this test before
-- adding one back.
select ok(
  not exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'message_templates'
                and column_name = 'status'),
  'message_templates has no status column — approval state is not tracked here');

select * from finish();
rollback;
