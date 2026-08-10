begin;
select plan(75);

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

-- 11: the purpose enum. 0110 shipped PICKUP_REMINDER alone and its comment
-- asked for what happened next in writing -- "a later block adds a second
-- rather than renaming this one, because Task 4 references it by name" -- and
-- 0160 (Block 17a) added WEB_VERIFICATION for the web widget's code. Both
-- values are asserted, in enum order, so a third arrives here as a failure
-- rather than as a silent third card the Templates screen would have to grow.
select is(
  enum_range(null::public.template_purpose)::text[],
  array['PICKUP_REMINDER', 'WEB_VERIFICATION'],
  'template_purpose has PICKUP_REMINDER and WEB_VERIFICATION');

-- 12: a blank name is refused. '   ' would satisfy NOT NULL and register a
-- template whose recorded name does not match what Meta approved.
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', '   ', 'pt_BR', 'Oi {{1}}, seu prêmio te espera!')
$$, '23514', null, 'a blank name is refused by the check constraint');

-- 13: a blank language is refused, same reasoning as 12 — the Cloud API
-- takes name AND language together, and a blank one cannot match what Meta
-- approved. A separate assertion from 12: these are two different check
-- constraints, and a failure here says which column let a blank through.
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Lembrete de retirada', '   ', 'Oi {{1}}, seu prêmio te espera!')
$$, '23514', null, 'a blank language is refused by the check constraint');

-- 14: a blank body is refused — the column a listener actually reads, and a
-- third distinct check constraint from 12 and 13.
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Lembrete de retirada', 'pt_BR', '   ')
$$, '23514', null, 'a blank body is refused by the check constraint');

-- 15: variables must be a JSON array. Task 3's enqueue indexes it
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

-- 16: one live template per (company_id, purpose).
select throws_ok($$
  insert into public.message_templates
    (organization_id, company_id, purpose, name, language, body)
  values ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c1',
          'PICKUP_REMINDER', 'Outro nome', 'pt_BR', 'Outro corpo')
$$, '23505', null, 'a second live template for the same purpose is refused');

-- 17: and archiving the first frees the purpose — the same partial-index
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

-- 18: authenticated cannot write directly — Task 2 opens no door at all yet;
-- a later registration screen adds one as SECURITY DEFINER.
select ok(
  not has_table_privilege('authenticated', 'public.message_templates', 'INSERT'),
  'authenticated cannot insert a template directly');

-- 18b: and authenticated CAN read one. Task 1's file asserts this positively
-- for station_message_templates (test 8); Task 2's asserted only the absence
-- of the insert grant, never the presence of the select — so dropping
-- `grant select … to authenticated` from 0110 would have left this file green
-- and the WhatsApp screen permanently empty. Measured, not assumed: with that
-- line revoked, tests 62-63 below now fail too, but only INCIDENTALLY, by
-- reading the table inside a door's fixture. This is the assertion that says
-- so on purpose and would survive those being rewritten.
select ok(
  has_table_privilege('authenticated', 'public.message_templates', 'SELECT'),
  'authenticated may read registered templates, gated by the policy');

-- 19: service_role reads — Task 3's enqueue_whatsapp_outbound resolves the
-- row under service_role. A separate assertion from 18 and 20: three
-- different grants, three different reasons a fix would touch.
select ok(
  has_table_privilege('service_role', 'public.message_templates', 'SELECT'),
  'service_role reads templates, which is how the enqueue resolves them');

-- 20: and service_role cannot truncate. 0059's lesson, applied again.
select ok(
  not has_table_privilege('service_role', 'public.message_templates', 'TRUNCATE'),
  'service_role cannot truncate the templates');

-- 21: no status column, deliberately (spec §3.2). This table records what
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

-- Task 3: the outbox learns templates, and the enqueue resolves them. Same
-- fixtures — company e4c1 still holds the live PICKUP_REMINDER template test
-- 17 registered ('Lembrete novo', pt_BR, body 'Novo corpo {{1}}'): one
-- placeholder, so a one-element variables array is the correct call and a
-- zero- or two-element one is the mismatch this task must refuse.

insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-00000000e4a1', '00000000-0000-0000-0000-00000000e4f1',
   '00000000-0000-0000-0000-00000000e4c1', 'WHATSAPP', '5511900000100', true);

-- A second Station with no registered template at all, for the "no live row"
-- refusal — e4c1 cannot show that, because it has one.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e4c9', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates no registry', 'America/Sao_Paulo');
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-00000000e4a9', '00000000-0000-0000-0000-00000000e4f1',
   '00000000-0000-0000-0000-00000000e4c9', 'WHATSAPP', '5511900000900', true);

-- Fix round 1: two more Stations. e4c6 registers a TWO-placeholder template,
-- for the re-substitution guard (e4c1's one-placeholder template cannot show
-- it: the loop only ever runs once against it). e4c7 registers a
-- FIXED-TEXT template with no {{n}} at all — a real, Meta-approved shape
-- (Task 2) that a variable-count check alone does not exercise.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e4c6', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates two vars', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-00000000e4c7', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates zero vars', 'America/Sao_Paulo');
insert into public.integrations
  (id, organization_id, company_id, provider, phone_number_id, enabled)
values
  ('00000000-0000-0000-0000-00000000e4a6', '00000000-0000-0000-0000-00000000e4f1',
   '00000000-0000-0000-0000-00000000e4c6', 'WHATSAPP', '5511900000600', true),
  ('00000000-0000-0000-0000-00000000e4a7', '00000000-0000-0000-0000-00000000e4f1',
   '00000000-0000-0000-0000-00000000e4c7', 'WHATSAPP', '5511900000700', true);
insert into public.message_templates
  (organization_id, company_id, purpose, name, language, body)
values
  ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c6',
   'PICKUP_REMINDER', 'Lembrete duas variáveis', 'pt_BR', 'Oi {{1}}, prêmio {{2}}'),
  ('00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4c7',
   'PICKUP_REMINDER', 'Lembrete fixo', 'pt_BR', 'Seu prêmio já está te esperando!');

-- 22-24: the three columns exist, and only as a triple.
select has_column('public', 'outbox_messages', 'template_name',
                  'the outbox can name the template a row sends');
select has_column('public', 'outbox_messages', 'template_language',
                  'and the language it was registered under');
select has_column('public', 'outbox_messages', 'template_variables',
                  'and the values actually substituted into it');

-- 25: a purpose with no live registry row for that Station is refused at
-- enqueue, before anything is written — Meta would refuse a name it has never
-- approved, and this turns that into a validation error rather than a wasted
-- send.
select throws_ok($$
  select public.enqueue_whatsapp_outbound(
    '00000000-0000-0000-0000-00000000e4a9', '5511911111101', 'unused',
    null, 'no-registry:test', 'PICKUP_REMINDER', '[]'::jsonb)
$$, 'P0002', null,
  'a purpose with no live registry row for the Station is refused at enqueue');

-- 26: a variable count disagreeing with the body's highest {{n}} is refused.
-- The registered body wants exactly one; this call offers zero.
select throws_ok($$
  select public.enqueue_whatsapp_outbound(
    '00000000-0000-0000-0000-00000000e4a1', '5511911111102', 'unused',
    null, 'bad-count:test', 'PICKUP_REMINDER', '[]'::jsonb)
$$, '22023', null,
  'a variable count disagreeing with the body''s highest {{n}} is refused');

-- 27: THE PROOF THAT MATTERS MOST (D6). Rendering happens inside the enqueue,
-- not in whatever called it, so the stored body and the stamped variables
-- cannot be produced from different sources. Asserting more than "both
-- columns are non-null": the actual substituted text is checked against the
-- registry's actual template.
select public.enqueue_whatsapp_outbound(
  '00000000-0000-0000-0000-00000000e4a1', '5511911111103', 'this is ignored',
  null, 'template-happy:test', 'PICKUP_REMINDER', '["Maria"]'::jsonb);

select is(
  (select body from public.outbox_messages where dedupe_key = 'template-happy:test'),
  'Novo corpo Maria',
  'the stored body is the registry''s approved text with the variable actually substituted');

-- 28-30: the three columns are stamped from the registry and the call, not
-- left for a caller to fill in separately.
select is(
  (select template_name from public.outbox_messages where dedupe_key = 'template-happy:test'),
  'Lembrete novo', 'template_name is stamped from the resolved registry row');
