-- supabase/migrations/0231_withdraw_marketing_by_phone.sql

-- Block 29c, fix round 1, F7. The cold-path stop word: a listener texting
-- PARAR/CANCELAR/DESCADASTRAR with NO live conversation open. Task 4's
-- report named this unimplemented and why -- the worker holds no user
-- identity to resolve a phone through, and every existing resolution path
-- (apply_member_lookup, find_member_by_identifier) is revoked from
-- service_role. This is that door.
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
create or replace function public.withdraw_marketing_by_phone(
  p_integration_id uuid,
  p_phone          text
)
returns boolean
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
  -- a listener of a DIFFERENT Station in the same group get the same false,
  -- because nothing was withdrawn HERE either way, and telling either one
  -- "removed" would describe an action this call never took.
  -- member_linked_to_company (0034) is the same guard record_member_consent
  -- itself is built on.
  if v_member is null or not public.member_linked_to_company(v_member, v_integ.company_id) then
    return false;
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

  return true;
end;
$$;

revoke execute on function public.withdraw_marketing_by_phone(uuid, text) from public;
grant execute on function public.withdraw_marketing_by_phone(uuid, text) to service_role;

comment on function public.withdraw_marketing_by_phone(uuid, text) is
  'Block 29c, F7. The cold-path stop word: PARAR/CANCELAR/DESCADASTRAR with no live conversation to answer. Resolves the sender through apply_member_lookup (0061) -- local form then delivered form, the same order and shared core ingest_whatsapp_event (0179) already resolves every listener through, never a re-implementation of phone_normalized''s own normalize_phone (0031). Scoped to the Station THIS integration belongs to (spec D3): a member this Station never linked answers false, identically to an unknown phone, because nothing was withdrawn HERE either way -- the caller must not tell either one "removed". Writes member_consents (whatsapp_marketing, granted=false, origin=''stop_word'') directly rather than through record_member_consent, which is gated on has_permission and would refuse a caller with no auth.uid(). SECURITY DEFINER, service_role only -- the worker holds no user identity, so this is a door rather than a grant, the same shape enqueue_whatsapp_outbound (0071) already uses.';
