-- supabase/migrations/0055_promotion_freeze.sql
--
-- Block 4a's D9 comes due. 0042 and 0043 each carry a comment saying the freeze
-- was deliberately left out because it would have had to consult a table that
-- did not exist yet, and that a guard against a table that does not exist is a
-- guard that can never fire. 0052 built that table. Both guards are written
-- here and both of those comments are corrected in the same migration, because
-- a comment saying a guard is absent, sitting one screen above the guard, is
-- worse than no comment at all: the next reader has to run the code to learn
-- which of the two is lying, and this project has already shipped a comment
-- that outlived its own code twice on this branch.
--
-- WHAT FREEZES, and the reason is the audience's rather than the schema's.
-- Listeners are already texting the hashtag and the promotion went on air at a
-- time that was announced. Changing either one after the first entry rewrites
-- what the people who already entered were answering, and neither the schema
-- nor the audit log would show that it had happened — the row simply reads as
-- though it had always said the new thing.
--
-- WHAT DOES NOT, and this half matters as much: the name, the end date, the
-- call to action, the art and the two button labels stay editable for the whole
-- life of the promotion. Nobody entered because of the name, and extending the
-- end date takes nothing away from anybody who already has. A freeze that
-- locked the whole row would be simpler to write and would stop an operator
-- fixing a typo in the call to action on a promotion that is running, which is
-- the commonest edit there is.
--
-- A REFUSED ATTEMPT STILL COUNTS. Neither guard filters on status. A TOO_SOON
-- or an OVER_LIMIT row is still somebody who read the hashtag and texted it,
-- which is exactly the fact the freeze exists to protect. Filtering to VALID
-- was the alternative and it is wrong in the direction that matters: a
-- promotion whose every entry so far was refused would go on being editable
-- underneath the people who sent them.

-- ---------------------------------------------------------------------------
-- update_promotion is DROPPED and recreated, NOT replaced.
--
-- D1's ceiling adds p_max_entries_per_member, and `create or replace` cannot
-- change an argument list. Used that way it creates a SECOND function beside
-- the sixteen-argument one, and every caller that passes sixteen arguments —
-- services/promotions.ts among them — goes on resolving to the old body, which
-- has neither the freeze nor the ceiling. The failure is silent: nothing errors
-- and nothing is refused, the guard simply never runs.
--
-- Block 4b shipped exactly this mistake with apply_inventory_movement (0047)
-- and then found something worse about detecting it. `::regprocedure` resolves
-- the signature it is handed and succeeds regardless of what else shares the
-- name, so 02_permissions.test.sql passed 331 of 331 with two overloads live
-- while the block claimed in five places that its signature pins caught
-- precisely that. The overload count added to that file for this function is
-- the only assertion that can see a surviving twin; the signature pins beside
-- it cannot, and are not asked to.
--
-- Dropping resets the ACL. Postgres grants EXECUTE to PUBLIC on every newly
-- created function, so the revoke and the grant below are not restated out of
-- tidiness — without them anon could reach this function, which is the exact
-- hole 0050 closed for all six of Block 4a's promotion RPCs.
-- ---------------------------------------------------------------------------
drop function public.update_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer,
  boolean, boolean, text, boolean, text, text, text,
  public.promotion_requested_field[]);

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
  p_use_art                   boolean default false,
  p_art_url                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}',
  -- Last, and defaulting to null, for the reason 0043's p_question_id comment
  -- gives about its own position: the commoner call is the one that does not
  -- set a ceiling, and it should read that way at the call site. Null means no
  -- ceiling; 0052's check refuses 1 and refuses any value at all unless
  -- allow_multiple_entries is true, so this function does not restate either
  -- rule — the table holds them, the same division 0042's own header describes.
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
  v_art     text := nullif(btrim(coalesce(p_art_url, '')), '');
  v_yes     text := nullif(btrim(coalesce(p_yes_button_label, '')), '');
  v_no      text := nullif(btrim(coalesce(p_no_button_label, '')), '');
  -- The two frozen fields as they stand. Read by the select that already takes
  -- FOR UPDATE rather than by a second statement of their own: a second read
  -- would sit outside nothing at all — the lock is already held — but it would
  -- be a second place that has to remember the filter on deleted_at, and the
  -- first one is right there.
  v_current_hashtag text;
  v_current_starts  timestamptz;
  v_frozen          boolean;
begin
  -- FOR UPDATE, so two edits racing serialise rather than both reading the
  -- same "before" and each writing a whole row over the other's fields. It is
  -- also what makes the freeze below decidable: the participation count and the
  -- row it is compared against are read under one lock, so an entry arriving
  -- mid-edit either loses the race or is seen.
  select organization_id, company_id, hashtag, starts_at
    into v_org, v_company, v_current_hashtag, v_current_starts
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

  -- Block 4a's D9, finally able to fire. 0042 carried a comment saying this
  -- guard was deliberately absent because it would have had to consult a table
  -- that did not exist, and a guard that can never fire is a defect this
  -- project has shipped five times. The table exists now.
  --
  -- Placed AFTER the two presence checks above rather than immediately after
  -- the permission check, and the difference is a sentence an operator reads.
  -- `p_starts_at is distinct from v_current_starts` is TRUE when p_starts_at is
  -- null, so a submission that simply left the start date empty would be
  -- refused with "the start date can no longer change" — a true SQLSTATE and a
  -- false explanation, for somebody who was not trying to change it at all.
  -- Ordered this way, an incomplete form is told it is incomplete and only a
  -- form that really moves a frozen field hears about the freeze.
  --
  -- Status is deliberately not filtered: see this migration's header. Somebody
  -- refused for coming in too early still read the hashtag and texted it.
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

  -- Wholesale replace, the same convention as update_prize and update_role:
  -- every field is set on every call rather than merged with what was there,
  -- so a field cleared on screen is cleared in the row. The freeze above is the
  -- one narrowing of it: two of these assignments are no-ops by the time they
  -- run on a promotion somebody has entered, because anything else would have
  -- raised.
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

