-- supabase/migrations/0033_member_dedup.sql

-- THE ONE PLACE IN THIS PROJECT THAT READS ACROSS THE VISIBILITY BOUNDARY BY DESIGN.
-- Everywhere else, a cross-tenant read is a defect; here it is the feature, which
-- makes it the thing to review hardest.
--
-- A Member is Organization-scoped but visibility is per Station. So when someone
-- registers a phone number that already exists at a Station they cannot reach, the
-- system must refuse the duplicate WITHOUT revealing who holds it.
--
-- Three answers, and only three:
--   none      — no Member in this Organization carries that identifier.
--   visible   — there is one, and the caller may see it: the id comes back.
--   elsewhere — there is one, and the caller may NOT see it: existence only.
--
-- The third leaks that SOMEBODY holds the identifier. That is unavoidable — any
-- system preventing duplicates across a boundary leaks the existence of what is on
-- the other side. What it must never leak is WHO: no id, no name, no Station name,
-- no count. The message says what to do next so the answer is a workflow, not a
-- dead end.
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
  v_phone   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email   text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_id      uuid;
  v_visible boolean;
begin
  -- The caller must hold members.view somewhere in this Organization. Without this
  -- the function is an Organization-wide existence oracle for anyone with a session.
  if not public.has_org_permission('members.view', p_organization_id) then
    raise log 'find_member_by_identifier denied: actor=% org=%', auth.uid(), p_organization_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  if v_phone is null and v_email is null and p_cpf_hash is null and p_passport is null then
    raise exception 'give at least one identifier to search by' using errcode = '22023';
  end if;

  select m.id into v_id
  from public.members m
  where m.organization_id = p_organization_id
    and m.deleted_at is null
    and (
         (v_phone     is not null and m.phone_normalized = v_phone)
      or (v_email     is not null and m.email_normalized = v_email)
      or (p_cpf_hash  is not null and m.cpf_hash = p_cpf_hash)
      or (p_passport  is not null and lower(m.passport) = lower(p_passport))
    )
  limit 1;

  if v_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;

  -- Can the caller reach any Station this Member is linked to?
  select exists (
    select 1
    from public.member_company_links l
    where l.member_id = v_id
      and public.has_permission('members.view', l.company_id)
  ) into v_visible;

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