select is(
  (select template_language from public.outbox_messages where dedupe_key = 'template-happy:test'),
  'pt_BR', 'template_language is stamped from the resolved registry row');
select is(
  (select template_variables from public.outbox_messages where dedupe_key = 'template-happy:test'),
  '["Maria"]'::jsonb, 'template_variables is stamped with what was actually sent');

-- 31-33: a plain text send — p_template_purpose omitted — still works
-- unchanged through the new signature. This is the regression guard for
-- every message this system already sends.
select public.enqueue_whatsapp_outbound(
  '00000000-0000-0000-0000-00000000e4a1', '5511911111104', 'Oi, tudo bem?',
  null, 'plain-text:test');

select is(
  (select body from public.outbox_messages where dedupe_key = 'plain-text:test'),
  'Oi, tudo bem?', 'a plain text send still stores the caller''s own body, unrendered');
select is(
  (select template_name from public.outbox_messages where dedupe_key = 'plain-text:test'),
  null, 'and carries no template stamp');
select is(
  (select count(*)::int from public.outbox_messages
    where dedupe_key = 'plain-text:test'
      and template_name is null and template_language is null and template_variables is null),
  1, 'the three template columns stay null together on a plain text row');

-- 34-35: claim_outbox_batch hands the worker the template columns too, and a
-- plain text row still comes back with nothing templated on it — the same
-- pairing 0067 proved for `interactive`.
create temporary table claimed_templated as
  select * from public.claim_outbox_batch(10000);

select is(
  (select c.template_name from claimed_templated c
    join public.outbox_messages o on o.id = c.id
   where o.dedupe_key = 'template-happy:test'),
  'Lembrete novo',
  'the claim hands the worker the template name, language and variables too');

select is(
  (select count(*)::int from claimed_templated c
    join public.outbox_messages o on o.id = c.id
   where o.dedupe_key = 'plain-text:test'
     and c.template_name is null and c.template_language is null and c.template_variables is null),
  1, 'and a plain text row still comes back with nothing templated on it');

-- 36: the grant survives the drop-and-recreate. Lost, this answers 42501 to
-- every template send the moment Task 4 makes one.
select ok(
  has_function_privilege('service_role',
    'public.enqueue_whatsapp_outbound(uuid, text, text, jsonb, text, public.template_purpose, jsonb)',
    'EXECUTE'),
  'service_role may still call enqueue_whatsapp_outbound under its new signature');

-- Fix round 1 -------------------------------------------------------------

-- 37: THE IMPORTANT ONE. A fixed-text (zero-placeholder) template sent with
-- p_template_variables omitted used to pass validation -- coalesce(
-- jsonb_array_length(null), 0) = 0 matches an expected count of zero -- and
-- then fail the INSERT on outbox_messages_template_shape with a bare 23514,
-- because template_name/template_language were non-null beside a null
-- template_variables. The enqueue said yes and the insert said no.
select lives_ok($$
  select public.enqueue_whatsapp_outbound(
    '00000000-0000-0000-0000-00000000e4a7', '5511911111107', 'unused',
    null, 'zero-var:test', 'PICKUP_REMINDER')
$$, 'a zero-placeholder template sent with no variables at all is accepted, not refused by its own shape constraint');

-- 38-39: and it is accepted CORRECTLY — the fixed body verbatim, and
-- template_variables coalesced to an empty array rather than left null.
select is(
  (select body from public.outbox_messages where dedupe_key = 'zero-var:test'),
  'Seu prêmio já está te esperando!',
  'the fixed-text body is stored unchanged, with nothing to substitute');
select is(
  (select template_variables from public.outbox_messages where dedupe_key = 'zero-var:test'),
  '[]'::jsonb,
  'template_variables is coalesced to an empty array, keeping outbox_messages_template_shape satisfied');

