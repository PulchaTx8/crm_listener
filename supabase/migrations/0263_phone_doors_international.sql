-- supabase/migrations/0263_phone_doors_international.sql

-- Block 30d, item 1b, D4. The doors that write a listener's telephone number
-- now write ONE shape: international_phone's answer (0260), computed from the
-- Station's own country. Six functions, and in each the phone is sanitised
-- once, on entry, before it is compared or stored.
--
-- WHY AT THE DOORS AND NOT IN THE SHARED RESOLVER. apply_member_lookup and
-- find_member_by_identifier (0061) are the single point every one of these
-- doors already funnels through, and they are the wrong place twice over: they
-- resolve and never write, so a door that looked up the clean number and
-- inserted the raw one would find the right listener and still store the wrong
-- form; and they take an Organization, while the calling code lives on the
-- Station. Adding a parameter to them would OVERLOAD rather than replace them
-- (D4), leaving every un-edited caller on the old signature, silently.
--
-- EVERY BODY BELOW IS THE LIVE DEFINITION, dumped with pg_get_functiondef and
-- edited, not re-derived from the migration that introduced the function. Most
-- of these are live somewhere other than where they were introduced --
-- widget_verify_code on 0164 not 0161, create_member and update_member on 0220
-- not 0034 -- and re-typing an older body silently reverts every repair made
-- since, with nothing turning red. 0172's header records the time this project
-- did exactly that.
--
-- NO SIGNATURE MOVES, so every one of these is a create-or-replace and every
-- ACL survives untouched (the Block 24 loss came from a drop). The grants are
-- restated at the foot of this file anyway, matching what pg_proc.proacl held
-- before it ran, so a future drop-and-recreate has the list in front of it.
--
-- IMPORT_PARTICIPATIONS IS NOT HERE, deliberately, and it is on the plan's own
-- list of doors. Its live body (0056) touches the spreadsheet's phone exactly
-- twice: in the "no identifier" test, which only asks whether the cell is
-- blank, and as the argument it hands to resolve_or_create_member -- which is
-- the first function below. Sanitising it here would be the same rule written
-- a second time one call further up, and re-typing a 170-line body in order to
-- change nothing in it is the exact risk the paragraph above describes.
--
-- WHAT THIS FILE DOES NOT CLOSE. The WhatsApp bot registers a listener through
-- apply_member_creation with whatsapp_local_phone's answer -- the LOCAL form --
-- in ingest_whatsapp_event and ingest_link_intent, both live on 0179. Those two
-- doors belong to Tasks 7 and 8 of this block and are not touched here. Until
-- they are, a listener whose first contact is a WhatsApp message is stored as
-- 11988887777 while every door in this file searches for 5511988887777 -- so
-- each lookup below goes on searching the RAW spelling too, second. That is not
-- caution: without it this migration would REGRESS the bot-then-widget case,
-- which resolves correctly today precisely because the widget searched the raw
-- local form and found the bot's row. Each of those branches names itself and
-- says when it can be deleted.

-- 1. resolve_or_create_member -- live on 0054. The manual entry door behind
-- the Participations screen, and the per-row door import_participations
-- calls. It sanitises for BOTH halves of what it does: the search here, and
-- the registration through create_member below.
create or replace function public.resolve_or_create_member(
  p_company_id      uuid,
  p_full_name       text,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_cpf_last_digits text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org     uuid;
  v_country text;
  v_phone   text;
  v_found   jsonb;
  v_id      uuid;
begin
  select organization_id, country into v_org, v_country
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Block 30d, item 1b. Sanitised HERE, at the door, and not inside
  -- apply_member_lookup or find_member_by_identifier: those functions resolve
  -- and never write, so a door that looked up the clean number and inserted
  -- the raw one would find the right listener and still store the wrong form
  -- -- the same split, one layer deeper. The country comes from the Station
  -- this door already resolved above.
  v_phone := public.international_phone(p_phone, v_country);

  v_found := public.find_member_by_identifier(
    v_org, v_phone, p_email, p_cpf_hash, p_passport);

  -- THE RAW SPELLING IS STILL SEARCHED, SECOND, and this is not belt and
  -- braces. The WhatsApp bot's own registration (apply_member_creation called
  -- with whatsapp_local_phone's answer, in ingest_whatsapp_event and
  -- ingest_link_intent, both live on 0179) still writes the LOCAL form, so a
  -- listener whose first contact was a WhatsApp message is stored as
  -- 11988887777 while this door now searches for 5511988887777. Searching the
  -- canonical form alone would miss them and register a second row -- exactly
  -- the split item 1b exists to stop, in the one direction this migration does
  -- not close. Adding the canonical search IN FRONT of the search this door
  -- already made, rather than in place of it, is what keeps every listener
  -- reachable today reachable after it. Delete this branch when the bot's
  -- doors write the canonical form too.
  if v_found ->> 'outcome' = 'none' and v_phone is distinct from p_phone then
    v_found := public.find_member_by_identifier(
      v_org, p_phone, p_email, p_cpf_hash, p_passport);
  end if;

  if v_found ->> 'outcome' = 'visible' then
    return jsonb_build_object(
      'outcome', 'resolved', 'member_id', (v_found ->> 'member_id')::uuid);
  end if;

  if v_found ->> 'outcome' = 'elsewhere' then
    return jsonb_build_object('outcome', 'elsewhere');
  end if;

  v_id := public.create_member(
    p_company_id, p_full_name, v_phone, p_email,
    p_cpf_hash, p_cpf_last_digits, p_passport);

  return jsonb_build_object('outcome', 'created', 'member_id', v_id);
