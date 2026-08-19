-- supabase/migrations/0246_marketing_eligibility_for_the_worker.sql

-- Block 29d-2, Task 6a Part 2 (ledger R23). members_marketing_eligible_bulk
-- (0235) is granted to authenticated alone and raises 42501 unless the caller
-- resolves, through auth.uid(), to the platform admin, the Organization's
-- owner or a holder of members.view. The worker runs as service_role with no
-- auth.uid() at all, so it cannot call that door and never will be able to --
-- the block's own D1 (consent re-checked in the instant before each message
-- goes out) has no door to go through today.
--
-- NOT ONE MORE ARM ON 0235'S GATE. The house has already answered this exact
-- shape of problem: 0234's own comment on widget_enter_promotion records that
-- record_member_consent is unreachable for a service-role caller with no
-- auth.uid(), and answers it with a SEPARATE door "granted to service_role
-- only" rather than an `or` arm hidden inside a gate that already has one. A
-- door that answers with NO identity check must be visibly a different door
-- from one that has a real gate -- an `or auth.uid() is null` arm bolted onto
-- 0235 would read, to the next person who edits that gate, as one more
-- ordinary case rather than as the absence of a check.
--
-- ONE CORE, TWO DOORS, NOT TWO COPIES OF THE RULE. The per-listener rule is
-- five layers deep (linked to the Station, not anonymized, no active
-- suspension, the latest consent row, the per-channel default), and a second
-- copy of it -- in this migration, or worse, in TypeScript -- is a copy that
-- eventually disagrees with the first. So section 1 below lifts 0235's
-- per-listener computation into apply_members_marketing_eligible, PRIVATE
-- (SECURITY INVOKER, EXECUTE granted to nobody, the same convention
-- member_linked_to_company (0034) and apply_member_candidates (0061) use for
-- a helper meant to be reached only from inside a SECURITY DEFINER body,
-- where the executing role is the definer's, not the original caller's).
-- Section 2 recreates members_marketing_eligible_bulk to keep its gate
-- exactly as it is and delegate to that core. Section 3 is the worker's own
-- door: the same arguments, the same (member_id, eligible) return shape, NO
-- identity gate, granted to service_role alone.
--
-- THE BODY BELOW IS TAKEN FROM THE LIVE FUNCTION (pg_get_functiondef against
-- the running database), never retyped from 0235's own file -- this project
-- has a documented incident where recreating a function from the migration
-- that first created it silently reverted every fix a later migration had
-- made. Byte-compared: the live definition and 0235's file agree character
-- for character, so nothing has drifted since 0235 shipped, and what is lifted
-- into section 1 below is exactly what runs today.
--
-- CREATE OR REPLACE for members_marketing_eligible_bulk, never DROP+CREATE:
-- the argument list and return type are unchanged, so CREATE OR REPLACE is
-- legal and preserves the ACL 0235 set (authenticated alone) rather than
-- destroying it. The grants are restated below anyway, following 0235's own
-- considered precedent for superseding a shipped, security-relevant function,
-- so this migration is self-contained rather than relying on 0235 having run
-- first and done the right thing silently.

