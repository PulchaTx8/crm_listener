-- supabase/migrations/0181_service_link_worker_support.sql

-- Block 19a, Task 5. Doors the worker needs that no earlier task in this
-- block produced, discovered while wiring sendServiceLink and none of them
-- reopening a migration already shipped and reviewed (0177, 0178, 0179):
--
-- 1. finish_whatsapp_turn's whitelist. It closes "an inbound event whose
--    decision was taken in Node" (0070's own words) and today only knows five
--    outcomes, none of them a link. A link intent is exactly the same kind of
--    thing -- a decision Node made about a message -- so it is added to the
--    SAME door rather than growing a second one that would duplicate
--    finish_whatsapp_event's write and audit-log call for no reason.
--
-- 2. widget_link_send_context(company_id). mint_widget_link (0178) returns
--    only the raw code -- by design, D2's window means it cannot also hand
--    back a public_key on the window's null path, and 0178 is not reopened
--    for it. But buildServiceLink (Task 4) needs the installation's
--    public_key to address the URL, and widget_installations has its ACL
--    revoked (0159): "every reader is inside a SECURITY DEFINER body". This
--    is that body, and it returns the Station's system-message overrides in
--    the same call for the same reason whatsapp_prompt_context (0114) bundles
--    promotion and systemMessages -- one round trip, not two.
--
--    Fix round 1, Important #2: sendServiceLink (src/services/whatsapp-link.ts)
--    calls this BEFORE mint_widget_link, not after. mint_widget_link spends
--    D2's two-minute window the instant it answers a code; any failure past
--    that point -- this call included -- lands the retried turn INSIDE the
--    window, where the mint answers null and the event closes
--    'already_answered' having sent nothing. Calling the fallible read first
--    costs one wasted read on the ordinary path and removes the class.
--
-- 3. Fix round 1, Important #5 (owner's ruling): a SUSPENDED Station must not
--    keep being served by either door a link now passes through.
--    widget_installations resolved alone -- without joining companies and
--    organizations -- is the exact defect 0164 already named and fixed at
--    the widget's other three public doors, for the same reason its own
--    header gives: "the widget was the only external door in this product
--    that a suspended Station and a blocked Organization could both keep
--    walking through." widget_link_send_context gains the join here, at its
--    birth; mint_widget_link (0178) gains it by create or replace below,
--    because with #2's reordering, widget_link_send_context now runs FIRST
--    and is what actually stops a suspended Station before any code is
--    minted -- but mint_widget_link is reachable on its own (nothing stops a
--    future caller from using it directly) and must not be the one door in
--    this block that still trusts widget_installations.enabled alone.
--
--    THE REFUSAL IS P0002 ON BOTH, NOT 0164'S UNKNOWN_INSTALLATION -- and
--    that is a real difference from 0164, not an oversight. 0164's three
--    doors are public: an anonymous visitor or an unauthenticated code
--    attempt, where a distinct reason would publish a Station's billing
--    status to a prober. Both doors here are service_role-only, called from
--    inside the worker for an event ingest_whatsapp_event already resolved
--    against a real, matched integration -- there is no outside prober to
--    keep this fact from, and P0002 is the answer mint_widget_link already
--    gives for "no live installation" (0178), which a suspended Station now
--    is a second way of being.

