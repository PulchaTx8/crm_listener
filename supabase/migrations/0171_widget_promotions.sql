-- supabase/migrations/0171_widget_promotions.sql

-- Block 17c. The widget's second button: a listener reads a promotion's rules,
-- agrees, answers what it asks, and the entry lands with source 'WEB'.
--
-- Design: docs/superpowers/specs/2026-08-11-block-17c-widget-promotions-design.md

alter table public.promotions add column rules text;

alter table public.promotions
  add column web_enabled boolean not null default false;

comment on column public.promotions.web_enabled is
  'Whether this promotion takes part through the embedded widget, Block 17c (D1). The sister of whatsapp_enabled: an operator ticks either, both, or neither, and the two together decide whether the promotion converses at all. Defaults to FALSE, so every promotion that existed before 17c is invisible on the website until somebody says otherwise -- which is also what makes the constraint change below need no backfill.';

-- ---------------------------------------------------------------------------
-- THE CONSTRAINT THAT ENCODED A ONE-DOOR WORLD.
--
-- promotions_whatsapp_shape said requested_fields, use_art and art_url may only
-- exist when whatsapp_enabled -- true while the WhatsApp conversation was the
-- only thing that could ask a listener anything. 17c asks the same fields
-- through another door, so the rule is now wrong rather than merely narrow.
--
-- REPLACED BY TWO, NOT WIDENED INTO ONE. A single condition covering both doors
-- AND the WhatsApp-only fields fails as one anonymous violation: an operator who
-- forgot a hashtag would be told exactly what one who set art on a promotion
-- that converses nowhere is told. Two constraints, two names, two sentences.
--
-- No backfill: web_enabled defaults to false, which reduces the first check
-- below to the old one for every row that already exists.
-- ---------------------------------------------------------------------------
alter table public.promotions drop constraint promotions_whatsapp_shape;

alter table public.promotions
  add constraint promotions_conversational_shape check (
    whatsapp_enabled
    or web_enabled
    or (use_art = false and art_url is null and cardinality(requested_fields) = 0)
  );

alter table public.promotions
  add constraint promotions_whatsapp_fields check (
    (whatsapp_enabled and hashtag is not null)
    or (not whatsapp_enabled
        and hashtag is null
        and yes_button_label is null
        and no_button_label is null)
  );

comment on constraint promotions_conversational_shape on public.promotions is
  'Art and requested fields need a door to be asked through -- either one. Block 17c split this out of promotions_whatsapp_shape, which required WhatsApp specifically because WhatsApp was the only door there was.';

comment on constraint promotions_whatsapp_fields on public.promotions is
  'The hashtag and the two button labels are objects of the WhatsApp conversation and of nothing else, so they stay tied to whatsapp_enabled even now that a promotion can converse on the web.';

comment on column public.promotions.rules is
  'What a listener agrees to when they enter from the Station''s own website, Block 17c (D2). NULLABLE, and the null case is meaningful rather than broken: a promotion with no rules does not appear in the widget at all (D3), because an agreement box above nothing is exactly what this column exists to prevent. WRITING IT IS HOW AN OPERATOR PUBLISHES A PROMOTION TO THE WEBSITE -- which is why 17c needs no `web_enabled` flag beside whatsapp_enabled: the rules text is the opt-in. Every promotion that existed before this migration has null here, so the widget list is empty at every Station until somebody writes the first one.';

