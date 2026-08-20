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
-- IT EXISTS BECAUSE 0254 STOPS SENDING THE NUMBER TO THE BROWSER. Four digits
-- travel with the list; the rest is asked for. Without the narrowing this door
-- would be a lock on a door standing in an open field.

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
  -- Station this listener is linked to. That is the same reach
  -- members_select_reachable (0035) already grants for reading the row, so this
  -- door widens nobody: it discloses one column of a row the caller could
  -- already select.
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
           else concat_ws(', ',
                  nullif(btrim(coalesce(m.address_line, '')), ''),
                  nullif(btrim(coalesce(m.address_number, '')), ''),
                  nullif(btrim(coalesce(m.address_complement, '')), ''))
         end
    into v_value
    from public.members m
   where m.id = p_member_id and m.anonymized_at is null
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
  'Returns one whole value -- phone, email, passport or the postal address as one string -- for one listener, and writes an audit row for the asking. Exists because 0254 stops sending the telephone number to the browser with the pickups and participations lists (Block 30a D1); four digits travel, and the rest is asked for. Gated on members.view at any Station the listener is linked to, which is the reach members_select_reachable (0035) already grants for the row itself, so this door discloses a column of a row the caller could already select rather than widening anybody. The field name is checked against a closed list, because a door that selects a column named by its argument selects any column. Null for a listener who has exercised erasure, and null for a field with nothing in it; the audit row is written either way.';

revoke execute on function public.reveal_member_field(uuid, text) from public;
grant execute on function public.reveal_member_field(uuid, text) to authenticated;