-- 40: MINOR 1, treated as the serious one. A value substituted at {{1}} that
-- itself contains the literal text "{{2}}" must not be re-substituted when
-- the loop reaches index 2 — Meta takes parameter values literally, and a
-- naive replace()-per-placeholder run against a mutating body would corrupt
-- exactly this case (and iterating in reverse would not fix it: the
-- vulnerable index just moves). e4c6's template has two placeholders, which
-- e4c1's one-placeholder template cannot exercise.
select public.enqueue_whatsapp_outbound(
  '00000000-0000-0000-0000-00000000e4a6', '5511911111108', 'unused',
  null, 'no-resubstitution:test', 'PICKUP_REMINDER',
  '["diga {{2}} para mim", "Maria"]'::jsonb);

select is(
  (select body from public.outbox_messages where dedupe_key = 'no-resubstitution:test'),
  'Oi diga {{2}} para mim, prêmio Maria',
  'a variable value containing a literal {{n}} token is stored verbatim, not re-substituted as a second placeholder');

-- 41: MINOR 3. claim_outbox_batch's grant is re-issued in the migration but,
-- unlike enqueue_whatsapp_outbound's (test 36), was never actually asserted
-- by this file — and by 0111's own comment this is the one whose loss
-- "would answer 42501 to every send".
select ok(
  has_function_privilege('service_role', 'public.claim_outbox_batch(integer)', 'EXECUTE'),
  'service_role may still call claim_outbox_batch after the drop-and-recreate');

-- Task 5's prerequisite: the four operator doors -----------------------------
--
-- 0109 and 0110 opened both tables to `authenticated` for READING and to
-- nobody for writing, each saying the write door would be SECURITY DEFINER.
-- Neither task wrote one, and the plan's file list stops at 0112 — so until
-- 0113 an operator holding templates.manage could not change a single word,
-- and Task 5 had no write to be refused. This is that door, and these are the
-- mechanics of it.
--
-- What pgTAP proves here is the same half 15_music_rpcs proves for the music
-- doors: the shape of the write, the refusals that need no second identity,
-- and the grants. The permission GATE as a narrower caller experiences it —
-- templates.view without templates.manage — needs two identities and lives in
-- tests/isolation/templates.test.ts, written in the same task.

-- A Station of its own for the doors, so none of the direct inserts above can
-- be mistaken for something a door wrote.
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e4c2', '00000000-0000-0000-0000-00000000e4f1',
   'Station templates doors', 'America/Sao_Paulo');

-- A real actor, not a superuser bypass: has_permission reads auth.uid(), null
-- under plain pgTAP, and postgres bypasses every EXECUTE grant besides — so a
-- call made as postgres would succeed even if `grant execute … to
-- authenticated` had been left off 0113 entirely. Granted BOTH codes:
-- templates.manage alone passes the door, but 0109's and 0110's select
-- policies gate on templates.view, so the actor could not read back what it
-- had just written.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e4b1', '00000000-0000-0000-0000-00000000e4f1',
   'Templates manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-00000000e4b1', 'templates.view'),
  ('00000000-0000-0000-0000-00000000e4b1', 'templates.manage');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e4b2', 'templates-manager@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-00000000e4b2', '00000000-0000-0000-0000-00000000e4c2',
   '00000000-0000-0000-0000-00000000e4f1', '00000000-0000-0000-0000-00000000e4b1');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

-- 42: the override door writes.
select lives_ok($$
  select public.set_station_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'REFUSAL', 'Beleza! Fica pra próxima.')
$$, 'set_station_message_template writes an override');

reset role;

-- 43: with the body it was given.
select is(
  (select body from public.station_message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2'
      and key = 'REFUSAL' and deleted_at is null),
  'Beleza! Fica pra próxima.',
  'the override carries the body the door was given');

-- 44: and stamped with who wrote it. Not decoration: the two codes are the
-- whole permission model here, so the row itself is the only record of which
-- operator changed what a listener reads.
select is(
  (select created_by from public.station_message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2'
      and key = 'REFUSAL' and deleted_at is null),
  '00000000-0000-0000-0000-00000000e4b2'::uuid,
  'the override records the actor who set it');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

select public.set_station_message_template(
  '00000000-0000-0000-0000-00000000e4c2', 'REFUSAL', 'Tudo bem, fica pra próxima!');

reset role;

