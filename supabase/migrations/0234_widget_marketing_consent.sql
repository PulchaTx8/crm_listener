-- supabase/migrations/0234_widget_marketing_consent.sql

-- Block 29c, Task 9. The widget's marketing checkbox is recorded through the
-- one door that already proves this caller may act for this member and this
-- Station -- widget_enter_promotion (0171, amended by 0186) -- rather than
-- through a new door taking a member id from `anon`. The widget is public;
-- a door shaped that way would let anyone on the internet write a consent row
-- for any listener, the same class of defect Task 5's F15 had to close as a
-- Critical. This extends the one call that already carries that proof, so the
-- consent belongs inside its authorisation rather than beside it.
--
-- NOT record_member_consent (0034) EITHER: that function gates on
-- has_permission, which reads auth.uid() -- always null for the service-role
-- client this door is called through. Task 4 hit the identical wall twice
-- (0231's own comments on withdraw_marketing_by_phone and
-- record_conversation_marketing_answer) and wrote a direct insert both times.
-- This is that same fix, done inline rather than as a fourth door.
--
-- DROP + CREATE, NOT CREATE OR REPLACE: a new parameter changes the
-- signature, and CREATE OR REPLACE only replaces a function whose signature
-- matches exactly -- otherwise it defines a second overload alongside the one
-- this migration means to retire. The body below is copied from the LIVE
-- function (pg_get_functiondef against the running database, verified
-- byte-identical to 0186's own body before a single line changed) rather than
-- retyped from either 0171 or 0186 -- this project has a documented incident
-- where recreating a function from its original migration silently reverted
-- every fix a later migration had made to it.
--
-- THE GRANTS ARE REISSUED EXPLICITLY: DROP destroys the ACL a CREATE OR
-- REPLACE would have preserved. Read from the running database before this
-- migration touched anything (pg_proc.proacl): '{postgres=X/postgres,
-- service_role=X/postgres}' -- EXECUTE held by service_role only, plus the
-- owner's own implicit right, which needs no grant statement. Restored
-- exactly that below, no wider.
--
-- p_marketing_consent IS THE LAST PARAMETER, not inserted beside p_consent,
-- so every existing POSITIONAL call in supabase/tests/42_widget_promotions.
-- test.sql -- four and six arguments alike -- keeps meaning what it already
-- meant. The widget's own server action calls this RPC by name
-- (promotion-actions.ts already names every argument it sends), so where the
-- new one lands in the parameter list does not affect it either.
drop function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb);

