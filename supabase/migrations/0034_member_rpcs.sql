-- supabase/migrations/0034_member_rpcs.sql

-- Shared shape (0017_role_rpcs.sql, 0027_inventory_rpcs.sql): resolve the Organization
-- from the row rather than a caller-supplied id, re-check the caller's own permission
-- here even though SECURITY DEFINER bypasses RLS, RAISE LOG then RAISE EXCEPTION on
-- denial, audit on success.
--
-- THE RULE THAT BINDS EVERY ONE OF THESE NINE FUNCTIONS: an audit entry about a
-- Member records the member_id and NO personal value. Not masked — absent. Every
-- `detail` below is `member_id` alone, plus at most one non-personal id of the
-- note/consent/block row the call concerns (created by that same call, except
-- lift_member_block, which re-uses the block_id of the row it updates) and, for
-- anonymize_member only, the operator's SELECTED reason — a bounded enum
-- (member_erasure_reason, below), never free text. Never a name, phone, e-mail,
-- document, address, or a note's/block's free text. Otherwise anonymize_member
-- scrubs the source table while the audit trail quietly keeps a copy, and this
-- product's erasure promise is false in exactly the place nobody looks.

-- member_reachable — whether the caller holds a permission code at ANY Station a
-- Member is linked to, admitting the owner/platform admin outside the per-link
-- has_permission check so a Member whose only Station is archived is not a
-- permanent dead end — now lives in 0033_member_dedup.sql, alongside
-- find_member_by_identifier, its other caller (Task 4 review, Important 5: this
-- file used to carry its own copy, which was exactly the drift 0031's comment on
-- normalize_phone/normalize_email warns against). update_member, archive_member and
-- anonymize_member below call public.member_reachable(...) — see 0033 for its
-- definition and comment.

-- Shared by record_member_consent, add_member_note and block_member (all three take
-- a company_id and must refuse to write Station-scoped data for a Member who was
-- never linked there) — Task 4 review, Important 2: this used to be the same
-- `exists (select 1 from member_company_links ...)` check, copied three times.
-- SECURITY INVOKER, EXECUTE granted to nobody — same convention as member_reachable
-- (0033) and apply_inventory_movement (0027).
create or replace function public.member_linked_to_company(
  p_member_id  uuid,
  p_company_id uuid
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.member_company_links l
    where l.member_id = p_member_id and l.company_id = p_company_id
  );
$$;

comment on function public.member_linked_to_company(uuid, uuid) is
  'Whether a member_company_links row exists for this pair. Shared by record_member_consent, add_member_note and block_member (0034) so the same check cannot drift across three copies. SECURITY INVOKER; reachable only from inside a SECURITY DEFINER body, same convention as member_reachable (0033) and apply_inventory_movement (0027).';

revoke execute on function public.member_linked_to_company(uuid, uuid) from public;

-- Registers a listener and links them to the Station it was called with. The Member
-- itself is Organization-scoped (0031); this write also creates the
-- member_company_links row for that Station (link_member_to_company, below, is the
-- only other writer of that table in this file), because a registration IS the
-- first Station the person took part in.
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
  v_org   uuid;
  v_name  text := nullif(trim(p_full_name), '');
  v_id    uuid;
begin
  -- FOR SHARE: member_links_company_org_fk (0031) cannot see deleted_at — a
  -- composite foreign key cannot reference a partial index — so without this lock a
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
       birth_date, address_line, address_number, address_complement, neighbourhood,
       city, state, postal_code, discovery_source, first_contact_at, first_contact_origin,
       created_by)
    values
      (v_org, v_name,
       nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''),
       -- Normalised the same way 0033's find_member_by_identifier normalises them
       -- (Task 3 review, Important 4): an empty string — what an HTML/JSON client
       -- sends for a blank field — would otherwise reach 0031's cpf_hash format
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
       v_actor)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'a listener with this phone, e-mail, CPF or passport is already registered in this organization'
        using errcode = '23505';
  end;

  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (v_id, p_company_id, v_org, v_actor);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'create_member', 'members', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', v_id));

  return v_id;
end;
$$;

