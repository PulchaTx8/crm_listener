-- supabase/migrations/0248_campaign_test_send_sender.sql

-- Block 29d-2, Task 7 addendum, section 4 (the test send). It sends through
-- the SAME provider a real campaign uses -- WhatsAppMessagingProvider, which
-- needs the Station's own phone_number_id (WhatsAppSendJob.phoneNumberId,
-- src/lib/messaging/provider.ts) before it can call the Cloud API at all.
--
-- public.integrations (0057) CARRIES RLS WITH NO POLICY, on purpose: "nothing
-- reaches this table through a user-scoped client, by design" (0057's own
-- table comment). The one existing authenticated door onto it,
-- list_integrations (0130), is gated on is_platform_admin() alone -- an
-- installation-wide console listing every Station's integration at once
-- (0130's own header: "there is no Company permission that could grant
-- this... the account being configured belongs to the platform rather than
-- to the customer"). That is the wrong shape for the question this screen
-- asks, which is narrower and per-caller: "may THIS operator, who already
-- holds messaging.view at THEIR OWN Station, test-send from it."
--
-- src/lib/supabase/service-client.ts's own header is explicit about the other
-- way this could have been read: "ONLY for system routines (webhook, cron,
-- ETL, platform). Never in a user request." The worker's drain (Task 6b,
-- src/services/campaigns.ts) already reads this table as service_role for
-- exactly that reason -- it IS a system routine. A Server Action answering
-- one click from an operator's browser is not, and reaching for the service
-- client there to route around this table's RLS would be the exact
-- boundary that comment exists to hold.
--
-- SO: a narrow, new, per-Station door, the same shape 0246's own
-- members_marketing_eligible_bulk_for_worker is for its caller -- a
-- SEPARATE, VISIBLY DIFFERENT door rather than one more arm bolted onto an
-- existing gate. NO SECRET LEAVES IT: only phone_number_id, which 0057's own
-- table comment calls out by name as not one ("Holds no secret (design spec
-- D6)... phone_number_id, WABA id, display number and nothing else").
-- Gated on messaging.view -- the same permission that gates the whole
-- campaigns screen and, per the addendum, the test send along with it
-- ("messaging.send gates the send button and the cancel button, separately
-- from everything else").

create function public.campaign_whatsapp_sender(p_company_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_phone_number_id text;
begin
  if not public.has_permission('messaging.view', p_company_id) then
    raise log 'campaign_whatsapp_sender denied: actor=% company=%', auth.uid(), p_company_id;
    raise exception 'permission denied: messaging.view required' using errcode = '42501';
  end if;

  -- The identical filter drainCampaigns' own loadPhoneNumberIds
  -- (src/services/campaigns.ts) applies for the real send -- deliberately not
  -- a stricter one (say, adding `enabled`): a test send disagreeing with the
  -- drain about which integration counts as "this Station's WhatsApp sender"
  -- would prove nothing about what a real campaign will do.
  select i.phone_number_id into v_phone_number_id
    from public.integrations i
   where i.company_id = p_company_id
     and i.provider = 'WHATSAPP'
     and i.deleted_at is null
   limit 1;

  return v_phone_number_id;
end;
$$;

revoke execute on function public.campaign_whatsapp_sender(uuid) from public;
grant execute on function public.campaign_whatsapp_sender(uuid) to authenticated;

comment on function public.campaign_whatsapp_sender(uuid) is
  'The Station''s own active WhatsApp phone_number_id, for the campaigns screen''s test send alone (Task 7 addendum, section 4) -- public.integrations (0057) carries RLS with no policy and the one existing authenticated door onto it, list_integrations (0130), is gated on is_platform_admin() alone for its own, wider console. This is the narrow, per-Station equivalent: gated on messaging.view, the same permission that gates the whole campaigns screen, and returns nothing but the phone_number_id itself -- "no secret", by 0057''s own words. Uses the identical filter (provider = WHATSAPP, deleted_at is null, no `enabled` check) drainCampaigns'' own loadPhoneNumberIds (src/services/campaigns.ts) applies for a real send, so a test send''s sender resolution cannot disagree with what a real campaign''s drain would use.';
