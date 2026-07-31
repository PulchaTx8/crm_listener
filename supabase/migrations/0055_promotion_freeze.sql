-- supabase/migrations/0055_promotion_freeze.sql
--
-- Block 4a's D9 comes due. 0042 and 0043 each carry a comment saying the freeze
-- was deliberately left out because it would have had to consult a table that
-- did not exist yet, and that a guard against a table that does not exist is a
-- guard that can never fire. 0052 built that table. All three guards are
-- written here and both of those comments are corrected in the same migration,
-- because a comment saying a guard is absent, sitting one screen above the
-- guard, is worse than no comment at all: the next reader has to run the code
-- to learn which of the two is lying, and this project has already shipped a
-- comment that outlived its own code twice on this branch.
--
-- D9 HAS THREE SURFACES, and the first draft of this migration guarded two.
-- The spec's words are "Frozen: the questions, their options, the hashtag and
-- the start date. Open: the name, the call to action, the art, the button
-- labels, the end date, and ADDING a new question." Two of those surfaces are
-- update_promotion and remove_promotion_question. The third is
-- save_promotion_question, whose non-null p_question_id branch REPLACES a
-- question and its options wholesale — so without a guard there, an operator
-- could reword an option, or move is_correct onto a different one, while every
-- participation_answers row went on pointing at an option that now says
-- something else. 0052's own table comment, written on this branch, stakes
-- Block 6's draw-time correctness on that not being possible: "no option may be
-- reworded once somebody has chosen it — is what makes deriving it safe".
-- Guarding two of three would have left that comment asserting a guarantee no
-- code provided, which is the same defect this migration exists to close.
--
-- WHAT FREEZES, and the reason is the audience's rather than the schema's.
-- Listeners are already texting the hashtag and the promotion went on air at a
-- time that was announced. Changing either one after the first entry rewrites
-- what the people who already entered were answering, and neither the schema
-- nor the audit log would show that it had happened — the row simply reads as
-- though it had always said the new thing. An option reworded under an answer
-- is the same wrong, and worse, because Block 6 will read that option back as
-- if it were what the person chose.
--
-- WHAT DOES NOT, and this half matters as much: the name, the end date, the
-- call to action, the art, the two button labels and ADDING a question stay
-- open for the whole life of the promotion. Nobody entered because of the name,
-- extending the end date takes nothing away from anybody who already has, and
-- a question nobody has been asked yet cannot invalidate an answer nobody gave.
-- A freeze that locked the whole row would be simpler to write and would stop
-- an operator fixing a typo in the call to action on a promotion that is
-- running, which is the commonest edit there is.
--
-- Not exhaustive, and deliberately so: this list names the fields an operator
-- thinks about. update_promotion's wholesale replace also rewrites
-- require_correct_answer, requested_fields, the site code and the repetition
-- settings, none of which freeze.
--
-- A REFUSED ATTEMPT STILL COUNTS. Neither guard filters on status. A TOO_SOON
-- or an OVER_LIMIT row is still somebody who read the hashtag and texted it,
-- which is exactly the fact the freeze exists to protect. Filtering to VALID
-- was the alternative and it is wrong in the direction that matters: a
-- promotion whose every entry so far was refused would go on being editable
-- underneath the people who sent them.