comment on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) is
  'Registers a listener and links them to the Station it was called with — the other writer of member_company_links in this file is link_member_to_company, below. Gated on members.create; FOR SHARE on the Station row protects the Station''s deleted_at through to the member_company_links insert. cpf_hash/cpf_last_digits are expected pre-hashed by the caller (Task 6, Node) and are normalised the same way find_member_by_identifier (0033) normalises them, so an empty string cannot slip past into the cpf_hash format CHECK (0031) as a raw 23514 — this function neither hashes nor validates the raw CPF itself. A duplicate phone/e-mail/CPF/passport within the Organization is refused with 23505; find_member_by_identifier is the friendly pre-submission check, this is the backstop. Audit detail carries member_id only.';

-- Wholesale replacement of a listener's own EDITABLE fields (same convention as
-- update_role, update_prize) — every field below is set on every call, not merged.
-- Two of the Member's own columns are deliberately NOT here and so cannot be
-- touched by this function at all: first_contact_at and first_contact_origin.
-- They are the evidence behind the owner's decision (spec §7) that a listener who
-- messages a Station first has authorised the reply; write-once through
-- create_member and correctable by nothing keeps that evidence from being rewritten
-- for a position already taken. (anonymize_member still erases
-- first_contact_origin — it treats it as identifying enough to remove, which is a
-- different question from whether it may be edited while it stands as evidence.)
--
-- Deliberately does NOT record a before/after diff the way update_role/update_prize
-- do: their diffs are role names and prize fields, neither personal; a Member's diff
-- would be exactly the name/phone/e-mail/CPF/address this whole block exists to keep
-- out of audit_logs.
create or replace function public.update_member(
  p_member_id             uuid,
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
  p_discovery_source      text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_name  text := nullif(trim(p_full_name), '');
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

  -- deleted_at and anonymized_at are re-checked HERE, inside the UPDATE's own WHERE
  -- clause, not only via the earlier SELECT: a plain read-then-write would leave a
  -- window where archive_member or anonymize_member commits between the read and
  -- this write, and this call would then either silently succeed on an
  -- already-archived row or — the single worst thing this function could do —
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
           address_line        = nullif(trim(coalesce(p_address_line, '')), ''),
           address_number      = nullif(trim(coalesce(p_address_number, '')), ''),
           address_complement  = nullif(trim(coalesce(p_address_complement, '')), ''),
           neighbourhood       = nullif(trim(coalesce(p_neighbourhood, '')), ''),
           city                = nullif(trim(coalesce(p_city, '')), ''),
           state               = nullif(trim(coalesce(p_state, '')), ''),
           postal_code         = nullif(trim(coalesce(p_postal_code, '')), ''),
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

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'update_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id));
end;
$$;

comment on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text) is
  'Replaces a listener''s own editable fields wholesale. Does NOT touch first_contact_at/first_contact_origin — write-once through create_member, immutable here by design because they are the evidence behind the owner''s first-contact-consent position (spec §7). Gated on members.edit, checked via member_reachable (any Station the listener is linked to) since this function takes no company_id. The UPDATE''s own WHERE clause re-checks anonymized_at is null (and deleted_at is null) atomically with the write; on a miss it re-reads anonymized_at to report which of the two actually happened (22023, distinct messages) rather than guessing, since a concurrent archive_member or anonymize_member could equally be the cause. cpf_hash/cpf_last_digits are normalised the same way create_member normalises them. Audit detail carries member_id only — no before/after diff, unlike update_role/update_prize, because a Member''s diff IS the personal data.';

-- The one place a Station is added to a listener's reach beyond registration.
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

  -- FOR SHARE — the direct analogue of assign_company_role's own lock on roles
  -- (0017): member_links_company_org_fk (0031) cannot see deleted_at, so without
  -- this lock a concurrent archival of this Station between this check and the
  -- member_company_links insert below could let the link be written against a
  -- Station that is archived by the time this transaction commits.
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

  -- ON CONFLICT DO NOTHING rather than a select-then-insert: two concurrent calls
  -- racing to link the same pair would otherwise both see nothing and both insert.
  -- FOUND is false when the conflict branch fires (no row written), which is how a
  -- redundant call is told apart from a real one — same reasoning
  -- remove_company_access (0017) gives for why a no-op must not report success.
  insert into public.member_company_links (member_id, company_id, organization_id, linked_by)
  values (p_member_id, p_company_id, v_org, v_actor)
  on conflict (member_id, company_id) do nothing;

  if not found then
    raise exception 'this listener is already linked to that station' using errcode = '23505';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'link_member_to_company', 'member_company_links', p_member_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id));