create function public.widget_enter_promotion(
  p_public_key         text,
  p_member_id          uuid,
  p_promotion_id       uuid,
  p_consent            boolean,
  p_fields             jsonb default '{}'::jsonb,
  p_answers            jsonb default '[]'::jsonb,
  p_marketing_consent  boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v         record;
  v_steps   jsonb;
  v_missing integer;
  v_result  jsonb;
  v_id      uuid;
  v_status  text;
begin
  select * into v from public.widget_listener_context(p_public_key, p_member_id);
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  -- THE PROMOTION IS RESOLVED AGAINST THE STATION THE KEY NAMES. A caller
  -- handing us a promotion id from another Station gets the same answer as one
  -- naming a promotion that never existed.
  if not exists (
    select 1 from public.promotions p
     where p.id = p_promotion_id
       and p.company_id = v.o_company
       and p.deleted_at is null
       and p.cancelled_at is null
       -- The same three conditions the list applies, restated rather than
       -- trusted: a promotion unticked, emptied of its rules, or emptied of a
       -- question's alternatives between the list rendering and this
       -- submission must not be entered.
       and p.web_enabled
       and p.rules is not null
       and btrim(p.rules) <> ''
       and now() between p.starts_at and p.ends_at
       -- The third condition, added by 0186. Without it this door answers
       -- missing_answers for a question the listener was never shown --
       -- blaming the visitor for the configuration -- where promotion_closed
       -- is both true and actionable.
       and not exists (
         select 1
           from public.promotion_questions q
          where q.promotion_id = p.id
            and q.kind <> 'ESSAY'
            and not exists (
              select 1 from public.promotion_question_options o
               where o.question_id = q.id))
  ) then
    return jsonb_build_object('ok', false, 'reason', 'promotion_closed');
  end if;

  -- DECLINING IS A REAL PATH, not an abandonment, and it is recorded in the
  -- same table the WhatsApp flow writes -- stamped with the door it came
  -- through, which is what the source column on that table is for.
  if not coalesce(p_consent, false) then
    insert into public.promotion_refusals
      (promotion_id, member_id, organization_id, company_id, source)
    values
      (p_promotion_id, p_member_id, v.o_org, v.o_company, 'WEB');

    return jsonb_build_object('ok', false, 'reason', 'refused');
  end if;

  -- THE STEP LIST IS RECOMPUTED HERE, and this is the assertion the block is
  -- built around: THE SCREEN IS NOT THE AUTHORITY ON WHAT TO ASK. A promotion
  -- edited while somebody had the widget open would otherwise write an entry
  -- answering questions it no longer asks -- and a crafted payload would skip
  -- whichever field it found inconvenient.
  v_steps := public.whatsapp_conversation_steps(p_promotion_id, p_member_id);

  select count(*) into v_missing
    from jsonb_array_elements(v_steps) s
   where (s ->> 'kind') = 'field'
     and nullif(btrim(coalesce(p_fields ->> (s ->> 'field'), '')), '') is null;

  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_answers');
  end if;

  select count(*) into v_missing
    from jsonb_array_elements(v_steps) s
   where (s ->> 'kind') = 'question'
     and not exists (
       select 1 from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) a
        where (a ->> 'question_id') = (s ->> 'questionId'));

  if v_missing > 0 then
    return jsonb_build_object('ok', false, 'reason', 'missing_answers');
  end if;

  perform public.apply_member_field_values(p_member_id, coalesce(p_fields, '{}'::jsonb));

  -- THE DIVERGENCE, DELIBERATE AND RULED ON BY THE OWNER. 0071's
  -- complete_conversation records no consent at all when a listener agrees on
  -- WhatsApp; only a refusal is written. Here a rules text was displayed and
  -- agreed to, so there is something to record and 0032's `rules` consent type
  -- exists for exactly it. WhatsApp will record the same when that door is next
  -- worked on; until then the two differ, in writing.
  --
  -- recorded_by is null for the reason 0161 gives: a website visitor is not an
  -- auth.users row.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, recorded_by)
  values
    (v.o_org, p_member_id, v.o_company, 'rules', true, 'web-widget', null);

  -- The same core the operator's door and the import use, so the doors cannot
  -- come to disagree about what entering means.
  v_result := public.apply_participation(
    p_promotion_id, p_member_id, now(), 'WEB', coalesce(p_answers, '[]'::jsonb));

  v_status := v_result ->> 'status';
  v_id     := (v_result ->> 'participation_id')::uuid;

  -- apply_participation ANSWERS RATHER THAN RAISES for a repeat: 'DUPLICATE'
  -- when the promotion allows one entry and this listener already has it. That
  -- is a refusal to the visitor, not a success with an odd status, and the
  -- panel needs to say so.
  if v_status is distinct from 'VALID' then
    return jsonb_build_object('ok', false, 'reason', 'already_entered', 'status', v_status);
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'widget_enter_promotion', 'participations', v_id, v.o_org, v.o_company,
     jsonb_build_object('public_key', p_public_key, 'promotion_id', p_promotion_id));

  -- Block 29c, Task 9. THE WIDGET IS THIS BLOCK'S ONLY WORKING COLLECTION
  -- POINT: the WhatsApp conversation's own marketing_consent step cannot
  -- fire, because nothing has opened a conversation since Block 19a
  -- (services/conversation.ts's own comment on 0179, at the `open()` call
  -- that never runs). Every participation reaches here, so this is where
  -- whatsapp_marketing is asked and answered, in BOTH directions -- true from
  -- a ticked box, false from an unticked one -- because the decline is
  -- itself the fact an audit needs: not "never asked" but "asked, and said
  -- no". record_conversation_marketing_answer (0231, F9) records its own
  -- door's Yes/No the identical way, for the identical reason.
  --
  -- ISOLATED IN ITS OWN SUB-BLOCK, on purpose, the same shape the sweep
  -- functions use for a per-item failure that must not stop the run (0094's
  -- own comment): a listener whose consent write fails must still be entered
  -- in the promotion, and by this point the entry above is already recorded
  -- (and audited). Catching everything is the price of that guarantee; the
  -- failure is NAMED -- the participation id and SQLERRM -- in a WARNING
  -- rather than swallowed silently, so it still reaches the server log even
  -- though it must never reach the visitor as a refusal of an entry that, in
  -- fact, succeeded.
  --
  -- origin = 'widget' pairs with record_conversation_marketing_answer's own
  -- 'conversation', naming which door asked. It is deliberately NOT
  -- 'web-widget', the string the 'rules'/'identification' consents above use:
  -- those predate this block and name a different consent entirely: reusing
  -- their string would make one origin value describe two unrelated
  -- questions.
  --
  -- promotion_id IS CARRIED, matching record_conversation_marketing_answer's
  -- own shape for the identical question (which promotion's participation
  -- this answer travelled with) -- unlike the 'rules' insert three lines
  -- above, which predates promotion_id existing on this table at all (0032's
  -- own comment: "Promotions do not exist yet").
  begin
    insert into public.member_consents
      (organization_id, member_id, company_id, consent_type, granted, origin,
       promotion_id, recorded_by)
    values
      (v.o_org, p_member_id, v.o_company, 'whatsapp_marketing', p_marketing_consent,
       'widget', p_promotion_id, null);
  exception
    when others then
      raise warning 'widget_enter_promotion: whatsapp_marketing consent write failed for participation %: %',
        v_id, sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'participation_id', v_id, 'status', v_status);
end;
$$;

comment on function public.widget_enter_promotion is
  'Block 17c. Records an entry made from the Station''s own website. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, promotion_closed, missing_answers, already_entered, refused -- so the widget can say which happened. THE STEP LIST IS RECOMPUTED HERE rather than trusted from the payload: the screen is not the authority on what a promotion asks, and a promotion edited mid-walk would otherwise be answered wrongly. Since 0186 it restates THREE of the list''s conditions rather than two -- web_enabled, rules present, and no non-ESSAY question left without alternatives -- so a browser holding a list drawn before the options were deleted is answered promotion_closed rather than blamed with missing_answers for a question nobody could see. Declining writes promotion_refusals stamped WEB and nothing else. Agreeing writes a `rules` consent row, which is a deliberate divergence from complete_conversation (0071), which records none. Since Block 29c (Task 9) it ALSO writes a `whatsapp_marketing` consent row from `p_marketing_consent` -- true or false, both recorded -- ONLY after the participation above is confirmed VALID, isolated in its own exception-catching sub-block so a failure there cannot undo an entry that already succeeded (a WARNING names the participation and SQLERRM instead). origin `widget` pairs with record_conversation_marketing_answer''s (0231) `conversation`; neither door writes through record_member_consent (0034), which is unreachable for a service-role caller with no auth.uid(). Granted to service_role only.';

-- create or replace does not reset privileges, but this migration used DROP,
-- which does -- these two statements are load-bearing here, not merely
-- restated for the reason 0171/0186 give.
revoke execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb, boolean) from public;
grant execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb, boolean) to service_role;
