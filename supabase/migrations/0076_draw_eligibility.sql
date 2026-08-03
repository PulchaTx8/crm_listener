-- Block 6a, Task 2: one definition of who is in the hat.
--
-- This file also does something no other migration in this block does: it
-- rewrites two functions Block 3 shipped. The reason, in full, because a
-- migration that edits merged code owes an argument.
--
-- The draw needs to know whether a listener is blocked. is_member_blocked
-- (0032, body superseded by 0036) already answers that -- but it answers a
-- LARGER question: it is SECURITY DEFINER and re-checks that its own caller is
-- the platform admin, the Organization's owner, or holds members.view, raising
-- 42501 otherwise. auth.uid() is read from the JWT claims and is unaffected by
-- run_draw being SECURITY DEFINER, so calling it from the draw would mean an
-- operator holding draws.execute and nothing else gets
--   ERROR: permission denied: members.view required
-- instead of a draw -- while the design spec 4.3 gates drawing on draws.execute
-- alone. It would also cost a member_reachable call PER PARTICIPATION, and
-- member_reachable runs a has_permission for every link the listener holds;
-- over a hat of thousands of entries that is thousands of those subtrees, a
-- cost 0036's own header comment already names for the batch case.
--
-- So the DOMAIN question is extracted here and the AUTHORIZATION question stays
-- where it was. member_block_active answers only "is there a live block on this
-- listener at this Station right now" -- no caller guard, no reachability term,
-- EXECUTE to nobody. is_member_blocked and members_blocked_bulk keep their
-- guards and their reachability terms and now read the predicate from here
-- instead of each carrying a copy of it, so the three-way duplication this
-- extraction would otherwise have created does not happen and the block rule
-- keeps exactly one home. Neither function changes what it answers; the
-- fixtures in 02_permissions.test.sql (the six-way bulk_block_probe and
-- single_block_probe, covering the Organization boundary, a Station-scoped
-- block at a different Station, and an unreachable listener) are what proves
-- that, and they are untouched.
--
-- Owner's ruling, 2026-08-02, when the implementation surfaced the coupling.

create function public.member_block_active(
  p_member_id       uuid,
  p_organization_id uuid,
  p_company_id      uuid
)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.member_blocks b
    where b.member_id = p_member_id
      and b.organization_id = p_organization_id
      and (b.company_id is null or b.company_id = p_company_id)
      and b.lifted_at is null
      and b.starts_at <= now()
      and (b.ends_at is null or b.ends_at > now())
  );
$$;

comment on function public.member_block_active(uuid, uuid, uuid) is
  'Whether a live block bars this Member at this Station right now: draw_ban or suspension, Station-scoped or Organization-wide, derived at read time from starts_at/ends_at/lifted_at. THE DOMAIN QUESTION ONLY -- no caller guard and no reachability term, which is why EXECUTE is granted to nobody. is_member_blocked and members_blocked_bulk (0036) are the public doors and keep their own three-arm guard and their member_reachable term on top of this; draw_eligible_participations reads it directly, because the draw checks draws.execute beside its own operation and must not also demand members.view of an operator the spec never asked to hold it (4.3).';

revoke execute on function public.member_block_active(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- The two public doors, now reading the predicate above. Same guards, same
-- reachability term, same answers -- the exists() sub-query each carried is
-- the only thing that moved.
--
-- Grants restated rather than left to CREATE OR REPLACE's silent ACL
-- preservation, per 0030's precedent and 0036's own practice.

create or replace function public.is_member_blocked(p_member_id uuid, p_company_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and public.is_owner(c.organization_id)
    )
    or public.has_permission('members.view', p_company_id)
  ) then
    raise log 'is_member_blocked denied: actor=% member=% company=%', auth.uid(), p_member_id, p_company_id;
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  select c.organization_id into v_organization_id
  from public.companies c
  where c.id = p_company_id;

  return public.member_reachable(p_member_id, v_organization_id, 'members.view')
     and public.member_block_active(p_member_id, v_organization_id, p_company_id);
end;
$$;

comment on function public.is_member_blocked(uuid, uuid) is
  'Whether an active block bars this Member at p_company_id right now, derived at read time from starts_at/ends_at/lifted_at rather than a maintained status column. Re-checks the caller is the platform admin, the owner of p_company_id''s Organization, or holds members.view at p_company_id — mirroring member_company_links_select_reachable''s own three arms (0035) exactly. Also requires that the caller can reach the Member at all (public.member_reachable, 0033), closing the cross-tenant oracle within the caller''s own Organization against a Member they hold no link to. THE BLOCK PREDICATE ITSELF now lives in public.member_block_active (0076) and is no longer written out here: this function is the authorization wrapper around it, and the Organization-scoping term the block query carries moved there with the rest of it. 0032''s own file, and 0036''s inline copy of the query, both describe a body that no longer runs.';

