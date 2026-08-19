-- supabase/migrations/0249_campaign_test_send_audit.sql

-- Block 29d-2, Task 7 fix round 1 (F2, Important). A test send is a send.
--
-- The spec's own reason for splitting messaging.send from messaging.manage
-- ("approving a send to twenty thousand people is not the act of drafting
-- one", restated in 0243's own header) applies to a test send exactly: it
-- spends real provider traffic (a paid WhatsApp template send, or a real
-- SMTP delivery) to an address the operator typed, and until this migration
-- it was reachable on messaging.view alone, with no trace left anywhere.
--
-- TWO THINGS THIS DOOR DOES, IN ONE CALL, AND ONE ROUND TRIP IS THE POINT.
-- `public.audit_logs` has RLS with no INSERT grant for `authenticated` at all
-- (0006: "revoke all... from anon, authenticated", INSERT is
-- service_role-only) -- every write to it in this project happens from
-- inside a SECURITY DEFINER body, which is what this function is for. The
-- messages/campaigns/actions.ts Server Action calls this BEFORE it asks a
-- provider to send anything, and this door's own gate is the ONLY permission
-- check a test send goes through -- checked here rather than a second time in
-- TypeScript first, because a 42501 from here already means exactly one
-- thing (messaging.send is missing) and a courtesy check ahead of it would
-- only be a second place for that one fact to be asked.
--
-- THE DESTINATION IS RECORDED MASKED (whole-branch review, R35). It used to
-- be recorded in the clear, on the argument that create_campaign's own rule
-- ("No personal value in the detail... ids and counts only, never an
-- address", 0243) protects a MEMBER's PII, cross-referenced elsewhere by
-- member_id, while a test send's destination belongs to no member record --
-- it is whatever the operator typed, often their own number or inbox.
-- "Often" is the word that broke it: nothing stops an operator typing a
-- listener's real number, and the argument had no answer for the times it is
-- not their own. audit_logs is the ONE table sweep_retention's own comment
-- says is kept for ever, and that anonymize_member (0034, last replaced in
-- 0250) only ever ADDS a row to rather than clears anything in -- so an
-- address written here has no erasure path at all, and a listener who
-- exercises erasure would still be reachable from this row.
--
-- Masking keeps everything this door exists to answer -- who test-sent, when,
-- from which Station, on which channel, against which list and template, and
-- which address FAMILY it went to -- and drops the one thing that makes the
-- row a permanent contact record. WHATSAPP keeps the last four digits, the
-- same cut list_music_requests (0191) already makes for a listener's number
-- on a screen (`right(normalize_phone(...), 4)`), so the two agree about what
-- "a phone number, reduced" means in this system. EMAIL keeps the first
-- character and the domain, which is what tells an auditor whether a test
-- went to the Station's own inbox or to somebody else's.
--
-- THE MASK IS APPLIED HERE, NOT BY THE CALLER. A caller that masked before
-- calling would leave this door still able to store a clear address for
-- anybody who called it differently later; masking inside the definer body
-- means no caller can write one at all.
--
-- WRITTEN BEFORE THE SEND IS ATTEMPTED, not after it succeeds. The
-- application layer (testSendCampaignAction) calls this first and only
-- proceeds to call a provider if it does not raise -- the same order
-- create_campaign itself writes its own audit row at creation, not at
-- eventual delivery. A test send that failed at the provider is still a
-- real outbound attempt to a real address, and belongs in the trail either
-- way.
create function public.record_campaign_test_send(
  p_company_id  uuid,
  p_channel     public.message_channel,
  p_list_id     uuid,
  p_template_id uuid,
  p_destination text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_digits text;
  v_local  text;
  v_domain text;
  v_masked text;
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Permission before the write, the house order (0199's own comment,
  -- restated by create_campaign, 0243): a caller who may not approve a send
  -- learns that, and the audit trail gains no row for a test send that was
  -- refused before it could happen.
  if not public.has_permission('messaging.send', p_company_id) then
    raise log 'record_campaign_test_send denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: messaging.send required' using errcode = '42501';
  end if;

  -- The mask itself. Built from the RAW string the operator typed, because
  -- that is what this door is given and what the trail is about -- the
  -- application layer's own WHATSAPP normalisation (digits only) happens
  -- after this call, so masking here cannot depend on it having run.
  if p_channel = 'WHATSAPP' then
    v_digits := regexp_replace(coalesce(p_destination, ''), '[^0-9]', '', 'g');
    -- Four digits are only worth keeping when there is more than that to
    -- hide: a "number" of four digits or fewer would be stored whole by a
    -- bare right(), which is the one outcome this mask exists to prevent.
    v_masked := case when length(v_digits) > 4 then '****' || right(v_digits, 4) else '****' end;
  else
    v_local  := split_part(coalesce(p_destination, ''), '@', 1);
    v_domain := split_part(coalesce(p_destination, ''), '@', 2);
    -- An address with no '@' at all (split_part returns '' for the domain)
    -- is not an e-mail this system would have sent to, and there is nothing
    -- here worth half-keeping: mask the lot rather than publish a fragment
    -- of a string whose shape is unknown.
    v_masked := case
                  when v_domain = '' or v_local = '' then '****'
                  else left(v_local, 1) || '****@' || v_domain
                end;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'campaign_test_send', 'send_lists', p_list_id, v_org, p_company_id,
     jsonb_build_object(
       'channel', p_channel,
       'template_id', p_template_id,
       -- NAMED destination_masked, not destination: a reader who greps this
       -- trail for a whole number must find nothing rather than find a key
       -- whose name promises the address and whose value is not it.
       'destination_masked', v_masked
     ));
end;
$$;

revoke execute on function public.record_campaign_test_send(
  uuid, public.message_channel, uuid, uuid, text
) from public;
grant execute on function public.record_campaign_test_send(
  uuid, public.message_channel, uuid, uuid, text
) to authenticated;

comment on function public.record_campaign_test_send(
  uuid, public.message_channel, uuid, uuid, text
) is
  'The one write a campaign test send performs (Task 7 fix round 1, F2): re-checks messaging.send (the same permission create_campaign/cancel_campaign gate on, and the one the campaigns screen''s own Send Test button now checks before rendering) and writes an audit_logs row naming the actor, the Station, the channel, the list and template the sample was drawn from, and the destination the operator typed -- MASKED (whole-branch review, R35), as detail -> destination_masked: the last four digits for WHATSAPP, the first character and the domain for EMAIL. It was stored in the clear until that review, on the argument that the address belongs to no member record for create_campaign''s own rule (0034) to protect -- true of an operator testing against their own inbox, and not true of one who types a listener''s number, which nothing stops. audit_logs is the one table sweep_retention''s own comment calls kept for ever, and the one anonymize_member only ever adds a row to rather than clears anything in, so an address written here would have had no erasure path at all. The mask is applied inside this body rather than by the caller, so no caller can store a clear address by calling differently. Called from messages/campaigns/actions.ts before the provider is ever asked to send, so a refused or failed test send still leaves the attempt in the trail. Refuses 42501 for a caller lacking messaging.send and P0002 for an unknown Station.';
