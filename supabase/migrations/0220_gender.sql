-- supabase/migrations/0220_gender.sql

-- The gender block, Task 2: the column, the resolver, and the five functions
-- that have to learn about both.
--
-- SHAPED ON `country` (0213), DELIBERATELY AND ALMOST LINE FOR LINE. That block
-- added the ninth requested field five weeks ago and settled every question this
-- one would otherwise reopen: a constrained column rather than free text, a
-- resolver that is IMMUTABLE and granted to nobody, one write point, and — the
-- sentence that decides the whole design —
--
--   "Null rather than a raise, because its caller coalesces: an unrecognised
--    answer must cost the answer, never the participation."
--
-- A listener who answers something `gender_normalize` cannot resolve has no
-- gender recorded. They are not refused, not re-prompted into an abandon, and
-- not stored as a third thing nobody can filter on.
--
-- WHAT THIS BLOCK IS FOR, and what it is deliberately not (§5b, D8). Gender
-- segments who a CAMPAIGN IS SENT TO. It does not decide who may enter a
-- promotion: no attribute-based eligibility rule exists anywhere in this schema
-- — `promotions` carries no minimum age and no restriction of any kind, and
-- draw_eligible_participations (0076) is the single definition of who is in the
-- hat, whose own comment refuses to let a second definition exist. Making gender
-- an eligibility criterion would be the first rule of its kind and would have to
-- decide WHEN it refuses (at consent, after asking, or only at the draw). That
-- is a block of its own, and it is the block that has to engage with LGPD Art.
-- 6º IX (non-discrimination) directly. This one does not touch it.
--
-- LGPD, since somebody will ask. Gender is NOT in Art. 5º II's sensitive-data
-- list — that list names "vida sexual", which is not the same thing. It is
-- ordinary personal data, collected under the same consent this project already
-- records per Station and per type (member_consents, 0032), optional in every
-- sense: the promotion decides whether to ask, 'N' lets the listener decline,
-- and an unresolvable answer costs nothing.

-- ---------------------------------------------------------------------------
-- 1. The column.
--
-- THREE STORABLE VALUES AND A FOURTH STATE THAT IS THE ABSENCE OF THEM:
--
--   'M'   masculino
--   'F'   feminino
--   'N'   asked, and the listener declined to say
--   NULL  never asked
--
-- 'N' AND NULL ARE NOT THE SAME POPULATION, and keeping them apart is the whole
-- reason 'N' is storable rather than being folded into null. A campaign filter
-- that cannot tell "declined" from "never asked" is a filter that silently
-- treats a refusal as an unfilled form — and it is free to tell them apart,
-- because one is a value and the other is its absence.
--
-- A CHECK over three codes rather than an enum, following country's own
-- reasoning (0213): the set is closed, it is two characters wide, and an enum
-- would buy ordering this column never sorts by at the cost of an ADD VALUE
-- migration the day a fourth code is wanted.
alter table public.members add column gender text;

alter table public.members add constraint members_gender_shape
  check (gender is null or gender in ('M', 'F', 'N'));

comment on column public.members.gender is
  'Masculino (M), feminino (F), or asked-and-declined (N). NULL is a FOURTH state and not a synonym for any of them: it means nobody has asked. The distinction is what lets a campaign filter tell a refusal from an unfilled form. OPTIONAL in every sense — the promotion decides whether to ask (promotion_requested_field ''gender''), the listener may decline, and an answer gender_normalize cannot resolve leaves the column alone rather than refusing the participation. Written from a conversation or the widget only through gender_normalize, never raw: this column is a KEY a campaign groups by, and a column holding both ''M'' and ''masculino'' would split one audience in two. Block 29''s gender block; reverses Block 4a spec D5, which excluded the field when no segmented messaging existed to need it.';

