-- supabase/migrations/0263_phone_doors_international.sql

-- Block 30d, item 1b, D4. The doors that write a listener's telephone number
-- now write ONE shape: international_phone's answer (0260), computed from the
-- Station's own country. Seven functions, and in each the phone is sanitised
-- once, on entry, before it is compared, stored or sent to.
--
-- THE WIDGET'S TWO DOORS MOVE TOGETHER. widget_request_code stores the number
-- on the verification row and hands it to enqueue_whatsapp_outbound;
-- widget_verify_code matches that row on the second call. Canonicalising
-- either one alone breaks code entry outright, so they are adjacent below and
-- compute the identical expression from the identical Station country. The
-- design originally ruled that this pair should keep the raw value; that ruling
-- was reversed on 2026-08-21. The reason GIVEN for reversing it -- that a
-- visitor typing the local form never received a code -- was wrong, and is
-- corrected at the call site rather than repeated: the widget has composed
-- '+' || digits since 2026-08-10 (commit 658174b). What the reversal is
-- actually worth is that
-- asking in one spelling and entering in another now matches, and that a
-- service_role caller which is not the shipped form gets the same treatment.
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
-- widget_request_code and widget_verify_code on 0164 not 0161, create_member
-- and update_member on 0220 not 0034 -- and re-typing an older body silently
-- reverts every repair made
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
  v_local   text;
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

  -- THE BOT'S SPELLING IS SEARCHED SECOND, and it is searched by name rather
  -- than by hoping the caller typed it. The WhatsApp bot's own registration
  -- (apply_member_creation called with whatsapp_local_phone's answer, in
  -- ingest_whatsapp_event and ingest_link_intent, both live on 0179) still
  -- writes the LOCAL form, so a listener whose first contact was a WhatsApp
  -- message is stored as 11988887777 while the search above looks for
  -- 5511988887777 and finds nothing -- and registering them again is exactly
  -- the split item 1b exists to stop, in the one direction this migration does
  -- not close.
  --
  -- COMPUTED, NOT ECHOED, and the reason differs by door -- which is why this
  -- comment does not claim one reason for all of them.
  --
  -- AT THIS DOOR the earlier `v_phone is distinct from p_phone` guard was TRUE
  -- and its search really did run. Both real callers hand over keystrokes: the
  -- Participations manual form posts a bare <Input name="phone">
  -- (record-participation-form.tsx:264 -- no country-code composer, and
  -- src/schemas/participations.ts:50 only trims, caps at 40 and demands one
  -- digit), and import_participations feeds spreadsheet cells straight through.
  -- What was wrong there was not that the search never ran but WHAT it searched:
  -- an operator who typed the international form made the raw search look for
  -- the same number the canonical search had just looked for, so the bot's row
  -- was missed anyway. At widget_verify_code and api_record_music_request the
  -- guard was false outright, because their callers post the international form
  -- already.
  --
  -- whatsapp_local_phone(v_phone) answers both: it is the bot's own function
  -- applied to the canonical value, so it produces the bot's spelling whatever
  -- the caller typed. It subsumes the old search rather than replacing it --
  -- when the operator DID type the local form, v_local comes back as exactly
  -- the digits they typed -- and it additionally covers the case the old one
  -- could not reach.
  --
  -- Delete this branch when the bot's doors write the canonical form too.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_found ->> 'outcome' = 'none'
     and v_local is distinct from public.normalize_phone(v_phone) then
    v_found := public.find_member_by_identifier(
      v_org, v_local, p_email, p_cpf_hash, p_passport);
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
  --
  -- WHAT THAT STILL MEANS AFTER 0263, EXACTLY. The phone index refuses a second
  -- listener carrying the same phone_normalized, unchanged. What it has never
  -- been able to see is two SPELLINGS of one number, and 0263 widened that gap
  -- rather than closing it: this door now stores 5511988887777 where the
  -- WhatsApp bot (0179) still stores 11988887777, so a caller reaching this
  -- function directly -- through PostgREST, say -- with the local form would
  -- not collide with the bot's row and would register the same person twice.
  -- The console is not that caller: register-member-form.tsx reveals this
  -- action only once checkMemberIdentifierAction has answered 'none'
  -- (src/app/(app)/members/actions.ts:87-94), and that check hands the
  -- operator's own keystrokes to find_member_by_identifier -- so an operator
  -- typing the local form does find the bot's listener and is told before this
  -- function is called at all. resolve_or_create_member, the other way in,
  -- searches both spellings itself. The gap closes when the bot writes the
  -- canonical form too.
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

