-- supabase/migrations/0259_promotion_rules_gate.sql

-- Block 30c, items 15 and (the plumbing for) 10 and 17.
--
-- BOTH BODIES BELOW ARE THE LIVE DEFINITIONS (pg_get_functiondef), with the
-- edits listed here and nothing else. These two functions have been redefined
-- SIX times -- 0042, 0050, 0055, 0144, 0172, 0184 -- and 0172's own header
-- records what retyping one costs: "Retyping a shipped body is how 0168
-- silently reverted 0163's public-key pin one block ago." Re-deriving from 0172
-- would revert 0184's hashtag collision guard; from 0144, five rounds at once.
-- Nothing would turn red.
--
-- The edits are only these:
--
--   * p_authorization_certificate and p_show_id are appended to both parameter
--     lists and written to the row.
--   * update_promotion gains the rules gate below. create_promotion gains its
--     simpler half: there is no previous row, so any door-on-and-blank is
--     refused outright.
--
-- DROP AND CREATE, NOT create or replace, and this is not housekeeping: adding
-- a parameter changes the signature, and `create or replace` with a different
-- argument list creates an OVERLOAD -- the 17-argument function would survive
-- beside the 19-argument one and PostgREST would keep resolving to whichever
-- matched the call. 0172 faced this and dropped explicitly for the same reason.
-- The drop destroys the ACL, so both grants are restated at the end.

drop function if exists public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text);
drop function if exists public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text);