end;
$$;

comment on function public.link_member_to_company(uuid, uuid) is
  'Adds a Station to a listener''s reach without touching their identity fields. Gated on members.create at the Station being linked. FOR SHARE on the Station row (the direct analogue of assign_company_role''s lock on roles, 0017) protects deleted_at through to the insert. A pair already linked is refused with 23505 rather than silently succeeding a second time. Audit detail carries member_id only.';

-- Archival, not erasure — deleted_at, not anonymized_at. The row keeps every field;
-- it just leaves the day-to-day lists.
create or replace function public.archive_member(p_member_id uuid)
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

  if not public.member_reachable(p_member_id, v_org, 'members.archive') then
    raise log 'archive_member denied: actor=% member=%', v_actor, p_member_id;
    raise exception 'permission denied: members.archive required' using errcode = '42501';
  end if;

  -- Re-checked in the WHERE clause, atomically with the write, so a concurrent
  -- archive_member call is told apart from this one rather than both silently
  -- reporting success and both writing an audit row for the same event.
  update public.members
     set deleted_at = now(), updated_at = now()
   where id = p_member_id and deleted_at is null;

  -- Not "not found, or already archived": the SELECT above already proved the row
  -- existed and was live moments ago, and nothing in this codebase hard-deletes a
  -- Member, so the only way this UPDATE can find nothing is a concurrent
  -- archive_member call that won the race.
  if not found then
    raise exception 'this listener has already been archived: %', p_member_id using errcode = 'P0002';
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'archive_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id));
end;
$$;

comment on function public.archive_member(uuid) is
  'Soft-deletes a listener (deleted_at), not erasure — every field survives. Gated on members.archive, checked via member_reachable since this function takes no company_id. Audit detail carries member_id only.';

-- Append-only (0032): a withdrawal is a new row, never an edit of the one that
-- granted it. Requires the listener already be linked to the Station recording the
-- consent — the same member_company_links fact RLS (Task 5, 0035) will use to
-- decide whether this listener appears on that Station's screen at all.
create or replace function public.record_member_consent(
  p_member_id    uuid,
  p_company_id   uuid,
  p_consent_type public.member_consent_type,
  p_granted      boolean,
  p_origin       text default null,
  p_promotion_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_id    uuid;
begin
  -- FOR SHARE, and anonymized_at is null in the same WHERE: member_consents_member_org_fk
  -- (0032) cannot see deleted_at OR anonymized_at, so without this lock a concurrent
  -- archive_member/anonymize_member between this check and the insert below could
  -- let a fresh, personal consent row be written for a listener who is archived or
  -- has just been erased (Task 4 review, Important 2 and Important 3 together — the
  -- lock closes both the sequential gap and the race window in one fix, since a
  -- concurrent anonymize_member's UPDATE on this same row blocks until this
  -- transaction ends).
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null and anonymized_at is null
    for share;

  if not found then
    raise exception 'listener not found, or has been anonymised: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_linked_to_company(p_member_id, p_company_id) then
    raise exception 'this listener is not linked to that station: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('members.edit', p_company_id) then
    raise log 'record_member_consent denied: actor=% member=% company=%', v_actor, p_member_id, p_company_id;
    raise exception 'permission denied: members.edit required' using errcode = '42501';
  end if;

  if p_consent_type is null then
    raise exception 'consent type is required' using errcode = '22023';
  end if;

  if p_granted is null then
    raise exception 'granted must be true or false' using errcode = '22023';
  end if;

  insert into public.member_consents
    (organization_id, member_id, company_id, consent_type, granted, origin, promotion_id, recorded_by)
  values
    (v_org, p_member_id, p_company_id, p_consent_type, p_granted,
     nullif(trim(coalesce(p_origin, '')), ''), p_promotion_id, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'record_member_consent', 'member_consents', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'consent_id', v_id));

  return v_id;
end;
$$;

comment on function public.record_member_consent(uuid, uuid, public.member_consent_type, boolean, text, uuid) is
  'Appends a consent row (0032) — a withdrawal is granted = false as a NEW row, never an edit. FOR SHARE plus deleted_at/anonymized_at is null on the listener read (Task 4 review, Important 2/3) refuses both an archived and an already-anonymised listener, and closes the race where anonymize_member could commit between the read and this insert. Requires the listener already be linked to the Station (member_linked_to_company, shared with add_member_note/block_member); gated on members.edit at that Station. Audit detail carries member_id and the new consent''s own id only — consent_type and origin are deliberately left out, not because either is personal, but to keep every one of the nine audit shapes in this file to the same narrow member_id-plus-own-id pattern rather than inventing a wider one with no product need behind it yet.';

