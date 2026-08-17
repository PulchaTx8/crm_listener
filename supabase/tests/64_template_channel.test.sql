begin;
select plan(21);

-- Block 29b-1, Task 1. The two vocabularies this block adds.
--
-- SEPARATE FILE FOR THE TYPES, and the reason is readability rather than
-- correctness: `CREATE TYPE` and its first use may share a transaction. The
-- rule 0219 states is about `ALTER TYPE ... ADD VALUE`, which nothing in this
-- block does. A reader who has met 0219 will assume the harder rule applies
-- here; it does not, and this comment is why the split is still worth making.
select has_type('public', 'message_channel', 'message_channel exists');
select has_type('public', 'template_variable', 'template_variable exists');

-- ORDER IS NOT DECORATION for template_variable: a WhatsApp template's
-- `variables` array is POSITIONAL, so the enum's own order is what a reader
-- compares an array against. The campaign-resolvable four come first because
-- they are the ones 29d may offer.
select is(
  enum_range(null::public.template_variable)::text[],
  array['LISTENER_FIRST_NAME', 'LISTENER_FULL_NAME', 'LISTENER_CITY', 'STATION_NAME',
        'PRIZE_NAME', 'PICKUP_DEADLINE', 'VERIFICATION_CODE'],
  'template_variable holds both families, resolvable first');

-- ---------------------------------------------------------------------------
-- Task 2. The table.
-- ---------------------------------------------------------------------------
select has_column('public', 'message_templates', 'channel', 'channel exists');
select has_column('public', 'message_templates', 'internal_name', 'internal_name exists');
select has_column('public', 'message_templates', 'subject', 'subject exists');

select ok(
  (select is_nullable from information_schema.columns
    where table_name = 'message_templates' and column_name = 'purpose') = 'YES',
  'purpose is nullable -- null is a marketing template');

select is(
  (select data_type from information_schema.columns
    where table_name = 'message_templates' and column_name = 'variables'),
  'ARRAY',
  'variables is a typed array, not prose in jsonb');

-- The conditional pairs, asserted by DEFINITION. An insert-based test would
-- fail on the company_org foreign key first and pass for the wrong reason.
select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_whatsapp_shape'),
  'a WhatsApp row must name what the Cloud API takes');

select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_shape'),
  'an email row must have a subject');

-- Not symmetry. Without it an email template may carry a name and a language,
-- and every query asking "is this registered at Meta" gains a row that answers
-- yes and is not.
select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_no_meta_fields'),
  'an email row may NOT carry Meta''s name, language or OTP flag');

select ok(
  exists (select 1 from pg_constraint
           where conname = 'message_templates_email_variables_empty'),
  'an email row declares no positional array -- its body names its own places');

-- THE INDEX, and the assertion that matters most in this file.
select ok(
  (select indexdef from pg_indexes
    where indexname = 'message_templates_purpose_unique')
    like '%purpose IS NOT NULL%',
  'the purpose index excludes marketing rows, which all have a null purpose');

-- AND THE DOOR THAT NAMES IT. These two are a pair: narrowing the index above
-- without correcting the clause below leaves register_message_template raising
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" on every system registration.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'register_message_template')
    like '%purpose is not null%',
  'register_message_template''s ON CONFLICT predicate matches the narrowed index');

-- The signature is UNCHANGED, so `create or replace` kept the ACL. A drop would
-- have taken it, and every registration would answer 42501 -- which no test
-- calling this as the OWNER would notice, because has_permission's owner bypass
-- opens the door for the one identity that never needed the grant.
select has_function('public', 'register_message_template',
  array['uuid','template_purpose','text','text','text','jsonb','boolean'],
  'register_message_template keeps its exact signature');

select ok(
  has_function_privilege('authenticated',
    'public.register_message_template(uuid,public.template_purpose,text,text,text,jsonb,boolean)',
    'execute'),
  'and therefore still holds its grant');

-- The backfill, asserted rather than inspected.
select ok(
  not exists (select 1 from public.message_templates where channel is null),
  'every existing row was given a channel');

-- ---------------------------------------------------------------------------
-- Task 3. The enqueue stops resolving across channels.
-- ---------------------------------------------------------------------------

-- Task 3. Without this term, the day somebody registers an email template
-- carrying a system purpose, the pickup reminder resolves it and tries to send
-- an email through the Cloud API.
select ok(
  (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'enqueue_whatsapp_outbound')
    like '%channel = ''WHATSAPP''%',
  'the enqueue resolves WhatsApp templates and no others');

-- ---------------------------------------------------------------------------
-- Task 4. The marketing door: shape and grants only. pgTAP runs as superuser
-- with a null auth.uid(), where has_permission answers true unconditionally --
-- it cannot show the door REFUSES anybody. tests/isolation/marketing-
-- templates.test.ts holds that half, against real sessions.
-- ---------------------------------------------------------------------------
select has_function('public', 'save_marketing_template',
  array['uuid', 'message_channel', 'text', 'text', 'uuid', 'text', 'text', 'text',
        'text', 'jsonb', 'text', 'text', 'text'],
  'save_marketing_template exists with its full argument list');

select ok(
  has_function_privilege('authenticated',
    'public.save_marketing_template(uuid,public.message_channel,text,text,uuid,text,text,text,text,jsonb,text,text,text)',
    'execute'),
  'authenticated holds execute on the marketing door');

-- `anon` and PUBLIC both refused. `anon` is the widget's role and every
-- unauthenticated caller's; a door granted to it would let the internet write
-- a Station's templates, which nothing else in this plan would catch. PUBLIC
-- is the default ACL PostgreSQL hands out unless a migration revokes it.
select ok(
  not has_function_privilege('anon',
    'public.save_marketing_template(uuid,public.message_channel,text,text,uuid,text,text,text,text,jsonb,text,text,text)',
    'execute')
  and not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace,
           unnest(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
     where n.nspname = 'public'
       and p.proname = 'save_marketing_template'
       and acl::text like '=X/%'),
  'anon holds no execute and PUBLIC holds none either');

select * from finish();
rollback;
