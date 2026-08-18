-- supabase/migrations/0231_withdraw_marketing_by_phone.sql

-- Block 29c, fix round 1, F7 (amended in fix round 2, F8 -- see below). The
-- cold-path stop word: a listener texting PARAR/CANCELAR/DESCADASTRAR with NO
-- live conversation open. Task 4's report named this unimplemented and why --
-- the worker holds no user identity to resolve a phone through, and every
-- existing resolution path (apply_member_lookup, find_member_by_identifier)
-- is revoked from service_role. This is that door.
--
-- SECURITY DEFINER, service_role only: the same shape enqueue_whatsapp_outbound
-- (0071) already uses for the identical reason -- the engine that decides to
-- call this is TypeScript, with no auth.uid() of its own, so it gets a
-- door rather than a grant on the tables underneath.
--
-- RESOLUTION GOES THROUGH THE SHARED CORE, NEVER A RE-IMPLEMENTATION.
-- apply_member_lookup (0061) is what find_member_by_identifier and
-- ingest_whatsapp_event (0179) already resolve every phone through, built on
-- phone_normalized's own normalize_phone (0031) -- matching phone_normalized
-- by hand here would be the exact drift 0061's own header warns against.
-- whatsapp_local_phone (0062) strips a Brazilian country code and is tried
-- FIRST, for the same reason ingest_whatsapp_event tries it first: a
-- WhatsApp-registered listener's members.phone holds the LOCAL form
-- (apply_member_creation is always called with it), so the delivered form
-- alone would miss every listener this bot itself registered.
--
-- F8: RETURNS uuid, NOT boolean, AND THIS IS AN AMENDMENT IN PLACE, NOT A NEW
-- MIGRATION. F7's boolean told the caller "withdrew" from "unknown number"
-- and nothing else, which left the cold-path reply unable to speak a
-- Station's own MARKETING_STOPPED wording -- a Station that rewrote that
-- sentence would see it change in the conversation and not on this path,
-- which is worse than either behaviour alone. The Station's own id carries
-- strictly more information at the same cost, and lets the caller resolve
-- the override exactly as the in-conversation path already does. Amended
-- rather than replaced by a new migration because this branch has never been
-- pushed and no database anywhere has run 0231 yet -- the rule against
-- editing a migration in place protects a database that ran the old body and
-- will never run this one; none exists here.
create or replace function public.withdraw_marketing_by_phone(
  p_integration_id uuid,
  p_phone          text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_integ  public.integrations%rowtype;
  v_local  text;
  v_member uuid;
  v_id     uuid;
begin
  select * into v_integ
  from public.integrations
  where id = p_integration_id and enabled and deleted_at is null;

  if not found then
    raise exception 'integration not found or switched off: %', p_integration_id
      using errcode = 'P0002';
  end if;

  v_local := public.whatsapp_local_phone(p_phone);

  -- Local form first, delivered form second -- the same order and the same
  -- reason ingest_whatsapp_event already tries them (its own comment: the
  -- local-then-delivered pair), so a listener this bot has resolved once
  -- before is resolved the identical way here.
  v_member := public.apply_member_lookup(v_integ.organization_id, v_local, null, null, null);
  if v_member is null and p_phone is distinct from v_local then
    v_member := public.apply_member_lookup(v_integ.organization_id, p_phone, null, null, null);
  end if;

  -- No member at all, OR a member this STATION never linked -- spec D3's
  -- scoping, and the two are answered identically on purpose: a stranger and
  -- a listener of a DIFFERENT Station in the same group get the same null,
  -- because nothing was withdrawn HERE either way, and telling either one
  -- "removed" would describe an action this call never took.
  -- member_linked_to_company (0034) is the same guard record_member_consent
  -- itself is built on.
  if v_member is null or not public.member_linked_to_company(v_member, v_integ.company_id) then
    return null;
  end if;

  -- NOT record_member_consent (0034): that function is gated on
  -- has_permission('members.edit', ...), which a caller with no auth.uid()
  -- always fails. This is the same insert, verbatim, minus the operator gate
  -- a bot has no identity to pass -- append-only, a withdrawal is a NEW row
  -- (0032's own rule), never an edit of an earlier one. origin names THIS
  -- path specifically, so an audit can tell a stop word apart from an
  -- unsubscribe-link click and from the in-conversation tap ('conversation',
  -- Task 4's own record_member_consent call).
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin)
  values
    (v_integ.organization_id, v_member, v_integ.company_id, 'whatsapp_marketing', false, 'stop_word')
  returning id into v_id;

  -- actor_id null is how a bot-originated write is told from an operator's
  -- -- the same rule finish_whatsapp_event (0062) already states for its own
  -- audit row.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'withdraw_marketing_by_phone', 'member_consents', v_id,
     v_integ.organization_id, v_integ.company_id,
     jsonb_build_object('member_id', v_member, 'consent_id', v_id));

  -- F8: the Station, not a bare true -- so the caller can resolve THIS
  -- Station's own MARKETING_STOPPED wording rather than the code default.
  return v_integ.company_id;
end;
$$;

revoke execute on function public.withdraw_marketing_by_phone(uuid, text) from public;
grant execute on function public.withdraw_marketing_by_phone(uuid, text) to service_role;

comment on function public.withdraw_marketing_by_phone(uuid, text) is
  'Block 29c, F7/F8. The cold-path stop word: PARAR/CANCELAR/DESCADASTRAR with no live conversation to answer. Resolves the sender through apply_member_lookup (0061) -- local form then delivered form, the same order and shared core ingest_whatsapp_event (0179) already resolves every listener through, never a re-implementation of phone_normalized''s own normalize_phone (0031). Scoped to the Station THIS integration belongs to (spec D3): a member this Station never linked answers null, identically to an unknown phone, because nothing was withdrawn HERE either way -- the caller must not tell either one "removed". Writes member_consents (whatsapp_marketing, granted=false, origin=''stop_word'') directly rather than through record_member_consent, which is gated on has_permission and would refuse a caller with no auth.uid(). Returns the STATION''S id rather than a boolean (F8): the caller needs it to resolve the Station''s own MARKETING_STOPPED wording the same way the in-conversation path already does, not only to know whether to reply at all. SECURITY DEFINER, service_role only -- the worker holds no user identity, so this is a door rather than a grant, the same shape enqueue_whatsapp_outbound (0071) already uses.';

-- Fix round 3, F9 (Critical). THE IN-CONVERSATION COUNTERPART, ADDED HERE
-- RATHER THAN AS A NEW MIGRATION for the same reason F8 amended the function
-- above in place: this branch has never been pushed and no database anywhere
-- has run 0231 yet.
--
-- src/services/conversation.ts's recordMarketingAnswer called
-- record_member_consent (0034) directly, on the service-role worker client.
-- That RPC is granted to authenticated ONLY (0034's own grant list) and its
-- body gates on has_permission, which reads auth.uid() -- null for this
-- caller. The call fails on EVERY invocation in production: the Yes/No tap
-- and the stop word typed at the marketing_consent step both throw before
-- the MARKETING_STOPPED reply enqueues or the state clears, so the event
-- retries until its claim goes stale. Six green gates missed it because
-- nothing in this codebase's unit tests can see a missing grant, only a
-- pgTAP or isolation case can -- and the fake RPC client those unit tests use
-- answered success for any function name, this one included (fixed
-- separately in tests/unit/conversation-turn.test.ts, alongside this).
--
-- SAME SHAPE AS withdraw_marketing_by_phone ABOVE, because the underlying
-- problem is identical: a service-role caller with no auth.uid() needs a
-- door, not a grant, onto member_consents. The one difference between the
-- two is WHO is already resolved -- this door's caller already knows the
-- member and the Station from a live conversation, so there is no phone to
-- resolve and no local/delivered ambiguity to walk.
create or replace function public.record_conversation_marketing_answer(
  p_member_id    uuid,
  p_company_id   uuid,
  p_granted      boolean,
  p_promotion_id uuid default null
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
  -- Same integrity checks record_member_consent (0034) itself makes, minus
  -- the has_permission gate this caller could never pass: the listener must
  -- still be live (not archived, not erased) and linked to the Station the
  -- answer is about.
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null and anonymized_at is null;

  if not found then
    raise exception 'listener not found, or has been anonymised: %', p_member_id
      using errcode = 'P0002';
  end if;

  if not public.member_linked_to_company(p_member_id, p_company_id) then
    raise exception 'this listener is not linked to that station: %', p_company_id
      using errcode = 'P0002';
  end if;

  -- origin is fixed to 'conversation' -- never a parameter -- which is the
  -- one thing that tells this door's rows apart from withdraw_marketing_by_
  -- phone's own 'stop_word' rows in an audit. Append-only, the same rule
  -- record_member_consent states for itself: a withdrawal is a NEW row,
  -- never an edit of an earlier one.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, promotion_id)
  values
    (v_org, p_member_id, p_company_id, 'whatsapp_marketing', p_granted, 'conversation', p_promotion_id)
  returning id into v_id;

  -- actor_id null, the same convention withdraw_marketing_by_phone and
  -- finish_whatsapp_event (0062) already use for a bot-originated write.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'record_conversation_marketing_answer', 'member_consents', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'consent_id', v_id));

  return v_id;
end;
$$;

revoke execute on function public.record_conversation_marketing_answer(uuid, uuid, boolean, uuid) from public;
grant execute on function public.record_conversation_marketing_answer(uuid, uuid, boolean, uuid) to service_role;

comment on function public.record_conversation_marketing_answer(uuid, uuid, boolean, uuid) is
  'Block 29c, fix round 3, F9. The in-conversation counterpart to withdraw_marketing_by_phone above: records a whatsapp_marketing answer (a Yes/No tap, or a stop word typed AT the marketing_consent step) for a member and Station a live conversation has ALREADY resolved. NOT record_member_consent (0034): that RPC is granted to authenticated only and gates on has_permission, both unreachable for the service-role worker that calls this (auth.uid() is null) -- every call through record_member_consent failed in production before this door existed. Same integrity checks minus the operator gate: the listener must be live (not deleted/anonymised) and linked to the Station (member_linked_to_company). origin is fixed to ''conversation'', the one difference from the cold-path door''s ''stop_word''. SECURITY DEFINER, service_role only.';
