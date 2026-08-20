-- supabase/migrations/0253_reveal_member_field.sql

-- Block 30a. One listener's whole telephone number, e-mail, passport or postal
-- address, one at a time, with an audit row for the asking.
--
-- THIS IS reveal_request_phone (0190) GENERALISED, and the generalisation is
-- the subject rather than the value: that door asks "may this caller read the
-- listener behind THIS REQUEST", and three screens now need "may this caller
-- read THIS LISTENER" with no request in hand. Every argument in 0190's header
-- holds here unchanged and is not restated; what IS restated below is the pair
-- of decisions this wider door has to make on its own -- which Station decides,
-- and which columns are namable.
--
-- IT EXISTS SO THE PICKUPS AND PARTICIPATIONS LISTS NEED NOT SEND THE WHOLE
-- NUMBER TO THE BROWSER. Four digits travel with the list; the rest is asked
-- for, one field at a time, through this door. 0254, in this same block, is
-- what narrows those lists -- a separate change, not yet this one; without it
-- this door is a lock on a door standing in an open field.

create function public.reveal_member_field(p_member_id uuid, p_field text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_value   text;
begin
  -- THE FIELD NAME IS CHECKED BEFORE ANYTHING ELSE, and it is checked against a
  -- closed list rather than interpolated. A door that selects a column named by
  -- its argument selects any column -- cpf_hash among them, which is the one
  -- value in this table that is hashed precisely so that nobody can read it.
  if p_field is null or p_field not in ('phone', 'email', 'passport', 'address') then
    raise exception 'unknown field: %', p_field using errcode = '22023';
  end if;

  -- WHICH STATION DECIDES. A listener belongs to an Organization and is LINKED
  -- to Stations (member_company_links, 0031), so there is no single company to
  -- ask about -- the question is whether the caller holds members.view at ANY
  -- Station this listener is linked to.
  --
  -- NARROWER THAN members_select_reachable (0035), DELIBERATELY. That policy
  -- calls member_reachable (0033): is_platform_admin() OR is_owner(org) OR
  -- exists(a link where has_permission holds) -- three arms. This door only
  -- ever evaluates the third. A platform admin or an owner whose only link to
  -- this listener runs through a suspended or archived Station can still
  -- SELECT the row under 0035 but gets 42501 here. That is a dead end, not a
  -- leak, so it is left as is rather than matched to 0035 arm for arm.
  --
  -- The company it settles on is also what stamps the audit row, which is why
  -- it is selected rather than merely tested with `exists`.
  select l.organization_id, l.company_id
    into v_org, v_company
    from public.member_company_links l
   where l.member_id = p_member_id
     and public.has_permission('members.view', l.company_id)
   order by l.linked_at
   limit 1;

  if v_company is null then
    raise log 'reveal_member_field denied: actor=% member=% field=%', v_actor, p_member_id, p_field;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- FOR SHARE, NOT A BARE READ, and 0190 argues this in full one door over:
  -- anonymize_member (0034) erases through a plain UPDATE, which takes no lock
  -- an unlocked reader is obliged to respect under READ COMMITTED, so a
  -- disclosure racing an erasure could read the row a moment before the scrub
  -- commits and hand a human the live value anyway -- seen once, unseeable
  -- after, at the exact instant the erasure existed to prevent it.
  --
  -- FOR SHARE rather than FOR UPDATE: it conflicts with FOR UPDATE and nothing
  -- weaker, so it serialises against the erasure and against nothing else. Two
  -- operators revealing the same listener in the same instant never queue.
  select case p_field
           when 'phone'    then m.phone
           when 'email'    then m.email
           when 'passport' then m.passport
           -- ONE FACT, NOT THREE. A street, a number and a flat identify a
           -- household together; src/lib/members/mask.ts masks them as one row
           -- for the same reason. concat_ws skips nulls but not empty strings,
           -- so each part is nullif'd first -- otherwise a blank complement
           -- renders as a trailing ", ".
           when 'address'  then concat_ws(', ',
                  nullif(btrim(coalesce(m.address_line, '')), ''),
                  nullif(btrim(coalesce(m.address_number, '')), ''),
                  nullif(btrim(coalesce(m.address_complement, '')), ''))
           else null
         end
    into v_value
    from public.members m
   where m.id = p_member_id
     and m.anonymized_at is null
     and m.deleted_at is null
   for share;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reveal_member_field', 'members', p_member_id, v_org, v_company,
     jsonb_build_object('field', p_field));

  -- concat_ws returns '' rather than null when every part was null, and an
  -- empty string on screen is a revealed value that says nothing -- so the
  -- caller cannot tell "no address on file" from "revealed, and it is blank".
  return nullif(v_value, '');
end;
$$;

comment on function public.reveal_member_field(uuid, text) is
  'Returns one whole value -- phone, email, passport or the postal address as one string -- for one listener, and writes an audit row for the asking. Exists so the pickups and participations lists need not send the whole telephone number to the browser (Block 30a D1); four digits travel, and the rest is asked for one field at a time. 0254, in this same block, is what narrows those lists. Gated on members.view at an active Station the listener is linked to -- narrower than members_select_reachable (0035) on purpose, since it does not honour the platform-admin or owner arms of member_reachable (0033): a caller who could SELECT the row through one of those arms alone is refused here rather than disclosed to, which fails closed rather than open. The field name is checked against a closed list, because a door that selects a column named by its argument selects any column. Null for a listener who has exercised erasure or been archived, and null for a field with nothing in it; the audit row is written either way.';

revoke execute on function public.reveal_member_field(uuid, text) from public;
grant execute on function public.reveal_member_field(uuid, text) to authenticated;
