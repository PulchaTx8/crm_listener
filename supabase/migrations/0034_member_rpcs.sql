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
-- anonymize_member only, the operator's stated reason — never a name, phone, e-mail,
-- document, address, or a note's/reason's free text. Otherwise anonymize_member
-- scrubs the source table while the audit trail quietly keeps a copy, and this
-- product's erasure promise is false in exactly the place nobody looks.

-- Reachability for the three RPCs that take only a member_id and so have no
-- caller-supplied company_id to check has_permission against directly: update_member,
-- archive_member, anonymize_member. A Member is reachable under a permission code if
-- the caller holds it at ANY Station the Member is linked to.
--
-- has_permission requires an ACTIVE Station (has_company_access, 0005/0016), so a
-- Member linked only to a suspended or archived Station would be unreachable to
-- literally everyone — including the owner and the platform admin — unless their
-- bypass sits OUTSIDE that gate. This is the same fix Task 3's review made to
-- find_member_by_identifier (Important 2, 0033_member_dedup.sql), applied here for
-- the same reason: owner and platform admin are admitted explicitly, outside the
-- per-link has_permission check, so a Member whose only Station has been archived is
-- not a permanent dead end for the one Organization that can still resolve it.
--
-- SECURITY INVOKER, EXECUTE granted to nobody — reachable only from inside a
-- SECURITY DEFINER body, where it runs with that body's already-elevated privileges.
-- Same convention as apply_inventory_movement (0027_inventory_rpcs.sql).
create or replace function public.member_reachable(
  p_member_id       uuid,
  p_organization_id uuid,
  p_permission      text
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select
    public.is_platform_admin()
    or public.is_owner(p_organization_id)
    or exists (
      select 1
      from public.member_company_links l
      where l.member_id = p_member_id
        and public.has_permission(p_permission, l.company_id)
    );
$$;

revoke execute on function public.member_reachable(uuid, uuid, text) from public;

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
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

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
       p_cpf_hash, p_cpf_last_digits, nullif(trim(coalesce(p_passport, '')), ''),
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
  'Registers a listener and links them to the Station it was called with — the other writer of member_company_links in this file is link_member_to_company, below. Gated on members.create. cpf_hash/cpf_last_digits are expected pre-hashed by the caller (Task 6, Node) — this function neither hashes nor validates the raw CPF, and the column CHECK on cpf_hash (0031) refuses anything that is not already a 64-hex digest. A duplicate phone/e-mail/CPF/passport within the Organization is refused with 23505; find_member_by_identifier (0033) is the friendly pre-submission check, this is the backstop. Audit detail carries member_id only.';

-- Wholesale replacement of a listener's own fields (same convention as update_role,
-- update_prize) — every field is set on every call, not merged. Deliberately does
-- NOT record a before/after diff the way update_role/update_prize do: their diffs are
-- role names and prize fields, neither personal; a Member's diff would be exactly the
-- name/phone/e-mail/CPF/address this whole block exists to keep out of audit_logs.
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
           cpf_hash            = p_cpf_hash,
           cpf_last_digits     = p_cpf_last_digits,
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
  'Replaces a listener''s own fields wholesale. Gated on members.edit, checked via member_reachable (any Station the listener is linked to) since this function takes no company_id. The UPDATE''s own WHERE clause re-checks anonymized_at is null (and deleted_at is null) atomically with the write, refusing with 22023 rather than risk a read-then-write race silently re-planting personal data onto a row anonymize_member just erased. Audit detail carries member_id only — no before/after diff, unlike update_role/update_prize, because a Member''s diff IS the personal data.';

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

  if not exists (
    select 1 from public.companies
    where id = p_company_id and organization_id = v_org and deleted_at is null
  ) then
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
  'Adds a Station to a listener''s reach without touching their identity fields. Gated on members.create at the Station being linked. A pair already linked is refused with 23505 rather than silently succeeding a second time. Audit detail carries member_id only.';

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
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  -- The link's own composite foreign keys (member_links_member_org_fk,
  -- member_links_company_org_fk, 0031) already guarantee that if this row exists,
  -- company_id belongs to the same Organization as the listener — no separate
  -- companies lookup is needed to prove that.
  if not exists (
    select 1 from public.member_company_links l
    where l.member_id = p_member_id and l.company_id = p_company_id
  ) then
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
  'Appends a consent row (0032) — a withdrawal is granted = false as a NEW row, never an edit. Requires the listener already be linked to the Station (member_company_links); gated on members.edit at that Station. Audit detail carries member_id and the new consent''s own id only — consent_type and origin are deliberately left out, not because either is personal, but to keep every one of the nine audit shapes in this file to the same narrow member_id-plus-own-id pattern rather than inventing a wider one with no product need behind it yet.';

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
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.member_company_links l
    where l.member_id = p_member_id and l.company_id = p_company_id
  ) then
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
  'Appends a free-text note (0032), scoped to the Station that wrote it. Requires the listener already be linked to that Station; gated on members.edit. The note body is personal by nature and never reaches audit_logs — detail carries member_id and the new note''s own id, never its text.';

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
  select organization_id into v_org
  from public.members
  where id = p_member_id and deleted_at is null;

  if not found then
    raise exception 'listener not found: %', p_member_id using errcode = 'P0002';
  end if;

  if p_company_id is null then
    if not public.has_org_permission('members.block', v_org) then
      raise log 'block_member denied: actor=% member=% org=%', v_actor, p_member_id, v_org;
      raise exception 'permission denied: members.block required' using errcode = '42501';
    end if;
  else
    if not exists (
      select 1 from public.member_company_links l
      where l.member_id = p_member_id and l.company_id = p_company_id
    ) then
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
  'Appends a block row (0032): draw_ban or suspension, Organization-wide when company_id is null or scoped to one Station. Organization-wide is gated on has_org_permission(''members.block''); Station-scoped requires the listener already be linked there and is gated on has_permission(''members.block'', company_id). Reason is mandatory and free text, and — like a note''s body — never reaches audit_logs: detail carries member_id and the new block''s own id only.';

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