-- ===== update_promotion (live definition, pg_get_functiondef, confirmed byte
-- for byte identical to 0184's body before the edits below) =====
create function public.update_promotion(
  p_promotion_id              uuid,
  p_name                      text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_site_integration_code     integer default null,
  p_call_to_action            text default null,
  p_allow_multiple_entries    boolean default false,
  p_min_hours_between_entries integer default null,
  p_require_correct_answer    boolean default false,
  p_whatsapp_enabled          boolean default false,
  p_hashtag                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}',
  p_max_entries_per_member    integer default null,
  -- Block 17c. Appended rather than slotted beside p_whatsapp_enabled, so every
  -- existing positional call site keeps meaning what it meant.
  p_web_enabled               boolean default false,
  p_rules                     text default null,
  -- Block 30c. Appended for the same reason 17c gives above: every existing
  -- positional call site keeps meaning what it meant.
  p_authorization_certificate text default null,
  p_show_id                   uuid default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_name    text := nullif(btrim(p_name), '');
  v_cta     text := nullif(btrim(coalesce(p_call_to_action, '')), '');
  v_hashtag text := nullif(btrim(coalesce(p_hashtag, '')), '');
  v_yes     text := nullif(btrim(coalesce(p_yes_button_label, '')), '');
  v_no      text := nullif(btrim(coalesce(p_no_button_label, '')), '');
  v_certificate text := nullif(btrim(coalesce(p_authorization_certificate, '')), '');
  -- The two frozen fields as they stand. Read by the select that already takes
  -- FOR UPDATE rather than by a second statement of their own: a second read
  -- would sit outside nothing at all — the lock is already held — but it would
  -- be a second place that has to remember the filter on deleted_at, and the
  -- first one is right there.
  v_current_hashtag text;
  v_current_starts  timestamptz;
  -- The banner as it stands, read in the same select for the same reason. Used
  -- only when WhatsApp is being switched off; see the enqueue below.
  v_current_art     text;
  -- Block 30c D2. The two door flags and the rules text as they stood before
  -- this write, read in the same select for the same reason as the three
  -- above. Used by the gate below to tell a transition from a state already
  -- reached -- 0171 made rules nullable, so a promotion may already be
  -- door-on and rules-blank.
  v_current_whatsapp boolean;
  v_current_web      boolean;
  v_current_rules    text;
  v_frozen          boolean;
  -- Which constraint the UPDATE below tripped. Two of the three violations this
  -- function can raise share sqlstate 23505, so the handler has to ask.
  v_constraint      text;
begin
  -- FOR UPDATE, so two edits racing serialise rather than both reading the
  -- same "before" and each writing a whole row over the other's fields. It is
  -- also what makes the freeze below decidable: the participation count and the
  -- row it is compared against are read under one lock, so an entry arriving
  -- mid-edit either loses the race or is seen.
  select organization_id, company_id, hashtag, starts_at, art_url,
         whatsapp_enabled, web_enabled, rules
    into v_org, v_company, v_current_hashtag, v_current_starts, v_current_art,
         v_current_whatsapp, v_current_web, v_current_rules
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'update_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the promotion needs a name' using errcode = '22023';
  end if;
  if p_starts_at is null or p_ends_at is null then
    raise exception 'the promotion needs a start and an end' using errcode = '22023';
  end if;

  -- Block 4a's D9. Placed AFTER the two presence checks above rather than
  -- immediately after the permission check, and the difference is a sentence an
  -- operator reads. `p_starts_at is distinct from v_current_starts` is TRUE when
  -- p_starts_at is null, so a submission that simply left the start date empty
  -- would be refused with "the start date can no longer change" — a true
  -- SQLSTATE and a false explanation, for somebody who was not trying to change
  -- it at all. Ordered this way, an incomplete form is told it is incomplete and
  -- only a form that really moves a frozen field hears about the freeze.
  --
  -- Status is deliberately not filtered: see 0055's header. Somebody refused for
  -- coming in too early still read the hashtag and texted it.
  v_frozen := exists (
    select 1 from public.participations where promotion_id = p_promotion_id);

  if v_frozen then
    if v_hashtag is distinct from v_current_hashtag then
      raise exception 'somebody has already entered this promotion; the hashtag can no longer change'
        using errcode = '22023';
    end if;
    if p_starts_at is distinct from v_current_starts then
      raise exception 'somebody has already entered this promotion; the start date can no longer change'
        using errcode = '22023';
    end if;
  end if;

  -- Final review, Important #5. set_service_hashtags (0177) already refuses
  -- the OTHER direction: a Station hashtag equal to a live-or-future
  -- promotion's own. Nothing refused THIS direction until now, and D3
  -- matches a live promotion's hashtag ahead of the Station's two general
  -- ones -- so renaming a promotion to the Station's own music or service
  -- hashtag would silently kill that door, with nothing on any screen saying
  -- why. Checked here, at write time, the one moment an operator is looking,
  -- and scoped to THIS Station: a hashtag belongs to a Station, and the same
  -- word at a sibling Station is a different Station's word.
  --
  -- FIX ROUND, SECOND DISPATCH (regression in the round above). This guard
  -- shipped with no window at all, which made ANY promotion whose hashtag a
  -- Station later claimed as its own permanently unsaveable: 0177's OWN
  -- clash check is deliberately `ends_at > now()` (its header explains why
  -- at length -- an ended promotion cannot shadow the Station's hashtag,
  -- because ingest_whatsapp_event only ever matches a promotion inside its
  -- own starts_at..ends_at, so refusing reuse forever is worse than the
  -- collision it prevents). This guard is the mirror of that rule and now
  -- carries the SAME window -- `p_ends_at > now()` -- for the same reason:
  -- a promotion that has ended cannot shadow anything either, and 0177
  -- already let the Station claim its hashtag on exactly that basis. Without
  -- this window, update_promotion's own wholesale-replace convention (every
  -- field re-posted on every call) meant a promotion born before the
  -- Station claimed its ended hashtag would refuse EVERY later save,
  -- forever, over a field the operator never touched -- and once anybody
  -- had entered it, 0055's freeze also refuses changing the hashtag away
  -- from the collision, leaving no way out at all.
  --
  -- ALSO SKIPPED WHEN THE HASHTAG IS UNCHANGED (`is not distinct from`
  -- v_current_hashtag), independent of the window: a save that does not
  -- touch the hashtag cannot be what INTRODUCES a collision, whatever the
  -- window says, and this is what makes an ordinary resave -- change the
  -- name, flip a flag, nothing to do with the hashtag -- never trip a guard
  -- about a field that was not part of the edit.
  if v_hashtag is not null
     and v_hashtag is distinct from v_current_hashtag
     and p_ends_at > now()
     and exists (
    select 1 from public.widget_installations w
     where w.company_id = v_company
       and w.deleted_at is null
       and lower(w.music_hashtag) = lower(v_hashtag)
  ) then
    raise exception 'the hashtag % already belongs to this Station''s music hashtag', v_hashtag
      using errcode = '22023';
  end if;

  if v_hashtag is not null
     and v_hashtag is distinct from v_current_hashtag
     and p_ends_at > now()
     and exists (
    select 1 from public.widget_installations w
     where w.company_id = v_company
       and w.deleted_at is null
       and lower(w.service_hashtag) = lower(v_hashtag)
  ) then
    raise exception 'the hashtag % already belongs to this Station''s service hashtag', v_hashtag
      using errcode = '22023';
  end if;

  -- Block 30c D2. THE GATE REFUSES A TRANSITION, NOT A STATE, and that is the
  -- decision rather than a shortcut.
  --
  -- `rules` was added nullable and unconstrained (0171) and both doors have been
  -- enable-able without it ever since, so promotions in production may already
  -- be door-on and rules-blank. Refusing the STATE would hold an operator
  -- correcting a closing date hostage to a text they may not have; refusing the
  -- TRANSITION stops anyone making it worse while leaving the existing shape
  -- editable.
  --
  -- A CHECK cannot express this -- not even NOT VALID -- because a CHECK sees
  -- only the row being written and never the row being replaced. That is why
  -- this lives in the door, which has already read the current row.
  --
  -- WHAT THIS REPLACES IS A SILENT ABSENCE. A web_enabled promotion with no
  -- rules is already invisible in the widget: widget_promotions (0186) filters
  -- it out, on the grounds that a promotion which cannot be presented honestly
  -- should be absent rather than broken on screen. Today the operator gets no
  -- signal at all; now they get one at the moment they cause it.
  if (coalesce(p_whatsapp_enabled, false) or coalesce(p_web_enabled, false))
     and nullif(btrim(coalesce(p_rules, '')), '') is null
     and not (
       (v_current_whatsapp or v_current_web)
       and nullif(btrim(coalesce(v_current_rules, '')), '') is null
     )
  then
    raise exception 'a promotion that takes part by WhatsApp or on the website needs its rules'
      using errcode = '22023';
  end if;

  -- Switching WhatsApp off takes the banner with it, and the bytes with the
  -- banner. promotions_whatsapp_shape refuses a row that keeps one, so this is
  -- not a policy choice the assignment below could avoid -- without it the
  -- UPDATE fails a check and the operator reads "could not save" for a field
  -- they never touched. Queued BEFORE the update: if the update raises, the
  -- transaction takes this row with it.
  -- BOTH DOORS OFF, not just WhatsApp: the art is erased when the promotion
  -- stops conversing anywhere, which is the owner's ruling of 2026-08-11 and
  -- the same behaviour 0144 had when WhatsApp was the only door there was.
  if not (coalesce(p_whatsapp_enabled, false) or coalesce(p_web_enabled, false)) then
    perform public.enqueue_artwork_erasure(
      v_current_art, 'promotion-banners/' || v_company || '/' || p_promotion_id);
  end if;

  -- Wholesale replace, the same convention as update_prize and update_role:
  -- every field is set on every call rather than merged with what was there,
  -- so a field cleared on screen is cleared in the row. The freeze above is one
  -- narrowing of it; the two art columns are the other, and Block 14's reason
  -- is different -- they are not this function's to write at all.
  begin
    update public.promotions set
      site_integration_code     = p_site_integration_code,
      name                      = v_name,
      starts_at                 = p_starts_at,
      ends_at                   = p_ends_at,
      allow_multiple_entries    = coalesce(p_allow_multiple_entries, false),
      min_hours_between_entries = p_min_hours_between_entries,
      max_entries_per_member    = p_max_entries_per_member,
      require_correct_answer    = coalesce(p_require_correct_answer, false),
      call_to_action            = v_cta,
      whatsapp_enabled          = coalesce(p_whatsapp_enabled, false),
      web_enabled               = coalesce(p_web_enabled, false),
      -- Wholesale like every field around it: rules cleared on screen are
      -- cleared in the row, which is also how a promotion is taken off the
      -- website without unticking the box.
      rules                     = nullif(btrim(coalesce(p_rules, '')), ''),
      hashtag                   = v_hashtag,
      -- NOT from a parameter any more (Block 14). set_promotion_art is this
      -- column's only writer; what is left here is the one thing that function
      -- cannot do — honour promotions_conversational_shape when the LAST door
      -- is switched off in the same statement that would otherwise leave a
      -- banner behind. Block 17c widened the condition: one door is enough to
      -- keep the art, because either one can show it.
      use_art                   = case when coalesce(p_whatsapp_enabled, false)
                                         or coalesce(p_web_enabled, false)
                                       then use_art else false end,
      art_url                   = case when coalesce(p_whatsapp_enabled, false)
                                         or coalesce(p_web_enabled, false)
                                       then art_url else null end,
      yes_button_label          = v_yes,
      no_button_label           = v_no,
      requested_fields          = coalesce(p_requested_fields, '{}'),
      authorization_certificate = v_certificate,
      show_id                   = p_show_id,
      updated_at                = now()
    where id = p_promotion_id;
  exception
    when exclusion_violation or unique_violation then
      -- The cascade onto participations.allows_multiple fires as an AFTER ROW
      -- trigger of this UPDATE, so participations_one_per_member's 23505 is
      -- raised inside the statement and lands here, indistinguishable by
      -- sqlstate from a duplicate site integration code. The constraint name is
      -- what separates them.
      get stacked diagnostics v_constraint = constraint_name;
      perform public.promotion_write_error(
        v_hashtag, p_site_integration_code, sqlstate, v_constraint);
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('name', v_name));
end;
$$;

