begin;
select plan(8);

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

-- Two actors: one holding members.view at this Station, one holding nothing.
-- (Seeded with this file's usual role/grant idiom -- see
-- 51_music_request_triage.test.sql's attendant/onlooker setup for the exact
-- shape, reused verbatim rather than invented afresh.)
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

-- The second actor holds no role and no membership anywhere -- nothing at this
-- Station, deliberately, rather than some other permission that is merely not
-- members.view.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030a2', 'bystander-30a@example.test');

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

-- 7: an actor holding nothing at this Station is refused.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a2", "role": "authenticated"}';
select throws_ok($$
  select public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone')
$$, '42501', null, 'members.view somewhere the listener is linked is required');

-- 8: an erased listener discloses nothing -- AND THE AUDIT ROW IS STILL
-- WRITTEN, because somebody asked and that is the fact being recorded.
reset role;
update public.members set anonymized_at = now(), phone = null
 where id = '00000000-0000-0000-0000-0000000030d1';
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030a1", "role": "authenticated"}';
select is(public.reveal_member_field('00000000-0000-0000-0000-0000000030d1', 'phone'),
  null, 'an erased listener discloses nothing');

select * from finish();
rollback;