-- Erasure that survives an immutable audit trail (spec §7). The row stays so
-- participations and deliveries still reference something; the person does not.
create or replace function public.anonymize_member(
  p_member_id uuid,
  p_reason    text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor  uuid := auth.uid();
  v_org    uuid;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
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

  if v_reason is null then
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

  -- The audit entry names the event, the actor and the reason, and no erased value.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, detail)
  values
    (v_actor, 'anonymize_member', 'members', p_member_id, v_org,
     jsonb_build_object('member_id', p_member_id, 'reason', v_reason));
end;
$$;

comment on function public.anonymize_member(uuid, text) is
  'LGPD erasure. Nulls every identifying column (name, phone, e-mail, CPF hash and last digits, passport, birth date, full address, discovery source, first_contact_origin) and sets anonymized_at; the row and its id survive so participations and deliveries still reference something. phone_normalized/email_normalized are GENERATED ALWAYS from phone/email (0031) and clear automatically when the sources are nulled — verified against a live database, see the Task 4 report. Gated on members.erase, checked via member_reachable. The UPDATE''s own WHERE clause (anonymized_at is null) makes a double-erase a clean, atomic refusal (P0002) rather than a second no-op success. Audit detail carries member_id and the operator''s stated reason — no erased value, ever.';

revoke execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) from public;
revoke execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text) from public;
revoke execute on function public.link_member_to_company(uuid, uuid) from public;
revoke execute on function public.archive_member(uuid) from public;
revoke execute on function public.record_member_consent(uuid, uuid, public.member_consent_type, boolean, text, uuid) from public;
revoke execute on function public.add_member_note(uuid, uuid, text) from public;
revoke execute on function public.block_member(uuid, public.member_block_kind, text, uuid, timestamptz) from public;
revoke execute on function public.lift_member_block(uuid, text) from public;
revoke execute on function public.anonymize_member(uuid, text) from public;

grant execute on function public.create_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text, timestamptz, text) to authenticated;
grant execute on function public.update_member(uuid, text, text, text, text, text, text, date, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.link_member_to_company(uuid, uuid) to authenticated;
grant execute on function public.archive_member(uuid) to authenticated;
grant execute on function public.record_member_consent(uuid, uuid, public.member_consent_type, boolean, text, uuid) to authenticated;
grant execute on function public.add_member_note(uuid, uuid, text) to authenticated;
grant execute on function public.block_member(uuid, public.member_block_kind, text, uuid, timestamptz) to authenticated;
grant execute on function public.lift_member_block(uuid, text) to authenticated;
grant execute on function public.anonymize_member(uuid, text) to authenticated;