-- ---------------------------------------------------------------------------
-- 1. apply_members_marketing_eligible -- the per-listener rule itself, lifted
--    out of members_marketing_eligible_bulk (0235) as a set, with nothing
--    added and nothing removed. PRIVATE: SECURITY INVOKER, EXECUTE granted to
--    nobody. It has no identity gate of its own and must never be given one
--    -- gating is the two doors' job, not the shared core's, exactly as
--    apply_member_candidates (0061) carries no visibility filter and leaves
--    reachability to the public door that calls it.
-- ---------------------------------------------------------------------------
create function public.apply_members_marketing_eligible(
  p_member_ids uuid[],
  p_company_id uuid,
  p_channel    public.message_channel
)
returns table (member_id uuid, eligible boolean)
language sql
stable
set search_path = pg_catalog, public
as $$
  with asked as (
    select unnest(p_member_ids) as id
  ),
  -- The consent type this channel is about. Written as a mapping rather than
  -- as two functions because the four layers below are identical for both.
  channel as (
    select case p_channel
             when 'WHATSAPP' then 'whatsapp_marketing'
             else 'email_marketing'
           end::public.member_consent_type as consent_type,
           -- Layer 4: the default when nothing was ever recorded (spec D1).
           (p_channel = 'EMAIL') as default_eligible
  ),
  latest as (
    select distinct on (mc.member_id)
           mc.member_id, mc.granted
      from public.member_consents mc, channel ch
     where mc.company_id = p_company_id
       and mc.consent_type = ch.consent_type
       and mc.member_id = any(p_member_ids)
     -- granted_at defaults to now(), constant within a transaction, so two
     -- rows written together tie. id cannot break that tie -- it is
     -- gen_random_uuid() (0032), carrying no information about which row was
     -- written later -- so ordering by it is not a tiebreak at all, only an
     -- arbitrary comparison dressed up as one. Break the tie by MEANING
     -- instead: granted ASC puts false before true, so where nothing here can
     -- say which write came later, the one saying "do not send" wins. That is
     -- deterministic and it fails in the direction this function should fail
     -- in.
     order by mc.member_id, mc.granted_at desc, mc.granted asc
  )
  select a.id,
         -- F29's link check, and it sits FIRST because it is the widest bar of
         -- the lot: without it a member id from any Organization on earth came
         -- back carrying the channel default. member_linked_to_company (0034)
         -- rather than a hand-written exists() -- it is the same predicate the
         -- three write doors of this block already gate on
         -- (withdraw_marketing_by_phone, record_conversation_marketing_answer,
         -- issue_unsubscribe_token), and "linked to this Station" must not
         -- come to mean two things. It costs one index probe per id: the
         -- function carries a SET clause, so the planner cannot inline it, the
         -- same per-row price 0036 documents for member_reachable and accepts
         -- for the same reason -- one round trip is still one round trip.
         public.member_linked_to_company(a.id, p_company_id)
         -- Layers 1 and 2 are bars, not preferences: they cannot be overridden
         -- by a consent row, which is why they sit outside the coalesce.
         and m.anonymized_at is null
         and not exists (
           select 1 from public.member_blocks b
            where b.member_id = a.id
              and b.organization_id = co.organization_id
              -- NULL company_id MEANS THE WHOLE ORGANIZATION (0032's own
              -- comment). Matching only on equality would let an
              -- Organization-wide suspension go on receiving campaigns from
              -- every Station in it -- the widest possible miss.
              and (b.company_id is null or b.company_id = p_company_id)
              -- 'suspension' ONLY. member_block_kind also carries 'draw_ban',
              -- which means "may not win a draw" and says nothing about
              -- messages; barring it here would silently punish a listener for
              -- something else. This is also why members_blocked_bulk (0036) is
              -- not reused: it treats any active block as blocking, which is
              -- right for its question and wrong for this one.
              and b.kind = 'suspension'
              -- A block is active by its dates, not by its existence: 0036
              -- derives the same three conditions at read time, and a lifted or
              -- expired suspension must not bar anybody.
              and b.lifted_at is null
              and b.starts_at <= now()
              and (b.ends_at is null or b.ends_at > now())
         )
         and coalesce(l.granted, ch.default_eligible)
    from asked a
    cross join channel ch
    join public.members m on m.id = a.id
    -- The Station's Organization, which the block check needs: a suspension is
    -- recorded against an Organization, and a row from another one must never
    -- bar a listener here.
    join public.companies co on co.id = p_company_id
    left join latest l on l.member_id = a.id;
$$;

revoke execute on function
  public.apply_members_marketing_eligible(uuid[], uuid, public.message_channel) from public;

comment on function public.apply_members_marketing_eligible(uuid[], uuid, public.message_channel) is
  'The per-listener eligibility rule itself, lifted out of members_marketing_eligible_bulk (0235) unchanged, so members_marketing_eligible_bulk (authenticated, gated on members.view) and members_marketing_eligible_bulk_for_worker (service_role, no gate) answer from the SAME logic rather than each holding its own copy. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody -- the same convention member_linked_to_company (0034) and apply_member_candidates (0061) use for a helper reached only from inside a SECURITY DEFINER body, where the executing role is the definer''s. Carries no identity gate and must never be given one: linked to the Station at all (member_linked_to_company, 0034), members.anonymized_at is an absolute bar, an active member_blocks suspension bars, the LATEST member_consents row for (member, company, type) decides, and absent any row the channel default applies -- WhatsApp requires an explicit yes, e-mail does not.';