-- ---------------------------------------------------------------------------
-- promotion_write_error learns a third violation, because 0052 created one it
-- cannot currently name.
--
-- participations carries participations_allows_multiple_fk with ON UPDATE
-- CASCADE, and the partial unique index participations_one_per_member over
-- (promotion_id, member_id) where status = 'VALID' and not allows_multiple.
-- Turning allow_multiple_entries OFF on a promotion where one listener already
-- holds two VALID entries therefore cascades the new flag onto their rows and
-- the index refuses the whole update. 0052:107-112 predicted exactly that and
-- called it correct — the operator is stopped rather than left with a promotion
-- whose stated rule its own data breaks — but nobody wrote the sentence.
--
-- What the operator is told today, measured against the live database rather
-- than assumed: `select public.promotion_write_error(null, null, '23505')`
-- raises "site integration code <NULL> is already used by another promotion in
-- this station". The cascade raises 23505, the copied handler catches it as a
-- unique_violation, this function has exactly two cases, and so an operator who
-- unticked a checkbox is told about a numeric field they never filled in, with
-- the number rendered as <NULL>. services/promotions.ts maps 23505 to a
-- ConflictError and passes the message through verbatim, so that is what
-- reaches the screen.
--
-- The sqlstate cannot tell the two 23505s apart, so the caller now passes the
-- constraint name — GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME in the handler,
-- which for a unique INDEX reports the index's own name (probed:
-- constraint = participations_one_per_member).
--
-- DROPPED and recreated rather than replaced, for the same reason
-- update_promotion is: the argument list changes. p_constraint takes a DEFAULT
-- so that create_promotion's three-argument call goes on resolving. Dropping the
-- three-argument form without a default would break that function at runtime,
-- which is this migration's own trap sprung in the opposite direction.
-- create_promotion does not need the fourth argument on its own account: it
-- inserts a promotion no participation can yet name, so of the three violations
-- only two are reachable from it and the sqlstate already separates those.
--
-- That call site is now further down THIS file rather than in merged 0042 — this
-- migration recreates create_promotion too, for D1's ceiling — and the default
-- matters exactly as much either way, because the recreated body reproduces the
-- three-argument call unchanged.
-- ---------------------------------------------------------------------------
drop function public.promotion_write_error(text, integer, text);

create function public.promotion_write_error(
  p_hashtag    text,
  p_site_code  integer,
  p_sqlstate   text,
  p_constraint text default null
)
returns void
language plpgsql
-- Deliberately left volatile. Marking it immutable would let the planner
-- constant-fold a call with constant arguments, and a function whose entire
-- job is to raise would then raise at plan time instead of where it was called.
set search_path = pg_catalog, public
as $$
begin
  -- The constraint name is consulted BEFORE the sqlstate, because it is the
  -- more specific fact: two different constraints raise 23505 here and only
  -- this tells them apart. A null p_constraint compares as null, never as
  -- equal, so a three-argument caller falls through to the sqlstate branches
  -- exactly as it did before.
  if p_constraint = 'participations_one_per_member' then
    raise exception 'somebody already has more than one entry in this promotion; repeat entries can no longer be turned off'
      using errcode = '23505';
  elsif p_sqlstate = '23P01' then
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

-- The drop reset the ACL to Postgres's default of EXECUTE to PUBLIC. 0042
-- revoked it and this restores that: the function is only ever called from
-- inside a SECURITY DEFINER body, and a grant on it would make a function whose
-- entire job is to raise callable by anyone — noise rather than a hole, but
-- 0042 stated the reachability as a grant and dropping it here would quietly
-- unstate it.
revoke execute on function public.promotion_write_error(text, integer, text, text) from public;

comment on function public.promotion_write_error(text, integer, text, text) is
  'Translates the constraint violations create_promotion and update_promotion share into sentences an operator can act on. Holds EXECUTE for nobody: it is only ever called from inside a SECURITY DEFINER body. Three cases as of 0055, not two — 0052''s ON UPDATE CASCADE onto participations.allows_multiple means turning repeat entries off on a promotion where one listener holds two valid entries raises 23505 from participations_one_per_member, which is the SAME sqlstate as a duplicate site integration code and had been reaching the operator as a sentence about a numeric field they never filled in, with the number rendered as <NULL>. The constraint name is therefore consulted before the sqlstate. p_constraint defaults to null so that create_promotion''s three-argument call in merged 0042 still resolves; it cannot reach the third case anyway, because it inserts a promotion no participation can yet name.';

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
  -- Which constraint the UPDATE below tripped. Two of the three violations this
  -- function can raise share sqlstate 23505, so the handler has to ask.
  v_constraint      text;
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

-- Seventeen argument types, spelled out, on all three statements. A signature
-- typed one type short does not silently apply to the wrong function here — it
-- errors, because after the drop above there is exactly one update_promotion
-- and nothing else for a short list to resolve to.
revoke execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) from public;
grant execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) to authenticated;

