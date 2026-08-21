-- supabase/migrations/0268_widget_fast_entry.sql

-- Block 30d, D8 and D10. A promotion with nothing left to ask of this listener
-- takes the entry on the web the way 0267 made it take one on WhatsApp: the
-- panel draws no rules screen, and the consent row this door writes anyway
-- says which of the two things happened.
--
-- THE ENTRY ITSELF DOES NOT CHANGE. This door already entered a listener whose
-- recomputed step list was empty -- both missing-answer counts were zero and
-- p_consent arrived true. The rules screen was the PANEL's, not this door's,
-- and what 0268 changes here is one INSERT.
--
-- TWO CHANGES TO THAT INSERT, argued where they sit:
--   * promotion_id, which was null on the one consent_type 0032's column
--     comment names as the column's purpose; and
--   * origin, now 'web-widget-entry' when nothing was asked and 'web-widget'
--     when the listener walked and ticked.
-- The owner ruled on 2026-08-21 that the row is written on the fast path even
-- though nobody clicks. The objection -- that a row recording an acceptance
-- nobody clicked is weaker than no row -- was put and answered; this is what
-- makes the row say what actually happened instead.
--
-- CREATE OR REPLACE, NOT DROP + CREATE: the signature is untouched, so there
-- is no overload to retire and no ACL to lose. proacl before this migration,
-- read from the running database: '{postgres=X/postgres,
-- service_role=X/postgres}'. The two statements at the foot restate that and
-- change nothing, for the reason 0171 and 0186 give: the file that redefines a
-- door should read as the whole truth about who may open it.
--
-- THE BODY IS THE LIVE ONE. Copied from pg_get_functiondef against the running
-- database -- 0234, not 0171 and not 0186, both of which this project's own
-- design spec cited wrongly for this function once already. Recreating a
-- function from the migration that introduced it silently reverts every repair
-- made since, with nothing turning red.
--
-- AND THE COMMENTS THIS CHANGE FALSIFIED ARE FIXED IN PLACE. The
-- whatsapp_marketing block below explained itself in terms of a box that is
-- always shown and a `rules` row that never names its promotion; neither is
-- true after this migration. Its logic is untouched -- the gap the fast path
-- opens in it is named there and left for the owner, because closing it would
-- rewrite the three-way rule 42_widget_promotions.test.sql pins.

