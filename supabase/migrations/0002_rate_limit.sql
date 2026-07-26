create table if not exists public.rate_limit_counters (
  key         text primary key,
  count       integer not null default 0,
  reset_at    timestamptz not null
);

comment on table public.rate_limit_counters is 'Contadores atômicos de rate limiting (fallback sem Redis).';

-- Infraestrutura, não tabela de negócio: fica exposta por padrão no schema
-- `public` do PostgREST, então precisa de RLS mesmo sem policies de tenant.
-- Sem isso, qualquer holder de anon key apaga/zera os próprios contadores.
alter table public.rate_limit_counters enable row level security;
revoke all on public.rate_limit_counters from anon, authenticated;

-- O default ACL deste schema concede às roles do Supabase apenas `Dxtm`
-- (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) — nunca DML. Como `rate_limit_hit` é
-- SECURITY INVOKER e BYPASSRLS não substitui um GRANT ausente, sem esta linha o
-- PostgresRateLimiter falha com "permission denied for table" em toda chamada.
grant select, insert, update, delete on public.rate_limit_counters to service_role;

create index if not exists rate_limit_counters_reset_at_idx
  on public.rate_limit_counters (reset_at);

create or replace function public.rate_limit_hit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
) returns table(allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
  v_reset timestamptz;
begin
  insert into public.rate_limit_counters as c (key, count, reset_at)
    values (p_key, 1, v_now + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set count = case
          when c.reset_at <= v_now then 1
          when c.count <= p_limit then c.count + 1
          else c.count   -- satura em p_limit + 1
        end,
        reset_at = case when c.reset_at <= v_now
                        then v_now + make_interval(secs => p_window_seconds)
                        else c.reset_at end
  returning c.count, c.reset_at into v_count, v_reset;

  allowed := v_count <= p_limit;
  remaining := greatest(p_limit - v_count, 0);
  reset_at := v_reset;
  return next;
end;
$$;
