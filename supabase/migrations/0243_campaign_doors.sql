-- supabase/migrations/0243_campaign_doors.sql

-- Block 29d-2, Task 3: the two doors that create and stop a campaign.
--
-- BOTH GATED ON messaging.send, NOT messaging.manage. Creating a list only
-- ever needed messaging.manage (0239) because drafting one commits nobody to
-- anything; create_campaign's insert puts a pending row in a real queue for
-- however many people p_member_ids names, which is exactly the act 0236's
-- own comment on the permission itself calls out: "approving a send to
-- twenty thousand people is not the act of drafting one." Stopping a
-- campaign already under way is the same authority in reverse, which is why
-- cancel_campaign is gated identically rather than on messaging.manage --
-- the plan's own screen task (Task 7, Step 4: "Cancel on a running
-- campaign, gated on messaging.send") already settled this at the UI layer,
-- and a door looser than the button in front of it would let an operator who
-- never got messaging.send reach this RPC directly and stop a send nobody
-- gave them authority to touch.
--
-- THE SNAPSHOT IS PASSED IN, NOT COMPUTED HERE (spec §5). create_campaign
-- receives the member ids, their resolved addresses and their variable
-- values rather than asking members_marketing_eligible_bulk (0235) itself,
-- for two reasons -- and NEITHER of them is identity. A SECURITY DEFINER
-- door calling 0235 would in fact ask with exactly the operator's own
-- identity: 0235 gates on auth.uid(), which reads the request's JWT claims,
-- a GUC that SECURITY DEFINER changes nothing about (it swaps the executing
-- ROLE, not that GUC), and 0240 is itself SECURITY DEFINER calling
-- auth.uid() and answers as the caller who invoked it. The real reasons:
--   1. A LIVING list is re-resolved by the three listing services in
--      src/services/ (Members, Requests, Participations -- 29d-1's own
--      resolver), which call the identical services the listing screens call
--      so a list a campaign is built from never drifts from what the
--      operator saw on screen. SQL cannot call a TypeScript service, so the
--      member set has to arrive from the application layer no matter what
--      this door could otherwise do with it once it has an id.
--   2. The addresses and the variable values require reading `members`
--      columns and the template's own variable mapping -- work the screen
--      (Task 7) already does to show the operator what will be sent before
--      they approve it. A door repeating that resolution would be a second
--      copy kept in agreement with the first by nothing.
--
-- "REGISTERED" (spec §6: a WhatsApp campaign is refused if the template is
-- not registered) has no boolean column to read -- 0110's own table comment
-- says so directly: "Deliberately has no status column". What 0223 names as
-- the same fact, in its own words, is name and language:
-- message_templates_whatsapp_shape requires both whenever channel is
-- WHATSAPP, and message_templates_email_no_meta_fields requires both ABSENT
-- whenever channel is EMAIL ("every screen and query that reads 'is this
-- registered at Meta' gains a row that answers yes and is not", 0223). With
-- message_channel holding exactly two values, "name and language are both
-- present" and "channel = WHATSAPP" are the same fact for every row this
-- schema can hold today -- so the WhatsApp arm below folds the channel
-- agreement 0242's own column comment requires ("Enforcing the agreement is
-- create_campaign's job") into ONE clause with the registration check: a
-- template of the wrong channel and a WhatsApp template missing its
-- transcribed name/language answer with the one sentence that is true of
-- both -- this template is not a WhatsApp template registered with Meta.
-- Folded into one clause rather than kept as two so that the day a row CAN
-- carry channel = WHATSAPP with name or language still null -- a draft
-- awaiting approval, should a later block add that state -- this clause
-- already refuses it correctly, without having been written with that day
-- in mind.

create function public.create_campaign(
  p_company_id  uuid,
  p_list_id     uuid,
  p_channel     public.message_channel,
  p_template_id uuid,
  p_member_ids  uuid[],
  p_addresses   jsonb,
  p_variables   jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor        uuid := auth.uid();
  v_org          uuid;
  v_list_company uuid;
  v_tpl          record;
  v_member_ids   uuid[] := coalesce(p_member_ids, '{}');
  v_bad_member   uuid;
  v_total        integer := array_length(coalesce(p_member_ids, '{}'), 1);
  v_id           uuid;
  v_count        integer;
begin
  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Permission before existence, the house order (0199's own comment,
  -- restated by create_send_list, 0239): a caller who may not approve a send
  -- learns that, and learns nothing about which lists, templates or
  -- listeners this Station has.
  if not public.has_permission('messaging.send', p_company_id) then
    raise log 'create_campaign denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: messaging.send required' using errcode = '42501';
  end if;

  -- Station resolved from p_company_id, not trusted from the row: a caller
  -- who could pass any list id could otherwise build a campaign against a
  -- list belonging to a Station they hold no permission at, from the id
  -- alone -- the same hole member_linked_to_company exists to close for
  -- listener ids below.
  select company_id into v_list_company
    from public.send_lists
   where id = p_list_id and deleted_at is null;

  if not found or v_list_company <> p_company_id then
    raise exception 'send list not found: %', p_list_id using errcode = 'P0002';
  end if;

  select channel, name, language into v_tpl
    from public.message_templates
   where id = p_template_id and company_id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'template not found: %', p_template_id using errcode = 'P0002';
  end if;

  if p_channel = 'WHATSAPP' then
    if v_tpl.channel <> 'WHATSAPP' or v_tpl.name is null or v_tpl.language is null then
      raise exception 'this template is not a WhatsApp template registered with Meta: %', p_template_id
        using errcode = '22023';
    end if;
  else
    if v_tpl.channel <> 'EMAIL' then
      raise exception 'this template does not send on the channel requested: %', p_template_id
        using errcode = '22023';
    end if;
  end if;

  if v_total is null or v_total = 0 then
    raise exception 'a campaign needs at least one recipient' using errcode = '22023';
  end if;

  select m into v_bad_member
    from unnest(v_member_ids) as m
   where not public.member_linked_to_company(m, p_company_id)
   limit 1;

  if v_bad_member is not null then
    raise exception 'listener not linked to this station: %', v_bad_member using errcode = 'P0002';
  end if;

  -- Task 7 addendum's own guard. 0242's own CHECK on message_campaign_recipients
  -- (message_campaign_recipients_variables_is_positional) only asks
  -- jsonb_typeof(variables) = 'array' -- true of BOTH channels' own element
  -- shapes (WHATSAPP: strings; EMAIL: {name, value} objects, 0242's own
  -- column comment), so it cannot catch a WHATSAPP snapshot carrying EMAIL's
  -- element shape or the reverse. Left unchecked, that mismatch either
  -- inserts successfully with values the drain (Task 6b) can never
  -- substitute -- discovered one recipient at a time, over however long the
  -- campaign takes to drain, on a row that already looks queued and correct
  -- -- or, if some entry is not even a JSON array at all, aborts the INSERT
  -- below with an unnamed 22023 raised by jsonb_array_elements itself rather
  -- than a sentence this door chose. Checked for every member's own entry,
  -- not merely that SOME entry somewhere is wrong, and before a single row
  -- is inserted -- the door can refuse the whole campaign here; the drain can
  -- only fail rows one at a time.
  if exists (
    select 1
      from unnest(v_member_ids) as m
     where jsonb_typeof(coalesce(p_variables -> m::text, '[]'::jsonb)) <> 'array'
  ) then
    raise exception 'a recipient''s variable values must be a JSON array' using errcode = '22023';
  end if;

  if p_channel = 'WHATSAPP' then
    if exists (
      select 1
        from unnest(v_member_ids) as m
        cross join lateral jsonb_array_elements(coalesce(p_variables -> m::text, '[]'::jsonb)) as e
       where jsonb_typeof(e) <> 'string'
    ) then
      raise exception 'a WhatsApp campaign''s variable values must be a positional array of strings'
        using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from unnest(v_member_ids) as m
        cross join lateral jsonb_array_elements(coalesce(p_variables -> m::text, '[]'::jsonb)) as e
       where not (
         jsonb_typeof(e) = 'object'
         and jsonb_typeof(e -> 'name') = 'string'
         and jsonb_typeof(e -> 'value') = 'string'
       )
    ) then
      raise exception 'an e-mail campaign''s variable values must be named {name, value} pairs'
        using errcode = '22023';
    end if;
  end if;

  insert into public.message_campaigns
    (organization_id, company_id, list_id, channel, template_id, created_by, total_recipients)
  values
    (v_org, p_company_id, p_list_id, p_channel, p_template_id, v_actor, v_total)
  returning id into v_id;

  -- The snapshot. address and variables are read out of p_addresses/p_variables
  -- by member id, cast to text because a jsonb object key can only be text --
  -- {"<member-uuid>": "<address>"} and {"<member-uuid>": <variables>},
  -- exactly the shape a caller building one map per array in application code
  -- already has to hand. A member id absent from p_addresses stores a null
  -- address (the column allows it, 0242); one absent from p_variables stores
  -- '[]', matching the column's own NOT NULL default rather than a null the
  -- column would refuse -- an empty array either way, because 0242's own
  -- CHECK requires variables to be a JSON array (true of both channels' own
  -- shapes: WHATSAPP's positional strings and EMAIL's {name, value} objects,
  -- 0242's own column comment), and an object is not an array regardless of
  -- whether it is empty. The guard just above this insert already refused a
  -- p_variables whose PER-MEMBER shape disagrees with p_channel, so every
  -- value read out here is known, by this point, to be shaped for the
  -- channel this campaign is actually sending on.
  insert into public.message_campaign_recipients
    (campaign_id, member_id, channel, address, variables)
  select v_id, m, p_channel,
         p_addresses ->> m::text,
         coalesce(p_variables -> m::text, '[]'::jsonb)
    from unnest(v_member_ids) as m;

  get diagnostics v_count = row_count;

  -- No personal value in the detail (0034's own rule for every audit entry
  -- touching a Member, restated here because this table is the first place
  -- in this project an audit row sits beside PHI at the scale of thousands):
  -- ids and counts only, never an address or a variable value.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_campaign', 'message_campaigns', v_id, v_org, p_company_id,
     jsonb_build_object('list_id', p_list_id, 'channel', p_channel,
                         'template_id', p_template_id, 'recipient_count', v_count));

  return v_id;
end;
$$;

comment on function public.create_campaign(
  uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb
) is
  'Snapshots a send list into a queued campaign. Gated on messaging.send, not messaging.manage (0236: approving a send is not the act of drafting one). The member set, their resolved addresses (p_addresses) and their variable values (p_variables) arrive as parameters -- both jsonb objects keyed by member id cast to text -- rather than being computed here: a LIVING list is re-resolved by the src/services/ listing resolvers (29d-1), which SQL cannot call, and the addresses/variables require reading members and the template''s own mapping, work the screen (Task 7) already does. NOT because a definer door calling members_marketing_eligible_bulk (0235) would ask with the wrong identity -- it would not; auth.uid() reads the request''s JWT claims regardless of SECURITY DEFINER. Refuses P0002 for an unknown or wrong-Station list, an unknown or wrong-Station template, or any member id not linked to this Station (member_linked_to_company, 0034); refuses 22023 for a WhatsApp campaign whose template is not itself WHATSAPP with a transcribed name and language (0223''s own definition of "registered"), for a template of the requested channel''s opposite, for an empty recipient set, for a p_variables entry that is not a JSON array at all, and -- Task 7 addendum''s own guard -- for a p_variables entry whose ELEMENT shape disagrees with p_channel (WHATSAPP wants a positional array of strings; EMAIL wants named {name, value} pairs), checked per member and refused before a single recipient row is inserted rather than left for 0242''s own top-level CHECK (message_campaign_recipients_variables_is_positional, true of both channels'' shapes alike) or for the drain (Task 6b) to fail one row at a time. Writes total_recipients once, from the snapshot size, and an audit_logs row naming the list, channel, template and recipient count -- never an address or a variable value.';

-- cancel_campaign. FOR UPDATE on the campaign row before anything is
-- decided, the same reason cancel_draw (0079) takes it: two simultaneous
-- cancellations of one campaign must not both read it as still cancellable
-- and both write a cancellation over each other's.
--
-- ONLY pending ROWS MOVE. A claimed row is already in flight at a provider
-- (Task 5's send has been handed the job) and cannot be recalled -- spec §10
-- and 0242's own comment on message_campaign_recipients.status say so, and
-- this door does not pretend the network can be unwound. A sent, failed or
-- suppressed row is a row the drain has already finished with; leaving it
-- alone is not a gap, it is the point.
create function public.cancel_campaign(
  p_campaign_id uuid,
  p_reason      text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_status  public.campaign_status;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_count   integer;
begin
  select organization_id, company_id, status
    into v_org, v_company, v_status
    from public.message_campaigns
   where id = p_campaign_id
     for update;

  if not found then
    raise exception 'campaign not found: %', p_campaign_id using errcode = 'P0002';
  end if;

  if not public.has_permission('messaging.send', v_company) then
    raise log 'cancel_campaign denied: actor=% campaign=%', v_actor, p_campaign_id;
    raise exception 'permission denied: messaging.send required' using errcode = '42501';
  end if;

  -- A campaign already sent, failed or cancelled has nothing left to stop --
  -- and letting this door touch its status again would overwrite a finished
  -- campaign's history with 'cancelled', which is simply false of a
  -- campaign that finished sending. cancel_draw (0079) refuses a second
  -- cancellation the same way, for the same reason.
  if v_status in ('sent', 'failed', 'cancelled') then
    raise exception 'this campaign has already finished and cannot be cancelled' using errcode = '22023';
  end if;

  update public.message_campaign_recipients
     set status = 'cancelled'
   where campaign_id = p_campaign_id
     and status = 'pending';

  get diagnostics v_count = row_count;

  update public.message_campaigns
     set status        = 'cancelled',
         cancelled_by  = v_actor,
         cancelled_at  = now(),
         cancel_reason = v_reason
   where id = p_campaign_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_campaign', 'message_campaigns', p_campaign_id, v_org, v_company,
     jsonb_build_object('recipients_cancelled', v_count));

  return v_count;
end;
$$;

comment on function public.cancel_campaign(uuid, text) is
  'Stops a campaign: marks every still-pending recipient row cancelled, leaves claimed (already in flight at a provider, spec §10), sent, failed and suppressed rows exactly as they are, and returns how many rows it marked. Station is resolved from the row under FOR UPDATE, the same lock cancel_draw (0079) takes so two simultaneous cancellations cannot both act. Gated on messaging.send -- the same permission create_campaign requires, and the one the plan''s own screen task gates its Cancel button on -- not messaging.manage: stopping a send is the same authority as approving one, in reverse. Refuses P0002 for an unknown campaign and 22023 for one already sent, failed or cancelled, so this door cannot overwrite a finished campaign''s history with a cancellation that never happened. p_reason is optional (message_campaigns_cancelled_shape does not require it, 0242) and is never written to audit_logs -- ids and counts only, matching every other audit row this feature writes.';

-- `create function` grants EXECUTE to PUBLIC by default; every write door in
-- this feature (0239) revokes that and grants back only to `authenticated`.
-- Neither door is called by the worker -- the drain (Task 6) claims and
-- settles rows through claim_campaign_batch (Task 4) and its own settle
-- write, never through these two -- so `service_role` gets no grant either,
-- the same choice 0239 makes for its three doors.

revoke execute on function public.create_campaign(
  uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb
) from public;
revoke execute on function public.cancel_campaign(uuid, text) from public;

grant execute on function public.create_campaign(
  uuid, uuid, public.message_channel, uuid, uuid[], jsonb, jsonb
) to authenticated;
grant execute on function public.cancel_campaign(uuid, text) to authenticated;
