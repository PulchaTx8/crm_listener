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
-- THE DESTINATION IS RECORDED IN THE CLEAR, unlike create_campaign's own
-- audit row (0243's own comment: "No personal value in the detail... ids and
-- counts only, never an address"). That rule protects a MEMBER's own PII,
-- cross-referenced elsewhere by member_id; a test send's destination belongs
-- to no member record at all -- it is whatever the operator typed, often
-- their own number or inbox -- and "who sent what to which address" is
-- exactly what this door exists to answer.
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
  v_actor uuid := auth.uid();
  v_org   uuid;
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

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'campaign_test_send', 'send_lists', p_list_id, v_org, p_company_id,
     jsonb_build_object(
       'channel', p_channel,
       'template_id', p_template_id,
       'destination', p_destination
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
  'The one write a campaign test send performs (Task 7 fix round 1, F2): re-checks messaging.send (the same permission create_campaign/cancel_campaign gate on, and the one the campaigns screen''s own Send Test button now checks before rendering) and writes an audit_logs row naming the actor, the Station, the channel, the list and template the sample was drawn from, and the destination the operator typed -- in the clear, unlike create_campaign''s own audit row, because this address belongs to no member record for create_campaign''s own rule (0034) to protect. Called from messages/campaigns/actions.ts before the provider is ever asked to send, so a refused or failed test send still leaves the attempt in the trail. Refuses 42501 for a caller lacking messaging.send and P0002 for an unknown Station.';