-- 4. widget_request_code -- live on 0164 (0161 introduced it). The widget's
-- FIRST call: it mints the verification row and asks WhatsApp to carry the
-- six digits. Read with the fifth function below; neither is correct alone.
create or replace function public.widget_request_code(
  p_public_key   text,
  p_phone        text,
  p_code_hash    text,
  p_code_plain   text,
  p_ttl_seconds  integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_install     public.widget_installations;
  v_country     text;
  v_phone       text;
  v_integration uuid;
  v_template    public.message_templates;
  v_id          uuid;
  v_outbox_id   uuid;
begin
  -- 0164: the two joins. `w.*` rather than `*` now that the from-list has
  -- three relations in it -- `select *` would try to build a
  -- widget_installations record out of every column of all three and fail.
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
                              'verification_id', null);
  end if;

  -- Block 30d, item 1b. THE CANONICAL NUMBER IS WHAT IS STORED AND WHAT IS
  -- SENT TO. The design's first ruling here -- keep whatever the visitor typed,
  -- because widget_verify_code matches the row against what the browser posts
  -- back -- was reversed on 2026-08-21.
  --
  -- AND THE STATED REASON FOR REVERSING IT WAS WRONG, so it is not repeated
  -- here. It said a visitor typing 11 98888-7777 got a row, an outbox message,
  -- an 'ok', and no code Meta could deliver. That is not reachable through the
  -- widget and has not been since 2026-08-10 (commit 658174b): composePhone
  -- (src/app/(widget)/w/[publicKey]/identify-form.tsx:41) joins a country-code
  -- box to a local box and posts '+' || digits, and its own comment records
  -- that as the fix for exactly this harm.
  --
  -- What the reversal actually buys, and it is worth having:
  --   * asking in one spelling and entering in another now matches. Two raw
  --     strings compared literally answered no_pending_code; one canonical
  --     value on both sides is the same number.
  --   * the row and the outbox agree with every other door in this file about
  --     what a number is, so a verification is legible next to a member.
  --   * a caller that is NOT the widget gets the same protection. Both doors
  --     are granted to service_role, so the shipped form is not the only thing
  --     that can reach them, and the harm 658174b removed is what an unguarded
  --     caller still walks into.
  --
  -- Storing the canonical form does not break the second call, it fixes it:
  -- widget_verify_code computes THE SAME expression from THE SAME
  -- installation's country, so the ordinary case (the browser posting the same
  -- string twice) matches exactly as it did, and the case that used to fail --
  -- 11 98888-7777 to ask, +55 11 98888-7777 to enter -- now matches too. The
  -- two functions have to move together and are adjacent here for that reason.
  --
  -- The country is read on its own rather than alongside the installation
  -- because PL/pgSQL refuses `select w.*, c.country into v_install, v_country`
  -- outright: "record variable cannot be part of multiple-item INTO list".
  select c.country into v_country
    from public.companies c
   where c.id = v_install.company_id;

  v_phone := public.international_phone(p_phone, v_country);

  -- `and enabled`: an operator who switches WhatsApp off temporarily leaves a
  -- row this lookup would otherwise FIND, which would then reach
  -- enqueue_whatsapp_outbound and hit its own check (0111) -- an unhandled
  -- P0002 exception surfacing to the caller instead of one of this
  -- function's named answers, which is exactly the failure naming the
  -- reasons exists to prevent (see the header comment above).
  --
  -- STILL 'no_integration', not a fifth reason: absent and switched-off are
  -- one answer here on purpose. Both put the operator on the same screen with
  -- the same next step -- go configure or re-enable WhatsApp for this Station
  -- -- and a distinction that changes nothing about what anybody does next
  -- would still need a fifth string translated into three locales to say so.
  select id into v_integration
    from public.integrations
   where company_id = v_install.company_id
     and provider = 'WHATSAPP'
     and enabled
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_integration',
                              'verification_id', null);
  end if;

  select * into v_template
    from public.message_templates
   where company_id = v_install.company_id
     and purpose = 'WEB_VERIFICATION'
     and deleted_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_template',
                              'verification_id', null);
  end if;

  insert into public.widget_verifications
    (organization_id, company_id, installation_id, phone, code_hash, expires_at)
  values
    (v_install.organization_id, v_install.company_id, v_install.id,
     v_phone, p_code_hash,
     now() + make_interval(secs => p_ttl_seconds))
  returning id into v_id;

  -- The dedupe key is the VERIFICATION, not the phone: two codes legitimately
  -- requested a minute apart are two messages, and collapsing them on the
  -- number would silently drop the second -- leaving a visitor typing a code
  -- that was superseded.
  --
  -- p_body is null, ON PURPOSE, not a placeholder for the masked text. When
  -- p_template_purpose is given, 0111's enqueue_whatsapp_outbound ignores its
  -- p_body argument entirely and renders `body` itself from p_template_variables
  -- (D6: "rendering happens HERE and only here", so the audit copy can never
  -- disagree with what was actually sent) -- so any value passed here would be
  -- silently discarded, and passing null says so instead of hiding it behind a
  -- value that looks used.
  v_outbox_id := public.enqueue_whatsapp_outbound(
    v_integration,
    v_phone,
    null,
    null,
    v_id::text || ':widget-verification',
    'WEB_VERIFICATION',
    -- THE ONLY PLACE THE SIX DIGITS EXIST outside the visitor's handset.
    -- sendTemplate (src/services/whatsapp.ts) builds Meta's template
    -- parameters from THIS column, not from `body` -- so this is also the
    -- value that actually reaches the phone. See 0161's header comment on this
    -- function for why the raw value is an argument here when it is
    -- forbidden everywhere else in this codebase.
    jsonb_build_array(p_code_plain));

  if v_outbox_id is not null then
    -- enqueue_whatsapp_outbound just wrote `body` as the template rendered
    -- WITH THE LIVE CODE, because D6 renders body and template_variables from
    -- the same source on purpose so they cannot drift for an ordinary send.
    -- A verification code is not an ordinary send: `body` is never pruned
    -- (0059's comment on the column is explicit that this is deliberate, so
    -- an operator can still answer "what were they told" after retention has
    -- taken the phone number), which means a live code left in it would
    -- outlive every mechanism meant to expire the code itself. Overwritten
    -- here, in the SAME transaction as the insert above -- Postgres has no
    -- dirty-read isolation level at all, at any setting, so no concurrent
    -- reader can see the row until this function's transaction commits, by
    -- which point `body` already holds the masked text and the unmasked
    -- value this statement replaces was never visible to anybody and never
    -- durable. jsonb_build_array(p_code_plain) alone remains as the one place
    -- the six digits live in the database, exactly as 0161's header comment
    -- requires.
    update public.outbox_messages
       set body = replace(v_template.body, '{{1}}', '******')
     where id = v_outbox_id;
  end if;

  return jsonb_build_object('ok', true, 'reason', null, 'verification_id', v_id);
