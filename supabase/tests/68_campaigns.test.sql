begin;
select plan(110);

-- Block 29d-2. Two vocabularies: what a campaign is doing, and what happened to
-- one recipient.
select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_status'),
  5, 'a campaign is queued, running, sent, failed or cancelled');

select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'campaign_recipient_status'),
  6, 'and a recipient has six outcomes, not five');

-- SUPPRESSED IS ITS OWN OUTCOME, and this assertion is the reason the enum has
-- six values rather than five. `failed` is our problem and earns a retry;
-- `suppressed` is the listener's choice and must never be retried. A counter
-- that added them together would hide the one fact the operator needs.
select ok(
  'suppressed' = any(enum_range(null::public.campaign_recipient_status)::text[]),
  'a listener who withdrew is suppressed, never failed');

-- ---------------------------------------------------------------------------
-- Task 2. The two tables: message_campaigns (the queue and the history) and
-- message_campaign_recipients (the snapshot and the queue, one row each).
-- ---------------------------------------------------------------------------

select has_table('public', 'message_campaigns', 'the campaign table exists');
select has_table('public', 'message_campaign_recipients', 'and the table holding one row per recipient');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'message_campaigns'
      and column_name in ('company_id', 'list_id', 'channel', 'template_id', 'status', 'created_by')) = 6,
  'a campaign carries its Station, the list it was built from, its channel, its template, its status and who created it');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'message_campaigns'
      and column_name in ('total_recipients', 'sent_count', 'failed_count', 'suppressed_count')) = 4,
  'and the four counters an operator reads on the history grid');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'message_campaigns'
      and column_name in ('cancelled_by', 'cancelled_at', 'cancel_reason')) = 3,
  'and section 10''s three cancellation fields');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'message_campaign_recipients'
      and column_name in ('campaign_id', 'member_id', 'channel', 'address', 'variables', 'status')) = 6,
  'a recipient row carries which campaign, which listener, which channel, the address resolved at snapshot time, the variable values used, and its status');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'message_campaign_recipients'
      and column_name in ('attempts', 'next_attempt_at', 'claimed_at', 'provider_message_id', 'error_code', 'error_description')) = 6,
  'and the queue half: attempts, the next try, when it was claimed, the provider''s message id, and the error pair');

-- The claim's partial index. The predicate is checked exactly -- 'pending'
-- alone, never also 'claimed' -- because claim_outbox_batch's own migration
-- (0059) explains why a predicate naming a status the claim can also see turns
-- the index condition into a filter and makes the planner's use of the index
-- depend on how big the table has grown.
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    where c.relname = 'message_campaign_recipients_sendable_idx'
      and t.relname = 'message_campaign_recipients'
      and i.indpred is not null
      and pg_get_expr(i.indpred, i.indrelid) = $pred$(status = 'pending'::campaign_recipient_status)$pred$
  ),
  'the sendable partial index exists and names exactly pending, the one status a fresh row holds');

-- 0238's own late fix (whole-branch review, F9) added exactly this after the
-- fact for send_list_members; this table holds real phone numbers and e-mail
-- addresses, so the same gap here would be worse, not the same.
select ok(
  not has_table_privilege('service_role', 'public.message_campaigns', 'TRUNCATE'),
  'service_role cannot truncate the campaign table');
select ok(
  not has_table_privilege('service_role', 'public.message_campaign_recipients', 'TRUNCATE'),
  'nor the recipient table -- a queue that can be emptied by one statement is worse than a list that can');

-- NO POLICY, deliberately (spec section 5 / plan Task 2): nothing reads this
-- table as a user. Checked on the catalog rather than trusted from the
-- migration's prose, the way 67_send_lists.test.sql checks send_list_members.
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'message_campaign_recipients'),
  0, 'message_campaign_recipients carries no RLS policy at all -- the doors and the drain reach it');

select ok(
  not has_table_privilege('authenticated', 'public.message_campaign_recipients', 'SELECT'),
  'and authenticated holds no grant to fall back on either');
select ok(
  not has_table_privilege('anon', 'public.message_campaign_recipients', 'SELECT'),
  'nor anon');

-- ---------------------------------------------------------------------------
-- message_campaigns' own SELECT policy: gated on messaging.view at the
-- campaign's Station, the same shape send_lists_select_messaging_view (0238)
-- uses. One Station, one campaign, a viewer who holds messaging.view there and
-- a session that holds nothing anywhere.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-024200000001', 'Org campaigns 0242');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-024200000002', '00000000-0000-0000-0000-024200000001', 'Station 0242');

insert into public.send_lists (id, organization_id, company_id, name, source, kind) values
  ('00000000-0000-0000-0000-024200000003', '00000000-0000-0000-0000-024200000001',
   '00000000-0000-0000-0000-024200000002', 'Lista 0242', 'members', 'living');

insert into public.message_templates (id, organization_id, company_id, channel, internal_name, name, language, body) values
  ('00000000-0000-0000-0000-024200000004', '00000000-0000-0000-0000-024200000001',
   '00000000-0000-0000-0000-024200000002', 'WHATSAPP', 'Modelo 0242', 'modelo_0242', 'pt_BR',
   'Corpo de teste do Bloco 0242');

insert into public.message_campaigns (id, organization_id, company_id, list_id, channel, template_id) values
  ('00000000-0000-0000-0000-024200000005', '00000000-0000-0000-0000-024200000001',
   '00000000-0000-0000-0000-024200000002', '00000000-0000-0000-0000-024200000003', 'WHATSAPP',
   '00000000-0000-0000-0000-024200000004');

insert into public.members (id, organization_id, full_name, email) values
  ('00000000-0000-0000-0000-024200000009', '00000000-0000-0000-0000-024200000001', 'Test Member 0242', 'member0242@example.test');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-024200000006', '00000000-0000-0000-0000-024200000001', 'Messaging Viewer 0242');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-024200000006', 'messaging.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-024200000007', 'campaigns-viewer-0242@example.test'),
  ('00000000-0000-0000-0000-024200000008', 'campaigns-nobody-0242@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-024200000007', '00000000-0000-0000-0000-024200000002',
   '00000000-0000-0000-0000-024200000001', '00000000-0000-0000-0000-024200000006');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024200000007", "role": "authenticated"}';

select is(
  (select count(*)::int from public.message_campaigns where id = '00000000-0000-0000-0000-024200000005'),
  1, 'messaging.view at the Station is enough to select its campaign');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024200000008", "role": "authenticated"}';

select is(
  (select count(*)::int from public.message_campaigns where id = '00000000-0000-0000-0000-024200000005'),
  0, 'and a session with no company_membership anywhere sees none of it');

reset role;
reset request.jwt.claims;