end;
$$;

-- 2. create_member -- live on 0220 (0034 introduced it; 0061, 0073, 0074,
-- 0213 and 0220 each rewrote it since). The console's own registration door.
create or replace function public.create_member(
  p_company_id uuid,
  p_full_name text,
  p_phone text default null,
  p_email text default null,
  p_cpf_hash text default null,
  p_cpf_last_digits text default null,
  p_passport text default null,
  p_birth_date date default null,
  p_address_line text default null,
  p_address_number text default null,
  p_address_complement text default null,
  p_neighbourhood text default null,
  p_city text default null,
  p_state text default null,
  p_postal_code text default null,
  p_discovery_source text default null,
  p_first_contact_at timestamptz default null,
  p_first_contact_origin text default null,
  p_country text default null,
  p_gender text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_country text;
  v_phone   text;
  v_name    text := nullif(trim(p_full_name), '');
  v_id      uuid;
begin
  -- FOR SHARE: member_links_company_org_fk (0031) cannot see deleted_at -- a
  -- composite foreign key cannot reference a partial index -- so without this lock a
  -- concurrent write to this Station's deleted_at, between this check and the
  -- member_company_links insert below, could let the link be written against a
  -- Station that is archived by the time this transaction commits. Same reasoning
  -- assign_company_role (0017) gives for its FOR SHARE on roles.
  select organization_id, country into v_org, v_country
  from public.companies
  where id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('members.create', p_company_id) then
    raise log 'create_member denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: members.create required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'listener name is required' using errcode = '22023';
  end if;

  -- Block 30d, item 1b. Sanitised HERE, at the door, and not inside
  -- apply_member_creation: that core is shared with the WhatsApp doors, which
  -- Tasks 7 and 8 of this block rewrite, and a rule planted in the core would
  -- be rewritten from underneath by whichever of us copied the older body
  -- forward. The country is the STATION's, read in the same statement that was
  -- already reading organization_id -- not p_country, which is where this
  -- listener LIVES and is routinely blank while the phone is not.
  --
  -- This also replaces the nullif(trim(coalesce(...))) that guarded the insert
  -- below: international_phone goes through normalize_phone (0031), which
  -- answers null for a blank or punctuation-only value, so "not supplied" is
  -- still null and the four partial unique indexes still see nothing.
  v_phone := public.international_phone(p_phone, v_country);

  -- Four independent partial unique indexes (phone, e-mail, CPF hash, passport;
  -- 0031_members.sql) can each be the one that collides. find_member_by_identifier
  -- (0033) is the friendly pre-submission path; this is what makes a duplicate
  -- unrepresentable even if a caller skips it or loses a race.
  begin
    insert into public.members
      (organization_id, full_name, phone, email, cpf_hash, cpf_last_digits, passport,
       birth_date, gender, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, country, discovery_source, first_contact_at,
       first_contact_origin, created_by)
    values
      (v_org, v_name,
       v_phone, nullif(trim(coalesce(p_email, '')), ''),
       -- Normalised the same way 0033's find_member_by_identifier normalises them
       -- (Task 3 review, Important 4): an empty string -- what an HTML/JSON client
       -- sends for a blank field -- would otherwise reach 0031's cpf_hash format
       -- CHECK and surface as a raw 23514 outside the unique_violation handler
       -- below, instead of simply being treated as "not supplied".
       nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''), nullif(trim(coalesce(p_cpf_last_digits, '')), ''),
       nullif(trim(coalesce(p_passport, '')), ''),
       p_birth_date,
       -- Through the resolver, like every other write to this column. A form
       -- posts a code or nothing, and the three codes resolve to themselves --
       -- but routing the operator's value through the same function as the
       -- listener's is what keeps ONE definition of what this column may hold.
       public.gender_normalize(p_gender),
       nullif(trim(coalesce(p_address_line, '')), ''), nullif(trim(coalesce(p_address_number, '')), ''),
       nullif(trim(coalesce(p_address_complement, '')), ''), nullif(trim(coalesce(p_neighbourhood, '')), ''),
       nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_state, '')), ''),
       nullif(trim(coalesce(p_postal_code, '')), ''),
       public.country_alpha2(p_country),
       nullif(trim(coalesce(p_discovery_source, '')), ''),
       p_first_contact_at, nullif(trim(coalesce(p_first_contact_origin, '')), ''),
       v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (v_id, p_company_id, v_org, v_actor);

  -- Block 5b, D3. Everything the operator actually typed is confirmed as of now.
  -- An empty "before" against the record as it now stands, which is the same
  -- comparison a save makes -- so the rule lives in one function and this door
  -- does not carry a second copy of it.
  perform public.apply_member_field_confirmations(
    v_id, v_org, '{}'::jsonb, public.member_field_values(v_id));

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));

  return v_id;
