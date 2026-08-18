-- supabase/migrations/0229_marketing_eligibility.sql

-- Block 29c, Task 2. Who this Station may send to, on this channel.
--
-- SET-AT-A-TIME, in the shape members_blocked_bulk (0036) already holds. Block
-- 29d resolves audiences of thousands; a function answering one listener would
-- be N round trips for a question the database can answer in one pass.
--
-- SECURITY INVOKER, and this is the one place this file departs from 0036's
-- shape deliberately. "Who may I reach" has to be answered under the RLS of
-- whoever is asking, not of whoever wrote the function: there is no privilege
-- to lend here, only a filtered read, and a definer function would hand every
-- caller a view of consent rows their own policies would refuse them.
--
-- THE CONSEQUENCE FOR BLOCK 29d, recorded here so it is met as a decision
-- rather than as an empty result: a caller with NO user identity -- a worker
-- draining a queue, the failure Block 8b already met once -- gets nothing back
-- from this function. 29d's send loop must call it as somebody.
create or replace function public.members_marketing_eligible_bulk(
  p_member_ids uuid[],
  p_company_id uuid,
  p_channel    public.message_channel
)
returns table (member_id uuid, eligible boolean)
language sql
stable
security invoker
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
     -- granted_at DESC, id DESC: granted_at defaults to now(), constant within
     -- a transaction, so two rows written together tie and the winner would
     -- otherwise be whichever the planner reached first.
     order by mc.member_id, mc.granted_at desc, mc.id desc
  )
  select a.id,
         -- Layers 1 and 2 are bars, not preferences: they cannot be overridden
         -- by a consent row, which is why they sit outside the coalesce.
         m.anonymized_at is null
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

revoke execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) from public;
grant execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) to authenticated;

comment on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) is
  'Block 29c. Which of these listeners this Station may send a campaign to on this channel. Four layers, first no wins: members.anonymized_at is an absolute bar; an active member_blocks suspension bars; the LATEST member_consents row for (member, company, type) decides; and absent any row the channel default applies -- WhatsApp requires an explicit yes, e-mail does not. SECURITY INVOKER on purpose: a caller with no user identity gets nothing back, so Block 29d must call it as somebody.';