-- Task 2: The unique constraint on (campaign_id, member_id). A duplicate
-- row means one listener receives the campaign twice, which is the complaint
-- that costs a WhatsApp Business number its quality rating -- the whole block
-- exists to check consent on every single row before sending, and a listener
-- sent twice is the same inbox complaint as one sent after they withdrew.
insert into public.message_campaign_recipients (id, campaign_id, member_id, channel, address)
  values ('00000000-0000-0000-0000-024200000010', '00000000-0000-0000-0000-024200000005',
          '00000000-0000-0000-0000-024200000009', 'WHATSAPP', '+55 (11) 99999-0000');

select throws_ok(
  $$insert into public.message_campaign_recipients (id, campaign_id, member_id, channel, address)
    values ('00000000-0000-0000-0000-024200000011', '00000000-0000-0000-0000-024200000005',
            '00000000-0000-0000-0000-024200000009', 'WHATSAPP', '+55 (11) 99999-0001')$$,
  '23505',
  'duplicate key value violates unique constraint "message_campaign_recipients_one_row_per_listener"',
  'two rows for the same listener in the same campaign are refused');

-- ---------------------------------------------------------------------------
-- Task 3. The two doors: create_campaign (the snapshot) and cancel_campaign
-- (the stop). Both SECURITY DEFINER, both gated on messaging.send rather
-- than messaging.manage -- 0236's own reason, restated in 0243's header:
-- approving a send is not the act of drafting one.
-- ---------------------------------------------------------------------------

select has_function('public', 'create_campaign', 'create_campaign exists');
select has_function('public', 'cancel_campaign', 'cancel_campaign exists');

-- `create function` grants EXECUTE to PUBLIC by default; 0243 revokes that and
-- grants back only to authenticated -- so anon, PUBLIC and service_role must
-- all hold nothing. service_role is checked explicitly here, unlike the three
-- send-list doors' own test (67), because these two doors sit one step closer
-- to the drain than send_list's ever did, and the point that the worker never
-- calls them is exactly the fact a stray grant would quietly contradict.

select ok(
  has_function_privilege('authenticated',
    'public.create_campaign(uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb)', 'EXECUTE'),
  'authenticated may create a campaign');
select ok(
  not has_function_privilege('anon',
    'public.create_campaign(uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb)', 'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public',
    'public.create_campaign(uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb)', 'EXECUTE'),
  'and PUBLIC holds nothing');
select ok(
  not has_function_privilege('service_role',
    'public.create_campaign(uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb)', 'EXECUTE'),
  'nor service_role -- the worker never creates a campaign, only the drain (Task 6) reads its queue');

select ok(
  has_function_privilege('authenticated', 'public.cancel_campaign(uuid, text)', 'EXECUTE'),
  'authenticated may cancel a campaign');
select ok(
  not has_function_privilege('anon', 'public.cancel_campaign(uuid, text)', 'EXECUTE'),
  'anon may not');
select ok(
  not has_function_privilege('public', 'public.cancel_campaign(uuid, text)', 'EXECUTE'),
  'and PUBLIC holds nothing');
select ok(
  not has_function_privilege('service_role', 'public.cancel_campaign(uuid, text)', 'EXECUTE'),
  'nor service_role -- cancellation is an operator''s action, never the worker''s own');

-- Fixtures: one Organization, two Stations, three listeners -- A1 and A2
-- linked to Station A, the Station every call below names; B1 linked ONLY to
-- Station B, a real cross-Station listener rather than merely an id that
-- matches nothing. Two living lists, one per Station. Three templates: a
-- WhatsApp template registered at Station A, the same at Station B (to prove
-- "wrong Station" rather than "wrong channel"), and an e-mail template at
-- Station A -- which message_templates_email_no_meta_fields (0223) forces to
-- carry null name and null language, making it, by 0223's own definition,
-- the one template in this fixture that is NOT a registered WhatsApp
-- template. Two roles -- messaging.send alone, messaging.manage alone --
-- because the permission split is the point of this task.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-024300000001', 'Org campaign doors 0243');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000001', 'Station 0243 A'),
  ('00000000-0000-0000-0000-024300000003', '00000000-0000-0000-0000-024300000001', 'Station 0243 B');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-024300000004', '00000000-0000-0000-0000-024300000001', 'Ouvinte 0243 A1'),
  ('00000000-0000-0000-0000-024300000005', '00000000-0000-0000-0000-024300000001', 'Ouvinte 0243 A2'),
  ('00000000-0000-0000-0000-024300000006', '00000000-0000-0000-0000-024300000001', 'Ouvinte 0243 so da B');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-024300000004', '00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000001'),
  ('00000000-0000-0000-0000-024300000005', '00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000001'),
  ('00000000-0000-0000-0000-024300000006', '00000000-0000-0000-0000-024300000003', '00000000-0000-0000-0000-024300000001');

insert into public.send_lists (id, organization_id, company_id, name, source, kind) values
  ('00000000-0000-0000-0000-024300000007', '00000000-0000-0000-0000-024300000001',
   '00000000-0000-0000-0000-024300000002', 'Lista 0243 A', 'members', 'living'),
  ('00000000-0000-0000-0000-024300000008', '00000000-0000-0000-0000-024300000001',
   '00000000-0000-0000-0000-024300000003', 'Lista 0243 B', 'members', 'living');

insert into public.message_templates (id, organization_id, company_id, channel, internal_name, name, language, body) values
  ('00000000-0000-0000-0000-024300000009', '00000000-0000-0000-0000-024300000001',
   '00000000-0000-0000-0000-024300000002', 'WHATSAPP', 'Modelo 0243 A', 'modelo_0243_a', 'pt_BR',
   'Corpo de teste do Bloco 0243 A'),
  ('00000000-0000-0000-0000-024300000010', '00000000-0000-0000-0000-024300000001',
   '00000000-0000-0000-0000-024300000003', 'WHATSAPP', 'Modelo 0243 B', 'modelo_0243_b', 'pt_BR',
   'Corpo de teste do Bloco 0243 B');

insert into public.message_templates (id, organization_id, company_id, channel, internal_name, subject, body) values
  ('00000000-0000-0000-0000-024300000011', '00000000-0000-0000-0000-024300000001',
   '00000000-0000-0000-0000-024300000002', 'EMAIL', 'Modelo 0243 email', 'Assunto de teste 0243',
   'Corpo de e-mail de teste do Bloco 0243');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-024300000012', '00000000-0000-0000-0000-024300000001', 'Messaging Sender 0243'),
  ('00000000-0000-0000-0000-024300000013', '00000000-0000-0000-0000-024300000001', 'Messaging Manager 0243');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-024300000012', 'messaging.send'),
  ('00000000-0000-0000-0000-024300000013', 'messaging.manage');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-024300000014', 'campaigns-sender-0243@example.test'),
  ('00000000-0000-0000-0000-024300000015', 'campaigns-manager-0243@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-024300000014', '00000000-0000-0000-0000-024300000002',
   '00000000-0000-0000-0000-024300000001', '00000000-0000-0000-0000-024300000012'),
  ('00000000-0000-0000-0000-024300000015', '00000000-0000-0000-0000-024300000002',
   '00000000-0000-0000-0000-024300000001', '00000000-0000-0000-0000-024300000013');