end;
$$;

-- 3. update_member -- live on 0220. The ficha's save. Without this one, a
-- save that changed nothing but the name would write the phone back in
-- whatever shape the form was holding and undo 0262 one listener at a time.
create or replace function public.update_member(
  p_member_id uuid,
  p_full_name text,
  p_phone text default null,
  p_email text default null,
  p_cpf_hash text default null,
  p_cpf_last_digits text default null,
  p_passport text default null,
  p_birth_date date default null,
  p_address_line text default null,
  p_address_number text default null,
  p_address_complement text default null,
  p_neighbourhood text default null,
  p_city text default null,
  p_state text default null,
  p_postal_code text default null,
  p_discovery_source text default null,
  p_country text default null,
  p_gender text default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_country text;
  v_phone   text;
  v_name    text := nullif(trim(p_full_name), '');
  v_before  jsonb;
begin
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.edit') then
    raise log 'update_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.edit required' using errcode = '42501';
  end if;

  if v_name is null then
    raise exception 'listener name is required' using errcode = '22023';
  end if;

  -- Block 30d, item 1b, AND THE COUNTRY IS STILL THE STATION'S -- but this
  -- door takes no p_company_id, so the Station is the one this listener is
  -- linked to. Oldest link first so the answer cannot depend on the planner: a
  -- listener linked to two Stations of one Organization gets the country of
  -- the one that registered them, and c.id breaks a tie between two links
  -- written in the same statement.
  --
  -- Not p_country: that column is where the listener LIVES (0213), and this
  -- form clears it whenever the operator leaves the select blank -- so reading
  -- the country from it would mean an ordinary save of an ordinary ficha
  -- storing the phone unprefixed and undoing 0262's repair one listener at a
  -- time. A listener with no link at all leaves v_country null, which
  -- international_phone answers by returning the digits unchanged.
  select c.country into v_country
    from public.member_company_links l
    join public.companies c on c.id = l.company_id
   where l.member_id = p_member_id
   order by l.linked_at, c.id
   limit 1;

  v_phone := public.international_phone(p_phone, v_country);

  -- Read BEFORE the write and after the permission check, so a refused save
  -- costs nothing and a successful one has something to compare against.
  v_before := public.member_field_values(p_member_id);

  -- deleted_at and anonymized_at are re-checked HERE, inside the UPDATE's own WHERE
  -- clause, not only via the earlier SELECT: a plain read-then-write would leave a
  -- window where archive_member or anonymize_member commits between the read and
  -- this write, and this call would then either silently succeed on an
  -- already-archived row or -- the single worst thing this function could do --
  -- silently re-plant a name/phone/e-mail onto a row anonymize_member just erased.
  -- The WHERE clause makes the check and the write one atomic statement, so no
  -- window exists for either race.
  begin
    update public.members
       set full_name          = v_name,
           phone               = v_phone,
           email               = nullif(trim(coalesce(p_email, '')), ''),
           -- Same normalisation as create_member, for the same reason: an empty
           -- string must be treated as "not supplied", not hit the cpf_hash format
           -- CHECK (0031) as a raw 23514.
           cpf_hash            = nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''),
           cpf_last_digits     = nullif(trim(coalesce(p_cpf_last_digits, '')), ''),
           passport            = nullif(trim(coalesce(p_passport, '')), ''),
           birth_date          = p_birth_date,
           -- Through the resolver, like country below, and CLEARABLE for the
           -- same reason: this form sets every field it takes on every call, so
           -- a blank Sex select means "not recorded" and gender_normalize
           -- answers null for it. That is how an operator UNDOES a wrong value
           -- -- and it is why the decline is a storable code rather than being
           -- spelled as the empty selection, which would make "declined" and
           -- "cleared" the same click.
           gender              = public.gender_normalize(p_gender),
           address_line        = nullif(trim(coalesce(p_address_line, '')), ''),
           address_number      = nullif(trim(coalesce(p_address_number, '')), ''),
           address_complement  = nullif(trim(coalesce(p_address_complement, '')), ''),
           neighbourhood       = nullif(trim(coalesce(p_neighbourhood, '')), ''),
           city                = nullif(trim(coalesce(p_city, '')), ''),
           state               = nullif(trim(coalesce(p_state, '')), ''),
           postal_code         = nullif(trim(coalesce(p_postal_code, '')), ''),
           -- Through the resolver, like every other write to this column, and
           -- CLEARABLE like its neighbours: this form sets every field it takes
           -- on every call, so a blank Country select means "no country" and
           -- country_alpha2 answers null for it.
           country             = public.country_alpha2(p_country),
           discovery_source    = nullif(trim(coalesce(p_discovery_source, '')), ''),
           updated_at          = now()
     where id = p_member_id and deleted_at is null and anonymized_at is null;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  -- The two flags share one WHERE clause above for atomicity, but a caller deserves
  -- to be told WHICH one stopped the write, not a message that guesses. Re-read
  -- deliberately rather than trusted from the SELECT at the top of this function,
  -- since that read is exactly what could now be stale (see the comment above).
  if not found then
    if exists (select 1 from public.members where id = p_member_id and anonymized_at is not null) then
      raise exception 'this listener has been anonymised and cannot be edited' using errcode = '22023';
    else
      raise exception 'this listener has been archived and cannot be edited' using errcode = '22023';
    end if;
  end if;

  -- Block 5b, spec §9. Only what moved.
  perform public.apply_member_field_confirmations(
    p_member_id, v_org, v_before, public.member_field_values(p_member_id));

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id));
end;
$$;