-- Free text, personal by nature (0032's own comment: "an operator adds about a
-- Member"). The audit trail records that a note was added, and its id — never its
-- text, for the same reason a name or phone never appears in detail.
create or replace function public.add_member_note(
  p_member_id  uuid,
  p_company_id uuid,
  p_body       text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_body  text := nullif(trim(coalesce(p_body, '')), '');
  v_id    uuid;
begin
  -- FOR SHARE, and anonymized_at is null in the same WHERE — same reasoning as
  -- record_member_consent, above: without it, this function would happily attach a
  -- fresh, permanent, personal note to a Member whose erasure has already completed
  -- (Task 4 review, Important 2), and a concurrent anonymize_member could otherwise
  -- race between this check and the insert below (Important 3; the lock closes both
  -- at once, since anonymize_member's UPDATE on this same row blocks until this
  -- transaction ends).
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null and anonymized_at is null
    for share;

  if not found then
    raise exception 'listener not found, or has been anonymised: %', p_member_id using errcode = 'P0002';
  end if;

  if not public.member_linked_to_company(p_member_id, p_company_id) then
    raise exception 'this listener is not linked to that station: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('members.edit', p_company_id) then
    raise log 'add_member_note denied: actor=% member=% company=%', v_actor, p_member_id, p_company_id;
    raise exception 'permission denied: members.edit required' using errcode = '42501';
  end if;

  if v_body is null then
    raise exception 'note body is required' using errcode = '22023';
  end if;

  insert into public.member_notes (organization_id, member_id, company_id, body, created_by)
  values (v_org, p_member_id, p_company_id, v_body, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'add_member_note', 'member_notes', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'note_id', v_id));

  return v_id;
end;
$$;

comment on function public.add_member_note(uuid, uuid, text) is
  'Appends a free-text note (0032), scoped to the Station that wrote it. FOR SHARE plus deleted_at/anonymized_at is null on the listener read (Task 4 review, Important 2/3) refuses both an archived and an already-anonymised listener, and closes the race where anonymize_member could commit between the read and this insert. Requires the listener already be linked to that Station (member_linked_to_company); gated on members.edit. The note body is personal by nature and never reaches audit_logs — detail carries member_id and the new note''s own id, never its text.';

-- The two things a block covers (0032): draw_ban or suspension, Organization-wide
-- (company_id null) or scoped to one Station. An Organization-wide block is checked
-- with has_org_permission, since no single Station's grant should decide it; a
-- Station-scoped block requires the listener already be linked there, then
-- has_permission at that Station.
create or replace function public.block_member(
  p_member_id  uuid,
  p_kind       public.member_block_kind,
  p_reason     text,
  p_company_id uuid default null,
  p_ends_at    timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_id     uuid;
begin
  -- FOR SHARE, and anonymized_at is null in the same WHERE — same reasoning as
  -- record_member_consent/add_member_note, above: without it, this function would
  -- happily attach a fresh, permanent, personal reason to a Member whose erasure has
  -- already completed (Task 4 review, Important 2), and a concurrent
  -- anonymize_member could otherwise race between this check and the insert below
  -- (Important 3; the lock closes both at once, since anonymize_member's UPDATE on
  -- this same row blocks until this transaction ends). Applied regardless of branch
  -- below — an Organization-wide block is exactly as personal as a Station-scoped
  -- one.
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null and anonymized_at is null
    for share;

  if not found then
    raise exception 'listener not found, or has been anonymised: %', p_member_id using errcode = 'P0002';
  end if;

  if p_company_id is null then
    if not public.has_org_permission('members.block', v_org) then
      raise log 'block_member denied: actor=% member=% org=%', v_actor, p_member_id, v_org;
      raise exception 'permission denied: members.block required' using errcode = '42501';
    end if;
  else
    if not public.member_linked_to_company(p_member_id, p_company_id) then
      raise exception 'this listener is not linked to that station: %', p_company_id using errcode = 'P0002';
    end if;

    if not public.has_permission('members.block', p_company_id) then
      raise log 'block_member denied: actor=% member=% company=%', v_actor, p_member_id, p_company_id;
      raise exception 'permission denied: members.block required' using errcode = '42501';
    end if;
  end if;

  if p_kind is null then
    raise exception 'block kind is required' using errcode = '22023';
  end if;

  if v_reason is null then
    raise exception 'a reason is required to block a listener' using errcode = '22023';
  end if;

  insert into public.member_blocks
    (organization_id, member_id, company_id, kind, reason, ends_at, created_by)
  values
    (v_org, p_member_id, p_company_id, p_kind, v_reason, p_ends_at, v_actor)
  returning id into v_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'block_member', 'member_blocks', v_id, v_org, p_company_id,
     jsonb_build_object('member_id', p_member_id, 'block_id', v_id));

  return v_id;
end;
$$;

comment on function public.block_member(uuid, public.member_block_kind, text, uuid, timestamptz) is
  'Appends a block row (0032): draw_ban or suspension, Organization-wide when company_id is null or scoped to one Station. FOR SHARE plus deleted_at/anonymized_at is null on the listener read (Task 4 review, Important 2/3), regardless of branch, refuses both an archived and an already-anonymised listener and closes the race where anonymize_member could commit between the read and this insert. Organization-wide is gated on has_org_permission(''members.block''); Station-scoped requires the listener already be linked there (member_linked_to_company) and is gated on has_permission(''members.block'', company_id). Reason is mandatory and free text, and — like a note''s body — never reaches audit_logs: detail carries member_id and the new block''s own id only.';

-- Recorded on the block it lifts (0032's own comment explains why: is_member_blocked
-- reads lifted_at directly). Locks the row before checking it, so two concurrent
-- lifts of the same block cannot both succeed.
create or replace function public.lift_member_block(
  p_block_id uuid,
  p_reason   text
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
  v_member  uuid;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select organization_id, company_id, member_id
    into v_org, v_company, v_member
  from public.member_blocks
  where id = p_block_id and lifted_at is null
  for update;

  if not found then
    raise exception 'block not found, or already lifted: %', p_block_id using errcode = 'P0002';
  end if;

  if v_company is null then
    if not public.has_org_permission('members.block', v_org) then
      raise log 'lift_member_block denied: actor=% block=%', v_actor, p_block_id;
      raise exception 'permission denied: members.block required' using errcode = '42501';
    end if;
  else
    if not public.has_permission('members.block', v_company) then
      raise log 'lift_member_block denied: actor=% block=%', v_actor, p_block_id;
      raise exception 'permission denied: members.block required' using errcode = '42501';
    end if;
  end if;

  if v_reason is null then
    raise exception 'a reason is required to lift a block' using errcode = '22023';
  end if;

  update public.member_blocks
     set lifted_at = now(), lifted_by = v_actor, lift_reason = v_reason
   where id = p_block_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'lift_member_block', 'member_blocks', p_block_id, v_org, v_company,
     jsonb_build_object('member_id', v_member, 'block_id', p_block_id));
end;
$$;

comment on function public.lift_member_block(uuid, text) is
  'Lifts a block by recording lifted_at/lifted_by/lift_reason on the row it ends (0032), never as a new row. FOR UPDATE on the block row prevents two concurrent lifts. Gated the same way the block itself was: has_org_permission for an Organization-wide block, has_permission at its Station otherwise. lift_reason is free text and, like a block''s own reason, never reaches audit_logs: detail carries member_id and the block''s own id only.';

-- The bounded vocabulary an erasure must justify itself with (owner's ruling, Task 4
-- review, Ruling A). No `other`: an escape hatch invites exactly the free text back
-- that this ruling exists to keep out — an operator typing "erasure requested by
-- <name>, <phone>" into a text field would re-plant precisely what anonymize_member
-- scrubs, and no test could catch it, because the test does not control what an
-- operator types. The narrative stays out of the immutable trail entirely, the same
-- reasoning that keeps the raw CPF out of the database (0031).
create type public.member_erasure_reason as enum ('subject_request', 'court_order', 'internal_policy');

-- Erasure that survives an immutable audit trail (spec §7). The row stays so
-- participations and deliveries still reference something; the person does not.
create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason    public.member_erasure_reason
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

  -- Erasure that survives an immutable audit trail. The row stays so participations
  -- and deliveries still reference something; the person does not. Every identifying
  -- column goes, including the address and the discovery source — a full address plus
  -- a birth date identifies a person as surely as a name does.
  update public.members
     set full_name = null, phone = null, email = null,
         cpf_hash = null, cpf_last_digits = null, passport = null,
         birth_date = null,
         address_line = null, address_number = null, address_complement = null,
         neighbourhood = null, city = null, state = null, postal_code = null,
         discovery_source = null,
         first_contact_origin = null,
         anonymized_at = now(),
         updated_at = now()
   where id = p_member_id and anonymized_at is null;

  if not found then
    raise exception 'that listener is already anonymised, or does not exist'
      using errcode = 'P0002';
  end if;

  -- Owner's ruling B (Task 4 review, extended by the controller after the fix round:
  -- "unblocked after <name> called and apologised" is exactly the free text
  -- describing a person that the ruling exists to keep out, so it covers
  -- lift_reason too, not only the block's own reason — the "three columns" in the
  -- original ruling reflected the review's list, not a judgement that a fourth
  -- should survive). A note reading "this is the person we erased, phone ..." or a
  -- block/consent/lift reason typed the same way would outlive the erasure it
  -- describes. These three tables' rows survive — their dates, types/kinds and
  -- authors keep the history intact — only the free text a Station wrote about this
  -- listener goes. member_notes.body and member_blocks.reason were NOT NULL until
  -- this ruling (0032, amended); both are nullable now for exactly this write.
  -- member_consents.origin and member_blocks.lift_reason were already nullable.
  update public.member_notes
     set body = null
   where member_id = p_member_id and body is not null;

  update public.member_consents
     set origin = null
   where member_id = p_member_id and origin is not null;

  update public.member_blocks
     set reason = null, lift_reason = null
   where member_id = p_member_id and (reason is not null or lift_reason is not null);

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