create or replace function public.finish_whatsapp_turn(p_event_id uuid, p_outcome text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_outcome not in ('conversation', 'conversation_turn', 'refused',
                       'abandoned', 'no_conversation',
                       -- Block 19a: a link intent minted a code and enqueued
                       -- the one message that carries it, or minted nothing
                       -- because D2's two-minute window already answered this
                       -- listener for this purpose and the door said say
                       -- nothing. Neither carries a participation, exactly
                       -- like the five above.
                       'link_sent', 'already_answered') then
    raise exception 'not an outcome a turn may write: %', p_outcome
      using errcode = '22023';
  end if;

  return public.finish_whatsapp_event(p_event_id, p_outcome, null, null);
end;
$$;

comment on function public.finish_whatsapp_turn(uuid, text) is
  'Closes an inbound event whose decision was taken in Node: a conversation opened, a turn taken, a refusal, an abandonment, a message from somebody who is not mid-conversation, or (Block 19a) a link intent sent or withheld by D2''s window. The whitelist is the point -- an outcome carrying a participation is written by complete_whatsapp_conversation inside the transaction that writes the entry, so the two cannot disagree, and this door cannot be used to claim one happened. Everything else about the row is finish_whatsapp_event''s (0062), which stays private.';

create or replace function public.widget_link_send_context(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations%rowtype;
begin
  -- 0164's join, at this door's birth rather than bolted on later: a
  -- SUSPENDED Station (companies.status) or a BLOCKED Organization
  -- (organizations.suspended_at) answers exactly as no installation at all
  -- does, below. `w.*` because the from-list now has three relations.
  select w.* into v_install
    from public.widget_installations w
    join public.companies c
      on c.id = w.company_id
     and c.deleted_at is null
     and c.status = 'active'
    join public.organizations o
      on o.id = w.organization_id
     and o.suspended_at is null
   where w.company_id = p_company_id
     and w.enabled
     and w.deleted_at is null;

  if not found then
    -- One reason for "no installation", "disabled", "suspended Station" and
    -- "blocked Organization" alike: this door is service_role-only, called
    -- from inside the worker rather than by an outside prober, so there is
    -- nobody here for a distinct reason to inform (see this file's header).
    raise exception 'this Station has no live widget installation' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'publicKey', v_install.public_key,
    -- This Station's own wording, per text (D2) -- the same query
    -- whatsapp_prompt_context runs, scoped by company_id directly rather
    -- than through a promotion, because a MUSIC or MENU link names none.
    'systemMessages', coalesce((
      select jsonb_object_agg(t.key::text, t.body)
      from public.station_message_templates t
      where t.company_id = p_company_id
        and t.deleted_at is null), '{}'::jsonb)
  );
end;
$$;

revoke execute on function public.widget_link_send_context(uuid) from public, anon, authenticated;
grant execute on function public.widget_link_send_context(uuid) to service_role;

comment on function public.widget_link_send_context(uuid) is
  'Block 19a. What sendServiceLink needs and mint_widget_link (0178) does not carry: the installation''s public_key, so buildServiceLink can address the URL, and this Station''s own wording for the three LINK_* texts (D2, same per-text/per-Station rule as whatsapp_prompt_context). SECURITY DEFINER because widget_installations has its ACL revoked (0159) -- every reader is inside a body like this one. Fix round 1: called BEFORE mint_widget_link, not after (Important #2) -- minting spends D2''s two-minute window the instant it answers a code, and any failure downstream of that, including this call, would otherwise land a retried turn inside the window and close it ''already_answered'' having sent nothing. Joins companies and organizations (0164, Important #5): a SUSPENDED Station or a BLOCKED Organization refuses P0002 here, before a code is ever minted, exactly as an absent or disabled installation does -- one reason for all four, because the caller is the worker and there is no outside prober a distinct reason would matter to. Granted to service_role only.';

-- ---------------------------------------------------------------------------
-- mint_widget_link (0178), CREATE OR REPLACE with the same 0164 join added.
-- The signature and return type are unchanged, so the ACL 0178 granted
-- survives; the comment is repeated because a replaced function keeps its
-- old one otherwise, and that comment described a door that trusted
-- widget_installations.enabled alone.
--
-- Reproduced from 0178 whole rather than patched by a diff description, the
-- same rule 0179's own header states for ingest_whatsapp_event: retyping
-- risks silently reverting something. Only the SELECT that resolves
-- v_install changes; the window logic, the code generation and the insert
-- are 0178's, unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.mint_widget_link(
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
  -- 0164's join: see this file's header for why P0002 covers a suspended
  -- Station and a blocked Organization the same way it already covered an
  -- absent or disabled installation.
  select w.* into v_install
    from public.widget_installations w
    join public.companies c
      on c.id = w.company_id
     and c.deleted_at is null
     and c.status = 'active'
    join public.organizations o
      on o.id = w.organization_id
     and o.suspended_at is null
   where w.company_id = p_company_id
     and w.enabled
     and w.deleted_at is null;

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
  'Block 19a (D2). A single-use code, good for fifteen minutes, or NULL when this listener was already answered for this exact purpose inside the last two minutes -- NULL means "say nothing, they already have a working link", and is the whole of the protection against somebody sending the hashtag five times. Stores only the SHA-256; the raw code is returned once and never readable again, which is why the window answers NULL rather than repeating it. Fix round 1 (Important #5, 0164): now joins companies and organizations, so a SUSPENDED Station or a BLOCKED Organization refuses P0002 exactly as an absent or disabled installation already did -- previously this door trusted widget_installations.enabled alone, the one gap 0164''s fix wave had already closed at the widget''s other three public doors. In the ordinary call order (src/services/whatsapp-link.ts calls widget_link_send_context first, fix round 1 #2) that join is redundant with the one already run there; it is not redundant for any OTHER caller, present or future, of this function directly. Granted to service_role only: the caller is the worker.';
