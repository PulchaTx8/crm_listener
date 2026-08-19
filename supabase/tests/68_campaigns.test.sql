begin;
select plan(51);

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

select finish();
rollback;
