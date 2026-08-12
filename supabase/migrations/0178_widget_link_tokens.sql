-- supabase/migrations/0178_widget_link_tokens.sql

-- Block 19a (D2). The addressed door a hashtag is answered with.
--
-- A TABLE RATHER THAN A SIGNED STRING, and the spec's section 4 argues it: single
-- use is state -- there is nothing to burn in a token nobody wrote down -- and
-- the two-minute resend window needs the same state. The widget SESSION stays
-- signed and stateless, because it needs neither.

create type public.widget_link_purpose as enum ('MUSIC', 'MENU', 'PROMOTION');

create table public.widget_link_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  company_id      uuid not null,
  member_id       uuid not null references public.members (id),
  public_key      text not null,
  purpose         public.widget_link_purpose not null,
  promotion_id    uuid references public.promotions (id),
  -- THE HASH, never the code. The raw value exists in one WhatsApp message and
  -- in one URL, and nowhere else -- the same rule api_credentials (0148) holds,
  -- for the same reason: a table read is not a way to act as somebody.
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint widget_link_tokens_company_org_fk
    foreign key (company_id, organization_id)
    references public.companies (id, organization_id),

  -- A promotion link names a promotion; the other two do not. Stated here so a
  -- caller cannot mint a PROMOTION link that opens the menu instead.
  constraint widget_link_tokens_purpose_shape check (
    (purpose = 'PROMOTION' and promotion_id is not null)
    or (purpose <> 'PROMOTION' and promotion_id is null)
  )
);

-- The window's lookup: this listener, this purpose, still live.
create index widget_link_tokens_window_idx
  on public.widget_link_tokens (member_id, purpose, created_at desc)
  where consumed_at is null;

alter table public.widget_link_tokens enable row level security;
revoke all on public.widget_link_tokens from anon, authenticated;

comment on table public.widget_link_tokens is
  'Block 19a. One row per link a hashtag was answered with: who it is for, what it opens, and whether it has been used. RLS on with NO POLICY and the ACL revoked -- it names a listener, so it is reachable only from inside a SECURITY DEFINER body, the rule every listener-bearing table here follows. Rows past their expiry are removed by the retention sweep (Block 11a), never by a reader.';

