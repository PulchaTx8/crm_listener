-- supabase/migrations/0144_promotion_images.sql

-- Block 14, D2 and D5. A promotion gets a second picture, and both of them get
-- an owner.
--
-- THE CHANGE THAT MAKES THE REST SAFE is at the bottom of this file:
-- create_promotion and update_promotion stop taking p_use_art and p_art_url.
-- update_promotion replaces every field it is given on every call -- its own
-- comment says so, and 0055's ceiling was added precisely because a field
-- missing from that list is a field written null. The banner's address has just
-- left the form, so leaving the parameter on the RPC would have meant every
-- Save silently deleting the banner. One field, one writer.
--
-- use_art STAYS IN THE TABLE and leaves the screen. promotions_art_shape (0040)
-- already forces `use_art = (art_url is not null)`, so it has never been a
-- second state; the tick that used to set it is now "does this promotion have a
-- banner". Keeping the column means the conversation engine, interactive.ts and
-- the context RPC are untouched by this block.

alter table public.promotions add column thumb_url text;

comment on column public.promotions.thumb_url is
  'A small picture identifying this promotion inside the system -- the list, the record. NEVER sent anywhere: the banner Meta fetches is art_url, and the two are different pictures with different limits. Server-generated (Block 14); no form posts it.';

-- A shape check rather than an https rule, because unlike art_url this value
-- never leaves the building and Meta never fetches it.
alter table public.promotions
  add constraint promotions_thumb_shape
  check (thumb_url is null or thumb_url ~ '^https?://');

-- ---------------------------------------------------------------------------
-- promotions_art_https is relaxed to accept loopback.
--
-- NOT A WEAKENING, because of a change that did not exist when it was written:
-- THE ADDRESS IS NO LONGER TYPED. 0040's own comment says the constraint is
-- there so "the operator learns at the moment of typing" that Meta will not
-- fetch over http. There is no longer an operator typing -- the value is built
-- on the server from the upload's own result (services/promotions.ts), so no
-- form can post an address at all, which is a stronger guarantee than this
-- check ever gave.
--
-- What it buys: in development the Storage origin is http://127.0.0.1:54321,
-- and without this the feature cannot run on a developer's machine or in the
-- e2e suite. A loopback address is unreachable from Meta's fetchers, so it
-- cannot quietly degrade a production send either.
alter table public.promotions drop constraint promotions_art_https;

alter table public.promotions
  add constraint promotions_art_https
  check (
    art_url is null
    or art_url like 'https://%'
    or art_url like 'http://127.0.0.1:%'
    or art_url like 'http://localhost:%'
  );