-- 45: setting the same key twice UPDATES the live row. The partial unique
-- index would refuse a second insert with 23505, so a door that inserted
-- blindly would make the second edit of any text an error the operator cannot
-- act on.
select is(
  (select count(*)::int from public.station_message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2'
      and key = 'REFUSAL' and deleted_at is null),
  1, 'setting the same key twice leaves one live override, not two');

-- 46: and it is the second text, not the first — a door that swallowed the
-- conflict with `do nothing` would also satisfy 45.
select is(
  (select body from public.station_message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2'
      and key = 'REFUSAL' and deleted_at is null),
  'Tudo bem, fica pra próxima!',
  'the second call replaces the text rather than being silently dropped');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

-- 47: a blank body is refused BY THE DOOR, with a code a form can read, rather
-- than reaching the table's check constraint as a bare 23514. Same reasoning
-- as 0100's 'a name is required'.
select throws_ok($$
  select public.set_station_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'REFUSAL', '   ')
$$, '22023', null, 'a blank override body is refused by the door, not by the constraint');

-- 48-49: clearing. The live row goes, and the row itself does not — this
-- project deletes nothing, and the archived text is what an operator asking
-- "what did it used to say?" has left.
select lives_ok($$
  select public.clear_station_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'REFUSAL')
$$, 'clear_station_message_template archives the live override');

reset role;

select is(
  (select count(*)::int from public.station_message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and key = 'REFUSAL'
      and deleted_at is null),
  0, 'no live override remains for the cleared key');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

-- 50: and the key is free again, THROUGH THE DOOR. Test 4 proved the partial
-- index allows it with a direct insert; this proves the door's upsert does not
-- collide with the archived row it left behind — an `on conflict` that
-- inferred the wrong index would fail exactly here and nowhere else.
select lives_ok($$
  select public.set_station_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'REFUSAL', 'Texto depois de limpar')
$$, 'a cleared key can be set again through the door');

-- 51: clearing a key that has no live override says so, rather than reporting
-- a success that changed nothing. The caller already holds templates.manage in
-- this Station, so naming the absence reveals nothing they could not read.
select throws_ok($$
  select public.clear_station_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'ABANDON')
$$, 'P0002', null, 'clearing a key with no live override is refused, not silently accepted');

-- 52: THE GATE, in the one form pgTAP can show without a second identity. The
-- actor holds templates.manage at e4c2 and nothing at all at e4c9, and the
-- refusal is 42501 — the permission, never P0002, so the answer cannot be read
-- as "that Station does not exist" (0093).
select throws_ok($$
  select public.set_station_message_template(
    '00000000-0000-0000-0000-00000000e4c9', 'REFUSAL', 'Não deveria entrar')
$$, '42501', null,
  'an override at a Station the caller holds nothing in is refused 42501, not P0002');

-- 53: the registry door writes.
select lives_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
    'lembrete_retirada', 'pt_BR',
    'Oi {{1}}, seu prêmio {{2}} te espera até {{3}}.',
    '["nome do ouvinte", "prêmio", "prazo"]'::jsonb)
$$, 'register_message_template records an approved template');

reset role;

-- 54: under the name Meta approved. The name is not chosen here (D4) and a
-- door that trimmed or normalised it would send under a name Meta never saw.
select is(
  (select name from public.message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null),
  'lembrete_retirada', 'the registry records the name as registered with Meta');

-- 55: and with the variable descriptions in order. This is what the WhatsApp
-- screen labels its fields from and what Task 4's runbook pins the reminder's
-- three positions against; an array stored out of order or dropped to '[]'
-- would leave the screen labelling nothing.
select is(
  (select variables from public.message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null),
  '["nome do ouvinte", "prêmio", "prazo"]'::jsonb,
  'the registry records what each position means, in order');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

select public.register_message_template(
  '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
  'lembrete_retirada_v2', 'pt_BR',
  'Oi {{1}}, retire seu prêmio {{2}} até {{3}}.',
  '["nome", "prêmio", "prazo"]'::jsonb);

reset role;

-- 56: re-registering the same purpose replaces the live row. Meta approves a
-- new version under a new name and the operator transcribes it here; a door
-- that inserted blindly would hit the partial unique index with 23505.
select is(
  (select count(*)::int from public.message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null),
  1, 're-registering a purpose leaves one live template, not two');