-- ---------------------------------------------------------------------------
-- The three refusals every widget door shares.
--
-- EXTRACTED HERE RATHER THAN REUSED FROM 0167. widget_music_request_context
-- answers the same three questions and then computes a music cooldown, which a
-- promotion has no use for. Calling it would mean every promotion request paid
-- for a query about song requests, and reading it would mean a future editor
-- changing "the music context" and silently changing promotions too.
--
-- 0167 IS DELIBERATELY LEFT ALONE. Rewriting its body to call this is a retype
-- of a shipped function, which is how 0168 reverted 0163's public-key pin one
-- block ago. Converging the two is a follow-up with its own tests; until then
-- the three refusals exist in two places and both comments say so.
-- ---------------------------------------------------------------------------
create function public.widget_listener_context(
  p_public_key text,
  p_member_id  uuid,
  out o_company uuid,
  out o_org     uuid,
  out o_reason  text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- ONE ANSWER for unknown, disabled, archived and a suspended Station, which
  -- is the choice 0161, 0164 and 0167 already made: probing teaches nothing the
  -- iframe's `src` did not already say out loud.
  select i.company_id, i.organization_id
    into o_company, o_org
    from public.widget_installations i
    join public.companies c
      on c.id = i.company_id
     and c.deleted_at is null
     and c.status = 'active'
     and c.suspended_at is null
   where i.public_key = p_public_key
     and i.deleted_at is null
     and i.enabled;

  if not found then
    o_reason := 'unknown_installation';
    return;
  end if;

  -- The listener is checked against the Station THIS KEY names, never against
  -- anything the caller supplied. The widget cookie's Path is `/w`, one path
  -- for every installation this deployment serves, so a browser identified at
  -- Station A sends that cookie to Station B as well.
  if not exists (
    select 1
      from public.members m
      join public.member_company_links l
        on l.member_id = m.id and l.company_id = o_company
     where m.id = p_member_id
       and m.organization_id = o_org
       and m.deleted_at is null
  ) then
    o_reason := 'unknown_listener';
    return;
  end if;

  -- 0034's erasure, never cured by writing the same defect under a new row.
  if exists (
    select 1 from public.members where id = p_member_id and anonymized_at is not null
  ) then
    o_reason := 'listener_anonymized';
  end if;
end;
$$;

comment on function public.widget_listener_context is
  'Block 17c, internal. The three refusals every widget door shares -- unknown_installation, unknown_listener, listener_anonymized -- and the Station they resolve to. Granted to nobody: the doors below are what callers use. 0167''s widget_music_request_context answers the same three and then computes a music cooldown; converging them is a follow-up, and until it happens this reasoning lives in two places.';

-- ---------------------------------------------------------------------------
-- The write half of the eight-way field mapping.
--
-- EXTRACTED SO THIS BLOCK IS NOT ITS THIRD COPY. 0065's member_field_value
-- reads the mapping and 0071's complete_conversation writes it inline; both
-- comments name each other precisely because a ninth requested field is an edit
-- in every copy. This is now the third PLACE but the second WRITER, and 0071
-- adopting it is a follow-up rather than a retype of a shipped body.
-- ---------------------------------------------------------------------------
create function public.apply_member_field_values(
  p_member_id uuid,
  p_fields    jsonb
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.members where id = p_member_id;
  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- coalesce per field so an unanswered one is left alone rather than blanked:
  -- the step list only contains what was asked, and a walk re-run could carry
  -- fewer answers than the record already holds. 0071's own reasoning.
  update public.members m set
    full_name        = coalesce(nullif(btrim(p_fields ->> 'full_name'), ''), m.full_name),
    address_line     = coalesce(nullif(btrim(p_fields ->> 'address'), ''), m.address_line),
    city             = coalesce(nullif(btrim(p_fields ->> 'city'), ''), m.city),
    neighbourhood    = coalesce(nullif(btrim(p_fields ->> 'neighbourhood'), ''), m.neighbourhood),
    birth_date       = coalesce((nullif(btrim(p_fields ->> 'age'), ''))::date, m.birth_date),
    cpf_hash         = coalesce(nullif(btrim(p_fields ->> 'cpf'), ''), m.cpf_hash),
    passport         = coalesce(nullif(btrim(p_fields ->> 'passport'), ''), m.passport),
    discovery_source = coalesce(nullif(btrim(p_fields ->> 'discovery_source'), ''), m.discovery_source),
    updated_at       = now()
  where m.id = p_member_id;

  -- ONE CONFIRMATION PER FIELD THE LISTENER ACTUALLY ANSWERED, stamped now
  -- rather than with any time the caller supplied: the confirmation records
  -- when we were told.
  insert into public.member_field_confirmations (member_id, organization_id, field, confirmed_at)
  select p_member_id, v_org, k::public.promotion_requested_field, now()
  from jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
  on conflict (member_id, field) do update set confirmed_at = excluded.confirmed_at;
end;
$$;

comment on function public.apply_member_field_values is
  'Block 17c. Writes the values a listener gave for a promotion''s requested fields onto their record, and stamps one confirmation per field they actually answered. The eight-way mapping is written out here rather than derived; member_field_value (0065) is the read half and complete_conversation (0071) still carries its own write half, so a NINTH requested field is an edit in all three until 0071 adopts this. Granted to nobody: called from inside a SECURITY DEFINER body.';

-- ---------------------------------------------------------------------------
-- The list.
-- ---------------------------------------------------------------------------
create function public.widget_promotions(
  p_public_key text,
  p_member_id  uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v record;
begin
  select * into v from public.widget_listener_context(p_public_key, p_member_id);
  if v.o_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v.o_reason);
  end if;

  return jsonb_build_object(
    'ok', true,
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              p.id,
               'name',            p.name,
               'rules',           p.rules,
               'art_url',         p.art_url,
               'thumb_url',       p.thumb_url,
               -- What the listener still has to answer, computed by the SAME
               -- function the WhatsApp bot uses (0066), so a promotion
               -- configured once asks the same things at both doors. Carried in
               -- the list so choosing one costs no second round trip.
               'steps',           public.whatsapp_conversation_steps(p.id, p_member_id),
               'already_entered', exists (
                 select 1 from public.participations pa
                  where pa.promotion_id = p.id
                    and pa.member_id = p_member_id
                    and pa.status = 'VALID'))
             order by p.ends_at)
        from public.promotions p
       where p.company_id = v.o_company
         and p.deleted_at is null
         and p.cancelled_at is null
         -- TWO CONDITIONS, and they say different things. web_enabled is where
         -- the promotion belongs (D1); the rules are the content this door
         -- requires (D2, D3). Ticking the box does not write the wording, and
         -- an agreement box above nothing is what D2 exists to prevent -- so an
         -- operator who ticked one and not the other gets a promotion that is
         -- correctly configured and correctly invisible, and the promotions
         -- screen says which half is missing.
         and p.web_enabled
         and p.rules is not null
         and btrim(p.rules) <> ''
         and now() between p.starts_at and p.ends_at), '[]'::jsonb));