-- 4. widget_verify_code -- live on 0164 (0161 introduced it). The door the
-- owner's report is about: a visitor typing the local form on the Station's
-- own website became a second listener.
create or replace function public.widget_verify_code(
  p_public_key text,
  p_phone      text,
  p_code_hash  text,
  p_name       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install public.widget_installations;
  v_verif   public.widget_verifications;
  v_country text;
  v_phone   text;
  v_member  uuid;
  v_anon    boolean;
begin
  -- 1. Resolve the installation. Unknown, disabled, archived, suspended and
  -- blocked all answer the same refusal -- probing for a live key learns
  -- nothing here either, the same shape widget_frame_context already answers
  -- with for the same key. 0164 added the last two; `w.*` for the same reason
  -- widget_request_code's lookup gives.
  select w.* into v_install
    from public.widget_installations w
    join public.companies c
      on c.id = w.company_id
     and c.deleted_at is null
     and c.status = 'active'
    join public.organizations o
      on o.id = w.organization_id
     and o.suspended_at is null
   where w.public_key = p_public_key and w.enabled and w.deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_installation',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- Block 30d, item 1b. A SECOND READ OF A ROW THE JOIN ABOVE ALREADY TOUCHED,
  -- and it has to be: PL/pgSQL refuses `select w.*, c.country into v_install,
  -- v_country` outright -- "record variable cannot be part of multiple-item
  -- INTO list" -- and widening v_install to a bare `record` would rewrite every
  -- v_install reference below for the sake of one column read once per call.
  --
  -- SANITISED FOR THE LOOKUP AND THE REGISTRATION IN STEPS 7 AND 8 ONLY. Step 2
  -- below still matches widget_verifications.phone against the RAW p_phone, and
  -- must: widget_request_code wrote that row with the spelling the visitor
  -- typed and the browser posts that same spelling back on this second call, so
  -- canonicalising one side without the other stops code entry working at all.
  select c.country into v_country
    from public.companies c
   where c.id = v_install.company_id;

  v_phone := public.international_phone(p_phone, v_country);

  -- 2. The newest UNCONSUMED verification for this installation and phone.
  -- Newest, not merely "a matching one": a visitor who asks for a second
  -- code has abandoned the first, and only the latest is still meant to be
  -- typed back. consumed_at is null is the whole filter -- an expired but
  -- never-used row is still "the pending one" here, and step 3 below is what
  -- refuses it, so the reason reported is the true one rather than a generic
  -- "no such code".
  --
  -- FOR UPDATE, AND THIS IS WHAT MAKES THE CEILING A CEILING. Without this
  -- lock, N requests that arrive concurrently for the same row all execute
  -- their own step 2 select before any of them reaches step 5's update, so
  -- all N read the SAME pre-increment `attempts` and all N pass step 4's
  -- `attempts >= 5` check against it -- a ceiling of five sequential guesses,
  -- but no ceiling at all on however many an attacker can open at once. See
  -- 0161 for the full argument, including why this is a row lock rather than
  -- apply_participation's (0054) advisory lock.
  select * into v_verif
    from public.widget_verifications
   where installation_id = v_install.id
     and phone = p_phone
     and consumed_at is null
   order by created_at desc
   limit 1
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_pending_code',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 3. Expired.
  if v_verif.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 4. THE CEILING, CHECKED BEFORE THE HASH -- see 0161's header comment on
  -- this function for why the order is the entire control.
  if v_verif.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 5. The hash, compared only once the ceiling has already let this attempt
  -- through. A wrong guess counts against the ceiling and stops here; it
  -- does not touch consumed_at, so the row is still "the pending one" for
  -- the next attempt, counted or refused in its turn.
  if v_verif.code_hash <> p_code_hash then
    update public.widget_verifications
       set attempts = attempts + 1
     where id = v_verif.id;

    return jsonb_build_object('ok', false, 'reason', 'wrong_code',
                              'member_id', null, 'company_id', null,
                              'organization_id', null);
  end if;

  -- 6. The right code, spent. Stamped now, before the listener below is even
  -- looked up, so this exact code cannot be replayed regardless of what the
  -- remaining steps decide -- including the anonymised-listener refusal in
  -- step 7, which answers false but leaves the code burned all the same.
  update public.widget_verifications
     set consumed_at = now()
   where id = v_verif.id;

  -- 7. Resolved through the SAME core the WhatsApp bot (0062) and the
  -- Block 15 API door (0152) use -- nothing new decides who a listener is.
  -- The RAW phone, not a normalised one: members.phone_normalized is a
  -- generated column and apply_member_lookup normalises what it is handed
  -- through normalize_phone (0031) itself; 0152's comment on this exact call
  -- makes the same argument for the API door, and it applies unchanged here.
  v_member := public.apply_member_lookup(v_install.organization_id, v_phone, null, null, null);

  -- And the raw spelling second, for the reason resolve_or_create_member's own
  -- comment gives at length: the WhatsApp bot still registers a listener under
  -- the local form, and searching only the canonical one would hand a visitor
  -- the bot already knows a second row. This branch resolves; it writes
  -- nothing, so a listener found by it keeps the phone the bot stored.
  if v_member is null and v_phone is distinct from p_phone then
    v_member := public.apply_member_lookup(v_install.organization_id, p_phone, null, null, null);
  end if;

  if v_member is not null then
    select m.anonymized_at is not null into v_anon
      from public.members m where m.id = v_member;

    -- 0034's erasure. Recording fresh activity -- a name, a Station link, a
    -- consent -- against somebody who exercised it is precisely what the
    -- erasure was for, the same refusal 0152 gives for the API door. NOT
    -- re-created under a new row either: that would be the same defect
    -- wearing a different id. Nothing past this point is written; the code
    -- stays consumed from step 6, which is what makes this a REFUSAL rather
    -- than a retryable failure -- the visitor cannot simply ask again.
    if v_anon then
      return jsonb_build_object('ok', false, 'reason', 'listener_anonymized',
                                'member_id', null, 'company_id', null,
                                'organization_id', null);
    end if;
  end if;

  -- 8. Not found: a name is required to register one -- there is no WhatsApp
  -- profile name to fall back on here, the way the bot (0062) does, because
  -- this visitor has never sent a WhatsApp message. p_first_contact_origin
  -- is 'web-widget' so an audience report can tell this listener's first
  -- contact apart from one who arrived over WhatsApp, the same distinction
  -- 0160's comment on member_consent_type draws for the consent row in step
  -- 10. p_actor is null -- see 0161's header comment on this function.
  if v_member is null then
    if nullif(trim(coalesce(p_name, '')), '') is null then
      return jsonb_build_object('ok', false, 'reason', 'name_required',
                                'member_id', null, 'company_id', null,
                                'organization_id', null);
    end if;

    v_member := public.apply_member_creation(
      v_install.company_id, p_name, v_phone, null, null, null, null, null,
      null, null, null, null, null, null, null, null,
      now(), 'web-widget', null);
  end if;

  -- 9. Idempotent at the table (0061, ON CONFLICT DO NOTHING): a returning
  -- visitor already linked to this Station costs nothing extra to call this
  -- again, and one already known to the Organization through a different
  -- Station is linked to this one for the first time. The boolean this core
  -- returns is deliberately ignored here, the same way the WhatsApp bot
  -- (0062) ignores it -- a listener already linked is the ordinary case for
  -- a repeat visitor, not a refusal.
  perform public.apply_member_link(v_member, v_install.company_id, v_install.organization_id, null);

  -- 10. The consent this whole door exists to produce: a name and a phone
  -- number, volunteered on this Station's own website rather than arriving
  -- over WhatsApp. origin = 'web-widget' is what lets an audit tell the two
  -- apart (0160). recorded_by is null for the same reason p_actor is -- see
  -- 0161's header comment on this function.
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, recorded_by)
  values
    (v_install.organization_id, v_member, v_install.company_id,
     'identification', true, 'web-widget', null);

  -- 11. ok, with the three ids the caller needs and nothing else -- no name,
  -- no phone, echoing back exactly what widget_frame_context's minimalism
  -- already argues for the refusal branches above.
  return jsonb_build_object('ok', true, 'reason', null,
                            'member_id', v_member,
                            'company_id', v_install.company_id,
                            'organization_id', v_install.organization_id);
