-- supabase/migrations/0042_promotion_rpcs.sql
--
-- The four writes a promotion takes. Each checks its own permission beside the
-- operation rather than inside a shared helper, for the reason 0027's own
-- comment gives: a reader looking for "who may do this" finds it next to the
-- thing being done.
--
-- Every one of them resolves the Organization and the Station from the row
-- itself once the promotion exists, never from a parameter — a caller must not
-- be able to redirect the permission check at a Station where they happen to
-- hold the code.

-- Shared by create and update: the two constraint violations an operator can
-- actually cause, turned into sentences. A raw 23P01 reaching a screen reads
-- like nothing anyone has seen; this names the hashtag and the period.
create or replace function public.promotion_write_error(
  p_hashtag text,
  p_site_code integer,
  p_sqlstate text
)
returns void
language plpgsql
-- Deliberately left volatile. Marking it immutable would let the planner
-- constant-fold a call with constant arguments, and a function whose entire
-- job is to raise would then raise at plan time instead of where it was called.
set search_path = pg_catalog, public
as $$
begin
  if p_sqlstate = '23P01' then
    raise exception 'another promotion in this station already uses "%" during that period', p_hashtag
      using errcode = '23P01';
  elsif p_sqlstate = '23505' then
    raise exception 'site integration code % is already used by another promotion in this station', p_site_code
      using errcode = '23505';
  else
    raise exception 'promotion could not be written: %', p_sqlstate using errcode = p_sqlstate;
  end if;
end;
$$;

comment on function public.promotion_write_error(text, integer, text) is
  'Translates the two constraint violations create_promotion and update_promotion share into sentences an operator can act on. Holds EXECUTE for nobody: it is only ever called from inside a SECURITY DEFINER body.';

revoke execute on function public.promotion_write_error(text, integer, text) from public;

create or replace function public.create_promotion(
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
  p_use_art                   boolean default false,
  p_art_url                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}'
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
  v_art     text := nullif(btrim(coalesce(p_art_url, '')), '');
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

  begin
    insert into public.promotions
      (organization_id, company_id, site_integration_code, name, starts_at, ends_at,
       allow_multiple_entries, min_hours_between_entries, require_correct_answer,
       call_to_action, whatsapp_enabled, hashtag, use_art, art_url,
       yes_button_label, no_button_label, requested_fields, created_by)
    values
      (v_org, p_company_id, p_site_integration_code, v_name, p_starts_at, p_ends_at,
       coalesce(p_allow_multiple_entries, false), p_min_hours_between_entries,
       coalesce(p_require_correct_answer, false),
       v_cta, coalesce(p_whatsapp_enabled, false), v_hashtag,
       coalesce(p_use_art, false), v_art, v_yes, v_no,
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

comment on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) is
  'Registers a promotion. Gated on promotions.create. Every coherence rule between the fields lives in the table''s own checks (0040), not here — this function''s job is the permission, the Station and turning two constraint violations into sentences.';

create or replace function public.update_promotion(
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
  p_use_art                   boolean default false,
  p_art_url                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}'
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
  v_art     text := nullif(btrim(coalesce(p_art_url, '')), '');
  v_yes     text := nullif(btrim(coalesce(p_yes_button_label, '')), '');
  v_no      text := nullif(btrim(coalesce(p_no_button_label, '')), '');