-- ---------------------------------------------------------------------------
-- 2. The resolver.
--
-- MIRRORS country_alpha2 (0213) exactly, down to the grant: IMMUTABLE, EXECUTE
-- to nobody, called only from inside another function's body. What it is NOT is
-- a gender vocabulary — it resolves what a Brazilian listener actually types
-- into a WhatsApp reply, and it is not meant to grow into a taxonomy.
--
-- THE THREE CODES RESOLVE TO THEMSELVES, and that is load-bearing rather than a
-- convenience. A listener who PRESSES one of the three buttons has their answer
-- arrive as the code (the engine maps the button id, see FIELD_SHAPE in
-- src/lib/conversation/steps.ts); a listener who TYPES gets prose. Both reach
-- this function, and they must converge on one value or the same audience
-- splits by how each person answered.
--
-- WHY TYPED ANSWERS EXIST AT ALL, given the question goes out as buttons: the
-- WhatsApp keyboard stays open beneath them. Somebody will type. Refusing that
-- would abandon the conversation after three tries, on a field the promotion
-- marked optional — so buttons are UX on top of this function, never instead of
-- it, and that is the design decision this comment exists to keep.
create function public.gender_normalize(p_input text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $$
  select case
    -- Lower-cased and unaccented by hand rather than by unaccent(): that
    -- extension is not installed here, and the whole vocabulary below is short
    -- enough to spell both ways. `translate` is IMMUTABLE, which this function
    -- must be.
    when v in ('m', 'masculino', 'masc', 'homem', 'macho', 'male', 'hombre', 'h')
      then 'M'
    when v in ('f', 'feminino', 'fem', 'mulher', 'femea', 'female', 'mujer')
      then 'F'
    -- The decline, in the words somebody actually writes when they mean it.
    -- 'n' is here because it is the code, not because it is Portuguese for no —
    -- "não" alone is NOT accepted, and deliberately: a bare "não" answering
    -- "qual é o seu sexo?" is a listener who did not read the question, and
    -- recording it as a considered refusal would be inventing an answer.
    when v in ('n', 'prefiro nao dizer', 'prefiro nao informar', 'nao informar',
               'prefiro nao responder', 'nao quero dizer', 'nao quero informar',
               'outro', 'outra', 'nenhum', 'nenhuma')
      then 'N'
    else null
  end
  from (
    select translate(lower(btrim(coalesce(p_input, ''))),
                     'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
                     'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') as v
  ) normalised;
$$;

revoke execute on function public.gender_normalize(text) from public;

comment on function public.gender_normalize(text) is
  'A sex an operator or a listener named, as ''M'', ''F'' or ''N'', or null when it cannot be resolved. The three codes resolve to themselves, which is what makes a pressed button and a typed reply converge on one value — the WhatsApp keyboard stays open beneath the buttons, so both arrive. ''outro''/''nenhum'' resolve to ''N'' rather than to a fourth code: this column is a campaign filter with three storable values, and a listener who does not see themselves in two of them has declined the question in the only sense the filter can act on. A bare "não" is NOT accepted — answering "qual é o seu sexo?" with it is somebody who did not read the question, and recording that as a considered refusal would be inventing an answer. IMMUTABLE, EXECUTE granted to nobody — it is only ever called from inside another function''s body. Null rather than a raise, because its callers coalesce: an unrecognised answer must cost the answer, never the participation (0213''s own rule, applied to the tenth field).';

-- ---------------------------------------------------------------------------
-- 3. member_field_value: one more arm.
--
-- RECREATED FROM THE LIVE DEFINITION, not from the body in the migration that
-- first created it. This project has paid for the alternative: rebuilding a
-- function from an old file silently reverts every fix applied to it since, and
-- the diff looks like the one line somebody meant to add. The body below is
-- what `pg_get_functiondef` returned before this migration ran, plus the
-- `gender` arm.
--
-- The plural form, member_field_values (0114), needs NOTHING: it walks
-- `enum_range(null::promotion_requested_field)` and picks up a tenth value on
-- its own. So does whatsapp_conversation_steps (0066). That genericity is why
-- this block is five functions rather than a dozen.
create or replace function public.member_field_value(
  p_member_id uuid,
  p_field public.promotion_requested_field)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select nullif(btrim(coalesce(
    case p_field
      when 'full_name'        then m.full_name
      when 'address'          then m.address_line
      when 'city'              then m.city
      when 'neighbourhood'    then m.neighbourhood
      when 'age'                then m.birth_date::text
      when 'gender'            then m.gender
      when 'cpf'               then m.cpf_hash
      when 'passport'          then m.passport
      when 'discovery_source' then m.discovery_source
      when 'country'           then m.country
    end,
    '')), '')
  from public.members m
  where m.id = p_member_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. apply_member_field_values: the one write point, shared by the WhatsApp
-- conversation and the widget. Live definition forward, plus one arm.
--
-- THROUGH gender_normalize AND INSIDE THE SAME coalesce as country, for the
-- identical reason: the listener may have typed "masculino" and this column
-- stores 'M'. An answer the resolver does not know returns null, which coalesce
-- turns into "leave what was there" — so an unrecognised sex is a sex not
-- recorded, never a participation refused by a CHECK constraint at the far end
-- of somebody's entry.
--
-- The confirmation insert below is untouched and needs to be: it walks the KEYS
-- the caller supplied, so a tenth field confirms itself. Note the consequence,
-- which is country's too and is correct: an answer that arrived but did not
-- resolve still records a confirmation, because the listener WAS asked and DID
-- answer. data_validity_months decides when to ask again; it is not a record of
-- what was stored.
create or replace function public.apply_member_field_values(
  p_member_id uuid,
  p_fields jsonb)
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
    -- The gender block. See this migration's header for why the resolver may
    -- answer null and why that is the safe direction.
    gender           = coalesce(public.gender_normalize(p_fields ->> 'gender'), m.gender),
    cpf_hash         = coalesce(nullif(btrim(p_fields ->> 'cpf'), ''), m.cpf_hash),
    passport         = coalesce(nullif(btrim(p_fields ->> 'passport'), ''), m.passport),
    discovery_source = coalesce(nullif(btrim(p_fields ->> 'discovery_source'), ''), m.discovery_source),
    -- Block 28. THROUGH country_alpha2, and inside the same coalesce as the
    -- rest: the listener typed "Portugal" into WhatsApp and this column stores
    -- 'PT'. An answer the resolver does not know returns null, which coalesce
    -- turns into "leave what was there" — so the failure mode of an unknown
    -- country is a country not recorded, never a participation refused by a
    -- CHECK constraint at the far end of somebody's entry.
    country          = coalesce(public.country_alpha2(p_fields ->> 'country'), m.country),
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

-- ---------------------------------------------------------------------------
-- 5. anonymize_member: two more columns, and one of them is a Block 28 gap
-- rather than this block's own work.
--
-- Live definition forward, as in 3 and 4 above.
--
-- `gender` joins the null list for the obvious reason: it is a fact about a
-- person, and this function's whole job is that the row survives while the
-- person does not.
--
-- `country` JOINS IT TOO, AND DID NOT BELONG TO THIS BLOCK. Block 28 added the
-- column and did not add it here, so a listener who exercised erasure kept the
-- country they had told a Station — beside a nulled city, state, postal code and
-- neighbourhood, which is the same kind of fact one field coarser. It is fixed
-- in this migration rather than left for a tidier one because the line being
-- edited is the same line, and an erasure list that is right about nine columns
-- and wrong about one is exactly the shape 0059's header describes paying for.
--
-- WHAT STILL IS NOT ERASED HERE, so the absence keeps reading as a decision:
-- phone_normalized and email_normalized are GENERATED from phone and email
-- (0031), so nulling those two empties these two; first_contact_at survives
-- because a date with no person attached identifies nobody and answers "when did
-- this record begin".
create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason public.member_erasure_reason)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  -- Not filtered on deleted_at: an already-archived listener can still be erased —
  -- archival and erasure are different mechanisms (spec §6) and neither implies the
  -- other.
  select organization_id into v_org
  from public.members
  where id = p_member_id;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_reachable(p_member_id, v_org, 'members.erase') then
    raise log 'anonymize_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.erase required' using errcode = '42501';
  end if;

  if p_reason is null then
    raise exception 'a reason is required to erase a listener' using errcode = '22023';
  end if;

  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         gender = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         country = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;

  update public.member_notes
     set body = null
   where member_id = p_member_id and body is not null;

  update public.member_consents
     set origin = null
   where member_id = p_member_id and origin is not null;

  update public.member_blocks
     set reason = null, lift_reason = null
   where member_id = p_member_id and (reason is not null or lift_reason is not null);

  -- Block 6b. The queue row is written BEFORE the update that nulls the column
  -- it reads -- reverse the two and this erases the reference and forgets the
  -- object, which is the failure mode the queue exists to close.
  --
  -- Both statements are in this transaction, so an erasure cannot be recorded
  -- without the instruction to finish it, and the instruction cannot be issued
  -- for an erasure that rolled back.
  insert into public.storage_erasure_queue (bucket, path)
  select 'delivery-receipts', w.receipt_path
  from public.winners w
  where w.member_id = p_member_id and w.receipt_path is not null;

  update public.winners
     set receipt_path = null,
         receipt_erased_at = now(),
         updated_at = now()
   where member_id = p_member_id and receipt_path is not null;

  -- The audit entry names the event, the actor and the reason. p_reason is a bounded
  -- enum (owner's ruling A), never free text, so there is no operator prose here
  -- that could re-plant what this function just scrubbed.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'anonymize_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id, 'reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The two operator doors, so the field an operator can filter on is also a
-- field an operator can correct.
--
-- DROPPED AND RECREATED, NOT REPLACED, and the distinction is the whole reason
-- this section is longer than one line. A new parameter is a new SIGNATURE, and
-- `create or replace` on a different argument list creates an OVERLOAD rather
-- than replacing anything -- leaving the nineteen-argument version alive beside
-- the twenty-argument one, and every call from PostgREST ambiguous between them.
--
-- AND A DROPPED FUNCTION TAKES ITS ACL WITH IT. Both grants below are reissued
-- for that reason and not for tidiness: without them every save from the member
-- form answers 42501, and no test in this repository that calls these as the
-- OWNER would notice -- the owner bypass in has_permission means the door opens
-- for the one identity that never needed the grant. Block 24 lost an ACL exactly
-- this way.
--
-- p_gender IS LAST, following p_country, which Block 28 appended for the same
-- reason: every caller in this codebase passes named arguments through
-- PostgREST, so position is a migration-ordering convention rather than an
-- interface. Both bodies are the live definitions forward, plus the column.

drop function if exists public.create_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, timestamptz, text, text);

create function public.create_member(
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
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(trim(p_full_name), '');
  v_id    uuid;
begin
  -- FOR SHARE: member_links_company_org_fk (0031) cannot see deleted_at -- a
  -- composite foreign key cannot reference a partial index -- so without this lock a
  -- concurrent write to this Station's deleted_at, between this check and the
  -- member_company_links insert below, could let the link be written against a
  -- Station that is archived by the time this transaction commits. Same reasoning
  -- assign_company_role (0017) gives for its FOR SHARE on roles.
  select organization_id into v_org
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
       nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''),
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

revoke execute on function public.create_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text) from public;
grant execute on function public.create_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, timestamptz, text, text, text) to authenticated;

drop function if exists public.update_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, text);

create function public.update_member(
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
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_name   text := nullif(trim(p_full_name), '');
  v_before jsonb;
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
           phone               = nullif(trim(coalesce(p_phone, '')), ''),
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

revoke execute on function public.update_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, text, text) from public;
grant execute on function public.update_member(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, text, text) to authenticated;