-- messaging.manage alone -- STEP 5's own case: the caller this permission
-- split exists to refuse. Params are otherwise entirely valid (Station A's
-- own list, template and a linked listener), so the ONLY thing standing
-- between this call and success is the permission check itself.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024300000015", "role": "authenticated"}';

select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007',
      'WHATSAPP', '00000000-0000-0000-0000-024300000009', array['00000000-0000-0000-0000-024300000004'::uuid],
      '{}'::jsonb, '{}'::jsonb)$$,
  '42501', null, 'messaging.manage alone cannot create a campaign -- messaging.send is required');

reset role;

-- messaging.send -- every business-rule refusal below runs as this caller,
-- so each throws_ok isolates exactly one guard rather than also proving the
-- permission gate again.

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024300000014", "role": "authenticated"}';

-- member_linked_to_company (0034): B1 is a real listener, just not this
-- Station's. Without this check a caller who could pass any member id would
-- assemble a recipient list of people at a Station they hold no permission
-- at, from the id alone -- create_send_list's own reason (0239) for the
-- identical check.
select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007',
      'WHATSAPP', '00000000-0000-0000-0000-024300000009', array['00000000-0000-0000-0000-024300000006'::uuid],
      '{}'::jsonb, '{}'::jsonb)$$,
  'P0002', null, 'create_campaign refuses a listener linked only to another Station');

-- Template 0010 exists, and belongs to Station B -- a real template, not
-- merely an id that matches nothing, the same shape B1 gives the listener
-- check above.
select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007',
      'WHATSAPP', '00000000-0000-0000-0000-024300000010', array['00000000-0000-0000-0000-024300000004'::uuid],
      '{}'::jsonb, '{}'::jsonb)$$,
  'P0002', null, 'create_campaign refuses a template belonging to another Station');

-- List 0008 exists, and belongs to Station B -- the guard this task adds
-- beyond the brief's own list, for the identical reason: a caller who could
-- name any list id would otherwise snapshot a Station's listeners into a
-- campaign built against a list they hold no permission to read.
select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000008',
      'WHATSAPP', '00000000-0000-0000-0000-024300000009', array['00000000-0000-0000-0000-024300000004'::uuid],
      '{}'::jsonb, '{}'::jsonb)$$,
  'P0002', null, 'create_campaign refuses a list belonging to another Station');

-- Template 0011 is Station A's own, but it is an EMAIL template --
-- message_templates_email_no_meta_fields (0223) forces its name and language
-- both null, which is exactly what 0223 itself calls "is this registered at
-- Meta". Requesting WHATSAPP against it exercises the registration check
-- specifically, not the not-found path the two throws_ok above already cover.
select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007',
      'WHATSAPP', '00000000-0000-0000-0000-024300000011', array['00000000-0000-0000-0000-024300000004'::uuid],
      '{}'::jsonb, '{}'::jsonb)$$,
  '22023', null, 'a WhatsApp campaign is refused when the template is not registered');

-- An empty p_member_ids. array_length(empty_array, 1) returns NULL, not 0 --
-- the Postgres quirk create_campaign's own v_total is null or v_total = 0
-- works around -- the identical guard create_send_list states for itself
-- (67_send_lists.test.sql, 'a fixed list needs at least one person').
select throws_ok(
  $$select public.create_campaign('00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007',
      'WHATSAPP', '00000000-0000-0000-0000-024300000009', array[]::uuid[],
      '{}'::jsonb, '{}'::jsonb)$$,
  '22023', null, 'create_campaign refuses an empty recipient set');

-- The snapshot itself: two recipients, each with their OWN address and
-- variables, keyed by member id cast to text -- proving the door reads each
-- recipient's own entry rather than, say, applying the first one to everybody.
create temporary table t0243_campaign as
select public.create_campaign(
  '00000000-0000-0000-0000-024300000002', '00000000-0000-0000-0000-024300000007', 'WHATSAPP',
  '00000000-0000-0000-0000-024300000009',
  array['00000000-0000-0000-0000-024300000004'::uuid, '00000000-0000-0000-0000-024300000005'::uuid],
  jsonb_build_object(
    '00000000-0000-0000-0000-024300000004', '+55 11 90000-0001',
    '00000000-0000-0000-0000-024300000005', '+55 11 90000-0002'),
  jsonb_build_object(
    '00000000-0000-0000-0000-024300000004', jsonb_build_array('Maria'),
    '00000000-0000-0000-0000-024300000005', jsonb_build_array('Joao'))
) as campaign_id;

reset role;

-- Verification as the pgTAP superuser -- create_campaign's own row and its
-- recipients are readable this way regardless of RLS, the same convention
-- 67_send_lists.test.sql uses for its own doors' results.