-- ---------------------------------------------------------------------------
-- 2. members_marketing_eligible_bulk (0235), recreated to delegate its
--    computation to the shared core above. The gate -- platform admin, the
--    Organization''s owner, or members.view, all read from auth.uid(), 42501
--    otherwise -- is copied verbatim from the live function; nothing about
--    who may call this door or what it refuses changes.
-- ---------------------------------------------------------------------------
create or replace function public.members_marketing_eligible_bulk(
  p_member_ids uuid[],
  p_company_id uuid,
  p_channel    public.message_channel
)
returns table (member_id uuid, eligible boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and public.is_owner(c.organization_id)
    )
    or public.has_permission('members.view', p_company_id)
  ) then
    raise log 'members_marketing_eligible_bulk denied: actor=% company=% batch=%',
      auth.uid(), p_company_id, coalesce(array_length(p_member_ids, 1), 0);
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  return query
  select * from public.apply_members_marketing_eligible(p_member_ids, p_company_id, p_channel);
end;
$$;

revoke execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) from public;
grant execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) to authenticated;

comment on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) is
  'Block 29c, whole-branch review F29. Which of these listeners this Station may send a campaign to on this channel. Refuses a caller who is not the platform admin, not the owner of p_company_id''s Organization and does not hold members.view there (42501) -- the same three-arm guard members_blocked_bulk (0036) uses, checked once for the one Station the whole batch concerns. SECURITY DEFINER, replacing 0229''s SECURITY INVOKER: two of the per-listener layers are phrased as the ABSENCE of a row, and RLS hiding a row is indistinguishable from the row not existing, so under invoker every listener at a Station the caller could not read came back eligible -- including one who had unsubscribed and one under suspension. A caller with no identity is refused rather than silently answered. Block 29d-2 (0246): the per-listener computation itself now lives in apply_members_marketing_eligible, shared with members_marketing_eligible_bulk_for_worker -- the worker''s own door, granted to service_role, for a caller this gate can never admit because it has no auth.uid() to read. This function''s gate and its outward behaviour are unchanged by that move -- create or replace, not drop and recreate, so the ACL survives too.';

-- ---------------------------------------------------------------------------
-- 3. members_marketing_eligible_bulk_for_worker -- the worker''s own door.
--    Same arguments, same (member_id, eligible) shape, delegating to the
--    identical core as section 2 -- and NO identity gate, because the caller
--    it exists for has no identity to gate on. SECURITY DEFINER so that,
--    inside its body, apply_members_marketing_eligible (SECURITY INVOKER,
--    granted to nobody) executes as this function''s owner rather than as
--    service_role, the same mechanism 0235 already relies on for the door
--    above.
--
--    GRANTED TO service_role ALONE, revoked from public, authenticated and
--    anon explicitly: a door with no gate reachable by a browser session
--    would answer any caller''s question about any listener''s consent state,
--    which is the exact shape of defect F29 (0235''s own header) closed for
--    the operator''s door. Only the drain (Task 6b) has a reason to call this.
-- ---------------------------------------------------------------------------
create function public.members_marketing_eligible_bulk_for_worker(
  p_member_ids uuid[],
  p_company_id uuid,
  p_channel    public.message_channel
)
returns table (member_id uuid, eligible boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select * from public.apply_members_marketing_eligible(p_member_ids, p_company_id, p_channel);
$$;

revoke execute on function
  public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)
  from public, authenticated, anon;
grant execute on function
  public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel)
  to service_role;

comment on function public.members_marketing_eligible_bulk_for_worker(uuid[], uuid, public.message_channel) is
  'The eligibility question members_marketing_eligible_bulk (0235) answers, for the one caller its gate can never admit: the worker, running as service_role with no auth.uid(), so a gate built from is_platform_admin()/is_owner()/has_permission() has nothing to read and would refuse every call, forever. The house has answered this exact shape of problem before -- 0234''s own comment on widget_enter_promotion records that record_member_consent is unreachable for a service-role caller with no auth.uid(), and answers it with a door "granted to service_role only" rather than one more arm on an existing gate. This is that same answer for the read side: a SEPARATE door, visibly not the operator''s, carrying NO identity check of its own, delegating every bit of its computation to apply_members_marketing_eligible (0246) -- the identical core members_marketing_eligible_bulk uses -- so the two can never quietly disagree about who is eligible. SECURITY DEFINER only to let that PRIVATE core execute as the owner; this function performs no check that a caller could bypass by holding the wrong role, because service_role already IS the one caller this door exists for. GRANTED TO service_role ALONE, revoked explicitly from public, authenticated and anon: a door with no gate reachable by any of those three would leak every listener''s consent state to whoever could call it, the precise shape of defect 0235''s own header (F29) closed for the operator''s equivalent.';