create function public.mint_widget_link(
  p_company_id   uuid,
  p_member_id    uuid,
  p_purpose      public.widget_link_purpose,
  p_promotion_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations%rowtype;
  v_code    text;
  v_live    text;
begin
  select * into v_install
    from public.widget_installations
   where company_id = p_company_id
     and enabled
     and deleted_at is null;

  if not found then
    raise exception 'this Station has no live widget installation' using errcode = 'P0002';
  end if;

  -- D2's window: a listener who sends the hashtag again inside two minutes
  -- gets no second row and no second message. The row below stores only the
  -- SHA-256 of the code (token_hash), never the code itself, so there is no
  -- raw value left anywhere to hand back on a repeat -- the window cannot
  -- answer with "the same code" even in principle, only with nothing at all.
  -- It answers NULL, and the caller (src/services/whatsapp-link.ts) reads
  -- NULL as "this listener already has a working link -- send nothing",
  -- which is the whole of what the window is for.
  select token_hash into v_live
    from public.widget_link_tokens
   where member_id = p_member_id
     and purpose = p_purpose
     and promotion_id is not distinct from p_promotion_id
     and consumed_at is null
     and expires_at > now()
     and created_at > now() - interval '2 minutes'
   order by created_at desc
   limit 1;

  if v_live is not null then
    return null;
  end if;

  v_code := encode(extensions.gen_random_bytes(24), 'base64');
  -- URL-safe, and without padding: this value goes in a query string.
  v_code := replace(replace(rtrim(v_code, '='), '+', '-'), '/', '_');

  insert into public.widget_link_tokens
    (organization_id, company_id, member_id, public_key, purpose, promotion_id,
     token_hash, expires_at)
  values
    (v_install.organization_id, p_company_id, p_member_id, v_install.public_key,
     p_purpose, p_promotion_id,
     encode(extensions.digest(v_code, 'sha256'), 'hex'), now() + interval '15 minutes');

  return v_code;
end;
$$;

comment on function public.mint_widget_link is
  'Block 19a (D2). A single-use code, good for fifteen minutes, or NULL when this listener was already answered for this exact purpose inside the last two minutes -- NULL means "say nothing, they already have a working link", and is the whole of the protection against somebody sending the hashtag five times. Stores only the SHA-256; the raw code is returned once and never readable again, which is why the window answers NULL rather than repeating it. Refuses a Station with no live installation. Granted to service_role only: the caller is the worker.';

create function public.consume_widget_link(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.widget_link_tokens%rowtype;
begin
  -- ONE STATEMENT DECIDES IT. The predicate carries `consumed_at is null`, so
  -- two browsers opening the same link at the same instant race inside Postgres
  -- and exactly one row is returned -- the loser sees zero rows, not a stale
  -- read. A select-then-update would let both through.
  update public.widget_link_tokens
     set consumed_at = now()
   where token_hash = encode(extensions.digest(coalesce(p_code, ''), 'sha256'), 'hex')
     and consumed_at is null
     and expires_at > now()
  returning * into v_row;

  if not found then
    -- One answer for expired, used and unknown, on purpose: the caller is a
    -- route handler serving a public URL and has nothing useful to do with the
    -- difference, while a distinct answer per cause hands a prober a way to
    -- tell them apart. The screen says "ask again", which is true of all three.
    return jsonb_build_object('ok', false, 'reason', 'unusable');
  end if;

  -- Task 9, fix round 1, C1. THE SAME JOIN 0164 ALREADY CARRIES AT THE
  -- WIDGET'S OTHER PUBLIC DOORS, AND 0181 ALREADY CARRIES AT
  -- mint_widget_link AND widget_link_send_context -- missing here until
  -- now, which was Task 5's own omission and not a later regression: this
  -- function was written before 0181 existed, and 0181's header explains
  -- carrying the join into mint_widget_link by CREATE OR REPLACE rather
  -- than reopening this file, precisely because "0178... has never been
  -- applied outside local resets" was not yet true of the review that
  -- wrote it. It is true now, so this one is fixed in place instead of by
  -- a fourth copy of the same join in a later migration.
  --
  -- WITHOUT IT: a Station suspended, or an Organization blocked, between
  -- the mint and the tap left `consume_widget_link` answering `ok:true` --
  -- checking only `widget_installations.enabled`, which a suspension never
  -- touches (0164's own point) -- so the route minted a session and
  -- redirected to the widget WITHOUT `link=expired`. `page.tsx` then found
  -- no installation through `installationExists` (which DOES join
  -- `companies`/`organizations`, via `widget_frame_context`), `linkExpired`
  -- was false, and it called `notFound()`: the plain 404 this whole block
  -- exists to forbid a WhatsApp-minted link from ever producing -- and
  -- because the UPDATE above had already burned the code, a second tap
  -- could only ever show "ask again", with nothing anywhere pointing at
  -- the real cause.
  if not exists (
    select 1
      from public.widget_installations w
      join public.companies c
        on c.id = w.company_id
       and c.deleted_at is null
       and c.status = 'active'
      join public.organizations o
        on o.id = w.organization_id
       and o.suspended_at is null
     where w.company_id = v_row.company_id
       and w.enabled
       and w.deleted_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'unavailable');
  end if;

  return jsonb_build_object(
    'ok',              true,
    'public_key',      v_row.public_key,
    'company_id',      v_row.company_id,
    'organization_id', v_row.organization_id,
    'member_id',       v_row.member_id,
    'purpose',         v_row.purpose,
    'promotion_id',    v_row.promotion_id);
end;
$$;

comment on function public.consume_widget_link is
  'Block 19a (D2). Trades a code for the claims a widget session is minted from, and burns it in the same statement -- the UPDATE carries `consumed_at is null` in its predicate, so two simultaneous opens have exactly one winner and the loser reads no row rather than a stale one. Expired, used and unknown are ONE answer: the caller serves a public URL and the difference would only help somebody probing. A Station switched off, SUSPENDED, or whose Organization has been BLOCKED since the code was minted refuses separately as unavailable (Task 9 fix round 1, C1, joining companies and organizations the same way 0181''s mint_widget_link and widget_link_send_context already do) -- because those are all configurations an operator can act on, and because leaving out the join here let a suspended Station''s link mint a session anyway and land the visitor on the plain 404 this whole block exists to prevent.';

revoke execute on function public.mint_widget_link(uuid, uuid, public.widget_link_purpose, uuid) from public, anon, authenticated;
revoke execute on function public.consume_widget_link(text) from public, anon, authenticated;
grant execute on function public.mint_widget_link(uuid, uuid, public.widget_link_purpose, uuid) to service_role;
grant execute on function public.consume_widget_link(text) to service_role;