-- ===== create_promotion (live definition, pg_get_functiondef, confirmed byte
-- for byte identical to 0184's body before the edits below) =====
create function public.create_promotion(
  p_company_id                uuid,
  p_name                      text,
  p_starts_at                 timestamptz,
  p_ends_at                   timestamptz,
  p_site_integration_code     integer default null,
  p_call_to_action            text default null,
  p_allow_multiple_entries    boolean default false,
  p_min_hours_between_entries integer default null,
  p_require_correct_answer    boolean default false,
  p_whatsapp_enabled          boolean default false,
  p_hashtag                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}',
  p_max_entries_per_member    integer default null,
  -- Block 17c. Appended rather than slotted beside p_whatsapp_enabled, so every
  -- existing positional call site keeps meaning what it meant.
  p_web_enabled               boolean default false,
  p_rules                     text default null,
  -- Block 30c. Appended for the same reason 17c gives above: every existing
  -- positional call site keeps meaning what it meant.
  p_authorization_certificate text default null,
  p_show_id                   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_id      uuid;
  v_name    text := nullif(btrim(p_name), '');
  v_cta     text := nullif(btrim(coalesce(p_call_to_action, '')), '');
  v_hashtag text := nullif(btrim(coalesce(p_hashtag, '')), '');
  v_yes     text := nullif(btrim(coalesce(p_yes_button_label, '')), '');
  v_no      text := nullif(btrim(coalesce(p_no_button_label, '')), '');
  v_certificate text := nullif(btrim(coalesce(p_authorization_certificate, '')), '');
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.create', p_company_id) then
    raise log 'create_promotion denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: promotions.create required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'the promotion needs a name' using errcode = '22023';
  end if;
  if p_starts_at is null or p_ends_at is null then
    raise exception 'the promotion needs a start and an end' using errcode = '22023';
  end if;

  -- Final review, Important #5. The same guard update_promotion now carries,
  -- and for the same reason: set_service_hashtags (0177) already refuses a
  -- Station hashtag equal to a live-or-future promotion's own, but nothing
  -- refused a NEW promotion being born with the Station's own music or
  -- service hashtag, which would silently kill that door the moment this
  -- row is created. Scoped to this Station, the same as the reverse guard.
  --
  -- FIX ROUND, SECOND DISPATCH: carries the same window as 0177's own clash
  -- check, `p_ends_at > now()` -- see update_promotion's own comment on the
  -- identical guard for the full reasoning (0177's header, and the
  -- permanently-unsaveable regression this window closes). A promotion
  -- being CREATED with an end date already in the past is unusual but not
  -- illegal (an operator backfilling a record, say), and it cannot shadow
  -- the Station's hashtag on arrival for the same reason an ended one
  -- already in the table cannot: ingest_whatsapp_event never matches
  -- outside a promotion's own window.
  if v_hashtag is not null and p_ends_at > now() and exists (
    select 1 from public.widget_installations w
     where w.company_id = p_company_id
       and w.deleted_at is null
       and lower(w.music_hashtag) = lower(v_hashtag)
  ) then
    raise exception 'the hashtag % already belongs to this Station''s music hashtag', v_hashtag
      using errcode = '22023';
  end if;

  if v_hashtag is not null and p_ends_at > now() and exists (
    select 1 from public.widget_installations w
     where w.company_id = p_company_id
       and w.deleted_at is null
       and lower(w.service_hashtag) = lower(v_hashtag)
  ) then
    raise exception 'the hashtag % already belongs to this Station''s service hashtag', v_hashtag
      using errcode = '22023';
  end if;

  -- The same rule with no previous row to compare against: a promotion cannot
  -- be BORN door-on and rules-blank. See update_promotion's comment for why the
  -- update case is a transition test instead.
  if (coalesce(p_whatsapp_enabled, false) or coalesce(p_web_enabled, false))
     and nullif(btrim(coalesce(p_rules, '')), '') is null
  then
    raise exception 'a promotion that takes part by WhatsApp or on the website needs its rules'
      using errcode = '22023';
  end if;

  -- A promotion is BORN WITHOUT PICTURES, and that is not a gap in this
  -- function: neither key exists until the row does. The registering action
  -- creates the promotion, uploads against the id that comes back, and calls
  -- set_promotion_thumb / set_promotion_art. use_art and art_url take their
  -- column defaults (false, null), which promotions_whatsapp_shape accepts with
  -- WhatsApp on or off.
  begin
    insert into public.promotions
      (organization_id, company_id, site_integration_code, name, starts_at, ends_at,
       allow_multiple_entries, min_hours_between_entries, max_entries_per_member,
       require_correct_answer,
       call_to_action, whatsapp_enabled, web_enabled, rules, hashtag,
       yes_button_label, no_button_label, requested_fields,
       authorization_certificate, show_id, created_by)
    values
      (v_org, p_company_id, p_site_integration_code, v_name, p_starts_at, p_ends_at,
       coalesce(p_allow_multiple_entries, false), p_min_hours_between_entries,
       p_max_entries_per_member,
       coalesce(p_require_correct_answer, false),
       v_cta, coalesce(p_whatsapp_enabled, false), coalesce(p_web_enabled, false),
       nullif(btrim(coalesce(p_rules, '')), ''), v_hashtag,
       v_yes, v_no,
       coalesce(p_requested_fields, '{}'),
       v_certificate, p_show_id, v_actor)
    returning id into v_id;
  exception
    when exclusion_violation or unique_violation then
      perform public.promotion_write_error(v_hashtag, p_site_integration_code, sqlstate);
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_promotion', 'promotions', v_id, v_org, p_company_id,
     jsonb_build_object('name', v_name, 'whatsapp', coalesce(p_whatsapp_enabled, false)));

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The grants, restated because both functions above were dropped and
-- recreated with a new signature -- a grant follows a signature, not a name.
-- 0172's grants survived 0184's create-or-replace untouched (same signature,
-- same OID); they do not survive this drop.
-- ---------------------------------------------------------------------------
revoke execute on function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text, text, uuid) from public;
grant execute on function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text, text, uuid) to authenticated;

revoke execute on function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text, text, uuid) from public;
grant execute on function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text, text, uuid) to authenticated;