revoke execute on function public.is_member_blocked(uuid, uuid) from public;
grant execute on function public.is_member_blocked(uuid, uuid) to authenticated;

create or replace function public.members_blocked_bulk(
  p_member_ids uuid[],
  p_company_id uuid
)
returns table (member_id uuid, blocked boolean)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_organization_id uuid;
begin
  if not (
    public.is_platform_admin()
    or exists (
      select 1 from public.companies c
      where c.id = p_company_id and public.is_owner(c.organization_id)
    )
    or public.has_permission('members.view', p_company_id)
  ) then
    raise log 'members_blocked_bulk denied: actor=% company=% batch=%',
      auth.uid(), p_company_id, coalesce(array_length(p_member_ids, 1), 0);
    raise exception 'permission denied: members.view required' using errcode = '42501';
  end if;

  select c.organization_id into v_organization_id
  from public.companies c
  where c.id = p_company_id;

  return query
  select
    ids.id,
    public.member_reachable(ids.id, v_organization_id, 'members.view')
    and public.member_block_active(ids.id, v_organization_id, p_company_id)
  from unnest(p_member_ids) as ids(id);
end;
$$;

comment on function public.members_blocked_bulk(uuid[], uuid) is
  'Whether an active block bars each listed Member at p_company_id right now. The set-at-a-time form of is_member_blocked: same three-arm caller guard, checked once for the one Station the whole batch concerns, and the same member_reachable term per id. THE BLOCK PREDICATE ITSELF now lives in public.member_block_active (0076) — this function is the authorization wrapper around it, and 0036''s inline copy of the query no longer runs.';

revoke execute on function public.members_blocked_bulk(uuid[], uuid) from public;
grant execute on function public.members_blocked_bulk(uuid[], uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Who is in the hat (design spec 5).
--
-- One definition, read by run_draw and by nothing else. Every exclusion is
-- here rather than spread between this function and its caller, because an
-- excluded participation is NOT recorded in draw_entries: the hat is what was
-- drawn from, and a row that could never have been picked would make the
-- reproduction disagree.

create function public.draw_eligible_participations(p_promotion_id uuid)
returns table (participation_id uuid, member_id uuid, participated_at timestamptz)
language sql
stable
set search_path = pg_catalog, public
as $$
  select p.id, p.member_id, p.participated_at
  from public.participations p
  join public.members m on m.id = p.member_id
  where p.promotion_id = p_promotion_id
    -- The other three statuses are records of an attempt, not entries.
    and p.status = 'VALID'
    and m.deleted_at is null
    and m.anonymized_at is null
    -- D6: draw_ban obviously, and suspension too, on the owner's ruling --
    -- somebody suspended is not eligible for anything. member_block_active is
    -- the one thing that answers this; what a block IS is not re-expressed here.
    and not public.member_block_active(m.id, p.organization_id, p.company_id)
    -- Block 6c, D4, revising 6a's D2: one person, one prize is per PROMOTION,
    -- not per draw. 6a enforced it inside the walk and with unique (draw_id,
    -- member_id), both of which stop at the edge of one draw -- so a second
    -- round could award the same listener again, which is not what "keep
    -- drawing over the others" means.
    --
    -- It lives HERE rather than in run_draw so that the list the operator sees
    -- and the hat the database accepts are the same set. Building only the
    -- first would need two definitions of who is eligible, which is the
    -- duplication this schema refuses everywhere else.
    --
    -- A CANCELLED draw's winner is eligible again: the draw was undone, so
    -- nothing was won. A winner whose prize was returned to stock or written
    -- off is NOT: they won, and what happened to the prize afterwards is a
    -- different fact about a different thing.
    and not exists (
      select 1
      from public.winners w
      join public.draws d2 on d2.id = w.draw_id
      where w.member_id = m.id
        and d2.promotion_id = p_promotion_id
        and d2.status <> 'CANCELLED'
    )
  -- The order Task 4 freezes as draw_entries.position (spec 4.1 step 1).
  order by p.participated_at, p.id;
$$;

comment on function public.draw_eligible_participations(uuid) is
  'Every participation eligible for a draw of this promotion, in the (participated_at, id) order run_draw freezes as draw_entries.position. ONE row per VALID participation and not per person (D1): somebody with three valid entries has three chances, which is what makes min_hours_between_entries and max_entries_per_member (Block 4) mean anything. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody, called only from run_draw, which checks draws.execute beside its own operation — the permission check stays out of here for the reason apply_participation (0054) gives.';

revoke execute on function public.draw_eligible_participations(uuid) from public;