create or replace function public.widget_enter_promotion(
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
  v_fast    boolean;
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

  -- Block 30d, D8. NOTHING LEFT TO ASK, read off the list this function has
  -- just recomputed and never off anything a browser sent -- the same
  -- predicate ingest_whatsapp_event (0267) tests before a hashtag takes an
  -- entry, so the two doors cannot come to disagree about which promotions ask
  -- nothing. It is a question about the PAIR (promotion, listener): a
  -- promotion with no quiz still asks a newcomer for the fields it declares,
  -- and asks a listener who has already given them for nothing.
  --
  -- IT CHANGES NO OUTCOME, ONLY WHAT THE CONSENT ROW SAYS. An empty step list
  -- was entered here before this migration exactly as it is after it -- both
  -- missing-answer counts below are zero either way, and p_consent has always
  -- been a boolean this door takes on trust. What is new is that the row can
  -- be told apart from one a tick produced.
  --
  -- 'consent' IS NOT COUNTED, and it is the first element of every list
  -- whatsapp_conversation_steps can build: by the owner's ruling of 2026-08-21
  -- the rules screen does not appear on this path at all.
  select not exists (
    select 1 from jsonb_array_elements(v_steps) s
     where (s ->> 'kind') in ('field', 'question'))
    into v_fast;

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
  -- WhatsApp; only a refusal is written. 0267's fast path, which takes an entry
  -- from a hashtag, records none either and says so in its own comment. Here a
  -- rules text exists and the listener asked to take part, so there is
  -- something to record and 0032's `rules` consent type exists for exactly it.
  -- The web door and the WhatsApp door still differ, in writing.
  --
  -- "AGREED" DOES NOT MEAN THE SAME THING ON BOTH WEB PATHS, and that is what
  -- the origin below exists to say. On the walk the listener was shown the
  -- rules and ticked a box. On the fast path -- D10, the owner's ruling of
  -- 2026-08-21 -- there is no rules screen: choosing the promotion IS the
  -- agreement, and the panel renders the text on the confirmation instead
  -- (enter-promotion.tsx), so it stays readable rather than unshown.
  --
  -- recorded_by is null for the reason 0161 gives: a website visitor is not an
  -- auth.users row.
  --
  -- Block 30d, D10. TWO CHANGES, and both are about what this row can prove.
  --
  -- promotion_id was null, on a consent whose whole content is "which rules".
  -- 0032's column comment says the column is "expected to be set only when
  -- consent_type = 'rules'" -- this row, and no other kind. That it is an
  -- oversight rather than a policy is settled inside this same function: the
  -- whatsapp_marketing consent written at the end has always filled it, for a
  -- consent_type that comment did not have in mind at all.
  --
  -- The origin distinguishes the two paths for ever. On the fast path nobody
  -- clicked a rules screen -- the consent comes from the act of entering, the
  -- way sending a hashtag does on WhatsApp -- and a row that cannot be told
  -- apart from a clicked one would be a record claiming something that did not
  -- happen. Every row this door wrote before 0268 carries 'web-widget' and came
  -- from a ticked box, because the panel had no other way to submit; nothing is
  -- rewritten and nothing has to be.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin,
     promotion_id, recorded_by)
  values
    (v.o_org, p_member_id, v.o_company, 'rules', true,
     case when v_fast then 'web-widget-entry' else 'web-widget' end,
     p_promotion_id, null);

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
  -- whatsapp_marketing is asked and answered.
  --
  -- BLOCK 30d, D10 NARROWED THAT LAST SENTENCE, AND DID NOT CLOSE WHAT IT
  -- OPENS. Every participation still reaches this code -- but on the fast path
  -- (v_fast, above) the panel draws no consent screen, so the box is never
  -- SHOWN: it posts the unticked default and this block answers a question
  -- nobody was asked. What lands is granted = false, which is true as a fact --
  -- consent was not given -- and misleading as a record, because arm B below
  -- reads a false row as "asked once, and said no". IT IS LEFT AS IT IS, and
  -- not because the case is rare: the cases pinning arms B and C in
  -- 42_widget_promotions.test.sql enter a promotion that asks nothing, so they
  -- run on this very path. Whether a listener who was never asked should be
  -- recorded at all is a product question the owner has not been put, and
  -- deciding it here would rewrite a rule those cases exist to hold still.
  --
  -- FIX ROUND 1, F23 (CRITICAL). THE FIRST VERSION WROTE AN UNCONDITIONAL ROW
  -- PER ENTRY AND REACHED LOGIC THAT SILENTLY REVOKES. The box renders
  -- unticked on EVERY entry, not only the first, and eligibility reads the
  -- LATEST whatsapp_marketing row per (member, company)
  -- (members_marketing_eligible_bulk, 0229). So a listener who opted in once
  -- and simply did not re-tick on a LATER promotion was written back to
  -- false with no withdrawal and no notice -- hitting repeat participants
  -- hardest, who are exactly the audience this block exists to build. A
  -- THREE-WAY RULE replaces the blanket insert:
  --   TICKED                         -> write true, ALWAYS -- a re-consent is
  --                                      harmless and it is how somebody
  --                                      changes their mind, even from a
  --                                      prior explicit decline.
  --   UNTICKED, no row exists yet    -> write false. This is what makes
  --                                      "asked once" true ON THE WALK: a
  --                                      decline has to land somewhere or the
  --                                      listener is asked forever. On the fast
  --                                      path nothing was asked at all -- see
  --                                      the D10 note above.
  --   UNTICKED, a row already exists -> write NOTHING. Silence must never
  --                                      revoke -- an unticked box on a
  --                                      second, third, ... entry says
  --                                      nothing about the listener's
  --                                      earlier answer.
  -- The existence check is scoped to (member_id, company_id), the same pair
  -- members_marketing_eligible_bulk reads latest-row-wins over, and
  -- deliberately NOT to promotion_id: this is a consent about the Station on
  -- a channel, not about any one promotion.
  --
  -- record_conversation_marketing_answer (0231, F9) records a ticked/unticked
  -- answer as a plain true/false because its step runs AT MOST ONCE per
  -- listener per Station by construction (spec D2) -- there is no repeat
  -- entry on that door for a stale unticked default to misfire against. This
  -- door has no such guarantee: every promotion entry reaches it, so the
  -- three-way rule above is what this door needs that the conversation door
  -- does not.
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
  -- 'web-widget' or 'web-widget-entry', the two strings the
  -- 'rules'/'identification' consents use: those predate this block and name a
  -- different consent entirely, and reusing one of them would make a single
  -- origin value describe two unrelated questions. It is NOT split by path the
  -- way the `rules` row became in 0268, and that is a gap rather than a
  -- decision -- the same one the D10 note at the top of this block records.
  --
  -- promotion_id IS CARRIED on the row THIS block writes, matching
  -- record_conversation_marketing_answer's own shape for the identical
  -- question (which promotion's participation this answer travelled with).
  -- THE `rules` INSERT EARLIER IN THIS FUNCTION carries it too since 0268
  -- (Block 30d, D10) and did not before, even though 0032's own column comment
  -- expects it precisely for consent_type = 'rules' -- 0032 declared the
  -- column, nullable, before public.promotions existed (its comment's "does
  -- not exist yet" names the TABLE, not the column, which is why the column is
  -- nullable rather than absent; the foreign key member_consents_promotion_fk
  -- exists today, so that half of the sentence is stale rather than wrong).
  -- This row is what proved the gap was an oversight: one function, two
  -- consent rows, and only one of them able to name the promotion.
  declare
    v_marketing_row_exists boolean;
  begin
    if p_marketing_consent then
      insert into public.member_consents
        (organization_id, member_id, company_id, consent_type, granted, origin,
         promotion_id, recorded_by)
      values
        (v.o_org, p_member_id, v.o_company, 'whatsapp_marketing', true,
         'widget', p_promotion_id, null);
    else
      select exists (
        select 1 from public.member_consents
         where member_id = p_member_id
           and company_id = v.o_company
           and consent_type = 'whatsapp_marketing'
      ) into v_marketing_row_exists;

      if not v_marketing_row_exists then
        insert into public.member_consents
          (organization_id, member_id, company_id, consent_type, granted, origin,
           promotion_id, recorded_by)
        values
          (v.o_org, p_member_id, v.o_company, 'whatsapp_marketing', false,
           'widget', p_promotion_id, null);
      end if;
    end if;
  exception
    when others then
      raise warning 'widget_enter_promotion: whatsapp_marketing consent write failed for participation %: %',
        v_id, sqlerrm;
  end;

  return jsonb_build_object('ok', true, 'participation_id', v_id, 'status', v_status);
end;
$$;

comment on function public.widget_enter_promotion is
  'Block 17c. Records an entry made from the Station''s own website. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, promotion_closed, missing_answers, already_entered, refused -- so the widget can say which happened. THE STEP LIST IS RECOMPUTED HERE rather than trusted from the payload: the screen is not the authority on what a promotion asks, and a promotion edited mid-walk would otherwise be answered wrongly. Since 0186 it restates THREE of the list''s conditions rather than two -- web_enabled, rules present, and no non-ESSAY question left without alternatives -- so a browser holding a list drawn before the options were deleted is answered promotion_closed rather than blamed with missing_answers for a question nobody could see. Declining writes promotion_refusals stamped WEB and nothing else. Agreeing writes a `rules` consent row, which is a deliberate divergence from complete_conversation (0071) and from ingest_whatsapp_event''s fast path (0267), both of which record none. Since 0268 (Block 30d, D10) that row NAMES THE PROMOTION -- the column 0032 declared for exactly this consent_type -- and its origin says which path produced it: `web-widget` when the listener was shown the rules and ticked, `web-widget-entry` when the recomputed step list held no field and no question, in which case the panel draws no rules screen at all and choosing the promotion is the agreement. Since Block 29c (Task 9, fix round 1 F23) it ALSO writes a `whatsapp_marketing` consent row from `p_marketing_consent`, by a three-way rule rather than a blanket insert: ticked always writes true (a re-consent is harmless); unticked writes false only when no whatsapp_marketing row exists yet for (member, company); unticked writes NOTHING when one already does, because a repeat entry''s default-unticked box must never silently revoke an earlier opt-in (eligibility, 0229, reads the latest row). On the `web-widget-entry` path that box is never shown, so the false arm answers a question nobody was asked -- recorded in the function body, not closed here. Written ONLY after the participation above is confirmed VALID, isolated in its own exception-catching sub-block so a failure there cannot undo an entry that already succeeded (a WARNING names the participation and SQLERRM instead). origin `widget` pairs with record_conversation_marketing_answer''s (0231) `conversation`; neither door writes through record_member_consent (0034), which is unreachable for a service-role caller with no auth.uid(). Granted to service_role only.';

-- create or replace does not reset privileges, so neither statement below
-- changes anything today. They are restated for the reason 0171 states them:
-- the file that redefines a door should read as the whole truth about who may
-- open it.
revoke execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb, boolean) from public;
grant execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb, boolean) to service_role;
