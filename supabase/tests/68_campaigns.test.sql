begin;
select plan(18);

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

select finish();
rollback;
