begin;
select plan(18);

-- Block 30a. One listener's whole value, asked for one at a time, recorded
-- every time. Generalises reveal_request_phone (0190) from one request to one
-- listener; the assertions below are that file's, restated for the wider door.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030f1', 'Org 30a');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030f1',
   'Station 30a', 'America/Sao_Paulo');

insert into public.members (id, organization_id, full_name, phone, email, passport,
                            address_line, address_number, address_complement)
values
  ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030f1',
   'Ouvinte 30a', '11985954985', 'joao@gmail.com', 'FX1284821',
   'Rua das Flores', '221', 'ap 3');
-- Columns verified against 0031_members.sql:125 — (member_id, company_id,
-- organization_id, linked_at, linked_by), primary key on the first two. Both
-- composite FKs require the organization to match the member's and the
-- company's, which is why it is passed explicitly rather than defaulted.
insert into public.member_company_links (member_id, company_id, organization_id)
values ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030c1',
        '00000000-0000-0000-0000-0000000030f1');

-- A second listener, linked the same way, kept apart from the first so the
-- archived-listener case (assertions 8-9 below) does not have to share an
-- audit trail with the four reveals already recorded against the first.
insert into public.members (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000030d2', '00000000-0000-0000-0000-0000000030f1',
   'Ouvinte Arquivada 30a', '11977776666');
insert into public.member_company_links (member_id, company_id, organization_id)
values ('00000000-0000-0000-0000-0000000030d2', '00000000-0000-0000-0000-0000000030c1',
        '00000000-0000-0000-0000-0000000030f1');

-- Two actors, seeded with this file's usual role/grant idiom -- see
-- 51_music_request_triage.test.sql's attendant/onlooker setup, reused
-- verbatim rather than invented afresh.
--
-- The attendant: members.view at this Station.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000030b1', '00000000-0000-0000-0000-0000000030f1',
   'Members Viewer 30a');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000030b1', 'members.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030a1', 'viewer-30a@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000030a1', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030f1', '00000000-0000-0000-0000-0000000030b1');

-- The onlooker: music.view alone, at the same Station -- some permission, but
-- not members.view. A user with zero memberships would short-circuit inside
-- has_company_access_for (0121_permission_for.sql:168) before the permission
-- code is ever examined, which would prove only that a stranger is refused,
-- not that members.view specifically is what gates this door.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000030b2', '00000000-0000-0000-0000-0000000030f1',
   'Onlooker 30a');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000030b2', 'music.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030a2', 'onlooker-30a@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000030a2', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030f1', '00000000-0000-0000-0000-0000000030b2');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';

-- 1-4: each legal field comes back whole.
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone'),
  '11985954985', 'phone comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'email'),
  'joao@gmail.com', 'email comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'passport'),
  'FX1284821', 'passport comes back whole');
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'address'),
  'Rua das Flores, 221, ap 3', 'the three address parts come back as one fact');

-- 5: a field name this door does not know is refused rather than selected.
-- A door that reads a column named by its argument reads any column.
select throws_ok($$
  select public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'cpf_hash')
$$, '22023', null, 'an unknown field name is refused');

-- 6: four reveals so far, four audit rows. Read as the superuser, the same
-- reason 0190's own audit assertion resets the role first.
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'),
  4, 'every reveal leaves a trace');

-- 6b-6c: whole-branch review F4. Assertions 6, 9 and 11 (as they stood before
-- this fix) counted rows by target_id and action alone -- a regression writing
-- `{"field": null}` or stamping the wrong Station would pass every one of
-- them. With no rate limit on this door (spec §8), the audit row IS the
-- record that a disclosure happened, so its SHAPE is asserted here rather
-- than merely its count: which field was asked for, in the order asked, and
-- that every row names members as target_table and the Station
-- reveal_member_field actually SELECTed rather than merely tested (0253's own
-- comment on why v_company is selected into, not just checked with exists).
select is(
  (select array_agg(detail->>'field' order by id)
     from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'),
  array['phone', 'email', 'passport', 'address'],
  'the audit trail names which field was asked for, in the order it was asked');
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'
      and target_table = 'members'
      and organization_id = '00000000-0000-0000-0000-0000000030f1'
      and company_id = '00000000-0000-0000-0000-0000000030c1'),
  4, 'every row names members as the target table, at the Station the door resolved');

-- 7: an actor holding some other permission, but not members.view, at this
-- Station is refused.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a2", "role": "authenticated"}';
select throws_ok($$
  select public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone')
$$, '42501', null, 'members.view specifically, not just some Station permission, is required');

-- 8-9: an archived listener discloses nothing -- members_select_reachable
-- (0035_rls_members.sql:95-100) keeps deleted_at is null OUTSIDE its own
-- bypass, and archive_member (0034_member_rpcs.sql) sets it, so an archived
-- row is unselectable to everyone, owner included; this door refuses to
-- disclose what the row-level policy itself would already hide. AND THE
-- AUDIT ROW IS STILL WRITTEN, because somebody asked and that is the fact
-- being recorded -- the same rule the erased case below applies, for the
-- same reason.
reset role;
update public.members set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000030d2';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d2', 'phone'),
  null, 'an archived listener discloses nothing');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d2'
      and action = 'reveal_member_field'),
  1, 'the archived listener''s reveal still leaves a trace');

-- 9b-9c: the same shape check as 6b-6c, for the one row a disclosure that
-- returned null still leaves -- the row this door's whole "audited either
-- way" claim depends on being examined rather than merely counted.
select is(
  (select detail->>'field' from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d2'
      and action = 'reveal_member_field'),
  'phone', 'the archived listener''s audit row still names the field that was asked for');
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d2'
      and action = 'reveal_member_field'
      and target_table = 'members'
      and organization_id = '00000000-0000-0000-0000-0000000030f1'
      and company_id = '00000000-0000-0000-0000-0000000030c1'),
  1, 'the archived listener''s audit row still names members as the target table, at the Station the door resolved');

-- 10-11: an erased listener discloses nothing -- AND THE AUDIT ROW IS STILL
-- WRITTEN, because somebody asked and that is the fact being recorded.
update public.members set anonymized_at = now(), phone = null
 where id = '00000000-0000-0000-0000-0000000030d1';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone'),
  null, 'an erased listener discloses nothing');
reset role;
select is(
  (select count(*)::int from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'),
  5, 'the erased listener''s reveal still leaves a trace');

-- 11b-11c: the same shape check as 6b-6c and 9b-9c, for the fifth row --
-- ordered by id so the assertion names the row this call just wrote rather
-- than one of the four legitimate reveals from assertions 1-4 above, which
-- share this same target_id.
select is(
  (select detail->>'field' from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'
    order by id desc limit 1),
  'phone', 'the erased listener''s audit row still names the field that was asked for');
select is(
  (select target_table from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'
    order by id desc limit 1),
  'members', 'the erased listener''s audit row still names members as the target table');
select is(
  (select (organization_id, company_id) from public.audit_logs
    where target_id = '00000000-0000-0000-0000-0000000030d1'
      and action = 'reveal_member_field'
    order by id desc limit 1),
  row('00000000-0000-0000-0000-0000000030f1'::uuid, '00000000-0000-0000-0000-0000000030c1'::uuid),
  'the erased listener''s audit row still names the Station the door resolved');

select * from finish();
rollback;
