-- supabase/migrations/0061_member_resolution_cores.sql
--
-- Block 5's bot needs the listener rules that Block 3 holds, and cannot reach
-- them: find_member_by_identifier and create_member gate on
-- has_permission(..., auth.uid()), and inside a SECURITY DEFINER body entered
-- by service_role auth.uid() is NULL.
--
-- The rejected alternative was reimplementing the dedup on the bot's path. That
-- is literally one rule with two entrances -- the defect Block 4b was returned
-- for twice -- and the rule duplicated would be the Organization-scoped dedup
-- that Block 3 exists to hold.
--
-- So: the mechanics move into private cores and each public door keeps its own
-- gate beside its own operation, exactly as apply_participation (0054) is
-- reached by record_participation and import_participations. The public
-- signatures, their gates, their error messages and their SQLSTATEs are
-- UNCHANGED; only the body moves. Every Block 3 test must still pass untouched,
-- and that is this migration's real acceptance criterion.
--
-- All four cores are SECURITY INVOKER with EXECUTE for nobody. Making them
-- DEFINER would let a future GRANT turn one into an unchecked write path -- the
-- reasoning 0054 gives for apply_participation, and it applies unchanged here.
--
-- create or replace throughout, never drop and recreate: every argument list
-- below is byte-identical to the one already deployed, so there is no second
-- signature for an old call site to resolve to and the ACL survives. 0033 and
-- 0034 are merged and deployed and are NOT edited; the replacements live here.
--
-- ---------------------------------------------------------------------------
-- THREE PLACES WHERE THE PLAN FOR THIS MIGRATION WOULD HAVE CHANGED BEHAVIOUR,
-- written down because no test in any suite covered any of them and the next
-- reader deserves to know they were deliberate rather than lucky:
--
--   1. The plan had one core returning a single uuid from a bare `limit 1`,
--      with find_member_by_identifier delegating to it. That silently reopens
--      the defect 0033's `order by reachable desc, c.id` was written to close
--      (0033's Task-3 review, Important 1): with phone matching a listener the
--      caller CAN reach and e-mail matching a different listener they cannot,
--      an unordered pick answers `elsewhere` where `visible` is correct, and
--      answers it differently on the next call if the plan changes. Reachable-
--      first cannot be recovered after the row has already been chosen, so the
--      match itself is extracted as a SET (apply_member_candidates) and the
--      single-answer core is built on top of it. One rule, one place, and
--      find_member_by_identifier's pick is unchanged.
--
--   2. The plan had apply_member_link returning void. link_member_to_company
--      tells a redundant link from a real one by reading FOUND after
--      `on conflict do nothing`, and raises 23505 for the redundant one -- a
--      shipped product decision, described in those words in
--      src/app/(app)/members/actions.ts ("idempotent-refusing, not
--      idempotent-succeeding"). PERFORM of a void function sets FOUND to TRUE
--      whatever the insert did, so a void core would have made that refusal
--      unreachable. The core returns boolean instead; the bot ignores it and is
--      still idempotent.
--
--   3. The plan matched the passport case-sensitively. 0033 matches
--      `lower(m.passport) = lower(...)` and members_passport_unique (0031) is
--      built on (organization_id, lower(passport)). A dedup narrower than its
--      own unique index finds nothing and then the index refuses the insert.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The identifier match itself, lifted out of find_member_by_identifier
--    (0033), as a set. NO visibility filter: this answers "does this
--    Organization already know this person?", and member_reachable -- which
--    answers "may the caller see them?" -- stays in the public function where
--    the gate belongs.
--
--    A set rather than one row because its two callers pick differently from
--    the same candidates and both picks are deliberate: the public door wants
--    the reachable one first (0033, Important 1), the bot has no caller to be
--    reachable to. Returning one row here would force one of those two picks on
--    the other.
--
--    Normalisation goes through normalize_phone/normalize_email (0031) rather
--    than a local re-derivation, so this can never disagree with
--    members.phone_normalized/email_normalized, which are GENERATED from the
--    same two functions. cpf_hash and passport have no generated column to
--    delegate to and are normalised here exactly as 0033 normalised them.
-- ---------------------------------------------------------------------------
create or replace function public.apply_member_candidates(
  p_org       uuid,
  p_phone     text,
  p_email     text,
  p_cpf_hash  text,
  p_passport  text
)
returns setof uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select m.id
  from public.members m
  where m.organization_id = p_org
    and m.deleted_at is null
    and (
      (public.normalize_phone(p_phone) is not null
        and m.phone_normalized = public.normalize_phone(p_phone))
      or (public.normalize_email(p_email) is not null
        and m.email_normalized = public.normalize_email(p_email))
      or (nullif(lower(trim(coalesce(p_cpf_hash, ''))), '') is not null
        and m.cpf_hash = nullif(lower(trim(coalesce(p_cpf_hash, ''))), ''))
      -- lower() on BOTH sides, matching 0033 and members_passport_unique
      -- (0031), which is built on (organization_id, lower(passport)).
      or (nullif(trim(coalesce(p_passport, '')), '') is not null
        and lower(m.passport) = lower(nullif(trim(coalesce(p_passport, '')), '')))
    );
$$;

revoke execute on function
  public.apply_member_candidates(uuid, text, text, text, text) from public;

comment on function public.apply_member_candidates(uuid, text, text, text, text) is
  'Every live Member of p_org that any supplied identifier matches -- the identifier match itself, shared by find_member_by_identifier (0033) and apply_member_lookup so the two cannot drift. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody. Deliberately has NO visibility filter -- it answers whether the Organization already knows this person; member_reachable answers whether the caller may see them, and stays in find_member_by_identifier beside the gate. Returns a SET, not one row, because its callers pick differently from the same candidates: the public door wants the reachable one first (0033, Task-3 review Important 1), and the bot has no caller to be reachable to. Ordinarily one row; more than one only in the split-identifier case 0033 describes, where each of phone/e-mail/CPF/passport carries its own per-Organization unique index (0031) and so can be held by a different Member. Normalisation goes through normalize_phone/normalize_email so this can never disagree with members.phone_normalized/email_normalized, which are generated from the same functions; the passport is matched through lower() on both sides, agreeing with members_passport_unique.';

-- ---------------------------------------------------------------------------
-- 2. One answer, for a caller with no reachability to speak of: the WhatsApp
--    door (Task 6), which runs as service_role inside a SECURITY DEFINER body
--    where auth.uid() is NULL.
--
--    `order by c.id` is DEFENSIVE, not a business rule, and must not be read as
--    one. The bot supplies a phone and nothing else, and members_phone_unique
--    (0031) is unique per Organization, so at most one candidate can exist on
--    that path. The ordering exists so that the degenerate case -- somebody
--    later calling this with two identifiers held by two different Members --
--    is deterministic rather than whatever the planner reached first. It does
--    NOT mean "the lowest id wins" is the right answer to that question; a
--    caller who needs the reachable one must use find_member_by_identifier,
--    which asks reachability and picks accordingly.
-- ---------------------------------------------------------------------------
create or replace function public.apply_member_lookup(
  p_org       uuid,
  p_phone     text,
  p_email     text,
  p_cpf_hash  text,
  p_passport  text
)
returns uuid
language sql
stable
set search_path = pg_catalog, public
as $$
  select c.id
  from public.apply_member_candidates(
         p_org, p_phone, p_email, p_cpf_hash, p_passport) as c(id)
  order by c.id
  limit 1;
$$;

revoke execute on function
  public.apply_member_lookup(uuid, text, text, text, text) from public;

comment on function public.apply_member_lookup(uuid, text, text, text, text) is
  'Whether this Organization already knows this person, as one id or null -- the shape the WhatsApp door (Block 5) needs, built on apply_member_candidates so it cannot drift from find_member_by_identifier (0033). PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, reachable only from inside a SECURITY DEFINER body that has already checked its own gate. Deliberately has NO visibility filter, for the reason apply_member_candidates gives. `order by id` is defensive rather than a business rule: the bot searches by phone alone and members_phone_unique (0031) is per-Organization, so at most one candidate exists on that path -- the ordering only makes the split-identifier case deterministic, and a caller who needs the REACHABLE candidate must use find_member_by_identifier, which asks and picks.';

-- ---------------------------------------------------------------------------
-- 3. Registration plus the Station link, lifted out of create_member (0034).
--    create_member already does both -- a registration IS the first Station the
--    person took part in -- so the link is not a separate concern and does not
--    become one here.
--
--    Parameters are create_member's, in the same order, plus the actor. The
--    actor is a PARAMETER and not auth.uid(): the bot has none and passes NULL,
--    which every column it lands in accepts (members.created_by,
--    member_company_links.linked_by and audit_logs.actor_id are all nullable
--    references to auth.users, 0031/0004).
--
--    The has_permission check does NOT come with the body. It stays in
--    create_member, beside the operation, where a reader looking for "who may
--    do this" finds it (0027's reasoning, restated by 0054).
--
--    The FOR SHARE on the Station row DOES come with the body:
--    member_links_company_org_fk (0031) cannot see deleted_at -- a composite
--    foreign key cannot reference a partial index -- so without this lock a
--    concurrent write to this Station's deleted_at, between this check and the
--    member_company_links insert below, could let the link be written against a
--    Station that is archived by the time this transaction commits. Same
--    reasoning assign_company_role (0017) gives for its FOR SHARE on roles.
--    create_member takes the same lock before its own gate, so that a stale
--    Station is still reported as P0002 BEFORE a permission refusal, exactly as
--    it was; taking it twice in one transaction is a no-op the second time.
-- ---------------------------------------------------------------------------
create or replace function public.apply_member_creation(
  p_company_id           uuid,
  p_full_name            text,
  p_phone                text,
  p_email                text,
  p_cpf_hash             text,
  p_cpf_last_digits      text,
  p_passport             text,
  p_birth_date           date,
  p_address_line         text,
  p_address_number       text,
  p_address_complement   text,
  p_neighbourhood        text,
  p_city                 text,
  p_state                text,
  p_postal_code          text,
  p_discovery_source     text,
  p_first_contact_at     timestamptz,
  p_first_contact_origin text,
  p_actor                uuid
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org  uuid;
  v_name text := nullif(trim(p_full_name), '');
  v_id   uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  -- Four independent partial unique indexes (phone, e-mail, CPF hash, passport;
  -- 0031_members.sql) can each be the one that collides. find_member_by_identifier
  -- (0033) is the friendly pre-submission path; this is what makes a duplicate
  -- unrepresentable even if a caller skips it or loses a race.
  begin
    insert into public.members
      (organization_id, full_name, phone, email, cpf_hash, cpf_last_digits, passport,
       birth_date, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, discovery_source, first_contact_at, first_contact_origin,
       created_by)
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
       nullif(trim(coalesce(p_address_line, '')), ''), nullif(trim(coalesce(p_address_number, '')), ''),
       nullif(trim(coalesce(p_address_complement, '')), ''), nullif(trim(coalesce(p_neighbourhood, '')), ''),
       nullif(trim(coalesce(p_city, '')), ''), nullif(trim(coalesce(p_state, '')), ''),
       nullif(trim(coalesce(p_postal_code, '')), ''), nullif(trim(coalesce(p_discovery_source, '')), ''),
       p_first_contact_at, nullif(trim(coalesce(p_first_contact_origin, '')), ''),
       p_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  -- A plain insert, not ON CONFLICT: create_member has just created v_id, so
  -- there cannot be a prior link for it. apply_member_link is the idempotent
  -- one, because it is the one that can be handed a listener already linked.
  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (v_id, p_company_id, v_org, p_actor);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (p_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));

  return v_id;
end;
$$;

revoke execute on function public.apply_member_creation(
  uuid, text, text, text, text, text, text, date, text, text, text, text, text,
  text, text, text, timestamptz, text, uuid) from public;

comment on function public.apply_member_creation(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text, uuid) is
  'Registers a listener and links them to the Station it was called with -- create_member''s (0034) body, shared with the WhatsApp door so the two cannot drift. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside a SECURITY DEFINER body that has already checked members.create. Holds NO gate of its own, for the reason apply_participation (0054) gives. The actor is a parameter rather than auth.uid(), because the bot has none and passes NULL; members.created_by, member_company_links.linked_by and audit_logs.actor_id all accept it. FOR SHARE on the Station row travels with the body and protects the Station''s deleted_at through to the member_company_links insert -- create_member takes the same lock before its own gate so a stale Station is still P0002 before any permission refusal, and taking it twice in one transaction is a no-op. cpf_hash is normalised so an empty string cannot reach 0031''s format CHECK as a raw 23514. A duplicate phone/e-mail/CPF/passport within the Organization is refused with 23505. Audit detail carries member_id only.';

-- ---------------------------------------------------------------------------
-- 4. The link insert, lifted out of link_member_to_company (0034). Idempotent
--    at the table -- the bot may be re-entering a listener already linked, and
--    a reprocessed event must not raise on the second pass.
--
--    Returns whether a row was actually written, and that boolean is load-
--    bearing rather than a convenience. link_member_to_company refuses a
--    redundant link with a named 23505 (see its own comment, and
--    src/app/(app)/members/actions.ts, which calls it "idempotent-refusing, not
--    idempotent-succeeding"), and it learns which case it is from FOUND. A void
--    core would have destroyed that: PERFORM of a void function sets FOUND to
--    TRUE whatever the insert underneath it did, so the refusal would have
--    become unreachable, with nothing in any suite to say so. The bot ignores
--    the boolean and gets the idempotence it needs.
--
--    ON CONFLICT names its target, as 0034 did, rather than the bare form: the
--    pair is what may legitimately already be there, and a bare DO NOTHING
--    would also swallow a conflict this function has no business swallowing.
-- ---------------------------------------------------------------------------
create or replace function public.apply_member_link(
  p_member_id  uuid,
  p_company_id uuid,
  p_org        uuid,
  p_actor      uuid
)
returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  -- ON CONFLICT DO NOTHING rather than a select-then-insert: two concurrent
  -- calls racing to link the same pair would otherwise both see nothing and
  -- both insert. FOUND is false when the conflict branch fires (no row
  -- written), which is how a redundant call is told apart from a real one --
  -- same reasoning remove_company_access (0017) gives for why a no-op must not
  -- report success.
  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (p_member_id, p_company_id, p_org, p_actor)
  on conflict (member_id, company_id) do nothing;

  return found;
end;
$$;

revoke execute on function
  public.apply_member_link(uuid, uuid, uuid, uuid) from public;

comment on function public.apply_member_link(uuid, uuid, uuid, uuid) is
  'Links a listener to a Station, idempotently at the table (ON CONFLICT on the pair), and returns whether a row was actually written. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from inside a SECURITY DEFINER body that has already checked members.create. The boolean is load-bearing: link_member_to_company (0034) refuses a redundant link with a named 23505 and learns which case it is from this result. It cannot use FOUND for that any more, because PERFORM of a function sets FOUND to TRUE whatever the statement inside it did -- which is exactly how returning void here would have deleted a shipped refusal in silence. The bot ignores the result and re-entering an already-linked listener is a no-op, which is what a reprocessed event needs.';

-- ---------------------------------------------------------------------------
-- The public doors. Each keeps its exact signature, its gate, its error
-- messages and its SQLSTATEs; only the mechanics leave.
-- ---------------------------------------------------------------------------

-- find_member_by_identifier: keeps its members.view gate, its all-blank guard,
-- member_reachable and the visible/elsewhere/none contract. The match is now
-- apply_member_candidates'; the PICK stays here, because it is a statement
-- about the caller and not about the Organization.
create or replace function public.find_member_by_identifier(
  p_organization_id uuid,
  p_phone           text default null,
  p_email           text default null,
  p_cpf_hash        text default null,
  p_passport        text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  -- The same functions the generated columns use (public.normalize_phone /
  -- public.normalize_email, 0031_members.sql) -- not a hand-copy of their
  -- expressions. These locals exist for the all-blank guard below; the search
  -- itself is handed the RAW arguments, because apply_member_candidates
  -- normalises them with these same expressions and passing pre-normalised
  -- values through a second normalisation is a promise about idempotence that
  -- nothing here needs to make.
  v_phone    text := public.normalize_phone(p_phone);
  v_email    text := public.normalize_email(p_email);
  -- cpf_hash and passport have no generated column to delegate to (cpf_hash is
  -- already a fixed-format hex digest; passport has no canonical case). Task-3
  -- review, Important 4: both are normalised into locals and tested in the
  -- guard below, so a blank string ('' -- the default a JSON/HTTP client sends
  -- for an empty field) cannot slip past nullif untested.
  v_cpf_hash text := nullif(lower(trim(coalesce(p_cpf_hash, ''))), '');
  v_passport text := nullif(trim(coalesce(p_passport, '')), '');
  v_id       uuid;
  v_visible  boolean;
begin
  -- The caller must hold members.view somewhere in this Organization. Without this
  -- the function is an Organization-wide existence oracle for anyone with a session.
  if not public.has_org_permission('members.view', p_organization_id) then
    raise log 'find_member_by_identifier denied: actor=% org=%', auth.uid(), p_organization_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- Testing the normalised locals, not the raw arguments: an all-blank call
  -- (every field null OR '' OR whitespace) is refused here, before it can reach
  -- the search below and manufacture a false 'none'.
  if v_phone is null and v_email is null and v_cpf_hash is null and v_passport is null then
    raise exception 'give at least one identifier to search by' using errcode = '22023';
  end if;

  -- Task-3 review, Important 1, unchanged by the extraction and the reason
  -- apply_member_candidates returns a set: phone, e-mail, CPF and passport each
  -- carry their own per-Organization unique index (0031), so nothing stops
  -- Member P holding the phone this call searches for while Member Q holds the
  -- e-mail. An unordered `limit 1` over the candidates would then hand back
  -- whichever row the planner happened to reach first: a wrong answer when the
  -- reachable Member (P) loses the race to the one the caller cannot see (Q),
  -- and a DIFFERENT wrong answer on the next call if the plan changes -- not
  -- idempotent, which a registration workflow cannot tolerate.
  --
  -- So the pick is deterministic: the reachable Member first, and among equally-
  -- reachable candidates the lowest id. This does not change the three-outcome
  -- contract (the owner's ruling: resolving per-identifier so the caller learns
  -- WHICH field collided was deliberately rejected); it only makes the single id
  -- this function already promised to return the right one, and the same one
  -- every time.
  --
  -- Reachability is computed by member_reachable (0033), which admits the
  -- platform admin and the Organization owner outside the per-link
  -- has_permission check, so a Member linked only to an archived or suspended
  -- Station is not a dead end to literally nobody. Consequence, deliberate: a
  -- Member with zero rows in member_company_links has no link for has_permission
  -- to ever approve, so an ordinary role holder can never reach one -- a
  -- data-hygiene state, not a permission state.
  with candidates as (
    select c.id,
           public.member_reachable(c.id, p_organization_id, 'members.view') as reachable
    from public.apply_member_candidates(
           p_organization_id, p_phone, p_email, p_cpf_hash, p_passport) as c(id)
  )
  select c.id, c.reachable
    into v_id, v_visible
  from candidates c
  order by c.reachable desc, c.id
  limit 1;

  if v_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;

  if v_visible then
    return jsonb_build_object('outcome', 'visible', 'member_id', v_id);
  end if;

  -- Existence, and nothing else. Returning the id here would hand a caller a handle
  -- to a record every policy in this block exists to keep from them.
  return jsonb_build_object('outcome', 'elsewhere');
end;
$$;

revoke execute on function public.find_member_by_identifier(uuid, text, text, text, text) from public;
grant execute on function public.find_member_by_identifier(uuid, text, text, text, text) to authenticated;

-- create_member: keeps its members.create gate, its P0002 for a stale Station
-- (raised BEFORE the gate, exactly as it was -- an existing caller may depend on
-- which of the two it gets for an unknown Station), and its 22023 for a blank
-- name. The registration and the link are apply_member_creation's.
create or replace function public.create_member(
  p_company_id            uuid,
  p_full_name             text,
  p_phone                 text default null,
  p_email                 text default null,
  p_cpf_hash              text default null,
  p_cpf_last_digits       text default null,
  p_passport              text default null,
  p_birth_date            date default null,
  p_address_line          text default null,
  p_address_number        text default null,
  p_address_complement    text default null,
  p_neighbourhood         text default null,
  p_city                  text default null,
  p_state                 text default null,
  p_postal_code           text default null,
  p_discovery_source      text default null,
  p_first_contact_at      timestamptz default null,
  p_first_contact_origin  text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text := nullif(trim(p_full_name), '');
begin
  -- FOR SHARE, and the P0002 below, stay here as well as travelling into the
  -- core: this read is what makes "station not found" precede "permission
  -- denied" for an unknown or archived Station, and swapping those two would be
  -- a silent contract change for every existing caller.
  perform 1 from public.companies
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

  return public.apply_member_creation(
    p_company_id, v_name, p_phone, p_email, p_cpf_hash, p_cpf_last_digits,
    p_passport, p_birth_date, p_address_line, p_address_number,
    p_address_complement, p_neighbourhood, p_city, p_state, p_postal_code,
    p_discovery_source, p_first_contact_at, p_first_contact_origin, v_actor);
end;
$$;

revoke execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) from public;
grant execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) to authenticated;

comment on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) is
  'Registers a listener and links them to the Station it was called with -- the other writer of member_company_links is link_member_to_company. Gated on members.create, checked here beside the operation; the registration, the link, the audit entry and the FOR SHARE that protects the Station''s deleted_at through to the link are apply_member_creation''s (0061), shared with the WhatsApp door so the two cannot drift. A stale or archived Station is still P0002 BEFORE any permission refusal, which is why the Station is read here as well as inside the core. cpf_hash/cpf_last_digits are expected pre-hashed by the caller and are normalised so an empty string cannot slip past into the cpf_hash format CHECK (0031) as a raw 23514 -- this function neither hashes nor validates the raw CPF itself. A duplicate phone/e-mail/CPF/passport within the Organization is refused with 23505; find_member_by_identifier is the friendly pre-submission check, this is the backstop. Audit detail carries member_id only.';

-- link_member_to_company: keeps its two P0002s, its members.create gate and its
-- 23505 for a pair already linked. The insert is apply_member_link's, and the
-- boolean it returns is what the 23505 is decided on.
create or replace function public.link_member_to_company(
  p_member_id  uuid,
  p_company_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
begin
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- FOR SHARE -- the direct analogue of assign_company_role's own lock on roles
  -- (0017): member_links_company_org_fk (0031) cannot see deleted_at, so without
  -- this lock a concurrent archival of this Station between this check and the
  -- member_company_links insert below could let the link be written against a
  -- Station that is archived by the time this transaction commits. It stays
  -- HERE, not in the core, because it is this function's own read of the Station
  -- and its own P0002 that it protects; the bot resolves its Station elsewhere.
  perform 1 from public.companies
   where id = p_company_id and organization_id = v_org and deleted_at is null
     for share;

  if not found then
    raise exception 'station not found in this organization: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('members.create', p_company_id) then
    raise log 'link_member_to_company denied: actor=% member=% company=%', v_actor, p_member_id, p_company_id;
    raise exception 'permission denied: members.create required' using errcode = '42501';
  end if;

  -- apply_member_link returns whether it actually wrote a row. FOUND cannot be
  -- read for this any more: PERFORM sets it TRUE whatever the statement inside
  -- the function did, which is why the core returns boolean rather than void.
  if not public.apply_member_link(p_member_id, p_company_id, v_org, v_actor) then
    raise exception 'this listener is already linked to that station' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'link_member_to_company', 'member_company_links', p_member_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id));
end;
$$;

revoke execute on function public.link_member_to_company(uuid, uuid) from public;
grant execute on function public.link_member_to_company(uuid, uuid) to authenticated;

comment on function public.link_member_to_company(uuid, uuid) is
  'Adds a Station to a listener''s reach without touching their identity fields. Gated on members.create at the Station being linked. FOR SHARE on the Station row (the direct analogue of assign_company_role''s lock on roles, 0017) protects deleted_at through to the insert, and stays here because it protects this function''s own read and its own P0002. The insert is apply_member_link''s (0061), shared with the WhatsApp door; a pair already linked is still refused with 23505 rather than silently succeeding a second time, decided on the boolean that core returns rather than on FOUND, which PERFORM would have set TRUE regardless. Audit detail carries member_id only.';
