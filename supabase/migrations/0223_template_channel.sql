-- supabase/migrations/0223_template_channel.sql

-- Block 29b-1, Task 2. One table, two channels -- and the door that the index
-- change breaks if it ships alone.
--
-- WHY ONE TABLE AND NOT ONE PER CHANNEL (design D1). Not to save a join. A
-- campaign (29d) points at ONE template and must not use the wrong channel's,
-- and with a `channel` column that rule is a foreign key plus a CHECK. With two
-- tables a campaign needs two nullable foreign keys or a polymorphic reference,
-- and the rule stops being expressible in the schema at all -- it becomes a
-- sentence in application code that the database cannot hold.

-- ---------------------------------------------------------------------------
-- 1. The columns.
--
-- `channel` arrives with a default so the existing rows are legal at the moment
-- the column exists, and the default is DROPPED immediately after: a default of
-- WHATSAPP on a table that now holds email templates would make the channel an
-- assumption rather than a statement, and the marketing door below sets it
-- explicitly for exactly that reason.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add column channel public.message_channel not null default 'WHATSAPP';

alter table public.message_templates
  alter column channel drop default;

alter table public.message_templates
  add column internal_name text,
  add column description   text,
  add column subject       text,
  add column from_name     text,
  add column from_email    text,
  add column reply_to      text,
  add column updated_by    uuid references auth.users (id);

comment on column public.message_templates.channel is
  'WHATSAPP or EMAIL. NOT NULL and with no default: a template that did not say which door it speaks through is a template somebody will send through the wrong one.';

comment on column public.message_templates.internal_name is
  'What an operator calls this template. NOT Meta''s name: with many marketing templates per Station, "pickup_reminder" is a value the Cloud API needs and not a label anybody searches by. A SYSTEM template gets this from `name`, because its card is titled by its purpose and there is no second label to give it.';

comment on column public.message_templates.from_name is
  'An override of the Station''s own sender identity (companies.email_from_name, 0226), null in the ordinary case. The Station declares it once; a template that needs to differ says so here. Null on every WhatsApp row, which has no sender to name.';

-- ---------------------------------------------------------------------------
-- 2. purpose becomes nullable, and null MEANS something.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  alter column purpose drop not null;

comment on column public.message_templates.purpose is
  'What a SYSTEM template is for, and NULL for every marketing template. The null is not an absence to tidy away: it is the discriminator between the two families, and message_templates_purpose_unique is partial on it so the index keeps meaning one registration per system purpose and stays a valid ON CONFLICT target for register_message_template -- not to stop marketing rows from colliding with one another, since a plain unique index never treats NULL as equal to NULL and they never would have.';

-- ---------------------------------------------------------------------------
-- 3. name and language become conditional, so the existing not-blank checks
-- have to admit null.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  alter column name drop not null,
  alter column language drop not null;

alter table public.message_templates
  drop constraint message_templates_name_not_blank,
  drop constraint message_templates_language_not_blank;

alter table public.message_templates
  add constraint message_templates_name_not_blank
    check (name is null or btrim(name) <> ''),
  add constraint message_templates_language_not_blank
    check (language is null or btrim(language) <> '');

-- ---------------------------------------------------------------------------
-- 4. variables: from prose to vocabulary.
--
-- RUN BEFORE THE CONDITIONAL PAIRS BELOW (originally drafted as step 5, moved
-- ahead of what was step 4): the email_variables_empty constraint below reads
-- `cardinality(variables)`, a function that does not exist for jsonb -- so it
-- can only be added once this section has already retyped the column to
-- public.template_variable[]. The two sections were also order-locked the
-- other way: that constraint would depend on the OLD jsonb `variables` column,
-- and this section's `drop column variables` would then fail with objects
-- depending on it. One order works; the other does not.
--
-- THE BACKFILL TAKES THE FIRST N OF THE PURPOSE'S CANONICAL ORDER, where N is
-- the row's existing description count -- rather than assuming a shape.
-- register_message_template has always refused a registration whose description
-- count disagrees with the body's placeholder count, so every existing row's
-- count is already correct -- and a Station's approved PICKUP_REMINDER body may
-- legitimately use one placeholder or three.
--
-- WHAT THE CLAMP ACTUALLY DOES, stated plainly because it is NOT a count-
-- preserving rewrite in general: `where o <= jsonb_array_length(m.variables)`
-- filters a FIXED canonical list (1 element for WEB_VERIFICATION, 3 for
-- PICKUP_REMINDER, none otherwise), so it can only ever shorten that list, never
-- extend it. The count survives exactly while N is at most the canonical
-- length. A row carrying MORE descriptions than its purpose's canonical list
-- comes out SHORTER than its body's placeholder count -- a shape
-- register_message_template would itself refuse to write -- and a row of any
-- other purpose comes out empty. Such a row must be RE-REGISTERED through
-- register_message_template, which is the only writer that checks the count
-- against the body. It is deliberately not padded: there is no
-- template_variable value meaning "unknown", and inventing one would give the
-- screen a row that reads as registered and is not.
--
-- Measured before writing: production holds ONE row (WEB_VERIFICATION, one
-- description), where N equals the canonical length and the clamp cannot bite.
-- That is what makes a typed vocabulary affordable here -- over hundreds of
-- prose rows the mapping would be guesswork. The proof of this backfill is a
-- post-deploy read of that one row, not a test: a test constructing input and
-- re-running this same CASE expression would only assert that a copy of the
-- code agrees with the code.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add column variable_fields public.template_variable[] not null default '{}';