comment on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) is
  'Replaces a promotion''s fields wholesale. Gated on promotions.edit. The Organization and Station come from the row, never a parameter. Block 4a''s D9 freeze IS here, in 0055, and 0042''s comment saying it was deliberately absent because it would have had to consult a table that did not exist is corrected by this one: once ANY participation exists — refused ones included, because somebody who was too early still read the hashtag and texted it — the hashtag and the start date are refused with 22023 and everything else stays editable, because nobody entered on account of the name and extending the end date takes nothing from anybody. Dropped and recreated rather than replaced, since p_max_entries_per_member changes the argument list and create or replace cannot: it would have left the sixteen-argument body alive beside this one, with every existing caller still resolving to the version that has no freeze. The ceiling itself is stored, not enforced here — apply_participation (0054) counts against it, and 0052''s check is what refuses a ceiling of one or a ceiling on a promotion that allows no repeats.';

-- ---------------------------------------------------------------------------
-- create_promotion is DROPPED and recreated too, and it belongs beside its
-- sibling above rather than in a migration of its own.
--
-- The first version of this migration gave the ceiling to update_promotion
-- ALONE, and that is a defect rather than a staged rollout. p_max_entries_per_member
-- is one field of one form: services/promotions.ts builds both calls from a
-- single promotionRpcArgs precisely because the two doors take the same field
-- set, and a promotion that can be edited into a ceiling but never born with one
-- is the "consistent except for the one nobody got to" shape this branch has
-- already rejected twice — Task 4's permission gate, and Block 4b's grant sweep.
--
-- Worse, the asymmetry is not inert. Sending seventeen arguments to the
-- sixteen-argument function does not raise a type error; PostgREST simply fails
-- to resolve the function at all and answers PGRST202, which maps to
-- InternalError and reaches an operator who filled in a legitimate field as
-- "Could not save". The alternative the service was carrying in the meantime —
-- refusing a ceiling at create time with a sentence — was honest but wrong as a
-- product: it made a field's availability depend on which button the operator
-- had pressed.
--
-- DROPPED rather than replaced, for the same reason and with the same trap as
-- update_promotion above: `create or replace` cannot change an argument list,
-- and used that way it leaves a SECOND sixteen-argument function alive. Here the
-- failure is silent in the same way — every existing sixteen-argument call site
-- resolves unambiguously to the survivor, which stores no ceiling, so the field
-- would appear to save and simply never be written. 02_permissions.test.sql
-- counts pg_proc entries by name for this function as well as for
-- update_promotion, because that count is the only assertion that can see a
-- surviving twin; ::regprocedure resolves the signature it is handed and
-- succeeds regardless of what else shares the name. (Measured, not assumed: with
-- the drop below removed, that count fails 2-against-1 while every signature pin
-- in 03_promotions.test.sql stays green.)
--
-- This SUPERSEDES the create_promotion in merged 0042, whose text is left alone
-- because that migration has shipped. Its body is reproduced below unchanged
-- except for the new parameter and the new column in the INSERT: the permission,
-- the Station lookup, the two presence checks and the constraint handler are
-- 0042's, and every coherence rule between the fields stays in the table's own
-- checks (0040 and 0052) rather than being restated here.
--
-- promotion_write_error is still called with THREE arguments, and that is not an
-- oversight of the fourth. An INSERT into promotions cannot cascade onto
-- participations — the row is new and no participation can yet name it — so of
-- the three violations that function distinguishes, only two are reachable from
-- here and the sqlstate already separates those. The fourth parameter's DEFAULT
-- is what keeps this call resolving, which is the reason it was given one.
--
-- Dropping resets the ACL to Postgres's default of EXECUTE to PUBLIC, so the
-- revoke and the grant below are not restated out of tidiness: without them anon
-- could reach this function, which is the exact hole 0050 closed for all six of
-- Block 4a's promotion RPCs.
-- ---------------------------------------------------------------------------
drop function public.create_promotion(
  uuid, text, timestamptz, timestamptz, integer, text, boolean, integer,
  boolean, boolean, text, boolean, text, text, text,
  public.promotion_requested_field[]);

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
  p_use_art                   boolean default false,
  p_art_url                   text default null,
  p_yes_button_label          text default null,
  p_no_button_label           text default null,
  p_requested_fields          public.promotion_requested_field[] default '{}',
  -- Last and defaulting to null, in the same position it takes on
  -- update_promotion, so that the two signatures read alike at the call site and
  -- one shared argument builder can fill both. Null means no ceiling; 0052's
  -- check refuses 1 and refuses any value at all unless allow_multiple_entries
  -- is true, so this function restates neither rule.
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
       allow_multiple_entries, min_hours_between_entries, max_entries_per_member,
       require_correct_answer,
       call_to_action, whatsapp_enabled, hashtag, use_art, art_url,
       yes_button_label, no_button_label, requested_fields, created_by)
    values
      (v_org, p_company_id, p_site_integration_code, v_name, p_starts_at, p_ends_at,
       coalesce(p_allow_multiple_entries, false), p_min_hours_between_entries,
       p_max_entries_per_member,
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

-- Seventeen argument types, spelled out, on all three statements — the same
-- discipline update_promotion's carry, and for the same reason: after the drop
-- above there is exactly one create_promotion, so a list typed one type short
-- errors rather than quietly applying to something else.
revoke execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) from public;
grant execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) to authenticated;