end;
$$;

-- 5. api_record_music_request -- live on 0152. Block 15's external intake:
-- another system posting a music request on a listener's behalf.
create or replace function public.api_record_music_request(
  -- p_request_external_id and p_listener_name carry defaults and sit after
  -- p_phone, for the reason api_register_song's own comment gives: a parameter
  -- with no default is generated as REQUIRED, and both of these are optional --
  -- the listener's name only when the Station already knows the phone (D6).
  p_credential_id       uuid,
  p_company_id          uuid,
  p_org                 uuid,
  p_phone               text,
  p_request_external_id text        default null,
  p_listener_name       text        default null,
  p_show_name           text        default null,
  p_requested_at        timestamptz default null,
  p_song_external_id    text    default null,
  p_title               text    default null,
  p_artist_name         text    default null,
  p_label_name          text    default null,
  p_genre_name          text    default null,
  p_album_title         text    default null,
  p_nationality         public.music_nationality default null,
  p_vocal               public.music_vocal default null,
  p_duration_seconds    integer default null,
  p_isrc                text    default null,
  p_internal_code       text    default null,
  p_deezer_track_id     bigint  default null,
  p_deezer_album_id     bigint  default null,
  p_upc                 text    default null,
  p_cover_md5           text    default null,
  p_release_date        date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_company    uuid;
  v_org        uuid;
  v_country    text;
  v_phone      text;
  v_scopes     text[];
  v_external   text := nullif(btrim(coalesce(p_request_external_id, '')), '');
  v_name       text := nullif(btrim(coalesce(p_listener_name, '')), '');
  v_show_name  text := nullif(btrim(coalesce(p_show_name, '')), '');
  v_member     uuid;
  v_member_new boolean := false;
  v_linked     boolean := false;
  v_anonymised boolean;
  v_show       uuid;
  v_song       jsonb;
  v_request    uuid;
  v_existing   public.music_requests%rowtype;
begin
  -- co.country joins Block 30d, item 1b, to a statement that was already
  -- joining companies for the archived/inactive gate. It is in the GROUP BY
  -- rather than wrapped in an aggregate because the group is one credential
  -- and therefore one Station: min(co.country) would answer the same value
  -- while suggesting there could be several.
  select c.company_id, c.organization_id,
         coalesce(array_agg(s.permission_code) filter (where s.permission_code is not null),
                  '{}'::text[]),
         co.country
    into v_company, v_org, v_scopes, v_country
  from public.api_credentials c
  left join public.api_credential_scopes s on s.credential_id = c.id
  join public.companies co
    on co.id = c.company_id and co.deleted_at is null and co.status = 'active'
  where c.id = p_credential_id
    and c.revoked_at is null
    and (c.expires_at is null or c.expires_at > now())
  group by c.company_id, c.organization_id, co.country;

  if not found or not ('music.request' = any(v_scopes)) then
    raise log 'api_record_music_request denied: credential=%', p_credential_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  -- The arguments are checked against the credential and never used, for the
  -- reason api_register_song gives above: a door that trusts a caller-supplied
  -- company_id is one bug in the route away from writing into another Station.
  if v_company <> p_company_id or v_org <> p_org then
    raise log 'api_record_music_request station mismatch: credential=% asked=%',
      p_credential_id, p_company_id;
    raise exception 'permission denied: music.request required' using errcode = '42501';
  end if;

  -- Block 30d, item 1b. AFTER the credential is resolved, because the country
  -- is the credential's OWN Station: p_company_id is never trusted here (see
  -- the station-mismatch check above), so it cannot be the thing asked for a
  -- country either.
  --
  -- The guard below tests v_phone rather than p_phone, and the two cannot
  -- disagree about it: international_phone answers null exactly when
  -- normalize_phone does, and normalize_phone of a non-null answer of its own
  -- is never null.
  v_phone := public.international_phone(p_phone, v_country);

  if public.normalize_phone(v_phone) is null then
    raise exception 'a listener must be identified by a phone number' using errcode = '22023';
  end if;

  -- IDEMPOTENCY FIRST, before anything is created. A retry must not register a
  -- listener or a song on its way to discovering that it already recorded this
  -- request -- which is exactly what would happen if this check sat lower down.
  if v_external is not null then
    select * into v_existing from public.music_requests
     where company_id = v_company and external_id = v_external and deleted_at is null;

    if found then
      return jsonb_build_object(
        'request_id', v_existing.id,
        'created', false,
        'song', jsonb_build_object('id', v_existing.song_id, 'created', false,
                                   'filled', '[]'::jsonb),
        'listener', jsonb_build_object('id', v_existing.member_id, 'created', false,
                                       'linked', true));
    end if;
  end if;

  -- The RAW phone, not the normalised one: members.phone_normalized is a
  -- generated column and both cores normalise what they are given. Handing them
  -- a pre-normalised value would make a promise about idempotence that nothing
  -- here needs -- 0033's own reasoning for passing raw arguments on.
  v_member := public.apply_member_lookup(v_org, v_phone, null, null, null);

  -- And the raw spelling second, for the reason resolve_or_create_member's own
  -- comment gives at length: the WhatsApp bot still registers a listener under
  -- the local form, and a Station running both the bot and this API would get
  -- a second row for one person.
  if v_member is null and v_phone is distinct from p_phone then
    v_member := public.apply_member_lookup(v_org, p_phone, null, null, null);
  end if;

  if v_member is not null then
    select m.anonymized_at is not null into v_anonymised
      from public.members m where m.id = v_member;

    -- 0034's erasure. Recording fresh activity against somebody who exercised
    -- it is precisely what that erasure was for, and create_music_request
    -- excludes them for the same reason. NOT recreated under a new row either:
    -- that would be the same defect wearing a different id.
    if v_anonymised then
      raise exception 'that listener has been anonymised' using errcode = '23514';
    end if;
  end if;

  if v_member is null then
    -- Design D6, the owner's ruling of 2026-08-09. The external application
    -- attends on WhatsApp and therefore holds the profile name; arriving
    -- without one is its bug, and this refuses rather than registering a
    -- nameless listener somebody has to clean up later.
    if v_name is null then
      raise exception 'a new listener must arrive with a name' using errcode = '22023';
    end if;
    if not ('members.create' = any(v_scopes)) then
      raise exception 'permission denied: members.create required' using errcode = '42501';
    end if;

    -- Every optional field is null, INCLUDING discovery_source and
    -- first_contact_origin. Those two are free text with a vocabulary the
    -- screens already read, and inventing a value here that no screen knows how
    -- to display would be worse than leaving the truth absent.
    v_member := public.apply_member_creation(
      v_company, v_name, v_phone, null, null, null, null, null,
      null, null, null, null, null, null, null, null, null, null, null);
    v_member_new := true;
    v_linked     := true;
  else
    -- Known to the Organization already -- members are Organization-scoped
    -- (0031), so the same person entering at two of the group's Stations is one
    -- row. What has to be true is that THIS Station may see them.
    if not exists (select 1 from public.member_company_links
                    where member_id = v_member and company_id = v_company) then
      if not ('members.create' = any(v_scopes)) then
        raise exception 'permission denied: members.create required' using errcode = '42501';
      end if;
      v_linked := public.apply_member_link(v_member, v_company, v_org, null);
    end if;
  end if;

  -- The programme. RESOLVED, NEVER CREATED. `shows` is the one catalogue entity
  -- with no merge door -- 0098's table comment says so and names it as the
  -- deliberate gap -- so an API creating one from a typed name would breed
  -- duplicates with no cure. An unknown name is refused loudly rather than
  -- dropped in silence, which would record a request against no programme at
  -- all and look like it worked.
  if v_show_name is not null then
    select id into v_show from public.shows
     where company_id = v_company and deleted_at is null
       and lower(name) = lower(v_show_name)
     order by created_at limit 1;

    if not found then
      raise exception 'programme not found in this station: %', v_show_name
        using errcode = 'P0002';
    end if;
  end if;

  -- The song, by endpoint 1's rules exactly -- the same core, so the two
  -- endpoints cannot come to disagree about what registering a song means.
  v_song := public.apply_song_intake(
    v_company, v_org, null,
    p_song_external_id, p_title, p_artist_name, p_label_name, p_genre_name,
    p_album_title, p_nationality, p_vocal, p_duration_seconds, p_isrc,
    p_internal_code, p_deezer_track_id, p_deezer_album_id, p_upc,
    p_cover_md5, p_release_date);

  -- Checked AFTER the intake rather than before, because whether the song has
  -- to be created is not knowable until the ladder has been walked. The whole
  -- body is one transaction, so this refusal unwinds the song it is refusing.
  if (v_song ->> 'created')::boolean and not ('music.manage' = any(v_scopes)) then
    raise exception 'permission denied: music.manage required' using errcode = '42501';
  end if;

  insert into public.music_requests
    (organization_id, company_id, member_id, song_id, show_id, channel,
     requested_at, external_id, created_by)
  values
    (v_org, v_company, v_member, (v_song ->> 'song_id')::uuid, v_show, 'API',
     coalesce(p_requested_at, now()), v_external, null)
  returning id into v_request;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'api_record_music_request', 'music_requests', v_request, v_org, v_company,
     jsonb_build_object('credential_id', p_credential_id,
                        'member_created', v_member_new,
                        'song', v_song, 'show_id', v_show));

  return jsonb_build_object(
    'request_id', v_request,
    'created', true,
    'song', v_song,
    'listener', jsonb_build_object('id', v_member, 'created', v_member_new,
                                   'linked', v_linked));
