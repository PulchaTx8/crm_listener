-- supabase/migrations/0149_api_credential_rpcs.sql

-- Block 15, Task 2. The four doors onto 0148's tables, which nothing else can
-- reach: those tables have RLS on and no policy, so this file is the whole
-- list of readers and writers.
--
-- THE AUTHENTICATOR IS GRANTED TO service_role AND NOBODY ELSE. It takes a hash
-- and answers whether it names a usable credential; a browser role holding it
-- could grind hashes against the table.
--
-- THE OTHER THREE ARE GATED ON is_platform_admin(), which is 0130's argument
-- for the WhatsApp integration applied unchanged: giving a machine write access
-- to a Station is an act of the platform, not of a Company role. There is no
-- permission code that could grant it and there should not be.

-- ---------------------------------------------------------------------------
-- 1. authenticate_api_credential.
--
-- ZERO ROWS versus ONE ROW WITH scope_ok = false is the whole contract, and the
-- route depends on the difference:
--
--   zero rows  -> 401. Unknown, revoked, expired, or the Station is deleted or
--                 suspended. FOUR CAUSES, ONE ANSWER, so a caller probing with
--                 a stolen hash cannot learn which it was.
--   scope_ok   -> 403 when false. The caller has already proved it holds a
--                 valid key, so naming the missing scope gives away nothing it
--                 did not know -- and an integrator cannot debug without it.
--
-- Folding the two into one answer would be worse in both directions: a 401 for
-- a missing scope sends an integrator to re-issue a key that was fine, and a
-- 403 for an unknown key confirms that some other key exists.
-- ---------------------------------------------------------------------------

create function public.authenticate_api_credential(
  p_token_hash text,
  p_scope      text
)
returns table (
  credential_id   uuid,
  organization_id uuid,
  company_id      uuid,
  scope_ok        boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id      uuid;
  v_org     uuid;
  v_company uuid;
begin
  select c.id, c.organization_id, c.company_id
    into v_id, v_org, v_company
  from public.api_credentials c
  join public.companies co
    on co.id = c.company_id
   and co.deleted_at is null
   -- A lapsed subscription stops the machine door too. Without this a Station
   -- suspended for non-payment would go on accepting writes for as long as
   -- nobody remembered to revoke its keys.
   and co.status = 'active'
  where c.token_hash = p_token_hash
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now());

  if not found then
    -- Returns zero rows, and deliberately does NOT raise. A wrong key is
    -- ordinary traffic on a URL that is public by design; an exception here
    -- would fill the log with stack traces for something the route answers
    -- with a plain 401.
    return;
  end if;

  -- AMORTISED, and the condition is the point: without it this is an UPDATE on
  -- one hot row for every single request the automation ever makes. Sixty
  -- seconds of resolution is ample for the only question this column answers.
  update public.api_credentials
     set last_used_at = now()
   where id = v_id
     and (last_used_at is null or last_used_at < now() - interval '60 seconds');

  credential_id   := v_id;
  organization_id := v_org;
  company_id      := v_company;
  scope_ok        := exists (
    select 1 from public.api_credential_scopes s
     where s.credential_id = v_id and s.permission_code = p_scope);
  return next;
end;
$$;

comment on function public.authenticate_api_credential(text, text) is
  'Block 15. Resolves a presented token HASH to its Station, and reports separately whether the requested scope is held. Zero rows means unknown, revoked, expired, or a Station that is deleted or suspended -- one answer for four causes on purpose. EXECUTE is granted to service_role alone: a browser role holding this could grind hashes against the table.';