-- Seventeen argument types, spelled out, on all three statements. A signature
-- typed one type short does not silently apply to the wrong function here — it
-- errors, because after the drop above there is exactly one update_promotion
-- and nothing else for a short list to resolve to.
revoke execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) from public;
grant execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) to authenticated;

comment on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) is
  'Replaces a promotion''s fields wholesale. Gated on promotions.edit. The Organization and Station come from the row, never a parameter. Block 4a''s D9 freeze IS here, in 0055, and 0042''s comment saying it was deliberately absent because it would have had to consult a table that did not exist is corrected by this one: once ANY participation exists — refused ones included, because somebody who was too early still read the hashtag and texted it — the hashtag and the start date are refused with 22023 and everything else stays editable, because nobody entered on account of the name and extending the end date takes nothing from anybody. Dropped and recreated rather than replaced, since p_max_entries_per_member changes the argument list and create or replace cannot: it would have left the sixteen-argument body alive beside this one, with every existing caller still resolving to the version that has no freeze. The ceiling itself is stored, not enforced here — apply_participation (0054) counts against it, and 0052''s check is what refuses a ceiling of one or a ceiling on a promotion that allows no repeats.';

-- ---------------------------------------------------------------------------
-- remove_promotion_question keeps its one-argument signature, so `create or
-- replace` is correct here and carries no drop-and-recreate hazard: the ACL
-- 0050 set survives it. Restated below all the same, following 0036's
-- precedent — relying on CREATE OR REPLACE's silent ACL preservation with
-- nothing in the suite behind it is how six functions held a PUBLIC grant
-- through the whole of Block 4a without anybody noticing.
--
-- This refusal is unconditional where update_promotion's is conditional, and
-- the asymmetry is not an oversight. An edit can leave the frozen fields
-- untouched and still be a legitimate edit; a removal cannot leave the question
-- in place. There is no harmless version of it once an answer may point at the
-- question — and participation_answers' foreign key would refuse the delete
-- anyway, with a bare 23503 and a constraint name instead of a sentence.
-- Refusing here means the operator is told the same thing whether or not
-- anybody happened to answer THIS question, which is the rule 0041's table
-- comment actually states.
-- ---------------------------------------------------------------------------
create or replace function public.remove_promotion_question(p_question_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor      uuid := auth.uid();
  v_org        uuid;
  v_company    uuid;
  v_promotion  uuid;
begin
  select q.organization_id, q.company_id, q.promotion_id
    into v_org, v_company, v_promotion
  from public.promotion_questions q
  join public.promotions p on p.id = q.promotion_id and p.deleted_at is null
  where q.id = p_question_id
    for update of q;

  if not found then
    raise exception 'question not found: %', p_question_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'remove_promotion_question denied: actor=% question=%', v_actor, p_question_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  -- Block 4a's D9, finally able to fire. 0043 carried a comment saying removal
  -- was only ever permitted while nothing pointed at the question and that
  -- Block 4c would enforce it, which nothing did; a guard against a table that
  -- does not exist is a guard that can never fire, and this project has shipped
  -- five of those. The table exists now.
  if exists (select 1 from public.participations where promotion_id = v_promotion) then
    raise exception 'somebody has already entered this promotion; its questions can no longer be removed'
      using errcode = '22023';
  end if;

  delete from public.promotion_question_options where question_id = p_question_id;
  delete from public.promotion_questions        where id = p_question_id;

  -- Renumbering is deliberately not done. The remaining questions keep the
  -- numbers they had; a gap orders exactly as well as a dense sequence, and
  -- renumbering would rewrite rows nobody asked to touch.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'remove_promotion_question', 'promotion_questions', p_question_id,
     v_org, v_company, jsonb_build_object('promotion_id', v_promotion));
end;
$$;

revoke execute on function public.remove_promotion_question(uuid) from public;
grant execute on function public.remove_promotion_question(uuid) to authenticated;

comment on function public.remove_promotion_question(uuid) is
  'Deletes a question and its options outright — neither table carries deleted_at, because removal is only ever permitted while nothing points at the question, which 0055 enforces here rather than leaving to a later block: a promotion any participation names, refused attempts included, refuses the removal with 22023. Gated on promotions.edit. Leaves the position gap rather than renumbering its siblings. The refusal is on the PROMOTION having been entered, not on this question having been answered — a question nobody happened to answer is still part of what the audience was shown, and participation_answers'' foreign key would only refuse the ones that were, with a constraint name instead of a sentence.';