end;
$$;

-- 6. withdraw_marketing_by_phone -- live on 0231. The stop word. It writes no
-- telephone number; it only has to find the right listener by one.
create or replace function public.withdraw_marketing_by_phone(
  p_integration_id uuid,
  p_phone          text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_integ   public.integrations%rowtype;
  v_country text;
  v_phone   text;
  v_local   text;
  v_member uuid;
  v_id     uuid;
begin
  select * into v_integ
  from public.integrations
  where id = p_integration_id and enabled and deleted_at is null;

  if not found then
    raise exception 'integration not found or switched off: %', p_integration_id
      using errcode = 'P0002';
  end if;

  -- Block 30d, item 1b. This door WRITES no telephone number -- it writes a
  -- consent row -- so what changes here is only which spelling is searched
  -- first. The country is read on its own rather than alongside the
  -- integration for the reason widget_verify_code gives: v_integ is a rowtype
  -- variable, and PL/pgSQL refuses to fill one alongside a scalar in a single
  -- INTO list.
  select c.country into v_country
    from public.companies c
   where c.id = v_integ.company_id;

  v_phone := public.international_phone(p_phone, v_country);
  v_local := public.whatsapp_local_phone(p_phone);

  -- CANONICAL FORM FIRST, LOCAL FORM SECOND. 0231 shipped this same pair in
  -- the opposite order, back when the local form was the likelier way a
  -- listener was stored; 0262 turned that round.
  --
  -- The delivered form is no longer searched on its own because it can no
  -- longer be missed. international_phone either leaves the delivered digits
  -- alone -- and then v_phone finds whatever the delivered form would have
  -- found -- or it adds a prefix, which it does only for a length inside the
  -- NATIONAL range, and whatsapp_local_phone strips at lengths 12 and 13 only,
  -- so at a national length v_local IS the delivered digits unchanged. One of
  -- the two is always the delivered form. Two lookups before, two lookups now.
  v_member := public.apply_member_lookup(v_integ.organization_id, v_phone, null, null, null);
  if v_member is null and v_local is distinct from v_phone then
    v_member := public.apply_member_lookup(v_integ.organization_id, v_local, null, null, null);
  end if;

  -- No member at all, OR a member this STATION never linked -- spec D3's
  -- scoping, and the two are answered identically on purpose: a stranger and
  -- a listener of a DIFFERENT Station in the same group get the same null,
  -- because nothing was withdrawn HERE either way, and telling either one
  -- "removed" would describe an action this call never took.
  -- member_linked_to_company (0034) is the same guard record_member_consent
  -- itself is built on.
  if v_member is null or not public.member_linked_to_company(v_member, v_integ.company_id) then
    return null;
  end if;

  -- NOT record_member_consent (0034): that function is gated on
  -- has_permission('members.edit', ...), which a caller with no auth.uid()
  -- always fails. This is the same insert, verbatim, minus the operator gate
  -- a bot has no identity to pass -- append-only, a withdrawal is a NEW row
  -- (0032's own rule), never an edit of an earlier one. origin names THIS
  -- path specifically, so an audit can tell a stop word apart from an
  -- unsubscribe-link click and from the in-conversation tap ('conversation',
  -- Task 4's own record_member_consent call).
  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin)
  values
    (v_integ.organization_id, v_member, v_integ.company_id, 'whatsapp_marketing', false, 'stop_word')
  returning id into v_id;

  -- actor_id null is how a bot-originated write is told from an operator's
  -- -- the same rule finish_whatsapp_event (0062) already states for its own
  -- audit row.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (null, 'withdraw_marketing_by_phone', 'member_consents', v_id,
     v_integ.organization_id, v_integ.company_id,
     jsonb_build_object('member_id', v_member, 'consent_id', v_id));

  -- F8: the Station, not a bare true -- so the caller can resolve THIS
  -- Station's own MARKETING_STOPPED wording rather than the code default.
  return v_integ.company_id;
end;
$$;


-- The ACLs these six carried before this file ran, restated verbatim. A
-- create-or-replace preserves them, so nothing here changes anything today;
-- they are written down so the next person who has to DROP one of these
-- functions -- to move a signature, the one thing create-or-replace cannot do
-- -- has the list to restore rather than a pg_proc query to remember. Block 24
-- lost a function's permissions exactly this way.
revoke execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) from public;
grant execute on function public.resolve_or_create_member(uuid, text, text, text, text, text, text) to authenticated;

revoke execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text, text, text) from public;
grant execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text, text, text) to authenticated;