comment on function public.anonymize_member(uuid, public.member_erasure_reason) is
  'LGPD erasure. Nulls every identifying column on members (name, phone, e-mail, CPF hash and last digits, passport, birth date, full address, discovery source, first_contact_origin) and sets anonymized_at; the row and its id survive so participations and deliveries still reference something. phone_normalized/email_normalized are GENERATED ALWAYS from phone/email (0031) and clear automatically when the sources are nulled — verified against a live database, see the Task 4 report. Owner''s ruling B (Task 4 review, extended after the fix round to cover lift_reason as well as reason): also nulls member_notes.body, member_consents.origin and member_blocks.reason/lift_reason for this listener, keeping those rows and their dates/types/authors. p_reason is a bounded enum (member_erasure_reason, owner''s ruling A) — no free-text escape hatch, so the trail cannot be re-seeded with the very narrative it is erasing. Gated on members.erase, checked via member_reachable. The UPDATE''s own WHERE clause (anonymized_at is null) makes a double-erase a clean, atomic refusal (P0002) rather than a second no-op success. Audit detail carries member_id and the selected reason: this function writes no value it read from a Member''s own row or its lifecycle tables, which is the guarantee it can actually make — not an absolute about every field''s contents forever, which no function can promise on behalf of an operator''s future free-text input elsewhere.';

revoke execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) from public;
revoke execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text) from public;
revoke execute on function public.link_member_to_company(uuid, uuid) from public;
revoke execute on function public.archive_member(uuid) from public;
revoke execute on function public.record_member_consent(uuid, uuid, public.member_consent_type, boolean, text, uuid) from public;
revoke execute on function public.add_member_note(uuid, uuid, text) from public;
revoke execute on function public.block_member(uuid, public.member_block_kind, text, uuid, timestamptz) from public;
revoke execute on function public.lift_member_block(uuid, text) from public;
revoke execute on function public.anonymize_member(uuid, public.member_erasure_reason) from public;

grant execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.link_member_to_company(uuid, uuid) to authenticated;
grant execute on function public.archive_member(uuid) to authenticated;
grant execute on function public.record_member_consent(uuid, uuid, public.member_consent_type, boolean, text, uuid) to authenticated;
grant execute on function public.add_member_note(uuid, uuid, text) to authenticated;
grant execute on function public.block_member(uuid, public.member_block_kind, text, uuid, timestamptz) to authenticated;
grant execute on function public.lift_member_block(uuid, text) to authenticated;
grant execute on function public.anonymize_member(uuid, public.member_erasure_reason) to authenticated;
