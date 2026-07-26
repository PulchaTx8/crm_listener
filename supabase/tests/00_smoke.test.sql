begin;
select plan(7);

select has_table('public', 'rate_limit_counters', 'rate_limit_counters existe');
select has_function('public', 'rate_limit_hit', 'função rate_limit_hit existe');

-- Existência não basta: o default ACL do schema `public` não concede DML às
-- roles do Supabase, e `rate_limit_hit` é SECURITY INVOKER. Só executando a RPC
-- sob a role real dá para provar que o GRANT da migração 0002 está em vigor.
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
  'service_role: 1ª chamada dentro do limite é permitida'
);
select is(
  (select remaining from rl_probe where step = 2),
  0,
  'service_role: 2ª chamada esgota a cota (remaining = 0)'
);
select is(
  (select allowed from rl_probe where step = 3),
  false,
  'service_role: 3ª chamada excede o limite e é bloqueada'
);
select is(
  (select c.count from public.rate_limit_counters c where c.key = 'pgtap:svc'),
  3,
  'contador satura em p_limit + 1 (não cresce indefinidamente)'
);

-- A correção não pode ter aberto a tabela para o resto do mundo: `anon` ainda
-- precisa falhar fechado ao chamar a RPC (EXECUTE é público, o DML não).
set local role anon;
select throws_ok(
  $$ select * from public.rate_limit_hit('pgtap:anon', 2, 60) $$,
  '42501',
  null,
  'anon continua sem DML na tabela (falha fechado)'
);
reset role;

select * from finish();
rollback;
