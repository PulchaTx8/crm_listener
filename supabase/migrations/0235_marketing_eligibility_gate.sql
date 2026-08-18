-- supabase/migrations/0235_marketing_eligibility_gate.sql

-- Block 29c, whole-branch review, F29 (Critical) and F32 (Minor). Two doors
-- this branch opened, closed here in one migration because both defects are
-- the same mistake in different clothing: a question answered from the
-- ABSENCE of a row, when absence is exactly what a caller who may not see the
-- rows produces.
--
-- ---------------------------------------------------------------------------
-- F29. members_marketing_eligible_bulk (0229) READ INVISIBLE AS PERMITTED.
--
-- 0229 shipped SECURITY INVOKER with no caller gate at all, and its own header
-- argued for that: "there is no privilege to lend here, only a filtered read".
-- The argument is wrong, and this is the specific way it is wrong. Two of the
-- four layers are phrased as absences --
--   layer 2: not exists (member_blocks ...)
--   layer 3: coalesce(latest_consent.granted, channel_default)
-- -- and RLS does not answer "there is no such row"; it answers "you cannot
-- see any such row", with the identical shape. A caller holding members.view
-- at Station A and nothing but a company_memberships row at Station B saw no
-- member_consents and no member_blocks at B, so every listener asked about
-- through B came back ELIGIBLE: the one who clicked unsubscribe, and the one
-- serving an active suspension, both reported as fair game. A filtered read is
-- safe when the filter can only remove recipients. Here it only ever ADDS
-- them, which is why "no privilege to lend" was the wrong test to apply.
--
-- 0229 also never checked the listener was linked to the Station at all: a
-- member id from any Organization came back carrying the channel default,
-- which for EMAIL is eligible.
--
-- THE SHAPE IS members_blocked_bulk's (0036), deliberately, down to the three
-- arms and the errcode -- has_permission alone refuses the platform admin and
-- the owner at a suspended or archived Station, which is the regression the
-- Block 3 whole-branch review caught and the reason 0036's guard has three
-- arms rather than one. One check for the whole batch, because every id in
-- p_member_ids is asked about the same single p_company_id.
--
-- WHAT THIS MEANS FOR A CALLER WITH NO IDENTITY, replacing the paragraph 0229
-- wrote on the same question, which is now false. 0229 said a worker with no
-- auth.uid() "gets nothing back" and that Block 29d's send loop must therefore
-- "call it as somebody". Under this body it does not get nothing back: it is
-- REFUSED, 42501, on the first call. That is the better failure -- an empty
-- audience is indistinguishable from an audience nobody consented to, and a
-- send loop reading zero recipients has no way to tell "refused" from "nobody
-- to send to". 29d must still call this as somebody; it now finds that out.
--
-- LANGUAGE CHANGES FROM sql TO plpgsql, because a gate has to be able to
-- raise. CREATE OR REPLACE permits that (the name, argument types and return
-- type are unchanged), which is why it is used here rather than DROP+CREATE:
-- the ACL survives. The grants below are restated anyway, following 0030's
-- own considered precedent (0030:188-194) for superseding a shipped,
-- security-relevant function -- so this migration is self-contained rather
-- than relying on the earlier one having run first and done the right thing
-- silently.
--
-- THE FOUR LAYERS AND THE TIEBREAK ARE UNTOUCHED, character for character,
-- and the body below was taken from the LIVE function (pg_get_functiondef
-- against the running database, byte-compared with 0229's file before a line
-- changed) rather than retyped from 0229 -- this project has a documented
-- incident where recreating a function from its original migration silently
-- reverted every later fix to it. Only three things are added: the guard, the
-- link check, and this comment.
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
end;
$$;

revoke execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) from public;
grant execute on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) to authenticated;

-- Overwrites 0229's comment on this same function: COMMENT ON is a property of
-- the live catalog object, not of the migration file that last set it, so
-- \df+ and obj_description show this text from here on. Said explicitly
-- because the point of this migration is that 0229's file no longer describes
-- what runs -- the same note 0036 attached when it superseded is_member_blocked.
comment on function public.members_marketing_eligible_bulk(uuid[], uuid, public.message_channel) is
  'Block 29c, whole-branch review F29. Which of these listeners this Station may send a campaign to on this channel. Refuses a caller who is not the platform admin, not the owner of p_company_id''s Organization and does not hold members.view there (42501) -- the same three-arm guard members_blocked_bulk (0036) uses, checked once for the one Station the whole batch concerns. Then, per listener: linked to this Station at all (member_linked_to_company, 0034, the predicate this block''s write doors share), members.anonymized_at is an absolute bar, an active member_blocks suspension bars, the LATEST member_consents row for (member, company, type) decides, and absent any row the channel default applies -- WhatsApp requires an explicit yes, e-mail does not. SECURITY DEFINER, replacing 0229''s SECURITY INVOKER: two of those layers are phrased as the ABSENCE of a row, and RLS hiding a row is indistinguishable from the row not existing, so under invoker every listener at a Station the caller could not read came back eligible -- including one who had unsubscribed and one under suspension. A caller with no identity is now REFUSED rather than silently answered, which is what Block 29d needs: an empty audience cannot be told apart from an audience nobody consented to.';

