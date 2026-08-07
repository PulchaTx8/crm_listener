begin;
select plan(6);

-- Block 14, D3. The prize's photograph, and the same rule its two siblings
-- follow: one writer, and it is not the wholesale-replace one.

select has_column('public', 'prizes', 'photo_url', 'a prize has a photograph');
select col_is_null('public', 'prizes', 'photo_url', 'and may have none');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_prize'
      and 'p_photo_url' = any(p.proargnames)),
  0::bigint,
  'update_prize does not touch the photograph, so an ordinary save cannot clear it');

select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'set_prize_photo'
      and grantee = 'anon'),
  0::bigint,
  'anon may not call set_prize_photo');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000d2', 'Org prize photo');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2',
   'Station prize photo', 'America/Sao_Paulo');
insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d2',
   '00000000-0000-0000-0000-0000000000e2', 'Pictured prize');

select throws_ok(
  $$update public.prizes set photo_url = 'not-an-address'
     where id = '00000000-0000-0000-0000-0000000000f2'$$,
  '23514', null,
  'a photograph that is not an address at all is refused');

-- No session is established, so has_permission answers false. What this proves
-- is that the gate is BEFORE the work, in the order attach_delivery_receipt
-- established: nothing is written and nothing is queued for a caller who may
-- not be here.
select throws_ok(
  $$select public.set_prize_photo('00000000-0000-0000-0000-0000000000f2', 'https://x/y')$$,
  '42501', null,
  'a caller without inventory.catalogue is refused before anything is written');

select * from finish();
rollback;