begin
  -- FOR UPDATE, so two edits racing serialise rather than both reading the
  -- same "before" and each writing a whole row over the other's fields.
  select organization_id, company_id into v_org, v_company
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

  -- Wholesale replace, the same convention as update_prize and update_role:
  -- every field is set on every call rather than merged with what was there,
  -- so a field cleared on screen is cleared in the row.
  --
  -- Block 4c narrows this: once a participation exists, the hashtag and the
  -- start date freeze and only the name, call to action, art, button labels and
  -- end date stay editable. That guard is deliberately NOT written here — it
  -- would have to consult a table that does not exist yet, which is a guard
  -- that can never fire, and this project has shipped five of those.
  begin
    update public.promotions set
      site_integration_code     = p_site_integration_code,
      name                      = v_name,
      starts_at                 = p_starts_at,
      ends_at                   = p_ends_at,
      allow_multiple_entries    = coalesce(p_allow_multiple_entries, false),
      min_hours_between_entries = p_min_hours_between_entries,
      require_correct_answer    = coalesce(p_require_correct_answer, false),
      call_to_action            = v_cta,
      whatsapp_enabled          = coalesce(p_whatsapp_enabled, false),
      hashtag                   = v_hashtag,
      use_art                   = coalesce(p_use_art, false),
      art_url                   = v_art,
      yes_button_label          = v_yes,
      no_button_label           = v_no,
      requested_fields          = coalesce(p_requested_fields, '{}'),
      updated_at                = now()
    where id = p_promotion_id;
  exception
    when exclusion_violation or unique_violation then
      perform public.promotion_write_error(v_hashtag, p_site_integration_code, sqlstate);
  end;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'update_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('name', v_name));
end;
$$;

comment on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) is
  'Replaces a promotion''s fields wholesale. Gated on promotions.edit. The Organization and Station come from the row, never a parameter. The freeze that Block 4c adds — hashtag and start date locked once a participation exists — is not here, because a guard against a table that does not exist yet is a guard that can never fire.';

create or replace function public.cancel_promotion(
  p_promotion_id uuid,
  p_reason       text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_ends      timestamptz;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- FOR UPDATE before the "already cancelled" read, so two cancels racing
  -- cannot both pass that check and the second one loses rather than
  -- overwriting the first one's author and reason.
  select organization_id, company_id, cancelled_at, ends_at
    into v_org, v_company, v_cancelled, v_ends
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.cancel', v_company) then
    raise log 'cancel_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.cancel required' using errcode = '42501';
  end if;

  -- A cancellation nobody can explain later is a row that will be argued about.
  if v_reason is null then
    raise exception 'a reason is required to cancel a promotion' using errcode = '22023';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is already cancelled' using errcode = '22023';
  end if;

  -- Cancelling something already over changes nothing and would only mislabel
  -- it: the list would read Cancelada for a promotion that ran its full course.
  if v_ends <= now() then
    raise exception 'this promotion has already ended; there is nothing to cancel'
      using errcode = '22023';
  end if;

  update public.promotions set
    cancelled_at        = now(),
    cancelled_by        = v_actor,
    cancellation_reason = v_reason,
    updated_at          = now()
  where id = p_promotion_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('reason', v_reason));
end;
$$;

comment on function public.cancel_promotion(uuid, text) is
  'Stops a promotion accepting entries before its end. Gated on promotions.cancel. Requires a reason, refuses a promotion already cancelled, and refuses one whose window has already closed — cancelling something already over would only mislabel it.';

create or replace function public.archive_promotion(p_promotion_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_starts    timestamptz;
  v_ends      timestamptz;
  v_cancelled timestamptz;
begin
  select organization_id, company_id, starts_at, ends_at, cancelled_at
    into v_org, v_company, v_starts, v_ends, v_cancelled
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.archive', v_company) then
    raise log 'archive_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.archive required' using errcode = '42501';
  end if;

  -- The shape of archive_prize's own refusal: a record the audience can still
  -- reach is not a record to file away. Archiving frees the hashtag (the
  -- exclusion constraint in 0040 skips archived rows), so doing it mid-flight
  -- would let a second promotion claim a hashtag listeners are still texting.
  if v_cancelled is null and now() >= v_starts and now() < v_ends then
    raise exception 'this promotion is still accepting entries; cancel it before archiving'
      using errcode = '22023';
  end if;

  update public.promotions set
    deleted_at = now(),
    deleted_by = v_actor,
    updated_at = now()
  where id = p_promotion_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id)
  values
    (v_actor, 'archive_promotion', 'promotions', p_promotion_id, v_org, v_company);
end;
$$;

comment on function public.archive_promotion(uuid) is
  'Soft-deletes a promotion, recording who did it. Gated on promotions.archive. Refused while the promotion is inside its window and not cancelled: archiving frees the hashtag for another promotion, and doing that while listeners are still texting it would hand their entries to the wrong promotion.';
