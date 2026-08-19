-- supabase/migrations/0251_campaign_erasure_finalizes_stranded_campaigns.sql

-- Block 29d-2, Task 8, fix round 1, Item 1(a). Task 8's own review found a
-- gap the task itself introduced: `anonymize_member` (0251, replacing 0250)
-- moves a listener's `pending` recipient row straight to `suppressed`
-- without ever going through the drain's own settle path
-- (src/services/campaigns.ts), which is the ONLY other place
-- message_campaigns.suppressed_count is written (bump_campaign_counters,
-- 0247). Left as 0250 shipped it, that counter simply never moved for a row
-- this function suppressed directly -- the recipient table said one more
-- listener was suppressed and the campaign's own summary disagreed, for
-- ever, since that summary is never recomputed from the recipient table
-- (0242's own comment).
--
-- The worse half of the same gap -- a campaign whose LAST outstanding row
-- was the one this function just suppressed never gets `finalizeCampaign`
-- called for it again, since nothing claims it again, and sits `running`
-- for ever -- is NOT a database concern and is fixed in
-- src/services/campaigns.ts (Item 1(b) of the same review), not here. It
-- matters here only as the reason this fix is not optional polish: the
-- retention sweep's own DELETE (0250) is gated on
-- `c.status in ('sent', 'failed', 'cancelled')`, so a campaign stranded in
-- `running` is invisible to retention for ever, and every recipient row of
-- that campaign -- not only the erased listener's -- carries a phone number
-- or e-mail address that never gets swept either.
--
-- RECREATED FROM THE LIVE DEFINITION, verified via `pg_get_functiondef`
-- through a throwaway Node script against the local stack (never from
-- 0034, 0087, 0220 or 0250's own text alone) -- confirmed byte-for-byte
-- identical to 0250's committed text before this migration changes anything,
-- the same verification Task 8's own report already describes doing for
-- 0250 itself.
create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason public.member_erasure_reason)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor       uuid := auth.uid();
  v_org         uuid;
  v_campaign_id uuid;
begin
  -- Not filtered on deleted_at: an already-archived listener can still be erased —
  -- archival and erasure are different mechanisms (spec §6) and neither implies the
  -- other.
  select organization_id into v_org
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.erase') then
    raise log 'anonymize_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.erase required' using errcode = '42501';
  end if;

  if p_reason is null then
    raise exception 'a reason is required to erase a listener' using errcode = '22023';
  end if;

  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         gender = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         country = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;

  update public.member_notes
     set body = null
   where member_id = p_member_id and body is not null;

  update public.member_consents
     set origin = null
   where member_id = p_member_id and origin is not null;

  update public.member_blocks
     set reason = null, lift_reason = null
   where member_id = p_member_id and (reason is not null or lift_reason is not null);

  -- Block 29d-2, Task 8. message_campaign_recipients (0242) holds this
  -- listener's phone number or e-mail address, resolved at snapshot time, and
  -- -- for an EMAIL campaign -- variable values that can themselves carry
  -- their first name, full name and city. Reached directly by member_id, at
  -- WHATEVER STATUS the row holds -- the same promise 0242's own column
  -- comment on message_campaign_recipients.member_id makes for this
  -- function, and unlike outbox_messages.to_phone (0059), which carries no
  -- such join and can only be pruned by retention age.
  --
  -- variables IS `jsonb not null` (0242), never nullable -- cleared to
  -- '[]'::jsonb, an empty array, which still satisfies
  -- message_campaign_recipients_variables_is_positional
  -- (jsonb_typeof(variables) = 'array') for both channels' own shapes.
  --
  -- PENDING moves to SUPPRESSED, in this same statement: 0242's own index
  -- comment calls `pending` "the only status a fresh, sendable row holds",
  -- and a row whose address was just nulled is not sendable -- left
  -- `pending`, claim_campaign_batch (0244) would still claim it before
  -- anything discovers there is nowhere left to send it.
  --
  -- CLAIMED IS LEFT EXACTLY AS IT STANDS, deliberately, not forgotten: that
  -- row is already inside a batch an active drain tick is holding in memory
  -- (src/services/campaigns.ts), which asks eligibility again -- and re-reads
  -- anonymized_at through it (members_marketing_eligible_bulk_for_worker,
  -- 0246) -- BEFORE it ever reads an address. An erased listener's claimed
  -- row therefore still resolves to `suppressed` there, through the drain's
  -- own settle write and its own atomic counter bump (bump_campaign_counters,
  -- 0247) -- which this statement has no way to reach correctly for a row it
  -- does not know is mid-flight. SENT, FAILED, CANCELLED and an
  -- already-SUPPRESSED row are also left exactly as they stand: each is a row
  -- the drain, or cancel_campaign (0243), has already finished with, and
  -- rewriting its status now would misstate what actually happened at send
  -- time.
  --
  -- CLEARED, NEVER DELETED -- the same choice this function already makes
  -- for every table above. message_campaigns' own counters (sent_count,
  -- failed_count, suppressed_count, 0242) are written once by the drain as
  -- it goes and never recomputed from this table (0242's own comment), so a
  -- finished campaign's history stays answerable from message_campaigns
  -- alone even after this row is cleared, or, later, removed outright by the
  -- retention sweep below.
  --
  -- Fix round 1, Item 1(a). THE suppressed_count BUMP LIVES INSIDE THIS SAME
  -- STATEMENT: `before` is a plain (non-modifying) CTE, so Postgres evaluates
  -- it against the snapshot as of the START of this statement -- BEFORE the
  -- sibling `flipped` UPDATE writes anything -- which is what lets
  -- `status_before` name the row's TRUE old status even though a plain
  -- UPDATE...RETURNING can only ever expose the NEW one.
  -- message_campaign_recipients_one_row_per_listener (0242) guarantees at
  -- most one row per campaign for this listener, so the FOR loop's result
  -- names each affected campaign at most once and bumps it by exactly one --
  -- no GROUP BY/count needed. bump_campaign_counters (0247) is called
  -- DIRECTLY, not through PostgREST: this function is itself SECURITY
  -- DEFINER, so its body runs AS ITS OWNER, and `bump_campaign_counters`'s
  -- own grant (service_role only, revoked from public/authenticated/anon)
  -- never touches the owner's OWN implicit EXECUTE -- verified against the
  -- live database rather than assumed: both functions are owned by the same
  -- role, and that role's `X` (EXECUTE) flag is present in both functions'
  -- pg_proc.proacl. No new GRANT was needed or added.
  for v_campaign_id in
    with before as (
      select id, status
        from public.message_campaign_recipients
       where member_id = p_member_id
         and (address is not null or variables <> '[]'::jsonb or status = 'pending')
    ),
    flipped as (
      update public.message_campaign_recipients r
         set address   = null,
             variables = '[]'::jsonb,
             status    = case when r.status = 'pending'
                              then 'suppressed'::public.campaign_recipient_status
                              else r.status
                         end
        from before b
       where r.id = b.id
      returning r.campaign_id, b.status as status_before
    )
    select f.campaign_id from flipped f where f.status_before = 'pending'
  loop
    perform public.bump_campaign_counters(v_campaign_id, 0, 0, 1);
  end loop;

  -- Block 6b. The queue row is written BEFORE the update that nulls the column
  -- it reads -- reverse the two and this erases the reference and forgets the
  -- object, which is the failure mode the queue exists to close.
  --
  -- Both statements are in this transaction, so an erasure cannot be recorded
  -- without the instruction to finish it, and the instruction cannot be issued
  -- for an erasure that rolled back.
  insert into public.storage_erasure_queue (bucket, path)
  select 'delivery-receipts', w.receipt_path
  from public.winners w
  where w.member_id = p_member_id and w.receipt_path is not null;

  update public.winners
     set receipt_path = null,
         receipt_erased_at = now(),
         updated_at = now()
   where member_id = p_member_id and receipt_path is not null;

  -- The audit entry names the event, the actor and the reason. p_reason is a bounded
  -- enum (owner's ruling A), never free text, so there is no operator prose here
  -- that could re-plant what this function just scrubbed.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'anonymize_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id, 'reason', p_reason));
end;
$$;

comment on function public.anonymize_member(uuid, public.member_erasure_reason) is
  'LGPD erasure. Nulls every identifying column on members and sets anonymized_at; the row and its id survive so participations and deliveries still reference something. Also nulls member_notes.body, member_consents.origin and member_blocks.reason/lift_reason (owner''s ruling B), keeping those rows and their dates/types/authors. EXTENDED IN 0087 to reach delivery receipts: a receipt is a photograph or a signature, so winners.receipt_path is cleared, receipt_erased_at is stamped, and the object is queued in storage_erasure_queue IN THE SAME TRANSACTION -- because deleting a storage.objects row in SQL takes only the metadata and leaves the file, so the worker (0064) is what actually deletes it. EXTENDED IN 0250 (Block 29d-2, Task 8) to reach message_campaign_recipients (0242): a real person''s phone number or e-mail address, and an EMAIL campaign''s own resolved variable values (which can carry a first name, full name and city), cleared at whatever status the row holds; a `pending` row also moves to `suppressed` in the same statement, since a row with no address left `pending` is not the sendable row that status claims it is -- a `claimed` row is left alone on purpose, because the drain (src/services/campaigns.ts) re-checks eligibility, and therefore anonymized_at, before it ever reads an address, and settles that row itself. EXTENDED AGAIN IN 0251 (fix round 1, Item 1(a)) to bump message_campaigns.suppressed_count for each campaign whose row it moves to `suppressed`, through bump_campaign_counters (0247) -- without it, that counter silently disagreed with the recipient table for ever, since it is never recomputed from it. What SURVIVES an erasure, deliberately: the DELIVERY movement, its actor and its date, and a campaign''s own counters, all facts about what happened rather than about a person. Gated on members.erase via member_reachable. The UPDATE''s own WHERE clause (anonymized_at is null) makes a double-erase a clean, atomic refusal (P0002).';