-- ---------------------------------------------------------------------------
-- Deleting the bytes, which SQL cannot do.
--
-- The queue 0087 built, drained by the worker tick. Clearing a picture enqueues
-- its object in the SAME transaction that clears the column, so the intent
-- cannot survive without the instruction.
--
-- THE GUARD IS THE POINT. Promotions registered before this block carry
-- externally hosted addresses; a key derived from one of those names nothing in
-- our bucket, and 0087 deliberately has NO give-up threshold -- such a row would
-- retry for ever, and a queue full of permanent failures is a queue nobody
-- reads. So only our own objects are enqueued, proved by the address rather
-- than assumed from it.
--
-- Replacing a picture enqueues nothing, and that is correct: the key is derived
-- from the record, so the new upload overwrites the same object. There is
-- nothing left behind to delete.
create function public.enqueue_artwork_erasure(p_url text, p_key text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_url is null or p_key is null then
    return;
  end if;
  if position('/storage/v1/object/public/artwork/' || p_key in p_url) = 0 then
    return;
  end if;
  insert into public.storage_erasure_queue (bucket, path) values ('artwork', p_key);
end;
$$;

comment on function public.enqueue_artwork_erasure(text, text) is
  'Queues an artwork object for the worker to delete, in the transaction that clears the column naming it. Enqueues ONLY when the stored address is one of ours: a promotion registered before Block 14 carries an external address, and 0087 has no give-up threshold, so a key naming nothing would retry for ever. Replacing a picture enqueues nothing -- the key is derived from the record, so the new object overwrites the old.';

-- Internal to the three setters below, which are SECURITY DEFINER and reach it
-- as their own owner. No client has any business calling it: a caller who could
-- would be a caller who could queue another Station's banner for deletion.
revoke execute on function public.enqueue_artwork_erasure(text, text) from public;

-- ---------------------------------------------------------------------------
-- One writer per picture, in the shape of attach_delivery_receipt (0086).
--
-- NEITHER IS SUBJECT TO THE FREEZE, and that is not a gap. 0055's own header
-- lists what stays open for the whole life of a promotion: "the name, the end
-- date, the call to action, THE ART, the two button labels and adding a
-- question". The thumb joins that list by the same argument -- nobody entered a
-- promotion because of the picture beside it on a list screen.

-- `default null`, and it is not decoration: this is how CLEARING is expressed.
-- Without it the generated TypeScript types the argument `string` and the
-- service cannot pass null at all without a cast — and a cast is how a caller
-- ends up passing the string "null". An omitted argument clears the picture,
-- deliberately.
create function public.set_promotion_thumb(p_promotion_id uuid, p_url text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company uuid;
  v_current text;
  v_url     text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, thumb_url into v_company, v_current
  from public.promotions
  where id = p_promotion_id and deleted_at is null
  for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'set_promotion_thumb denied: actor=% promotion=%', auth.uid(), p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  if v_url is null then
    perform public.enqueue_artwork_erasure(
      v_current, 'promotion-thumbs/' || v_company || '/' || p_promotion_id);
  end if;

  update public.promotions
     set thumb_url  = v_url,
         updated_at = now()
   where id = p_promotion_id;
end;
$$;

comment on function public.set_promotion_thumb(uuid, text) is
  'Sets or clears the picture that identifies a promotion inside the system. Gated on promotions.edit. Its own writer rather than a field of update_promotion, because that function replaces every field it takes and a picture uploaded before a Save would be deleted by it. Null clears and queues the object. Not subject to the freeze: 0055 keeps the art open for the whole life of a promotion, and a list thumbnail is not something anybody entered on account of.';

revoke execute on function public.set_promotion_thumb(uuid, text) from public;
grant execute on function public.set_promotion_thumb(uuid, text) to authenticated;

-- `default null` for the reason set_promotion_thumb gives above: an omitted
-- argument clears the banner and queues its object.
create function public.set_promotion_art(p_promotion_id uuid, p_url text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company  uuid;
  v_whatsapp boolean;
  v_current  text;
  v_url      text := nullif(btrim(coalesce(p_url, '')), '');
begin
  select company_id, whatsapp_enabled, art_url
    into v_company, v_whatsapp, v_current
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

  -- promotions_whatsapp_shape does not admit a banner on a promotion that does
  -- not use WhatsApp. Refused here with a sentence rather than left to the
  -- constraint, which would reach the operator as "could not save" with no
  -- field to point at.
  if v_url is not null and not v_whatsapp then
    raise exception 'turn WhatsApp on for this promotion before giving it a banner'
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

comment on function public.set_promotion_art(uuid, text) is
  'Sets or clears the banner Meta fetches. Gated on promotions.edit. Refuses a banner on a promotion with WhatsApp off, because promotions_whatsapp_shape does not admit one and a constraint failure reaches the operator with no field to point at. Sets use_art from the presence of the address rather than taking it -- promotions_art_shape has always required the two to agree. Null clears and queues the object. Not subject to the freeze; 0055 keeps the art open deliberately.';

revoke execute on function public.set_promotion_art(uuid, text) from public;
grant execute on function public.set_promotion_art(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The art leaves both write doors.
--
-- DROPPED AND RECREATED, not `create or replace`, and 0055's header explains
-- the trap at length: replace cannot change an argument list, so used here it
-- would leave the SEVENTEEN-argument bodies alive beside these fifteen-argument
-- ones. Every existing call site resolves unambiguously to the survivor, which
-- still writes art_url from a parameter -- so the banner would go on being
-- deleted by every Save and nothing would say so.
-- 02_permissions.test.sql counts pg_proc rows by name for both functions, which
-- is the only assertion that can see a surviving twin.
--
-- Dropping also resets the ACL to Postgres's default of EXECUTE to PUBLIC, so
-- the revokes and grants below are not restated out of tidiness: without them
-- anon could reach these functions, which is the hole 0050 closed for all six
-- of Block 4a's promotion RPCs.

drop function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer,
  boolean, boolean, text, boolean, text, text, text,
  public.promotion_requested_field[], integer);

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
  p_max_entries_per_member    integer default null
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
  if not coalesce(p_whatsapp_enabled, false) then
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
      hashtag                   = v_hashtag,
      -- NOT from a parameter any more (Block 14). set_promotion_art is this
      -- column's only writer; what is left here is the one thing that function
      -- cannot do — honour promotions_whatsapp_shape when WhatsApp is switched
      -- off in the same statement that would otherwise leave a banner behind.
      use_art                   = case when coalesce(p_whatsapp_enabled, false)
                                       then use_art else false end,
      art_url                   = case when coalesce(p_whatsapp_enabled, false)
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

revoke execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) from public;
grant execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) to authenticated;

comment on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) is
  'Replaces a promotion''s fields wholesale. Gated on promotions.edit. The Organization and Station come from the row, never a parameter. Block 4a''s D9 freeze is here: once ANY participation exists — refused ones included, because somebody who was too early still read the hashtag and texted it — the hashtag and the start date are refused with 22023 and everything else stays editable. Block 14 took p_use_art and p_art_url OFF this function: the banner has one writer, set_promotion_art, because a wholesale replace would delete it on every ordinary Save now that the address is uploaded rather than typed. What is left here is the one thing that writer cannot do — clearing the banner, and queueing its object, when WhatsApp is switched off, which promotions_whatsapp_shape requires. Dropped and recreated rather than replaced, since removing two arguments changes the signature and create or replace cannot: it would have left the seventeen-argument body alive with every caller still resolving to the version that writes art_url from a parameter.';

-- ---------------------------------------------------------------------------

drop function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer,
  boolean, boolean, text, boolean, text, text, text,
  public.promotion_requested_field[], integer);

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
  p_max_entries_per_member    integer default null
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
       call_to_action, whatsapp_enabled, hashtag,
       yes_button_label, no_button_label, requested_fields, created_by)
    values
      (v_org, p_company_id, p_site_integration_code, v_name, p_starts_at, p_ends_at,
       coalesce(p_allow_multiple_entries, false), p_min_hours_between_entries,
       p_max_entries_per_member,
       coalesce(p_require_correct_answer, false),
       v_cta, coalesce(p_whatsapp_enabled, false), v_hashtag,
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

revoke execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) from public;
grant execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) to authenticated;

comment on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, text, text, public.promotion_requested_field[], integer) is
  'Registers a promotion. Gated on promotions.create. Every coherence rule between the fields lives in the table''s own checks (0040 and 0052), not here — this function''s job is the permission, the Station and turning two constraint violations into sentences. Block 14 took p_use_art and p_art_url off it: neither key exists until the row does, so the registering action creates first and then uploads against the id that comes back. It reaches promotion_write_error with three arguments on purpose: an INSERT cannot cascade onto participations, so the constraint-name case is unreachable from here.';