revoke execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, text, text) to authenticated;

revoke execute on function public.widget_verify_code(text, text, text, text) from public;
grant execute on function public.widget_verify_code(text, text, text, text) to service_role;

revoke execute on function public.withdraw_marketing_by_phone(uuid, text) from public;
grant execute on function public.withdraw_marketing_by_phone(uuid, text) to service_role;

revoke execute on function public.api_record_music_request(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, public.music_nationality, public.music_vocal, integer, text, text, bigint, bigint, text, text, date) from public;
grant execute on function public.api_record_music_request(uuid, uuid, uuid, text, text, text, text, timestamptz, text, text, text, text, text, text, public.music_nationality, public.music_vocal, integer, text, text, bigint, bigint, text, text, date) to service_role;

-- normalize_phone (0031) is granted to authenticated ONLY, and 0260 granted
-- international_phone -- which is SECURITY INVOKER and calls it -- to
-- service_role as well. That grant advertised a capability that did not hold:
-- a direct service_role call fails with "permission denied for function
-- normalize_phone". It bites nobody today, because every service_role caller
-- of international_phone in this file is SECURITY DEFINER owned by postgres
-- and the nested call runs as the owner -- which is exactly what makes it a
-- trap for whoever adds the first caller that is not. 0031 is merged and is
-- not edited; the grant it is missing is added here.
grant execute on function public.normalize_phone(text) to service_role;