update public.message_templates m
   set variable_fields = (
     select coalesce(array_agg(v order by o), '{}')
     from unnest(
       case m.purpose
         when 'PICKUP_REMINDER' then
           -- FIRST name at {{1}}, not the full one, however much the reverse
           -- looks like the safer guess. The live sender decides this, not this
           -- migration: 0112_sweep_pickup_reminders.sql:112 computes
           -- `split_part(btrim(v_full_name), ' ', 1)` and passes it as the first
           -- element of jsonb_build_array (:134), because a pickup reminder is a
           -- message a person reads and not a record. Labelling {{1}}
           -- LISTENER_FULL_NAME would make the screen describe a substitution
           -- that never happens.
           array['LISTENER_FIRST_NAME', 'PRIZE_NAME', 'PICKUP_DEADLINE']::public.template_variable[]
         when 'WEB_VERIFICATION' then
           array['VERIFICATION_CODE']::public.template_variable[]
         else '{}'::public.template_variable[]
       end
     ) with ordinality as t(v, o)
     where o <= jsonb_array_length(m.variables)
   );

alter table public.message_templates drop column variables;
alter table public.message_templates rename column variable_fields to variables;
alter table public.message_templates alter column variables drop default;
alter table public.message_templates alter column variables set default '{}';

comment on column public.message_templates.variables is
  'What this template substitutes, IN ORDER: index 0 is {{1}}. Typed against template_variable (0222) rather than the prose array it replaced, which described something to a human and let no code act on it. EMPTY on every email row -- an email body names its own placeholders inline, so an array beside it would be a second declaration (message_templates_email_variables_empty holds that structurally).';

-- ---------------------------------------------------------------------------
-- 5. The conditional pairs, in the shape this schema already uses three times
-- (outbox_messages_template_shape, _sent_shape, _retention_shape): a row names
-- all of a channel's fields or none of them.
-- ---------------------------------------------------------------------------
alter table public.message_templates
  add constraint message_templates_whatsapp_shape
    check (channel <> 'WHATSAPP' or (name is not null and language is not null)),

  add constraint message_templates_email_shape
    check (channel <> 'EMAIL' or (subject is not null and btrim(subject) <> '')),

  -- NOT symmetry for its own sake. Without this an email template may carry a
  -- name, a language and the OTP flag, and every screen and query that reads
  -- "is this registered at Meta" gains a row that answers yes and is not.
  add constraint message_templates_email_no_meta_fields
    check (channel <> 'EMAIL' or (name is null and language is null and not otp_button)),

  -- An email body names its own placeholders inline ({{listener_first_name}}),
  -- so a positional array beside it would be a second declaration to drift from
  -- the first. The door validates the body against the enum on save.
  add constraint message_templates_email_variables_empty
    check (channel <> 'EMAIL' or cardinality(variables) = 0);

-- ---------------------------------------------------------------------------
-- 6. internal_name becomes required, after the backfill that can satisfy it.
-- ---------------------------------------------------------------------------
update public.message_templates set internal_name = name where internal_name is null;

alter table public.message_templates
  alter column internal_name set not null,
  add constraint message_templates_internal_name_not_blank
    check (btrim(internal_name) <> '');