-- ---------------------------------------------------------------------------
-- F32. consume_unsubscribe_token (0232) WROTE CONSENT FOR AN ERASED LISTENER.
--
-- The other three doors of this block all refuse an archived or anonymised
-- listener before writing -- record_conversation_marketing_answer (0231)
-- checks `deleted_at is null and anonymized_at is null` by name;
-- withdraw_marketing_by_phone resolves through apply_member_lookup (0061),
-- which never returns one; issue_unsubscribe_token cannot mint for a listener
-- with no live link. This door had no such check: a token minted before an
-- erasure, clicked after it, wrote member_consents rows about somebody who is
-- not supposed to have rows any more.
--
-- P0002 AND NOTHING MORE SPECIFIC, on purpose. This function already answers
-- unknown, spent and expired with one indistinguishable error so that probing
-- tokens teaches an attacker nothing; a fourth case that announced "this
-- listener was erased" would undo that, and would leak the one fact erasure
-- exists to remove. services/consent.ts maps P0002 to NotFoundError, so the
-- page says the same generic sentence it already says for the other three.
--
-- The check sits AFTER the claiming UPDATE because member_id is only known
-- from the token row. Raising here rolls the claim back with everything else,
-- which is right: nothing was withdrawn, so nothing should be spent either.
--
-- Body taken from the LIVE function (pg_get_functiondef, byte-compared with
-- 0232's file), not retyped from 0232, for the reason 0234 gives at length.
create or replace function public.consume_unsubscribe_token(
  p_token_hash   text,
  p_all_stations boolean default false
)
returns table (member_id uuid, company_id uuid, consents_written int)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_tok   public.unsubscribe_tokens;
  v_count int := 0;
begin
  -- One statement claims it: `consumed_at is null` inside the UPDATE means two
  -- simultaneous clicks cannot both win, which a SELECT-then-UPDATE would allow.
  update public.unsubscribe_tokens t
     set consumed_at = now()
   where t.token_hash = p_token_hash
     and t.consumed_at is null
     and t.expires_at > now()
  returning t.* into v_tok;

  -- ONE ANSWER FOR THREE CASES -- unknown, spent, expired. An attacker probing
  -- tokens learns nothing from the difference, and the listener sees the same
  -- page either way.
  if v_tok.id is null then
    raise exception 'no usable token' using errcode = 'P0002';
  end if;

  -- F32. The fourth case, answered identically: a listener archived or erased
  -- between the mint and the click. A withdrawal recorded for them would be a
  -- row about somebody the Organization has already been told to forget.
  if not exists (
    select 1 from public.members m
     where m.id = v_tok.member_id
       and m.deleted_at is null
       and m.anonymized_at is null
  ) then
    raise exception 'no usable token' using errcode = 'P0002';
  end if;

  if p_all_stations then
    -- Exactly the Stations this listener is linked to, and no more: a group
    -- with five Stations must not become five withdrawals for a listener who
    -- only ever joined two.
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    select l.organization_id, v_tok.member_id, l.company_id, ct, false,
           'unsubscribe-all:' || coalesce(v_tok.campaign_label, '')
      from public.member_company_links l
      cross join (values ('email_marketing'::public.member_consent_type),
                         ('whatsapp_marketing'::public.member_consent_type)) as t(ct)
     where l.member_id = v_tok.member_id
       and l.organization_id = v_tok.organization_id;
    get diagnostics v_count = row_count;
  else
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin)
    values (v_tok.organization_id, v_tok.member_id, v_tok.company_id, 'email_marketing', false,
            'unsubscribe:' || coalesce(v_tok.campaign_label, ''));
    v_count := 1;
  end if;

  return query select v_tok.member_id, v_tok.company_id, v_count;
end;
$$;

-- CREATE OR REPLACE preserved the ACL 0232 set (read back from pg_proc.proacl
-- before this migration was written: anon and authenticated hold EXECUTE, plus
-- the owner's implicit right). Restated for the same self-containment reason
-- the eligibility function's grants are, and no wider than what was there.
revoke execute on function public.consume_unsubscribe_token(text, boolean) from public;
grant execute on function public.consume_unsubscribe_token(text, boolean) to anon, authenticated;