revoke execute on function public.authenticate_api_credential(text, text) from public;
grant  execute on function public.authenticate_api_credential(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. issue_api_credential.
--
-- THE SECRET IS NOT GENERATED HERE. The caller sorts it in Node with
-- crypto.randomBytes and sends only the prefix and the hash. That is the rule
-- the WhatsApp webhook already follows for the wamid, and its comment gives the
-- reason: an argument passed to an RPC lands in query logs and in backups. A
-- secret generated in SQL would be in both before it ever reached the operator.
-- ---------------------------------------------------------------------------

create function public.issue_api_credential(
  p_company_id   uuid,
  p_name         text,
  p_token_prefix text,
  p_token_hash   text,
  p_scopes       text[],
  p_expires_at   timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(btrim(p_name), '');
  v_id    uuid;
  v_scope text;
begin
  if not public.is_platform_admin() then
    raise log 'issue_api_credential denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if v_name is null then
    raise exception 'a name is required' using errcode = '22023';
  end if;

  -- A key that may do nothing is a key somebody will spend an afternoon
  -- debugging against an endpoint that keeps answering 403. Refused at issue.
  if p_scopes is null or cardinality(p_scopes) = 0 then
    raise exception 'a key needs at least one scope' using errcode = '22023';
  end if;

  insert into public.api_credentials
    (organization_id, company_id, name, token_prefix, token_hash, expires_at, created_by)
  values
    (v_org, p_company_id, v_name, p_token_prefix, p_token_hash, p_expires_at, v_actor)
  returning id into v_id;

  -- One at a time rather than `insert ... select unnest(p_scopes)`, so the
  -- foreign key names the offending code in its error message. unnest would
  -- report only that some member of the array was wrong, and the operator would
  -- have to guess which.
  foreach v_scope in array p_scopes loop
    insert into public.api_credential_scopes (credential_id, permission_code)
    values (v_id, v_scope);
  end loop;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'issue_api_credential', 'api_credentials', v_id, v_org, p_company_id,
     -- The prefix and the scopes; never the hash, and never the secret. 0004's
     -- own comment on this column: never store credentials here.
     jsonb_build_object('name', v_name, 'token_prefix', p_token_prefix,
                        'scopes', to_jsonb(p_scopes), 'expires_at', p_expires_at));

  return v_id;
end;
$$;

comment on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) is
  'Block 15. Records a key whose secret was generated by the caller and never travels here. Gated on is_platform_admin() for 0130''s reason: machine access to a Station is an act of the platform. The audit detail carries the prefix and the scopes, never the hash.';

revoke execute on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) from public;
grant  execute on function public.issue_api_credential(uuid, text, text, text, text[], timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. revoke_api_credential.
--
-- SOFT, never a delete: audit entries name a credential id, and deleting the
-- row would leave every one of them pointing at nothing. The same reasoning
-- every archival column in this schema carries.
-- ---------------------------------------------------------------------------

create function public.revoke_api_credential(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
begin
  if not public.is_platform_admin() then
    raise log 'revoke_api_credential denied: actor=% credential=%', v_actor, p_credential_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  select organization_id, company_id into v_org, v_company
  from public.api_credentials
  where id = p_credential_id and revoked_at is null;

  if not found then
    -- Already revoked, or never existed. One answer, and no complaint: a
    -- console that double-submits must not produce an error somebody
    -- investigates, and revoking twice is not a failure by any reading.
    return;
  end if;

  update public.api_credentials
     set revoked_at = now(), revoked_by = v_actor, updated_at = now()
   where id = p_credential_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'revoke_api_credential', 'api_credentials', p_credential_id, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id));
end;
$$;

comment on function public.revoke_api_credential(uuid) is
  'Block 15. Marks a key dead. Soft, because audit entries name the credential id and a delete would leave them pointing at nothing. Revoking an already-revoked key is silent rather than an error.';

revoke execute on function public.revoke_api_credential(uuid) from public;
grant  execute on function public.revoke_api_credential(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. list_api_credentials.
--
-- REVOKED KEYS ARE INCLUDED. "Was this key ever issued, and when did it die?"
-- is the question somebody asks during an incident, and a list that quietly
-- hides them cannot answer it.
--
-- token_hash is not among the returned columns and must never be added.
-- ---------------------------------------------------------------------------

create function public.list_api_credentials(p_company_id uuid)
returns table (
  id           uuid,
  name         text,
  token_prefix text,
  scopes       text[],
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_platform_admin() then
    raise log 'list_api_credentials denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: platform admin required' using errcode = '42501';
  end if;

  return query
    select c.id, c.name, c.token_prefix,
           -- The filter matters: a left join with no scopes yields one row with
           -- a null code, and array_agg would return {NULL} rather than an
           -- empty array -- which renders as a blank chip on the screen.
           coalesce(array_agg(s.permission_code order by s.permission_code)
                    filter (where s.permission_code is not null), '{}'::text[]),
           c.expires_at, c.last_used_at, c.revoked_at, c.created_at
      from public.api_credentials c
      left join public.api_credential_scopes s on s.credential_id = c.id
     where c.company_id = p_company_id
     group by c.id
     order by c.created_at desc;
end;
$$;

comment on function public.list_api_credentials(uuid) is
  'Block 15. Every key a Station has ever been issued, newest first, revoked ones included -- an incident is exactly when somebody needs to see a dead key. The hash is not among the columns and must never be added.';

revoke execute on function public.list_api_credentials(uuid) from public;
grant  execute on function public.list_api_credentials(uuid) to authenticated;