select is(
  (select total_recipients from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  2, 'total_recipients is written once, from the snapshot size');
select is(
  (select status from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  'queued', 'a fresh campaign starts queued, the enum''s own default');
select is(
  (select created_by from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  '00000000-0000-0000-0000-024300000014'::uuid, 'created_by names the operator who called the door');
select is(
  (select address from public.message_campaign_recipients
    where campaign_id = (select campaign_id from t0243_campaign)
      and member_id = '00000000-0000-0000-0000-024300000004'),
  '+55 11 90000-0001', 'the first recipient gets their own resolved address');
select is(
  (select address from public.message_campaign_recipients
    where campaign_id = (select campaign_id from t0243_campaign)
      and member_id = '00000000-0000-0000-0000-024300000005'),
  '+55 11 90000-0002', 'and the second gets theirs -- not the first one''s, copied');
select is(
  (select variables from public.message_campaign_recipients
    where campaign_id = (select campaign_id from t0243_campaign)
      and member_id = '00000000-0000-0000-0000-024300000004'),
  '["Maria"]'::jsonb, 'variables are stored per recipient too');
select is(
  (select count(*)::int from public.audit_logs
    where target_table = 'message_campaigns' and target_id = (select campaign_id from t0243_campaign)
      and action = 'create_campaign'),
  1, 'the create is audited under the door''s own name');
select ok(
  not exists (
    select 1 from public.audit_logs
     where target_table = 'message_campaigns' and target_id = (select campaign_id from t0243_campaign)
       and action = 'create_campaign' and detail::text ilike '%90000-0001%'
  ),
  'and the audit row carries no phone number -- ids and counts only (0034''s own rule)');

-- message_campaign_recipients_variables_is_positional (0242). 0222 states a
-- WhatsApp template's own variables is POSITIONAL, index 0 is {{1}}; the
-- column's comment says a recipient's resolved values are a parallel array
-- in that same order, and this constraint is what makes the database hold
-- that, not only the comment's word for it. Direct insert, the same way the
-- unique constraint above is proven -- this is a table constraint, not
-- something either door decides.
select throws_ok(
  $$insert into public.message_campaign_recipients (campaign_id, member_id, channel, variables)
    values ((select campaign_id from t0243_campaign), '00000000-0000-0000-0000-024300000006',
            'WHATSAPP', '{"1": "Maria"}'::jsonb)$$,
  '23514', null, 'a recipient''s variables must be a positional array, not an object');

-- Simulate one recipient already claimed by the drain, as the pgTAP
-- superuser -- nothing in this feature's own doors moves a row to claimed
-- (that is claim_campaign_batch, Task 4, not built by this task), so the
-- state is written directly to set up cancel_campaign's own test.
update public.message_campaign_recipients
   set status = 'claimed', claimed_at = now()
 where campaign_id = (select campaign_id from t0243_campaign)
   and member_id = '00000000-0000-0000-0000-024300000005';

-- messaging.manage alone, again -- cancel_campaign's own Step 5 case.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024300000015", "role": "authenticated"}';

select throws_ok(
  (select format('select public.cancel_campaign(%L, %L)', campaign_id, 'nao deveria') from t0243_campaign),
  '42501', null, 'messaging.manage alone cannot cancel a campaign -- messaging.send is required');

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024300000014", "role": "authenticated"}';

select throws_ok(
  $$select public.cancel_campaign('00000000-0000-0000-0000-024300000fff', 'motivo')$$,
  'P0002', null, 'cancelling an unknown campaign is P0002');

create temporary table t0243_cancelled as
select public.cancel_campaign((select campaign_id from t0243_campaign), 'operator changed the offer') as marked;

reset role;

select is(
  (select marked from t0243_cancelled),
  1, 'cancel_campaign marks exactly the one still-pending row, not the claimed one too');
select is(
  (select status from public.message_campaign_recipients
    where campaign_id = (select campaign_id from t0243_campaign)
      and member_id = '00000000-0000-0000-0000-024300000004'),
  'cancelled', 'the pending recipient is marked cancelled');
select is(
  (select status from public.message_campaign_recipients
    where campaign_id = (select campaign_id from t0243_campaign)
      and member_id = '00000000-0000-0000-0000-024300000005'),
  'claimed', 'and the claimed recipient is left exactly alone -- it is in flight and cannot be recalled');
select is(
  (select status from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  'cancelled', 'the campaign itself is marked cancelled');
select is(
  (select cancelled_by from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  '00000000-0000-0000-0000-024300000014'::uuid, 'cancelled_by names who cancelled it');
select is(
  (select cancel_reason from public.message_campaigns where id = (select campaign_id from t0243_campaign)),
  'operator changed the offer', 'cancel_reason carries the operator''s free text');

-- Re-cancelling a campaign already cancelled must not overwrite its history
-- with a second, later cancellation -- the guard this task adds beyond the
-- brief's own list, because without it this door could turn a fully-sent
-- campaign's row back into 'cancelled', which would simply be false.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024300000014", "role": "authenticated"}';

select throws_ok(
  (select format('select public.cancel_campaign(%L, %L)', campaign_id, 'segunda tentativa') from t0243_campaign),
  '22023', null, 'cancelling an already-cancelled campaign is refused, not silently repeated');

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Task 4. claim_campaign_batch: the claim the fifth drain (Task 6, not built
-- yet) takes a batch of recipient rows with. claim_outbox_batch's own shape --
-- one statement, for update skip locked, attempts returned unchanged -- checked
-- live via pg_get_functiondef, not any one migration's text, because it has
-- been dropped and recreated more than once since it was first written.
--
-- Fixtures: one Organization, one Station, one send list, two templates (a
-- WhatsApp one carrying name/language, an e-mail one carrying subject --
-- 0223's own conditional pairs, message_templates_whatsapp_shape and
-- message_templates_email_no_meta_fields, forbid a row from carrying both),
-- two campaigns (one per channel, so the join to message_templates is proven
-- for both shapes rather than only the one this block sends more of), and
-- eight recipients, one per status this schema has plus one due row on the
-- e-mail campaign. Inserted directly rather than through create_campaign
-- (0243): that door cannot produce a `claimed`, `sent`, `failed`,
-- `suppressed` or `cancelled` row at all, the same reason 0243's own test
-- writes its one claimed row by hand.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-024400000001', 'Org campaign claim 0244');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-024400000002', '00000000-0000-0000-0000-024400000001', 'Station 0244');

insert into public.send_lists (id, organization_id, company_id, name, source, kind) values
  ('00000000-0000-0000-0000-024400000003', '00000000-0000-0000-0000-024400000001',
   '00000000-0000-0000-0000-024400000002', 'Lista 0244', 'members', 'living');

insert into public.message_templates (id, organization_id, company_id, channel, internal_name, name, language, body) values
  ('00000000-0000-0000-0000-024400000004', '00000000-0000-0000-0000-024400000001',
   '00000000-0000-0000-0000-024400000002', 'WHATSAPP', 'Modelo 0244 W', 'modelo_0244_w', 'pt_BR',
   'Corpo A {{1}}');

insert into public.message_templates (id, organization_id, company_id, channel, internal_name, subject, body) values
  ('00000000-0000-0000-0000-024400000005', '00000000-0000-0000-0000-024400000001',
   '00000000-0000-0000-0000-024400000002', 'EMAIL', 'Modelo 0244 E', 'Assunto 0244',
   'Corpo email 0244');

insert into public.message_campaigns (id, organization_id, company_id, list_id, channel, template_id) values
  ('00000000-0000-0000-0000-024400000006', '00000000-0000-0000-0000-024400000001',
   '00000000-0000-0000-0000-024400000002', '00000000-0000-0000-0000-024400000003', 'WHATSAPP',
   '00000000-0000-0000-0000-024400000004'),
  ('00000000-0000-0000-0000-024400000007', '00000000-0000-0000-0000-024400000001',
   '00000000-0000-0000-0000-024400000002', '00000000-0000-0000-0000-024400000003', 'EMAIL',
   '00000000-0000-0000-0000-024400000005');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-024400000010', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R1'),
  ('00000000-0000-0000-0000-024400000011', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R2'),
  ('00000000-0000-0000-0000-024400000012', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R3'),
  ('00000000-0000-0000-0000-024400000013', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R4'),
  ('00000000-0000-0000-0000-024400000014', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R5'),
  ('00000000-0000-0000-0000-024400000015', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R6'),
  ('00000000-0000-0000-0000-024400000016', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R7'),
  ('00000000-0000-0000-0000-024400000017', '00000000-0000-0000-0000-024400000001', 'Ouvinte 0244 R8');

-- R1: pending, due -- the plain case this function exists for.
-- R2: pending, NOT due -- next_attempt_at in the future.
-- R3: already claimed -- doubles as the fixture for the stale-claim section
--     below, which resets it to pending and claims it again.
-- R4: sent -- provider_message_id required by message_campaign_recipients_sent_shape.
-- R5: failed -- error_code required by message_campaign_recipients_failed_says_why.
-- R6: suppressed -- the listener's own withdrawal, never retried.
-- R7: cancelled -- what cancel_campaign (0243) leaves a pending row as.
-- R8: pending, due, on the EMAIL campaign -- proves the claim's predicate is
--     on status and timing, not channel, and that the template join carries
--     subject rather than name/language for this row.
insert into public.message_campaign_recipients
  (id, campaign_id, member_id, channel, address, variables, status, attempts, next_attempt_at, claimed_at, provider_message_id, error_code) values
  ('00000000-0000-0000-0000-024400000020', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000010', 'WHATSAPP', '+55 11 90000-1001', '["Ana"]'::jsonb,
   'pending', 1, now() - interval '5 minutes', null, null, null),
  ('00000000-0000-0000-0000-024400000021', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000011', 'WHATSAPP', '+55 11 90000-1002', '[]'::jsonb,
   'pending', 0, now() + interval '1 hour', null, null, null),
  ('00000000-0000-0000-0000-024400000022', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000012', 'WHATSAPP', '+55 11 90000-1003', '[]'::jsonb,
   'claimed', 0, now(), now() - interval '10 minutes', null, null),
  ('00000000-0000-0000-0000-024400000023', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000013', 'WHATSAPP', '+55 11 90000-1004', '[]'::jsonb,
   'sent', 1, now(), null, 'wamid.TEST0244', null),
  ('00000000-0000-0000-0000-024400000024', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000014', 'WHATSAPP', '+55 11 90000-1005', '[]'::jsonb,
   'failed', 3, now(), null, null, 'PERMANENT_TEST'),
  ('00000000-0000-0000-0000-024400000025', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000015', 'WHATSAPP', '+55 11 90000-1006', '[]'::jsonb,
   'suppressed', 0, now(), null, null, null),
  ('00000000-0000-0000-0000-024400000026', '00000000-0000-0000-0000-024400000006',
   '00000000-0000-0000-0000-024400000016', 'WHATSAPP', '+55 11 90000-1007', '[]'::jsonb,
   'cancelled', 0, now(), null, null, null),
  ('00000000-0000-0000-0000-024400000027', '00000000-0000-0000-0000-024400000007',
   '00000000-0000-0000-0000-024400000017', 'EMAIL', 'oitava.0244@example.test', '[]'::jsonb,
   'pending', 0, now() - interval '1 minute', null, null, null);

select has_function('public', 'claim_campaign_batch', 'claim_campaign_batch exists');

-- `create function` grants EXECUTE to PUBLIC by default; this function
-- revokes that and grants back only to service_role -- the drain (Task 6) is
-- the only caller, and a claim reachable by a user session is a way to take
-- real recipient rows out of circulation that nothing in this block can give
-- back yet.
select ok(
  has_function_privilege('service_role', 'public.claim_campaign_batch(integer)', 'EXECUTE'),
  'service_role may claim a batch -- the drain''s only door into this queue');
select ok(
  not has_function_privilege('authenticated', 'public.claim_campaign_batch(integer)', 'EXECUTE'),
  'authenticated may not -- a claim reachable by a user session is work nobody can give back');
select ok(
  not has_function_privilege('anon', 'public.claim_campaign_batch(integer)', 'EXECUTE'),
  'nor anon');
select ok(
  not has_function_privilege('public', 'public.claim_campaign_batch(integer)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- The limit is raised well past this fixture's own eight rows, the same
-- reason 07_whatsapp_worker.test.sql raises claim_outbox_batch's own limit
-- past its fixture: this function has no tenant scope, so every assertion
-- below is scoped to this fixture's own ids rather than to a bare count.
create temporary table t0244_claimed_first as
  select * from public.claim_campaign_batch(10000);

select ok(
  exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  'a pending row whose next_attempt_at has arrived is claimed');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000021'),
  'a pending row whose next_attempt_at has not arrived yet is left alone');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000022'),
  'a row already claimed is not claimed again');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000023'),
  'a sent row is not claimed');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000024'),
  'a failed row is not claimed');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000025'),
  'a suppressed row is not claimed -- the listener''s withdrawal, never retried');
select ok(
  not exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000026'),
  'a cancelled row is not claimed');
select ok(
  exists (select 1 from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027'),
  'a due pending row on an EMAIL campaign is claimed too -- the predicate is on status and timing, not channel');

-- Written to the table, not only returned as such -- the UPDATE inside the
-- claim CTE is what this checks, not merely the SELECT's own shape.
select is(
  (select status from public.message_campaign_recipients where id = '00000000-0000-0000-0000-024400000020'),
  'claimed', 'the claimed row is marked claimed in the table');
select ok(
  (select claimed_at from public.message_campaign_recipients
    where id = '00000000-0000-0000-0000-024400000020') is not null,
  'and claimed_at is set in the same statement');

-- The return shape itself: channel and address come from the recipient row,
-- company_id and the four template columns are resolved by the join, and
-- variables comes back exactly as stored -- not reshaped, not re-keyed.
select is(
  (select channel from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  'WHATSAPP'::public.message_channel, 'channel comes back from the recipient row itself');
select is(
  (select address from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  '+55 11 90000-1001', 'address comes back exactly as snapshotted');
select is(
  (select variables from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  '["Ana"]'::jsonb, 'variables come back verbatim -- positional, never reshaped');
select is(
  (select attempts from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  1, 'attempts comes back unchanged -- claiming is not attempting');
select is(
  (select company_id from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  '00000000-0000-0000-0000-024400000002'::uuid,
  'company_id is resolved from the campaign, not stored on the recipient row itself');
select is(
  (select template_name from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  'modelo_0244_w', 'template_name is the campaign''s own template, joined at claim time');
select is(
  (select template_language from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  'pt_BR', 'and its language');
select is(
  (select body from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020'),
  'Corpo A {{1}}', 'and its body');
select ok(
  (select subject from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000020') is null,
  'a WhatsApp template has no subject');

-- The e-mail campaign's own recipient: the join carries subject rather than
-- name/language, message_templates_email_no_meta_fields' (0223) own shape.
select is(
  (select company_id from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027'),
  '00000000-0000-0000-0000-024400000002'::uuid, 'company_id resolves correctly for an EMAIL campaign too');
select ok(
  (select template_name from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027') is null,
  'an EMAIL template carries no Meta name (0223''s own shape)');
select ok(
  (select template_language from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027') is null,
  'nor a language');
select is(
  (select subject from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027'),
  'Assunto 0244', 'subject comes back for an EMAIL campaign''s template');
select is(
  (select body from t0244_claimed_first where id = '00000000-0000-0000-0000-024400000027'),
  'Corpo email 0244', 'and its body');

-- THE ASSERTION THIS SECTION EXISTS FOR. pgTAP wraps this whole file in one
-- transaction and one session, so a second CONNECTION cannot be opened from
-- inside it -- the same limit 07_whatsapp_worker.test.sql's own
-- claim_outbox_batch section works within. What this proves is narrower than
-- "two concurrent workers never collide": R1, already marked claimed by the
-- call above, is not returned by a SECOND call in this SAME session. It does
-- NOT prove the row-level lock holds between two concurrent sessions -- that
-- is what the brief's own step-5 experiment (removing skip locked) and,
-- later, Task 9's isolation suite prove.
select ok(
  not exists (select 1 from public.claim_campaign_batch(10000) where id = '00000000-0000-0000-0000-024400000020'),
  'a row already claimed by an earlier call in this session is not returned by a second call');

-- The stale-claim case. R3 (id ...022) sits in the table as `claimed` since
-- the fixture above, and the assertion in the first-call section already
-- proved this function leaves it alone while it holds that status. No
-- reclaim function exists yet for this table -- when one is built it is Task
-- 6's drain's own direct write, not a new RPC, the same shape 0242's own
-- grant comment already justifies for settling a send's outcome -- so the
-- reset below is written directly, the same way 0243's own test simulates a
-- claimed row to set up cancel_campaign's test.
-- What this proves is the half claim_campaign_batch is actually responsible
-- for: once a claim has been reset to pending -- what a stale-claim reclaim
-- would do -- this function has no OTHER guard (an attempts cap, a minimum
-- age) standing between that row and being claimed again.
update public.message_campaign_recipients
   set status = 'pending', claimed_at = null, next_attempt_at = now() - interval '1 minute'
 where id = '00000000-0000-0000-0000-024400000022';

select ok(
  exists (select 1 from public.claim_campaign_batch(10000) where id = '00000000-0000-0000-0000-024400000022'),
  'a claim reset to pending -- what a stale-claim reclaim would do -- is claimable again');

-- ---------------------------------------------------------------------------
-- Task 6a, Part 1. The index a stale-claim reclaim (Task 6b, not built yet)
-- will scan: partial on `claimed` alone -- never also `pending` -- on
-- claimed_at, the column the reclaim's age comparison actually uses. Checked
-- the same way message_campaign_recipients_sendable_idx is checked above:
-- against pg_index directly, and the predicate text is compared for an EXACT
-- match so a later "helpful" widening to more than one status would fail
-- this assertion rather than pass it silently.
-- ---------------------------------------------------------------------------
select ok(
  exists (
    select 1
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    where c.relname = 'message_campaign_recipients_claimed_idx'
      and t.relname = 'message_campaign_recipients'
      and i.indpred is not null
      and pg_get_expr(i.indpred, i.indrelid) = $pred$(status = 'claimed'::campaign_recipient_status)$pred$
      and pg_get_indexdef(i.indexrelid) like '%(claimed_at)%'
  ),
  'the claimed-status partial index exists, keyed on claimed_at, and names exactly claimed -- never also pending');

-- ---------------------------------------------------------------------------
-- Task 6a, Part 2. members_marketing_eligible_bulk (0235) is granted to
-- authenticated alone and raises 42501 unless the caller resolves, through
-- auth.uid(), to the platform admin, the Organization's owner or a holder of
-- members.view. The worker runs as service_role with no auth.uid(), so it can
-- never call that door. members_marketing_eligible_bulk_for_worker (0246) is
-- its own door for that caller, sharing ONE extracted rule
-- (apply_members_marketing_eligible) with 0235 rather than a second copy of
-- it -- the assertion below is why: without it the extraction is exactly the
-- fork it exists to prevent.
--
-- Fixtures: one Organization, two Stations, six listeners at Station A in
-- six different states -- plainly eligible; anonymized despite an explicit
-- yes; the latest consent row says no; linked only to Station B, a real
-- cross-Station listener rather than an id matching nothing; an active
-- suspension despite an explicit yes; and never asked at all. Two roles --
-- members.view alone, and messaging.view alone (a real, different
-- permission, not merely nothing) -- because the gate-survival case needs a
-- real authenticated caller who holds some permission, just not this one.
--
-- Fix round 1 (review, Important 1 and 2). Every assertion below the first
-- version of this fixture shipped with asked only WHATSAPP -- so a worker's
-- door that hardcoded the channel, or dropped p_channel on the way into the
-- shared core, was invisible to this suite. Worse, the not-linked listener
-- (...13) had no consent row at all, and WHATSAPP's own absent-consent
-- default is already `false`, so that assertion passed whether or not
-- member_linked_to_company was in the shared core -- proving nothing about
-- the link check specifically. Both are fixed the same way
-- 65_marketing_consent.test.sql:213-221 already fixes the identical trap for
-- 0235 itself: the not-linked case is asked on EMAIL, where the default is
-- `true`, so a missing link check flips the answer and the assertion bites.
-- The sixth listener (never asked, linked and otherwise clean) gives the
-- equivalence check and the individual assertions a case whose answer
-- genuinely DIFFERS by channel -- false on WHATSAPP, true on EMAIL -- for a
-- reason that has nothing to do with the link check, so the two effects are
-- never tested by the same row.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-024600000001', 'Org worker eligibility 0246');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001', 'Station 0246 A'),
  ('00000000-0000-0000-0000-024600000003', '00000000-0000-0000-0000-024600000001', 'Station 0246 B');

insert into public.members (id, organization_id, full_name) values
  ('00000000-0000-0000-0000-024600000010', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 Elegivel'),
  ('00000000-0000-0000-0000-024600000011', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 Anonimizado'),
  ('00000000-0000-0000-0000-024600000012', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 Disse Nao'),
  ('00000000-0000-0000-0000-024600000013', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 So Na B'),
  ('00000000-0000-0000-0000-024600000014', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 Suspenso'),
  ('00000000-0000-0000-0000-024600000015', '00000000-0000-0000-0000-024600000001', 'Ouvinte 0246 Nunca Perguntado');

insert into public.member_company_links (member_id, company_id, organization_id) values
  ('00000000-0000-0000-0000-024600000010', '00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001'),
  ('00000000-0000-0000-0000-024600000011', '00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001'),
  ('00000000-0000-0000-0000-024600000012', '00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001'),
  ('00000000-0000-0000-0000-024600000014', '00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001'),
  ('00000000-0000-0000-0000-024600000015', '00000000-0000-0000-0000-024600000002', '00000000-0000-0000-0000-024600000001'),
  ('00000000-0000-0000-0000-024600000013', '00000000-0000-0000-0000-024600000003', '00000000-0000-0000-0000-024600000001');

-- Explicit yes for three of the five consent-bearing listeners, so the
-- anonymized and suspended cases prove their bars override a real consent
-- row rather than merely agreeing with a default nobody recorded. ...15
-- (Nunca Perguntado) deliberately gets NO consent row of any kind, on
-- either channel -- that absence, not a block or a link, is the whole point
-- of that listener: WHATSAPP's and EMAIL's opposite defaults (spec D1) are
-- what answer for them, and nothing else does.
insert into public.member_consents (organization_id, member_id, company_id, consent_type, granted) values
  ('00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000010',
   '00000000-0000-0000-0000-024600000002', 'whatsapp_marketing', true),
  ('00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000011',
   '00000000-0000-0000-0000-024600000002', 'whatsapp_marketing', true),
  ('00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000012',
   '00000000-0000-0000-0000-024600000002', 'whatsapp_marketing', false),
  ('00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000014',
   '00000000-0000-0000-0000-024600000002', 'whatsapp_marketing', true);

update public.members set anonymized_at = now()
 where id = '00000000-0000-0000-0000-024600000011';

insert into public.member_blocks (organization_id, member_id, company_id, kind, reason) values
  ('00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000014',
   '00000000-0000-0000-0000-024600000002', 'suspension', 'probe 0246');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-024600000020', '00000000-0000-0000-0000-024600000001', 'Members Viewer 0246'),
  ('00000000-0000-0000-0000-024600000021', '00000000-0000-0000-0000-024600000001', 'Messaging Viewer 0246');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-024600000020', 'members.view'),
  ('00000000-0000-0000-0000-024600000021', 'messaging.view');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-024600000030', 'campaigns-eligibility-operator-0246@example.test'),
  ('00000000-0000-0000-0000-024600000031', 'campaigns-eligibility-nobody-0246@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-024600000030', '00000000-0000-0000-0000-024600000002',
   '00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000020'),
  ('00000000-0000-0000-0000-024600000031', '00000000-0000-0000-0000-024600000002',
   '00000000-0000-0000-0000-024600000001', '00000000-0000-0000-0000-024600000021');

select has_function('public', 'members_marketing_eligible_bulk_for_worker',
  array['uuid[]','uuid','public.message_channel'],
  'the worker''s own eligibility door exists');

select is(
  (select pg_get_function_result(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'members_marketing_eligible_bulk_for_worker'),
  'TABLE(member_id uuid, eligible boolean)',
  'and returns the same (member_id, eligible) shape members_marketing_eligible_bulk does');

-- `create function` grants EXECUTE to PUBLIC by default; this door revokes
-- that and grants back only to service_role -- it carries no identity gate at
-- all, so anybody who could call it would get an unchecked answer.
select ok(
  has_function_privilege('service_role',
    'public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)', 'EXECUTE'),
  'service_role may ask the worker''s door -- this is what the drain (Task 6b) calls');
select ok(
  not has_function_privilege('authenticated',
    'public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)', 'EXECUTE'),
  'authenticated may not -- this door has no identity gate, so a browser session reaching it would get an unchecked answer');
select ok(
  not has_function_privilege('anon',
    'public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)', 'EXECUTE'),
  'nor anon');
select ok(
  not has_function_privilege('public',
    'public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- Fix round 1, ITEM 3. This proves authenticated still holds EXECUTE on
-- members_marketing_eligible_bulk once 0246 has run -- not, by itself, WHICH
-- mechanism produced that. 0246 restates this grant explicitly (0235's own
-- self-containment precedent), so this assertion would read identically
-- whether create-or-replace had preserved the ACL on its own or a drop+create
-- had simply re-granted it afterwards; it does not distinguish the two.
select ok(
  has_function_privilege('authenticated',
    'public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel)', 'EXECUTE'),
  'members_marketing_eligible_bulk still grants authenticated EXECUTE after 0246''s recreate');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024600000031", "role": "authenticated"}';

-- The same caller who holds messaging.view but not members.view at this exact
-- Station -- a real, different permission, not merely an empty role -- is
-- still refused. This is the assertion that 0246's recreate delegated the
-- COMPUTATION and left the GATE untouched.
select throws_ok(
  $$select * from public.members_marketing_eligible_bulk(
      array['00000000-0000-0000-0000-024600000010']::uuid[],
      '00000000-0000-0000-0000-024600000002', 'WHATSAPP')$$,
  '42501', 'permission denied: members.view required',
  'members_marketing_eligible_bulk still refuses a caller holding no members.view -- its gate survived the recreate');

reset role;
reset request.jwt.claims;

-- THE ASSERTION THIS TASK EXISTS FOR. Two doors, two callers, one shared
-- core: the operator's door is asked as the operator (members.view),
-- the worker's door is asked as service_role, and every one of the six
-- listeners above is asked about through both -- ON BOTH CHANNELS, so a
-- worker door that hardcoded a channel or dropped p_channel on the way into
-- the shared core would show up here too, not only WHATSAPP. If the
-- extraction had forked into two copies of the rule -- the thing R23 exists
-- to prevent -- this is where the fork would show up, not before.

create temporary table t0246_operator_view (member_id uuid, channel public.message_channel, eligible boolean);
create temporary table t0246_worker_view (member_id uuid, channel public.message_channel, eligible boolean);
-- The temp table is owned by the pgTAP superuser; INSERT under a restricted
-- role needs an explicit grant, the same reason 00_smoke.test.sql grants
-- service_role INSERT on its own probe table before switching role.
grant insert on t0246_operator_view to authenticated;
grant insert on t0246_worker_view to service_role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-024600000030", "role": "authenticated"}';

insert into t0246_operator_view
  select member_id, 'WHATSAPP'::public.message_channel, eligible from public.members_marketing_eligible_bulk(
    array['00000000-0000-0000-0000-024600000010'::uuid,
          '00000000-0000-0000-0000-024600000011'::uuid,
          '00000000-0000-0000-0000-024600000012'::uuid,
          '00000000-0000-0000-0000-024600000013'::uuid,
          '00000000-0000-0000-0000-024600000014'::uuid,
          '00000000-0000-0000-0000-024600000015'::uuid],
    '00000000-0000-0000-0000-024600000002', 'WHATSAPP');
insert into t0246_operator_view
  select member_id, 'EMAIL'::public.message_channel, eligible from public.members_marketing_eligible_bulk(
    array['00000000-0000-0000-0000-024600000010'::uuid,
          '00000000-0000-0000-0000-024600000011'::uuid,
          '00000000-0000-0000-0000-024600000012'::uuid,
          '00000000-0000-0000-0000-024600000013'::uuid,
          '00000000-0000-0000-0000-024600000014'::uuid,
          '00000000-0000-0000-0000-024600000015'::uuid],
    '00000000-0000-0000-0000-024600000002', 'EMAIL');

reset role;
reset request.jwt.claims;

set local role service_role;

insert into t0246_worker_view
  select member_id, 'WHATSAPP'::public.message_channel, eligible from public.members_marketing_eligible_bulk_for_worker(
    array['00000000-0000-0000-0000-024600000010'::uuid,
          '00000000-0000-0000-0000-024600000011'::uuid,
          '00000000-0000-0000-0000-024600000012'::uuid,
          '00000000-0000-0000-0000-024600000013'::uuid,
          '00000000-0000-0000-0000-024600000014'::uuid,
          '00000000-0000-0000-0000-024600000015'::uuid],
    '00000000-0000-0000-0000-024600000002', 'WHATSAPP');
insert into t0246_worker_view
  select member_id, 'EMAIL'::public.message_channel, eligible from public.members_marketing_eligible_bulk_for_worker(
    array['00000000-0000-0000-0000-024600000010'::uuid,
          '00000000-0000-0000-0000-024600000011'::uuid,
          '00000000-0000-0000-0000-024600000012'::uuid,
          '00000000-0000-0000-0000-024600000013'::uuid,
          '00000000-0000-0000-0000-024600000014'::uuid,
          '00000000-0000-0000-0000-024600000015'::uuid],
    '00000000-0000-0000-0000-024600000002', 'EMAIL');

reset role;

-- Each state's expected answer, proven through the WORKER'S door directly --
-- not only asserted by comparison to the operator's -- so a worker door that
-- always answered, say, `true` would be caught here rather than only in the
-- equivalence check below (which two doors sharing the SAME bug would still
-- pass). WHATSAPP unless the case is specifically about a channel difference.
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000010' and channel = 'WHATSAPP'),
  true, 'plainly eligible: linked, not anonymized, not blocked, an explicit yes -- eligible through the worker''s door');
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000011' and channel = 'WHATSAPP'),
  false, 'anonymized bars even an explicit yes -- through the worker''s door');
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000012' and channel = 'WHATSAPP'),
  false, 'the latest consent row says no -- through the worker''s door');
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000013' and channel = 'WHATSAPP'),
  false, 'linked only to another Station -- false here on WhatsApp, though WhatsApp''s own absent-consent default already says false too, so this alone proves nothing about the link check; the discriminating case is EMAIL, just below');
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000014' and channel = 'WHATSAPP'),
  false, 'an active suspension bars even an explicit yes -- through the worker''s door');

-- Fix round 1, ITEM 1. EMAIL's own absent-consent default is `true` -- the
-- opposite of WHATSAPP's -- so a shared core that dropped or never applied
-- member_linked_to_company would answer `true` here. It answers `false`,
-- which is what actually proves the link check runs inside the worker's
-- door, the same way 65_marketing_consent.test.sql:213-221 proves it for
-- 0235 itself.
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000013' and channel = 'EMAIL'),
  false, 'linked only to another Station -- still false on EMAIL, despite EMAIL''s own default being eligible -- this is what actually proves the link check, through the worker''s door');

-- Fix round 1, ITEM 2. Never asked, on either channel, and otherwise clean --
-- the one listener whose correct answer genuinely DIFFERS by channel, for a
-- reason that has nothing to do with the link check: spec D1's own asymmetry,
-- WhatsApp requires an explicit yes and e-mail does not.
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000015' and channel = 'WHATSAPP'),
  false, 'never asked means not eligible on WhatsApp -- through the worker''s door');
select is(
  (select eligible from t0246_worker_view where member_id = '00000000-0000-0000-0000-024600000015' and channel = 'EMAIL'),
  true, 'and eligible on e-mail, the same asymmetry 65_marketing_consent.test.sql proves for 0235 -- through the worker''s door too');

select is(
  (select jsonb_agg(jsonb_build_object('member_id', member_id, 'channel', channel, 'eligible', eligible) order by channel, member_id)
     from t0246_operator_view),
  (select jsonb_agg(jsonb_build_object('member_id', member_id, 'channel', channel, 'eligible', eligible) order by channel, member_id)
     from t0246_worker_view),
  'the operator''s door and the worker''s door answer identically for all six listeners on BOTH channels, row for row -- proof the two share one rule, channel included, rather than each holding a copy of it');

-- ---------------------------------------------------------------------------
-- Task 6b fix round 1 (review Item 2). bump_campaign_counters (0247): the
-- atomic increment PostgREST cannot express -- see 0247's own header for why
-- a read-then-write from TypeScript loses an update under two overlapping
-- ticks settling the same campaign.
-- ---------------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-024700000001', 'Org campaign counters 0247');
insert into public.companies (id, organization_id, name) values
  ('00000000-0000-0000-0000-024700000002', '00000000-0000-0000-0000-024700000001', 'Station 0247');
insert into public.send_lists (id, organization_id, company_id, name, source, kind) values
  ('00000000-0000-0000-0000-024700000003', '00000000-0000-0000-0000-024700000001',
   '00000000-0000-0000-0000-024700000002', 'Lista 0247', 'members', 'living');
insert into public.message_templates (id, organization_id, company_id, channel, internal_name, name, language, body) values
  ('00000000-0000-0000-0000-024700000004', '00000000-0000-0000-0000-024700000001',
   '00000000-0000-0000-0000-024700000002', 'WHATSAPP', 'Modelo 0247', 'modelo_0247', 'pt_BR', 'Corpo {{1}}');
insert into public.message_campaigns (id, organization_id, company_id, list_id, channel, template_id) values
  ('00000000-0000-0000-0000-024700000005', '00000000-0000-0000-0000-024700000001',
   '00000000-0000-0000-0000-024700000002', '00000000-0000-0000-0000-024700000003', 'WHATSAPP',
   '00000000-0000-0000-0000-024700000004');

select has_function('public', 'bump_campaign_counters', 'bump_campaign_counters exists');

select ok(
  has_function_privilege('service_role',
    'public.bump_campaign_counters(uuid, integer, integer, integer)', 'EXECUTE'),
  'service_role may bump a campaign''s counters -- the drain''s own atomic settle write');
select ok(
  not has_function_privilege('authenticated',
    'public.bump_campaign_counters(uuid, integer, integer, integer)', 'EXECUTE'),
  'authenticated may not -- this is the worker''s own write, not an operator door');
select ok(
  not has_function_privilege('anon',
    'public.bump_campaign_counters(uuid, integer, integer, integer)', 'EXECUTE'),
  'nor anon');
select ok(
  not has_function_privilege('public',
    'public.bump_campaign_counters(uuid, integer, integer, integer)', 'EXECUTE'),
  'and PUBLIC holds nothing');

-- Two calls, as two overlapping ticks would make them: proof this
-- accumulates rather than overwrites, which is the whole reason it exists
-- rather than a plain PostgREST update.
select public.bump_campaign_counters('00000000-0000-0000-0000-024700000005', 3, 1, 0);
select public.bump_campaign_counters('00000000-0000-0000-0000-024700000005', 2, 0, 1);

select is(
  (select sent_count from public.message_campaigns where id = '00000000-0000-0000-0000-024700000005'),
  5, 'two calls accumulate rather than overwrite -- sent_count is the sum of both calls'' deltas');
select is(
  (select failed_count from public.message_campaigns where id = '00000000-0000-0000-0000-024700000005'),
  1, 'failed_count carries the first call''s delta forward through the second');
select is(
  (select suppressed_count from public.message_campaigns where id = '00000000-0000-0000-0000-024700000005'),
  1, 'suppressed_count carries the second call''s delta, not overwritten by it');

select finish();
rollback;