-- 57: and it is the new text. Separate from 56 for the same reason 46 is
-- separate from 45: `do nothing` satisfies the count and loses the edit.
select is(
  (select body from public.message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null),
  'Oi {{1}}, retire seu prêmio {{2}} até {{3}}.',
  're-registering replaces the approved text rather than being dropped');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

-- 58: THE ONE THAT MATTERS MOST HERE. A registration whose variable
-- descriptions disagree with the body's highest {{n}} is refused. 0111 makes
-- the same comparison at enqueue and raises 22023 there — but by then the
-- caller is Task 4's unattended sweep, whose only signal is a WARNING in a
-- server log nobody is reading. Refused here, the same mistake is a form error
-- the operator sees at the moment they can still fix it.
select throws_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
    'lembrete_faltando_um', 'pt_BR',
    'Oi {{1}}, seu prêmio {{2}} te espera até {{3}}.',
    '["nome", "prêmio"]'::jsonb)
$$, '22023', null,
  'a registration whose variable descriptions disagree with the body''s {{n}} count is refused');

-- 59: and a non-string element is refused too. jsonb_typeof on the array as a
-- whole (0110's check constraint) cannot see inside it, so a null or a number
-- here would reach the screen as a blank label beside a field the operator is
-- being asked to fill in correctly.
select throws_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
    'lembrete_nulo', 'pt_BR', 'Oi {{1}}!', '[null]'::jsonb)
$$, '22023', null,
  'a variable description that is not a string is refused');

-- 60: a blank name is refused by the door, for the same reason as 47.
select throws_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
    '   ', 'pt_BR', 'Oi {{1}}!', '["nome"]'::jsonb)
$$, '22023', null, 'a blank template name is refused by the door');

-- 61: the gate again, on the second door. Both doors take a company_id from
-- the caller, so both can be pointed at a Station the caller cannot reach, and
-- both have to refuse the same way.
select throws_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c9', 'PICKUP_REMINDER',
    'nao_deveria', 'pt_BR', 'Oi {{1}}!', '["nome"]'::jsonb)
$$, '42501', null,
  'registering at a Station the caller holds nothing in is refused 42501, not P0002');

-- 62: archiving. Stops a future reminder; loses no past one.
select lives_ok($$
  select public.archive_message_template(
    (select id from public.message_templates
      where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null))
$$, 'archive_message_template archives the live registration');

reset role;

select is(
  (select count(*)::int from public.message_templates
    where company_id = '00000000-0000-0000-0000-00000000e4c2' and deleted_at is null),
  0, 'no live template remains for the archived purpose');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-00000000e4b2", "role": "authenticated"}';

-- 64: and the purpose is free again through the door, the registry's half of
-- what 50 proves for the overrides.
select lives_ok($$
  select public.register_message_template(
    '00000000-0000-0000-0000-00000000e4c2', 'PICKUP_REMINDER',
    'lembrete_depois_de_arquivar', 'pt_BR', 'Oi {{1}}!', '["nome"]'::jsonb)
$$, 'an archived purpose can be registered again through the door');

-- 65: archiving an id that names nothing answers 42501, not P0002 — 0093's
-- one-gated-query idiom. The door resolves the Station FROM THE ROW, so an
-- unknown id, a template in a Station the caller cannot reach, and one already
-- archived are one indistinguishable refusal.
select throws_ok($$
  select public.archive_message_template('00000000-0000-0000-0000-0000000000ff')
$$, '42501', null,
  'archiving an id that names nothing answers 42501, the same as one the caller may not touch');

reset role;

-- 66-70: the grants. Every door is reachable by an operator and by nobody
-- else. The service_role assertion is the one that would go unnoticed:
-- 0109 and 0110 grant it SELECT so the engine and the enqueue can resolve a
-- Station's wording, and a stray EXECUTE here would let the worker rewrite the
-- very texts it reads.
select ok(
  has_function_privilege('authenticated',
    'public.set_station_message_template(uuid, public.system_message_key, text)', 'EXECUTE'),
  'authenticated may call set_station_message_template');
select ok(
  has_function_privilege('authenticated',
    'public.clear_station_message_template(uuid, public.system_message_key)', 'EXECUTE'),
  'authenticated may call clear_station_message_template');