end;
$$;

-- 5. widget_verify_code -- live on 0164 (0161 introduced it). The widget's
-- SECOND call, and the door the owner's report is about: a visitor typing the
-- local form on the Station's own website became a second listener.
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
  v_local   text;
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
  -- ONE VALUE FOR EVERY THING THIS FUNCTION DOES WITH A NUMBER: the
  -- verification row it looks up in step 2, the listener it resolves in step 7,
  -- and the one it registers in step 8. widget_request_code above computes THE
  -- SAME expression from THE SAME installation's country and stores its answer,
  -- so the two calls agree by construction rather than by both being left raw.
  -- The ordinary case is unchanged -- the browser posts the same string twice
  -- and both canonicalise to the same value -- and the case that used to fail
  -- now works: a visitor who asks with 11 98888-7777 and enters with
  -- +55 11 98888-7777 matched nothing before and matches the row now.
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
     and phone = v_phone
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
  -- v_phone, which is the one value this function uses for every question it
  -- asks about a number: the verification row in step 2, this lookup, and the
  -- registration in step 8. Not p_phone, and not a normalisation of it --
  -- apply_member_lookup normalises whatever it is handed through
  -- normalize_phone (0031) anyway, so what matters here is not the punctuation
  -- but WHICH NUMBER is asked about, and at a Station with a country the
  -- canonical one is a different number from the keystrokes.
  v_member := public.apply_member_lookup(v_install.organization_id, v_phone, null, null, null);

  -- And the bot's spelling second, for the reason resolve_or_create_member's
  -- own comment gives at length: the WhatsApp bot still registers a listener
  -- under the local form, and searching only the canonical one would hand a
  -- visitor the bot already knows a second row. Computed with
  -- whatsapp_local_phone rather than echoing p_phone back, because the widget's
  -- own form has posted '+' || digits since 2026-08-10, commit 658174b
  -- (composePhone,
  -- identify-form.tsx:41) -- a guard comparing v_phone with p_phone would be
  -- false for every real visitor and this branch would never run. It resolves;
  -- it writes nothing, so a listener found by it keeps the phone the bot stored.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
    v_member := public.apply_member_lookup(v_install.organization_id, v_local, null, null, null);
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