end;
$$;

comment on function public.widget_promotions is
  'Block 17c. The Station''s live promotions as the widget shows them: name, rules, art, what this listener still has to answer, and whether they already have a valid entry. A promotion with no rules is absent (D3) -- that column is the website opt-in. Refuses by the same names as every other widget door. Granted to service_role only.';

-- ---------------------------------------------------------------------------
-- The write.
-- ---------------------------------------------------------------------------
create function public.widget_enter_promotion(
  p_public_key   text,
  p_member_id    uuid,
  p_promotion_id uuid,
  p_consent      boolean,
  p_fields       jsonb default '{}',
  p_answers      jsonb default '[]'
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
       -- The same two conditions the list applies, restated rather than
       -- trusted: a promotion unticked or emptied of its rules between the
       -- list rendering and this submission must not be entered.
       and p.web_enabled
       and p.rules is not null
       and btrim(p.rules) <> ''
       and now() between p.starts_at and p.ends_at
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

  return jsonb_build_object('ok', true, 'participation_id', v_id, 'status', v_status);
end;
$$;

comment on function public.widget_enter_promotion is
  'Block 17c. Records an entry made from the Station''s own website. Refuses by name -- unknown_installation, unknown_listener, listener_anonymized, promotion_closed, missing_answers, already_entered, refused -- so the widget can say which happened. THE STEP LIST IS RECOMPUTED HERE rather than trusted from the payload: the screen is not the authority on what a promotion asks, and a promotion edited mid-walk would otherwise be answered wrongly. Declining writes promotion_refusals stamped WEB and nothing else. Agreeing writes a `rules` consent row, which is a deliberate divergence from complete_conversation (0071), which records none. Granted to service_role only.';

revoke execute on function public.widget_listener_context(text, uuid) from public;
revoke execute on function public.apply_member_field_values(uuid, jsonb) from public;
revoke execute on function public.widget_promotions(text, uuid) from public;
revoke execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb) from public;

grant execute on function public.widget_promotions(text, uuid) to service_role;
grant execute on function public.widget_enter_promotion(text, uuid, uuid, boolean, jsonb, jsonb) to service_role;
