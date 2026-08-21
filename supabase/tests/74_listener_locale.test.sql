begin;
select plan(4);

-- Block 30d, item 2 (D6, D7). The Station's own language for what its
-- LISTENERS read, and the door that carries it to widget_frame_context
-- (0164, extended by 0265) -- the frame door every widget request reads in
-- both presentations, unlike widget_station_identity (0185), which
-- page.tsx:129 calls only when the presentation is 'app'.
--
-- Its own file, not an appendix to 72 (the phone rule) or 73 (fast entry,
-- Task 8's): a language assertion filed under either is one nobody looking
-- for it will read.
--
-- Fixture style follows 72_international_phone.test.sql and
-- 44_service_hashtags.test.sql: one organization, one company, one widget
-- installation, one role holding templates.manage, one user.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030e1', 'Org listener locale');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030e2', '00000000-0000-0000-0000-0000000030e1',
   'Station listener locale', 'America/Sao_Paulo');

insert into public.widget_installations (id, organization_id, company_id, public_key, enabled) values
  ('00000000-0000-0000-0000-0000000030e3', '00000000-0000-0000-0000-0000000030e1',
   '00000000-0000-0000-0000-0000000030e2', 'pw_000000000000000000030e', true);

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000030e4', '00000000-0000-0000-0000-0000000030e1', 'Templates Manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000030e4', 'templates.manage');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030e5', 'listener-locale-probe@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000030e5', '00000000-0000-0000-0000-0000000030e2',
   '00000000-0000-0000-0000-0000000030e1', '00000000-0000-0000-0000-0000000030e4');

-- 1: the column exists.
select has_column('public', 'companies', 'listener_locale', 'the Station carries a listener language');

-- The permission held: with it granted, an unsupported language still fails,
-- on the door's own validation rather than on has_permission -- proving the
-- 22023 branch is reachable at all, which it would not be if this ran with
-- no session (that would throw 42501 first, the same order set_service_hashtags
-- follows -- permission before shape).
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030e5", "role": "authenticated"}';

select throws_ok($$ select public.set_listener_locale('00000000-0000-0000-0000-0000000030e2', 'de') $$,
  '22023', null, 'a language with no catalogue is refused');

-- `reset role` alone leaves `request.jwt.claims` in place -- it is a `set
-- local` GUC, not a role attribute, and only `reset role` clearing it would
-- have let the previous claim keep naming a caller who holds the permission.
-- Both have to go for auth.uid() to answer null again.
reset role;
reset request.jwt.claims;

-- 3: and with no session at all, a SUPPORTED language is refused before the
--    door ever looks at what it was given -- has_permission is checked first.
select throws_ok($$ select public.set_listener_locale('00000000-0000-0000-0000-0000000030e2', 'pt') $$,
  '42501', null, 'a caller without templates.manage is refused');

-- A real write, so assertion 4 below has something to read back through the
-- frame door rather than asserting against the column's own default.
set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030e5", "role": "authenticated"}';

select public.set_listener_locale('00000000-0000-0000-0000-0000000030e2', 'pt');

reset role;
reset request.jwt.claims;

-- 4: The key rides on the door that runs in BOTH widget presentations.
-- Asserted on the door rather than on the column, because the column being
-- right while the door omits it is exactly the failure this block is fixing.
select is(
  public.widget_frame_context('pw_000000000000000000030e') ->> 'listenerLocale',
  'pt',
  'the frame door carries the language to the widget');

select * from finish();
rollback;