-- 6. api_record_music_request -- live on 0152. Block 15's external intake:
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
  v_local      text;
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

  -- v_phone, which is the one value this door uses for the guard above, this
  -- lookup and the registration below. Not p_phone, and the difference is not
  -- punctuation: both cores normalise whatever they are given, so what changes
  -- here is WHICH NUMBER is asked about -- at a Station with a country the
  -- canonical form is a different number from the digits that arrived.
  v_member := public.apply_member_lookup(v_org, v_phone, null, null, null);

  -- And the bot's spelling second, for the reason resolve_or_create_member's
  -- own comment gives at length: the WhatsApp bot still registers a listener
  -- under the local form, and a Station running both the bot and this API would
  -- get a second row for one person. Computed with whatsapp_local_phone rather
  -- than echoing p_phone back, because this endpoint's documented contract is
  -- already the international form (docs/API.md:147) -- a guard comparing
  -- v_phone with p_phone would be false for every caller following it, and this
  -- branch would never run.
  v_local := public.whatsapp_local_phone(v_phone);
  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
    v_member := public.apply_member_lookup(v_org, v_local, null, null, null);
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

-- 7. withdraw_marketing_by_phone -- live on 0231. The stop word. It writes no
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
  v_local := public.whatsapp_local_phone(v_phone);

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
  --
  -- The guard compares v_local against normalize_phone(v_phone) rather than
  -- against v_phone itself, and the three resolving doors in this file now use
  -- the identical expression on both sides. v_phone carries a leading plus
  -- WHENEVER THE NUMBER COULD BE PLACED -- not always: at a Station with no
  -- country, and for a length no rule explains, international_phone answers the
  -- bare digits and a direct comparison against v_phone would already have been
  -- right. It is when the plus IS there that a direct comparison goes wrong,
  -- being true even where the two name the same digits, and firing a second
  -- lookup that can only miss.
  --
  -- v_local IS COMPUTED FROM v_phone HERE TOO, as of fix round 3. 0231 computed
  -- it from p_phone and the two agree for everything this door is actually fed
  -- -- Meta delivers an international wa_id, which international_phone leaves
  -- alone, so v_phone and p_phone normalise identically. They do NOT agree for
  -- an arbitrary argument: hand this door a Portuguese national number at a
  -- Portuguese Station and whatsapp_local_phone(p_phone) answers 912345678
  -- while whatsapp_local_phone(v_phone) answers 351912345678, because it strips
  -- a leading 55 and nothing else. The second is the right one -- it is the
  -- spelling a bot would have written -- and making all four doors compute the
  -- identical expression is what lets this comment say "identical" and be
  -- checked rather than believed.
  v_member := public.apply_member_lookup(v_integ.organization_id, v_phone, null, null, null);
  if v_member is null and v_local is distinct from public.normalize_phone(v_phone) then
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


-- The ACLs these seven carried before this file ran, restated verbatim. A
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

revoke execute on function public.widget_request_code(text, text, text, text, integer) from public;
grant execute on function public.widget_request_code(text, text, text, text, integer) to service_role;

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