-- 0260's comment ended by claiming that "the doors that write a phone all call
-- this, so the widget, the console, the spreadsheet and the bot cannot come to
-- disagree about what a number is". Three quarters of that is true as of this
-- file and the fourth is not: the bot's own registration still writes the local
-- form (see this file's header). A comment that states something false is a
-- defect of the same weight as false code, so the sentence is restated here to
-- say what is actually wired -- and to name what is not, so the next reader
-- goes and looks instead of trusting it.
comment on function public.international_phone(text, text) is
  'One telephone number in the form this database already stores: a leading plus, then the country code, then the national number, and no other punctuation -- the shape every members.phone row in production already carries. Goes through normalize_phone (0031) for the comparison rather than stripping punctuation itself, so it cannot drift from members.phone_normalized, the generated column whose value decides who is who; that column drops the plus, so identity is unaffected by it. IDEMPOTENT: running this over its own output returns the same string, which is what makes the 0262 repair safe to re-run. Returns the digits UNCHANGED AND UNPREFIXED when country_phone_rule has no row for the country and when the length matches neither range -- refusing would stop a listener registering because an administrator left a select empty, guessing would split one person into two rows, and a plus in front of a number whose country nobody established would be a claim this function has not earned. Block 30d, item 1b: 0263 wired the console (create_member, update_member), the spreadsheet (resolve_or_create_member, which import_participations calls once per row), the widget (widget_verify_code) and the external API (api_record_music_request) to this function, so those four cannot come to disagree about what a number is. THE BOT IS NOT WIRED YET: ingest_whatsapp_event and ingest_link_intent (0179) still register a listener under whatsapp_local_phone''s LOCAL form, which is why every door 0263 touched goes on searching the raw spelling as well as this one.';