comment on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[], integer) is
  'Registers a promotion. Gated on promotions.create. Every coherence rule between the fields lives in the table''s own checks (0040 and 0052), not here — this function''s job is the permission, the Station and turning two constraint violations into sentences. Dropped and recreated in 0055 rather than replaced, because D1''s ceiling adds p_max_entries_per_member and create or replace cannot change an argument list: it would have left the sixteen-argument body from merged 0042 alive beside this one, and every existing call site would go on resolving to the version that stores no ceiling — a field that appears to save and is never written. The ceiling is stored, not enforced here; apply_participation (0054) counts against it, and 0052''s check is what refuses a ceiling of one or a ceiling on a promotion that allows no repeats. It reaches promotion_write_error with three arguments on purpose: an INSERT cannot cascade onto participations, so the constraint-name case that function gained in 0055 is unreachable from here.';

-- ---------------------------------------------------------------------------
-- save_promotion_question: D9's third surface, and the one the first draft of
-- this migration missed.
--
-- The guard is on the EDIT branch only. A non-null p_question_id replaces the
-- question and its options wholesale — 0043's own comment says "a given one
-- replaces, options included" — which is precisely the operation D9 forbids:
-- reword an option, or move is_correct onto a different one, and every
-- participation_answers row goes on pointing at an option that now says
-- something the person never read. Block 6 derives correctness at draw time by
-- joining promotion_question_options.is_correct (0052's table comment), so a
-- moved flag does not merely mislead a reader — it changes who won.
--
-- APPENDING stays open, and that is the spec's word rather than a convenience:
-- "Open: ... and ADDING a new question." A question nobody has been asked
-- cannot invalidate an answer nobody gave, and the alternative — freezing the
-- whole form — would stop an operator adding the tie-breaker question that
-- promotions routinely need once they are running.
--
-- Checked on the PROMOTION rather than on whether this particular question has
-- an answer, for the reason remove_promotion_question's comment gives at the
-- foot of this file: an operator gets the same answer either way, instead of a
-- rule that depends on which questions people happened to reach.
--
-- The signature does not change, so `create or replace` is correct here.
-- ---------------------------------------------------------------------------
create or replace function public.save_promotion_question(
  p_promotion_id uuid,
  p_kind         public.promotion_question_kind,
  p_prompt       text,
  p_menu_title   text default null,
  p_button_label text default null,
  p_options      jsonb default '[]'::jsonb,
  p_question_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_company  uuid;
  v_id       uuid := p_question_id;
  v_prompt   text := nullif(btrim(coalesce(p_prompt, '')), '');
  v_menu     text := nullif(btrim(coalesce(p_menu_title, '')), '');
  v_button   text := nullif(btrim(coalesce(p_button_label, '')), '');
  v_options  jsonb := coalesce(p_options, '[]'::jsonb);
  v_count    integer := jsonb_array_length(v_options);
  v_correct  integer;
  v_position integer;
begin
  -- FOR UPDATE on the promotion, not the question: a new question has no row to
  -- lock, and the next position is read from its siblings. Holding the parent
  -- is what stops two concurrent adds picking the same number.
  select organization_id, company_id into v_org, v_company
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.edit', v_company) then
    raise log 'save_promotion_question denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.edit required' using errcode = '42501';
  end if;

  -- Block 4a's D9, finally able to fire. Before the shape checks below rather
  -- than after them, unlike update_promotion's: this refusal depends on no
  -- input beyond "is this an edit", so there is no incomplete-submission case
  -- it could mislabel, and nothing about the prompt or the options can make a
  -- forbidden edit permissible.
  if v_id is not null and exists (
    select 1 from public.participations where promotion_id = p_promotion_id
  ) then
    raise exception 'somebody has already entered this promotion; its questions can no longer be edited'
      using errcode = '22023';
  end if;

  if v_prompt is null then
    raise exception 'the question needs a prompt' using errcode = '22023';
  end if;

  if jsonb_typeof(v_options) <> 'array' then
    raise exception 'options must be a list' using errcode = '22023';
  end if;

  select count(*) into v_correct
  from jsonb_array_elements(v_options) as o
  where coalesce((o ->> 'is_correct')::boolean, false);

  -- The three rules the schema cannot state. The first is the important one:
  -- a partial unique index forbids the SECOND right answer, and nothing can
  -- require a FIRST. This is the only place that rule exists, which is why it
  -- is checked before anything is written rather than after.
  if p_kind = 'QUIZ' and v_correct <> 1 then
    raise exception 'a quiz question needs exactly one right answer, and % were marked', v_correct
      using errcode = '22023';
  end if;

  if p_kind = 'ESSAY' and v_count > 0 then
    raise exception 'an essay question takes no options' using errcode = '22023';
  end if;

  if p_kind <> 'ESSAY' and v_count < 2 then
    raise exception 'a choice question needs at least two options, and % were given', v_count
      using errcode = '22023';
  end if;

  if v_id is null then
    select coalesce(max(position), 0) + 1 into v_position
    from public.promotion_questions
    where promotion_id = p_promotion_id;

    insert into public.promotion_questions
      (promotion_id, organization_id, company_id, position, kind, prompt,
       menu_title, button_label)
    values
      (p_promotion_id, v_org, v_company, v_position, p_kind, v_prompt,
       v_menu, v_button)
    returning id into v_id;
  else
    -- Options are replaced wholesale below, so they must go before the kind
    -- changes: an option row still marked correct would make a QUIZ-to-poll
    -- edit fail on the cascade, refusing an edit the operator has already
    -- corrected on screen.
    delete from public.promotion_question_options where question_id = v_id;

    update public.promotion_questions set
      kind         = p_kind,
      prompt       = v_prompt,
      menu_title   = v_menu,
      button_label = v_button,
      updated_at   = now()
    where id = v_id and promotion_id = p_promotion_id;

    if not found then
      raise exception 'question not found in this promotion: %', v_id using errcode = 'P0002';
    end if;
  end if;

  insert into public.promotion_question_options
    (question_id, kind, organization_id, company_id, position, label, is_correct)
  select
    v_id, p_kind, v_org, v_company, o.ordinality,
    btrim(o.value ->> 'label'),
    coalesce((o.value ->> 'is_correct')::boolean, false)
  from jsonb_array_elements(v_options) with ordinality as o(value, ordinality);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'save_promotion_question', 'promotion_questions', v_id, v_org, v_company,
     jsonb_build_object('promotion_id', p_promotion_id, 'kind', p_kind, 'options', v_count));

  return v_id;
end;
$$;

revoke execute on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) from public;
grant execute on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) to authenticated;

comment on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) is
  'Writes a question and its options in one call — they are one form, and splitting them would let a question exist with no options or with the previous version''s. A null p_question_id appends; a given one replaces, options included. Gated on promotions.edit. Holds "exactly one right answer on a QUIZ", which no index can express: an index forbids the second and nothing can require the first. As of 0055 it also holds Block 4a''s D9: once ANY participation exists on the promotion, the REPLACE branch is refused with 22023, because rewording an option — or moving is_correct onto a different one — would leave every participation_answers row pointing at text the person never read, and Block 6 derives correctness at draw time by reading exactly that option back. Appending a new question stays open, which is D9''s own wording and is safe for the reason the refusal is not: a question nobody has been asked cannot invalidate an answer nobody gave.';

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