-- AND THE SAME TRAP, SPRUNG. whatsapp_local_phone (0062) carries no grant to
-- any role at all -- 0062 revoked it from public and granted it to nobody --
-- because every caller it had was SECURITY DEFINER owned by postgres, so the
-- nested call ran as the owner and no grant was ever needed. This file adds a
-- caller that is not: resolve_or_create_member is SECURITY INVOKER (it reads
-- companies under the caller's own RLS, deliberately), so its second search
-- runs as `authenticated` and failed outright with "permission denied for
-- function whatsapp_local_phone" -- caught by
-- supabase/tests/72_international_phone.test.sql, not by reasoning. 0062 is
-- merged and is not edited; the grant it never needed is added here.
grant execute on function public.whatsapp_local_phone(text) to authenticated;

-- 0231's comment on withdraw_marketing_by_phone describes the resolution order
-- this file just inverted -- "local form then delivered form, the same order
-- ... ingest_whatsapp_event (0179) already resolves every listener through".
-- That sentence was true when it was written and is false now, and a comment
-- that describes the opposite of what the body does is worse than none: the
-- next reader trusts it. Restated below with the order the body now uses and
-- why it changed. Everything else in it is unchanged and still true.
comment on function public.withdraw_marketing_by_phone(uuid, text) is
  'Block 29c, F7/F8. The cold-path stop word: PARAR/CANCELAR/DESCADASTRAR with no live conversation to answer. Resolves the sender through apply_member_lookup (0061) -- since 0263, international_phone''s answer FIRST and whatsapp_local_phone''s second, which is the reverse of the order 0231 shipped: 0262 moved the listeners this door has to find into the international form, so the canonical spelling is now the likelier hit and the local one is the fallback for a row that repair could not reach. The delivered form is not searched on its own any more because it cannot be missed -- international_phone either leaves the delivered digits alone or prefixes a national-length number, and whatsapp_local_phone strips at lengths 12 and 13 only, so one of the two is always what Meta delivered. Still the shared core ingest_whatsapp_event (0179) resolves every listener through, never a re-implementation of phone_normalized''s own normalize_phone (0031). Scoped to the Station THIS integration belongs to (spec D3): a member this Station never linked answers null, identically to an unknown phone, because nothing was withdrawn HERE either way -- the caller must not tell either one "removed". Writes member_consents (whatsapp_marketing, granted=false, origin=''stop_word'') directly rather than through record_member_consent, which is gated on has_permission and would refuse a caller with no auth.uid(). Returns the STATION''S id rather than a boolean (F8): the caller needs it to resolve the Station''s own MARKETING_STOPPED wording the same way the in-conversation path already does, not only to know whether to reply at all. SECURITY DEFINER, service_role only -- the worker holds no user identity, so this is a door rather than a grant, the same shape enqueue_whatsapp_outbound (0071) already uses.';

-- 0260's comment ended by claiming that "the doors that write a phone all call
-- this, so the widget, the console, the spreadsheet and the bot cannot come to
-- disagree about what a number is". Three quarters of that is true as of this
-- file and the fourth is not: the bot's own registration still writes the local
-- form (see this file's header). A comment that states something false is a
-- defect of the same weight as false code, so the sentence is restated here to
-- say what is actually wired -- and to name what is not, so the next reader
-- goes and looks instead of trusting it.
comment on function public.international_phone(text, text) is
  'One telephone number in the form this database already stores: a leading plus, then the country code, then the national number, and no other punctuation -- the shape every members.phone row in production already carries. Goes through normalize_phone (0031) for the comparison rather than stripping punctuation itself, so it cannot drift from members.phone_normalized, the generated column whose value decides who is who; that column drops the plus, so identity is unaffected by it. A LEADING PLUS ON THE ARGUMENT SHORT-CIRCUITS THE WHOLE RULE: it is the caller asserting the international form, so the digits are returned with their plus and no country rule is consulted. Without that, the length test decides using the STATION''s national range and cannot tell a foreign number from a local one -- at a Brazilian Station the eleven-digit +12125551234 would be read as national and answered as +5512125551234, and update_member would do it again on every save. IDEMPOTENT: running this over its own output returns the same string -- now by that first branch rather than by the length ranges -- which is what makes the 0262 repair safe to re-run. Returns the digits UNCHANGED AND UNPREFIXED when country_phone_rule has no row for the country and when the length matches neither range -- refusing would stop a listener registering because an administrator left a select empty, guessing would split one person into two rows, and a plus in front of a number whose country nobody established would be a claim this function has not earned. Block 30d, item 1b: 0263 wired the console (create_member, update_member), the spreadsheet (resolve_or_create_member, which import_participations calls once per row), the widget (widget_request_code and widget_verify_code together, so the row one writes is the row the other matches) and the external API (api_record_music_request) to this function, so those four cannot come to disagree about what a number is. THE BOT IS NOT WIRED YET: ingest_whatsapp_event and ingest_link_intent (0179) still register a listener under whatsapp_local_phone''s LOCAL form, which is why the three doors that resolve a listener before they write one -- resolve_or_create_member, widget_verify_code and api_record_music_request -- go on searching a second spelling, whatsapp_local_phone''s answer, as well as this one. withdraw_marketing_by_phone searches that same pair for the same reason; the other three write without resolving and search nothing.';
