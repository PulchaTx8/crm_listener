begin;
select plan(7);

select has_table('public', 'rate_limit_counters', 'rate_limit_counters exists');
select has_function('public', 'rate_limit_hit', 'function rate_limit_hit exists');

-- Existence is not enough: the `public` schema default ACL grants no DML to the
-- Supabase roles, and `rate_limit_hit` is SECURITY INVOKER. Only by executing
-- the RPC under the real role can we prove the GRANT from migration 0002 is in
-- effect.
create temporary table rl_probe (step integer, allowed boolean, remaining integer);
grant insert on rl_probe to service_role;

set local role service_role;
insert into rl_probe select 1, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
insert into rl_probe select 2, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
insert into rl_probe select 3, allowed, remaining from public.rate_limit_hit('pgtap:svc', 2, 60);
reset role;

select is(
  (select allowed from rl_probe where step = 1),
  true,
  'service_role: 1st call is within the limit and allowed'
);
select is(
  (select remaining from rl_probe where step = 2),
  0,
  'service_role: 2nd call exhausts the quota (remaining = 0)'
);
select is(
  (select allowed from rl_probe where step = 3),
  false,
  'service_role: 3rd call exceeds the limit and is blocked'
);
select is(
  (select c.count from public.rate_limit_counters c where c.key = 'pgtap:svc'),
  3,
  'counter saturates at p_limit + 1 (does not grow indefinitely)'
);

-- The fix must not have opened the table to the rest of the world: `anon` must
-- still fail closed when calling the RPC (EXECUTE is public, DML is not).
set local role anon;
select throws_ok(
  $$ select * from public.rate_limit_hit('pgtap:anon', 2, 60) $$,
  '42501',
  null,
  'anon still has no DML on the table (fails closed)'
);
reset role;

select * from finish();
rollback;
