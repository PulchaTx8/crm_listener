-- supabase/migrations/0255_reveal_request_phone_excludes_archived.sql

-- The same leak, one door over. Block 30a's Task 2 review found that
-- reveal_member_field's (0253) locking select checked anonymized_at is null
-- but not deleted_at is null -- an archived listener's row still got resolved
-- and disclosed. reveal_request_phone (0190, Block 22) is that door's sibling,
-- built first and generalised into it, and it had the identical gap: its own
-- locking select below checked only anonymized_at.
--
-- members_select_reachable (0035_rls_members.sql:95-100) keeps deleted_at is
-- null OUTSIDE member_reachable's bypass -- its own comment states the rule:
-- an archived Member is "unselectable to everyone, owner included, the same
-- as every other soft-deleted row in this project." archive_member
-- (0034_member_rpcs.sql:376) sets deleted_at through a plain UPDATE; the
-- music_requests row this door is called with, and the member_company_links
-- row it resolves the Station from, both survive archiving untouched. So the
-- door still found a Station to authorise against and a phone to hand back,
-- for a listener the row-level policy itself has already made unselectable
-- to everyone in the building.
--
-- CREATE OR REPLACE, not DROP AND CREATE: the function still returns text, so
-- nothing about its result type changes and its ACL survives the replace --
-- contrast 0203, where a return-type change forced a drop. The body below is
-- 0190's LIVE definition (pg_get_functiondef, run against this branch's
-- database before this migration was written), with exactly one predicate
-- added to the locking select and one comment beside it naming the archived
-- case; the FOR SHARE reasoning itself is unchanged and not restated here.
--
-- Null for an archived listener, same as for an erased one, and the audit row
-- is still written either way -- somebody asked, and that is the fact being
-- recorded, whether or not there was anything left to disclose.

create or replace function public.reveal_request_phone(p_request_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor   uuid := auth.uid();
  v_org     uuid;
  v_company uuid;
  v_member  uuid;
  v_phone   text;
begin
  select organization_id, company_id, member_id
    into v_org, v_company, v_member
    from public.music_requests
   where id = p_request_id and deleted_at is null
     and public.has_permission('members.view', company_id);

  if v_company is null then
    raise log 'reveal_request_phone denied: actor=% request=%', v_actor, p_request_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  -- Null for a listener who has since exercised erasure: anonymize_member (0034)
  -- scrubs the number, and there is nothing to disclose. The audit row is still
  -- written -- somebody asked, and that is the fact being recorded.
  --
  -- Null for a listener who has since been archived, the same way and for the
  -- same reason: deleted_at is null is the predicate members_select_reachable
  -- (0035) itself gates SELECT on, outside member_reachable's bypass, and this
  -- door owes that row the same refusal RLS already gives it. See this file's
  -- header for the gap this closes.
  --
  -- FOR SHARE, NOT A BARE READ. anonymize_member (0034) erases through a plain
  -- UPDATE, which takes no lock a reader is obliged to respect; under READ
  -- COMMITTED an unlocked select is never blocked by one, so without this lock
  -- a disclosure racing an erasure could read the row a moment before the scrub
  -- commits and hand a human the live number anyway -- seen once, unseeable
  -- after, at the exact instant the erasure existed to prevent it. 0107:77-84
  -- closed this identical race on this identical table for create_music_request,
  -- and its header argues the case in full; this is the same lock for the same
  -- reason one door over.
  --
  -- FOR SHARE, NOT FOR UPDATE: it conflicts with FOR UPDATE and nothing weaker,
  -- so it serialises against the erasure and against nothing else -- two people
  -- revealing the same listener's number in the same instant never queue behind
  -- each other, which matters on a door that runs once per click.
  select phone into v_phone
    from public.members
   where id = v_member and anonymized_at is null and deleted_at is null
   for share;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reveal_request_phone', 'music_requests', p_request_id, v_org, v_company,
     jsonb_build_object('member_id', v_member));

  return v_phone;
end;
$$;

comment on function public.reveal_request_phone(uuid) is
  'Returns one listener''s whole telephone number for one request, and writes an audit row for the asking. Exists because 0191 stops sending the number to the browser with the list (Block 22 D8) -- four digits travel, and the rest is asked for. Gated on members.view, the boundary 0107''s RULE 2 already draws. Null for a listener who has exercised erasure or been archived, and the audit row is written either way -- the archived case closed by 0255, the identical gap Block 30a''s Task 2 found and closed in this door''s sibling, reveal_member_field (0253).';
