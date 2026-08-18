-- supabase/migrations/0232_unsubscribe_tokens.sql

-- Block 29c, Task 5. The token behind "descadastrar" in a campaign e-mail.
--
-- SHAPED ON widget_link_tokens (0178), retention in 0183, and for the same
-- reasons: the hash is stored and never the token, because a table read is not
-- a way to act as somebody; and the URL carries a random value rather than an
-- internal id, because an id in a link is an invitation to change it.
--
-- ONE YEAR, and the asymmetry is deliberate. This token grants exactly one
-- capability: stopping mail. Leaked, somebody unsubscribes another person --
-- low harm, and reversible by re-subscribing. A short expiry instead means a
-- listener who opens the mail a fortnight later cannot leave, which is the path
-- to a formal complaint rather than a quiet unsubscribe.
create table public.unsubscribe_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  member_id       uuid not null references public.members (id),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  campaign_label  text,
  expires_at      timestamptz not null default now() + interval '1 year',
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint unsubscribe_tokens_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id)
);

alter table public.unsubscribe_tokens enable row level security;

-- NO POLICY, deliberately. Nothing reads this table as a user: the public page
-- reaches it only through consume_unsubscribe_token below, which is SECURITY
-- DEFINER precisely so an unauthenticated visitor can spend a token without
-- being able to read the table it lives in.
comment on table public.unsubscribe_tokens is
  'Block 29c. One-time tokens behind the unsubscribe link in a campaign e-mail. Hashed like widget_link_tokens (0178); RLS on with no policy, because the only reachable path is consume_unsubscribe_token.';

create index unsubscribe_tokens_sweep_idx on public.unsubscribe_tokens (expires_at);

create function public.issue_unsubscribe_token(
  p_member_id      uuid,
  p_company_id     uuid,
  p_token_hash     text,
  p_campaign_label text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  select organization_id into v_org from public.companies where id = p_company_id and deleted_at is null;
  if v_org is null then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  insert into public.unsubscribe_tokens
    (organization_id, company_id, member_id, token_hash, campaign_label)
  values (v_org, p_company_id, p_member_id, p_token_hash, p_campaign_label)
  returning id into v_id;

  return v_id;
end;
$$;

create function public.consume_unsubscribe_token(
  p_token_hash   text,
  p_all_stations boolean default false
)
returns table (member_id uuid, company_id uuid, stations_left int)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tok   public.unsubscribe_tokens;
  v_count int := 0;
begin
  -- One statement claims it: `consumed_at is null` inside the UPDATE means two
  -- simultaneous clicks cannot both win, which a SELECT-then-UPDATE would allow.
  update public.unsubscribe_tokens t
     set consumed_at = now()
   where t.token_hash = p_token_hash
     and t.consumed_at is null
     and t.expires_at > now()
  returning t.* into v_tok;

  -- ONE ANSWER FOR THREE CASES -- unknown, spent, expired. An attacker probing
  -- tokens learns nothing from the difference, and the listener sees the same
  -- page either way.
  if v_tok.id is null then
    raise exception 'no usable token' using errcode = 'P0002';
  end if;

  if p_all_stations then
    -- Exactly the Stations this listener is linked to, and no more: a group
    -- with five Stations must not become five withdrawals for a listener who
    -- only ever joined two.
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    select l.organization_id, v_tok.member_id, l.company_id, ct, false,
           'unsubscribe-all:' || coalesce(v_tok.campaign_label, '')
      from public.member_company_links l
      cross join (values ('email_marketing'::public.member_consent_type),
                         ('whatsapp_marketing'::public.member_consent_type)) as t(ct)
     where l.member_id = v_tok.member_id
       and l.organization_id = v_tok.organization_id;
    get diagnostics v_count = row_count;
  else
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    values (v_tok.organization_id, v_tok.member_id, v_tok.company_id, 'email_marketing', false,
            'unsubscribe:' || coalesce(v_tok.campaign_label, ''));
    v_count := 1;
  end if;

  return query select v_tok.member_id, v_tok.company_id, v_count;
end;
$$;

revoke execute on function public.issue_unsubscribe_token(uuid, uuid, text, text) from public;
grant execute on function public.issue_unsubscribe_token(uuid, uuid, text, text) to authenticated;

-- anon HOLDS THIS ONE, and it is the only door in this project that it holds
-- for a write. The visitor clicking "descadastrar" has no account and never
-- will; the alternative is asking somebody to log in before they may stop
-- receiving mail, which is the pattern that produces complaints instead.
revoke execute on function public.consume_unsubscribe_token(text, boolean) from public;
grant execute on function public.consume_unsubscribe_token(text, boolean) to anon, authenticated;