-- ---------------------------------------------------------------------------
-- 7. The index, narrowed.
--
-- Without `and purpose is not null`, ON CONFLICT (company_id, purpose) --
-- register_message_template's own conflict target -- no longer matches this
-- index's predicate, and every system registration fails. NOT because a
-- marketing row would collide with another marketing row: a plain unique
-- index never treats NULL as equal to NULL, so two null-purpose rows were
-- never going to raise 23505 against it. The predicate exists so the index
-- keeps meaning ONE registration per system purpose, with marketing rows --
-- which have none -- excluded from it entirely.
-- ---------------------------------------------------------------------------
drop index public.message_templates_purpose_unique;

create unique index message_templates_purpose_unique
  on public.message_templates (company_id, purpose)
  where deleted_at is null and purpose is not null;

-- ---------------------------------------------------------------------------
-- 8. register_message_template, recreated FROM ITS LIVE DEFINITION.
--
-- WHY IT IS HERE AND NOT IN ITS OWN FILE: the ON CONFLICT clause below names
-- the index recreated in step 7. Ship them apart and every system registration
-- raises "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification" for however long the two files are separated.
--
-- THE SIGNATURE DOES NOT CHANGE, and that is deliberate rather than lucky:
-- `create or replace` keeps the ACL, where a drop would take it and leave every
-- registration answering 42501 -- which no test calling this as the OWNER would
-- notice, because has_permission's owner bypass opens the door for the one
-- identity that never needed the grant. Block 24 lost an ACL exactly that way.
--
-- p_variables STAYS jsonb for the same reason. The column is now
-- template_variable[]; the parameter is cast inside. Widening the parameter to
-- the array type would be a new signature, and the ACL would go with it.
--
-- WHAT ACTUALLY CHANGED, checked clause by clause against 0165 (fix round 3:
-- the previous version of this comment undercounted the columns below by
-- one, so this list is written to be checked against the body rather than
-- trusted):
--
--   1. The ON CONFLICT predicate now names the index narrowed in step 7
--      (gained `and purpose is not null`).
--   2. p_variables is cast to public.template_variable[] before use: a new
--      begin/exception block turns the jsonb array into v_fields, refusing
--      22023 for any element the cast cannot resolve, and the placeholder-
--      count check that follows now compares against v_fields (cardinality)
--      rather than the raw jsonb array (jsonb_array_length).
--   3. 0165's own non-blank-string guard, which used to run against v_vars
--      directly, now runs ahead of that cast and is narrower than it was:
--      only the non-string half (`jsonb_typeof(e) <> 'string'`) remains,
--      because the blank-string half is now caught redundantly by the cast
--      itself (`btrim('')` matches no enum label). Removed when this
--      function was first rewritten for this migration, then restored in
--      this exact narrower shape once fix round 2 (F3) found the cast alone
--      lets a JSON null through silently -- confirmed directly against the
--      live function.
--   4. The insert fills THREE columns this door now owns itself: `channel`
--      (fixed at 'WHATSAPP', since a system purpose is never email),
--      `internal_name` (reused from v_name -- a system card has no second
--      label to give it), and `updated_by` (stamped from v_actor). The ON
--      CONFLICT DO UPDATE carries `internal_name` and `updated_by` forward
--      on every re-registration too; `channel` is set once at insert and
--      never revised there, because re-registering never changes which
--      door a system purpose sends through.
-- ---------------------------------------------------------------------------
create or replace function public.register_message_template(
  p_company_id uuid,
  p_purpose    public.template_purpose,
  p_name       text,
  p_language   text,
  p_body       text,
  p_variables  jsonb default '[]'::jsonb,
  p_otp_button boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_name     text := nullif(btrim(p_name), '');
  v_language text := nullif(btrim(p_language), '');
  v_body     text := nullif(btrim(p_body), '');
  v_vars     jsonb := coalesce(p_variables, '[]'::jsonb);
  v_otp      boolean := coalesce(p_otp_button, false);
  v_fields   public.template_variable[];
  v_expected integer;
  v_id       uuid;
begin
  if not public.has_permission('templates.manage', p_company_id) then
    raise log 'register_message_template denied: actor=% company=% purpose=%',
      v_actor, p_company_id, p_purpose;
    raise exception 'permission denied: templates.manage required' using errcode = '42501';
  end if;

  select organization_id into v_org
    from public.companies
   where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Three separate refusals rather than one, so the message names the field
  -- the operator has to go back and fix. 0110 carries a check constraint for
  -- each of these; reaching them would be a 23514 naming a constraint.
  if v_name is null then
    raise exception 'the template name Meta approved is required' using errcode = '22023';
  end if;

  if v_language is null then
    raise exception 'the language Meta approved is required' using errcode = '22023';
  end if;

  if v_body is null then
    raise exception 'the approved body is required' using errcode = '22023';
  end if;

  if jsonb_typeof(v_vars) <> 'array' then
    raise exception 'the variables must be a JSON array' using errcode = '22023';
  end if;

  -- Carried forward from 0113/0165's own guard: every element a non-blank
  -- STRING, checked before the cast rather than left to it. The blank-string
  -- half is also caught by the cast below (btrim('') fails the enum lookup),
  -- but the null half is not -- `jsonb_array_elements('[null]') #>> '{}'`
  -- yields SQL NULL, and casting NULL to any type never raises. Without this
  -- check a JSON null in p_variables would silently become a NULL element
  -- inside variable_fields (confirmed directly against the live cast: it
  -- returns {NULL}, not an error), stored in an array whose own column is
  -- NOT NULL but whose ELEMENTS nothing here was otherwise refusing one at a
  -- time -- and src/services/templates.ts filters non-strings when it reads
  -- the array back, so the screen would silently show fewer labels than the
  -- body has positions rather than the operator ever seeing a refusal.
  if exists (
    select 1 from jsonb_array_elements(v_vars) as e
     where jsonb_typeof(e) <> 'string'
  ) then
    raise exception 'every variable must be named as a string' using errcode = '22023';
  end if;

  -- Block 29b-1. The array is now a VOCABULARY rather than prose, so an element
  -- outside template_variable is refused by name here instead of arriving as a
  -- raw 22P02 from the cast below. The screen offers a closed list, so reaching
  -- this means a hand-made call or a stale client.
  begin
    select array_agg(e #>> '{}' order by ord)::public.template_variable[]
      into v_fields
      from jsonb_array_elements(v_vars) with ordinality as t(e, ord);
  exception
    when invalid_text_representation then
      raise exception 'one of the variables is not a value this system substitutes'
        using errcode = '22023';
  end;

  v_fields := coalesce(v_fields, '{}'::public.template_variable[]);

  -- The same comparison 0111 makes at enqueue, moved to the moment it can
  -- still be acted on. The regexp form is 0111's, verified there against
  -- PostgreSQL 17.6.
  v_expected := coalesce((
    select max((regexp_matches[1])::integer)
    from regexp_matches(v_body, '\{\{(\d+)\}\}', 'g')
  ), 0);

  if cardinality(v_fields) <> v_expected then
    raise exception 'this body uses % placeholder(s) but % variable(s) were given',
      v_expected, cardinality(v_fields)
      using errcode = '22023';
  end if;

  -- 0165. An OTP button's parameter is the code, and the code is what the body
  -- says with its placeholder -- so a template marked as carrying the button
  -- with nothing to put in it is a registration that could never be sent.
  if v_otp and v_expected = 0 then
    raise exception 'an authentication template carries the code in {{1}}; this body has no placeholder'
      using errcode = '22023';
  end if;

  -- Block 29b-1: `channel` and `internal_name` are filled HERE rather than
  -- taken as parameters. A system purpose is never email, and a system card is
  -- titled by its purpose -- so there is no second label an operator could give
  -- it, and widening the signature to ask for one would drop the ACL for a
  -- field nobody would fill.
  insert into public.message_templates
    (organization_id, company_id, purpose, channel, internal_name,
     name, language, body, variables, otp_button, created_by, updated_by)
  values
    (v_org, p_company_id, p_purpose, 'WHATSAPP', v_name,
     v_name, v_language, v_body, v_fields, v_otp, v_actor, v_actor)
  on conflict (company_id, purpose) where deleted_at is null and purpose is not null
  do update set name          = excluded.name,
                internal_name = excluded.internal_name,
                language      = excluded.language,
                body          = excluded.body,
                variables     = excluded.variables,
                otp_button    = excluded.otp_button,
                updated_by    = excluded.updated_by,
                updated_at    = now()
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'register_message_template', 'message_templates', v_id, v_org, p_company_id,
     jsonb_build_object('purpose', p_purpose, 'name', v_name, 'language', v_language,
                        'otp_button', v_otp));

  return v_id;
end;
$$;