select ok(
  has_function_privilege('authenticated',
    'public.register_message_template(uuid, public.template_purpose, text, text, text, jsonb)', 'EXECUTE'),
  'authenticated may call register_message_template');
select ok(
  has_function_privilege('authenticated',
    'public.archive_message_template(uuid)', 'EXECUTE'),
  'authenticated may call archive_message_template');
select ok(
  not has_function_privilege('service_role',
    'public.set_station_message_template(uuid, public.system_message_key, text)', 'EXECUTE'),
  'service_role cannot call the operator doors — it reads these tables, it does not write them');

-- 0114: the overrides actually reach the engine -----------------------------
--
-- 0109 grants service_role SELECT and says that is "how the engine resolves
-- them", but until 0114 nothing read the table: the Messages screen would have
-- written rows that changed nothing a listener ever saw. These are the SQL
-- half of that fix. The TypeScript half — that the map survives the Zod
-- schema, the narrowing and the engine — is in
-- tests/unit/system-message-resolution.test.ts and conversation-turn.test.ts.
--
-- e4c2 carries exactly one live override at this point: REFUSAL, set through
-- the door by test 50. One, not ten, which is what makes 72 a test of D2 and
-- not merely of a join.

insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at)
values ('00000000-0000-0000-0000-00000000e4d1', '00000000-0000-0000-0000-00000000e4f1',
        '00000000-0000-0000-0000-00000000e4c2', 'Promo templates',
        now() - interval '1 day', now() + interval '30 days');

-- A promotion in a Station that has overridden NOTHING (e4c9, the registry-less
-- Station from Task 3), for the empty-map half.
insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at)
values ('00000000-0000-0000-0000-00000000e4d9', '00000000-0000-0000-0000-00000000e4f1',
        '00000000-0000-0000-0000-00000000e4c9', 'Promo sem override',
        now() - interval '1 day', now() + interval '30 days');

-- 71: the key is there at all.
select is(
  public.whatsapp_prompt_context('00000000-0000-0000-0000-00000000e4d1') -> 'systemMessages'
    ->> 'REFUSAL',
  'Texto depois de limpar',
  'whatsapp_prompt_context carries the Station''s own wording for an overridden text');

-- 72: AND ONLY the overridden one. A resolver handed all ten keys could not
-- tell an override from a default, and the per-text property (D2) would be
-- decided here rather than in the engine — invisibly, and in SQL.
select is(
  (select count(*)::int from jsonb_object_keys(
    public.whatsapp_prompt_context('00000000-0000-0000-0000-00000000e4d1') -> 'systemMessages')),
  1, 'and carries ONLY the texts that were overridden, never the other nine');

-- 73: a Station that has overridden nothing yields an empty object, not null.
-- Null would reach Zod as a missing key and only survive because of a
-- `.default({})`; an empty object is the honest answer and the ordinary case.
select is(
  public.whatsapp_prompt_context('00000000-0000-0000-0000-00000000e4d9') -> 'systemMessages',
  '{}'::jsonb,
  'a Station that has overridden nothing yields an empty map, not null');

-- 74: THE DUPLICATION GUARD. start_whatsapp_conversation (0070) assembles the
-- context for the FIRST message and whatsapp_prompt_context (0071) for every
-- turn after it, and the two build it separately. Fixing one and not the other
-- gives a Station its own words from the second message onward and the code's
-- default on the first — the hardest version of this bug to notice, and the
-- reason this assertion is separate from 71 rather than folded into it.
insert into public.members (id, organization_id, full_name)
values ('00000000-0000-0000-0000-00000000e4e1', '00000000-0000-0000-0000-00000000e4f1', 'Ouvinte templates');

select is(
  public.start_whatsapp_conversation(
    '00000000-0000-0000-0000-00000000e4d1',
    '00000000-0000-0000-0000-00000000e4e1',
    '00000000-0000-0000-0000-00000000e4a1',
    '5511911111199', 900) -> 'systemMessages' ->> 'REFUSAL',
  'Texto depois de limpar',
  'start_whatsapp_conversation carries the same wording, so the first turn speaks the same voice as the rest');

select * from finish();
rollback;
