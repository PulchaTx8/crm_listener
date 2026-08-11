-- supabase/migrations/0172_promotions_two_doors.sql

-- Block 17c. The three writers of a promotion learn that a promotion can
-- converse on the web.
--
-- 0171 gave promotions `web_enabled` and split promotions_whatsapp_shape in
-- two. These three still speak the one-door world: update_promotion CLEARS the
-- art when WhatsApp is switched off, set_promotion_art REFUSES art on a
-- promotion without WhatsApp, and neither writer knows the two new columns
-- exist. A promotion ticked for the web alone would save with no art it is
-- allowed to keep, and with its rules and its web flag dropped on the floor.
--
-- EVERY BODY BELOW IS 0144'S, EXTRACTED BY SCRIPT AND NOT RETYPED. 0144 is the
-- last definition of all three, checked before writing this. Retyping a shipped
-- body is how 0168 silently reverted 0163's public-key pin one block ago, and
-- why 0169 was assembled the same way. The edits are only these:
--
--   * `whatsapp_enabled` becomes `whatsapp_enabled or web_enabled` wherever it
--     gated ART or REQUESTED FIELDS -- the things either door can use.
--   * p_web_enabled and p_rules are appended to both writers' parameter lists
--     and written to the row.
--   * Nothing about the hashtag or the button labels changes. They are objects
--     of the WhatsApp conversation, and promotions_whatsapp_fields still says so.

drop function if exists public.set_promotion_art(uuid, text);
drop function if exists public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer);
drop function if exists public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer);

-- ===== set_promotion_art (0144:158-208) =====
create function public.set_promotion_art(p_promotion_id uuid, p_url text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company  uuid;
  v_whatsapp boolean;
  v_web      boolean;
  v_current  text;
  v_url      text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, whatsapp_enabled, web_enabled, art_url
    into v_company, v_whatsapp, v_web, v_current
  from public.promotions
  where id = p_promotion_id and deleted_at is null
  for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'set_promotion_art denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  -- promotions_conversational_shape (0171) does not admit a banner on a
  -- promotion that converses through no door at all. Refused here with a
  -- sentence rather than left to the constraint, which would reach the operator
  -- as "could not save" with no field to point at.
  --
  -- EITHER DOOR IS ENOUGH, and that is Block 17c's edit to this line: the art
  -- is what a listener sees above the rules in the widget, so a promotion on
  -- the website has as much use for it as one on WhatsApp.
  if v_url is not null and not (v_whatsapp or v_web) then
    raise exception 'turn WhatsApp or the web on for this promotion before giving it a banner'
      using errcode = '22023';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'promotion-banners/' || v_company || '/' || p_promotion_id);
  end if;

  -- use_art is set from the presence of the address and never independently:
  -- promotions_art_shape has always required exactly that, so there is no state
  -- here for a caller to get wrong.
  update public.promotions
     set art_url    = v_url,
         use_art    = (v_url is not null),
         updated_at = now()
   where id = p_promotion_id;
end;
$$;

-- ===== update_promotion (0144:238-396) =====
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
  p_rules                     text default null
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
  select organization_id, company_id, hashtag, starts_at, art_url
    into v_org, v_company, v_current_hashtag, v_current_starts, v_current_art
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

-- ===== create_promotion (0144:411-498) =====
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
  p_rules                     text default null
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
       yes_button_label, no_button_label, requested_fields, created_by)
    values
      (v_org, p_company_id, p_site_integration_code, v_name, p_starts_at, p_ends_at,
       coalesce(p_allow_multiple_entries, false), p_min_hours_between_entries,
       p_max_entries_per_member,
       coalesce(p_require_correct_answer, false),
       v_cta, coalesce(p_whatsapp_enabled, false), coalesce(p_web_enabled, false),
       nullif(btrim(coalesce(p_rules, '')), ''), v_hashtag,
       v_yes, v_no,
       coalesce(p_requested_fields, '{}'), v_actor)
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
-- The grants, restated because the three functions above were dropped and
-- recreated with new signatures -- a grant follows a signature, not a name, so
-- none of 0144's survived the drop.
-- ---------------------------------------------------------------------------
revoke execute on function public.set_promotion_art(uuid, text) from public;
grant execute on function public.set_promotion_art(uuid, text) to authenticated;

revoke execute on function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text) from public;
grant execute on function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text) to authenticated;

revoke execute on function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text) from public;
grant execute on function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean,
  boolean, text, text, text, public.promotion_requested_field[], integer,
  boolean, text) to authenticated;
