-- supabase/migrations/0050_promotion_lifecycle_returns_prizes.sql
--
-- D1: a promotion that ends its life hands its undrawn prizes back, in the same
-- transaction. Without it a cancelled promotion strands them — out of
-- available, counted in the balance, inside a record nobody will open again.
--
-- The spec's §2 said this only needed to happen on cancellation, reasoning that
-- archiving already refuses while a promotion is accepting entries, so anything
-- archivable had been cancelled first. That is not what 0042 shipped:
-- archive_promotion refuses only INSIDE the window, and cancel_promotion
-- refuses a promotion that has already ENDED. An ended, never-cancelled
-- promotion was therefore archivable with prizes still linked — the exact
-- stranding D1 exists to prevent. The owner's decision was that archiving
-- should return the units itself rather than grow a new refusal, so archiving
-- stops being a pure record operation and becomes one that moves stock. That is
-- the trade, and it is stated in archive_promotion's own comment.
--
-- return_promotion_prizes lives HERE, not in 0049. 0045's comment on
-- promotion_prizes.deleted_at points at "(0049)" for it, and that pointer
-- predates the split of this block's RPCs across two migrations: 0049 shipped
-- linking and unlinking, and the lifecycle return moved here with the two
-- functions that call it. 0045 is committed and migrations are append-only, so
-- the correction is written down here rather than made there.
--
-- WHAT THIS LEAVES OPEN, for Block 6 to settle rather than discover. What has
-- been drawn does not come back, and after a cancellation those units sit in
-- the `linked` bucket on a promotion that is over, with no operation left that
-- can move them: unlink_prize_from_promotion refuses to go below `drawn`
-- (0049), cancelling again is refused, and nothing else in the schema touches
-- that bucket. They are not lost — the ledger and both projections agree about
-- them, and reconciliation stays clean — but they are stuck, and they stay
-- stuck until Block 6 brings the draw, the delivery and the returns that move
-- `linked` -> `awaiting_pickup` -> `delivered` or back to `available`. Whoever
-- writes those must decide what a drawn unit on a CANCELLED promotion means:
-- the winner was promised something the station then called off. That is a
-- product question, it is not answered here, and the shape of this helper does
-- not prejudge it — it simply refuses to take back what a winner was promised.

-- Shared by both, so the rule has one implementation and one set of tests.
-- SECURITY INVOKER with EXECUTE granted to nobody: only ever called from inside
-- a SECURITY DEFINER body, where it runs with that body's privileges — the
-- shape ensure_inventory_balance_row and promotion_write_error already use.
create or replace function public.return_promotion_prizes(
  p_promotion_id uuid,
  p_company_id   uuid,
  p_note         text
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_link  record;
  v_units integer := 0;
begin
  -- No row lock is taken here. Both callers already hold FOR UPDATE on the
  -- promotion row, and every link and unlink against that promotion is
  -- serialised behind that same lock (0049), so these rows cannot move under
  -- this loop. Ordered by id only so the ledger reads the same way twice for
  -- the same input, which makes a diff of two runs meaningful.
  for v_link in
    select l.id,
           l.prize_id,
           coalesce(b.linked, 0) as linked,
           coalesce(b.drawn, 0)  as drawn
    from public.promotion_prizes l
    left join public.promotion_prize_balances b on b.promotion_prize_id = l.id
    where l.promotion_id = p_promotion_id and l.deleted_at is null
    order by l.id
  loop
    -- What has been drawn does not come back: it belongs to a winner. Those
    -- units are still in the `linked` bucket today and will move to
    -- awaiting_pickup once Block 6 brings the draw that moves them — nothing
    -- writes `drawn` or touches awaiting_pickup before that block, which is why
    -- the only fixture that can produce a non-zero `drawn` writes the
    -- projection by hand. See this file's header for what that leaves stuck.
    if v_link.linked - v_link.drawn > 0 then
      perform public.apply_inventory_movement(
        p_company_id, v_link.prize_id, 'PROMOTION_UNLINK', v_link.linked - v_link.drawn,
        'linked', 'available', p_note, null, v_link.id);
      v_units := v_units + (v_link.linked - v_link.drawn);
    end if;

    -- Nothing drawn means nothing is left holding this link open, so it leaves
    -- the Prizes tab the same way an unlink to zero does. A link with drawn > 0
    -- stays: it still has to show Vinculados and Sorteados against each other.
    if v_link.drawn = 0 then
      update public.promotion_prizes
         set deleted_at = now(), updated_at = now()
       where id = v_link.id;
    end if;
  end loop;

  return v_units;
end;
$$;

revoke execute on function public.return_promotion_prizes(uuid, uuid, text) from public;

comment on function public.return_promotion_prizes(uuid, uuid, text) is
  'D1, shared by cancel_promotion and archive_promotion: appends one PROMOTION_UNLINK per live link for everything committed and not drawn, moving linked -> available, and closes each link that had nothing drawn. Returns the number of units handed back, which both callers record in their audit row. Takes no lock of its own — both callers hold FOR UPDATE on the promotion, and 0049 serialises every link and unlink behind that same lock. SECURITY INVOKER, EXECUTE granted to nobody.';

-- ---------------------------------------------------------------------------
-- WHAT THIS COSTS IN PERMISSIONS, which is a different question from what it
-- costs in behaviour and is not answered anywhere else.
--
-- promotions.prizes exists because linking moves stock, and 0045's own comment
-- gives the reason for its own code: "somebody who may reword a promotion is not
-- thereby somebody who may commit inventory to it." The two functions below are
-- the converse of that separation. cancel_promotion gates on promotions.cancel
-- alone and archive_promotion on promotions.archive alone, and each then calls
-- return_promotion_prizes, which moves units from `linked` back to `available`.
--
-- So a delegate holding promotions.view + promotions.archive and NOTHING ELSE —
-- no promotions.prizes, no inventory code at all — moves inventory. Same for
-- promotions.view + promotions.cancel. Those two codes now authorise a stock
-- movement, and an owner reading the permission screen has no way to tell:
-- nothing on it says "archive" or "cancel" touches the balance.
--
-- This is DELIBERATE and is not being changed here. The alternative is to
-- require promotions.prizes alongside, and that makes archiving a compound
-- permission nobody would guess from the screen and refuses the operation to
-- exactly the person whose job it is — an ended promotion nobody may archive is
-- an ended promotion whose prizes stay stranded, which is the state D1 exists to
-- end. It is written down here, in the code, so the next reader meets it as a
-- decision rather than as a discovery, and it is on the spec's open list as a
-- question for the owner. tests/isolation/promotion-prizes.test.ts drives it
-- under a delegate holding no promotions.prizes, so the reach is proved rather
-- than described.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- cancel_promotion, recreated. Everything 0042 wrote is unchanged — the
-- FOR UPDATE, the reason, the already-cancelled refusal, the already-ended
-- refusal — and the return is written after the UPDATE that marks the row so
-- that the body reads in the order the operation happens. The ordering is for
-- the reader and nothing else: the whole body is one transaction with no
-- exception handler, so a failure in the return takes the cancellation with it
-- whichever side of the mark it sits on, and nothing on the helper's path reads
-- cancelled_at.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_promotion(
  p_promotion_id uuid,
  p_reason       text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_cancelled timestamptz;
  v_ends      timestamptz;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_returned  integer;
begin
  -- FOR UPDATE before the "already cancelled" read, so two cancels racing
  -- cannot both pass that check and the second one loses rather than
  -- overwriting the first one's author and reason.
  select organization_id, company_id, cancelled_at, ends_at
    into v_org, v_company, v_cancelled, v_ends
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.cancel', v_company) then
    raise log 'cancel_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.cancel required' using errcode = '42501';
  end if;

  -- A cancellation nobody can explain later is a row that will be argued about.
  if v_reason is null then
    raise exception 'a reason is required to cancel a promotion' using errcode = '22023';
  end if;

  if v_cancelled is not null then
    raise exception 'this promotion is already cancelled' using errcode = '22023';
  end if;

  -- Cancelling something already over changes nothing and would only mislabel
  -- it: the list would read Cancelada for a promotion that ran its full course.
  if v_ends <= now() then
    raise exception 'this promotion has already ended; there is nothing to cancel'
      using errcode = '22023';
  end if;

  update public.promotions set
    cancelled_at        = now(),
    cancelled_by        = v_actor,
    cancellation_reason = v_reason,
    updated_at          = now()
  where id = p_promotion_id;

  -- D1. The cancellation is the note, so the ledger explains itself without
  -- anybody having to cross-reference the promotion to find out why six units
  -- came back on a Tuesday.
  v_returned := public.return_promotion_prizes(
    p_promotion_id, v_company, 'promotion cancelled: ' || v_reason);

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'cancel_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('reason', v_reason, 'units_returned', v_returned));
end;
$$;

comment on function public.cancel_promotion(uuid, text) is
  'Stops a promotion accepting entries before its end, and hands its prizes back (D1). Gated on promotions.cancel. Requires a reason, refuses a promotion already cancelled, and refuses one whose window has already closed — cancelling something already over would only mislabel it, and archiving is what returns that one''s prizes. Every unit still linked and not drawn goes back to available as its own PROMOTION_UNLINK carrying the cancellation as its note, in this transaction; what has been drawn stays where it is, because it belongs to a winner. The number returned is recorded on the audit row. Note what this means for permissions: promotions.cancel alone now authorises a stock movement — a delegate holding it and no promotions.prizes, and no inventory code at all, moves units back into available by cancelling. That is deliberate, and it is on the spec''s open list for the owner.';

-- ---------------------------------------------------------------------------
-- archive_promotion, recreated. Its refusal is unchanged; what is new is that
-- it returns the prizes before it files the record away.
-- ---------------------------------------------------------------------------
create or replace function public.archive_promotion(p_promotion_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_org       uuid;
  v_company   uuid;
  v_starts    timestamptz;
  v_ends      timestamptz;
  v_cancelled timestamptz;
  v_returned  integer;
begin
  select organization_id, company_id, starts_at, ends_at, cancelled_at
    into v_org, v_company, v_starts, v_ends, v_cancelled
  from public.promotions
  where id = p_promotion_id and deleted_at is null
    for update;

  if not found then
    raise exception 'promotion not found: %', p_promotion_id using errcode = 'P0002';
  end if;

  if not public.has_permission('promotions.archive', v_company) then
    raise log 'archive_promotion denied: actor=% promotion=%', v_actor, p_promotion_id;
    raise exception 'permission denied: promotions.archive required' using errcode = '42501';
  end if;

  -- The shape of archive_prize's own refusal: a record the audience can still
  -- reach is not a record to file away. Archiving frees the hashtag (the
  -- exclusion constraint in 0040 skips archived rows), so doing it mid-flight
  -- would let a second promotion claim a hashtag listeners are still texting.
  if v_cancelled is null and now() >= v_starts and now() < v_ends then
    raise exception 'this promotion is still accepting entries; cancel it before archiving'
      using errcode = '22023';
  end if;

  -- Why this happens AT ALL: an archived promotion is one nobody will open
  -- again, and units still counted in its balance would be out of available
  -- with nothing on any screen pointing at them. That it is written before the
  -- soft delete rather than after is readability, not correctness — the whole
  -- body is one transaction with no exception handler, and nothing on the
  -- helper's path reads promotions.deleted_at, so either order produces the
  -- same committed state or no state at all. A cancelled promotion has already
  -- been through this and its links are closed, so the helper finds nothing and
  -- returns 0 — which is why this is safe to run on every archival rather than
  -- only on the ones that skipped cancellation.
  v_returned := public.return_promotion_prizes(p_promotion_id, v_company, 'promotion archived');

  update public.promotions set
    deleted_at = now(),
    deleted_by = v_actor,
    updated_at = now()
  where id = p_promotion_id;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'archive_promotion', 'promotions', p_promotion_id, v_org, v_company,
     jsonb_build_object('units_returned', v_returned));
end;
$$;

comment on function public.archive_promotion(uuid) is
  'Soft-deletes a promotion, recording who did it, and hands its undrawn prizes back first. Gated on promotions.archive. Refused while the promotion is inside its window and not cancelled: archiving frees the hashtag for another promotion, and doing that while listeners are still texting it would hand their entries to the wrong promotion. Archiving MOVES STOCK, which it did not before Block 4b — an ended, never-cancelled promotion cannot be cancelled (cancel_promotion refuses one whose window has closed) and so had no other way to give its prizes back; the alternative was a new refusal that would have left the operator unlinking by hand first. A promotion already cancelled has nothing left to return. Note what this means for permissions: promotions.archive alone now authorises a stock movement — a delegate holding promotions.view and promotions.archive, with no promotions.prizes and no inventory code at all, moves units back into available by archiving. That is the converse of the separation promotions.prizes was created to make, it is deliberate, and it is on the spec''s open list for the owner.';

-- ---------------------------------------------------------------------------
-- The reachability of Block 4a's six promotion write RPCs, stated as a grant.
--
-- All six have held the default PUBLIC EXECUTE since 4a shipped. 0042 carries
-- exactly one revoke, on the private promotion_write_error helper, and none on
-- create_promotion, update_promotion, cancel_promotion or archive_promotion;
-- 0043 carries neither a revoke nor a grant, so save_promotion_question and
-- remove_promotion_question are in the same position. Postgres grants EXECUTE
-- to PUBLIC on every newly created function, so anon has been able to call all
-- six all along. Nothing was reachable through them: each resolves
-- has_permission against auth.uid(), which is null for anon, so the call raises
-- 42501 before it touches a row. The hole is that the safety rests entirely on
-- the first `if` of each body — one refactor away from not being safe — where
-- every other write RPC in this project (0027, 0028, 0049, and
-- promotion_write_error one line away in 0042 itself) states its reachability
-- as a grant instead.
--
-- Closed now rather than later because this migration is what changes the
-- stakes: archive_promotion has just become an operation that MOVES STOCK. And
-- it had to be said here explicitly in any case — create or replace preserves
-- an existing ACL, so recreating two of these functions above inherited the
-- PUBLIC grant rather than resetting it.
--
-- All six, not only the two recreated above, and not only 0042's four. Leaving
-- the identical gap open on any of them because this migration happens not to
-- redefine them would read to the next person as a deliberate distinction, and
-- there is none: same block, same feature, same fail-closed has_permission
-- gate. 0043's two were missed on the first pass at this exact argument, which
-- is itself the point — a sweep that stops one file short leaves a surface
-- that looks audited and is not. The precedent is 0029, which found the same
-- class of hole late — service_role keeping the default ACL's TRUNCATE on four
-- tables nobody had revoked it from — and closed it after somebody noticed.
-- This is that lesson applied on time.
--
-- authenticated only, and deliberately not service_role: services/promotions.ts
-- calls all six through a client carrying the caller's own access token, for
-- the reason its own comment gives — these functions resolve has_permission
-- against auth.uid(), so calling one with the service key would defeat the
-- check it exists to make. Same grid 0049 gave the two linking RPCs.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) from public;
revoke execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) from public;
revoke execute on function public.cancel_promotion(uuid, text)  from public;
revoke execute on function public.archive_promotion(uuid)       from public;
revoke execute on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) from public;
revoke execute on function public.remove_promotion_question(uuid) from public;

grant execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) to authenticated;
grant execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) to authenticated;
grant execute on function public.cancel_promotion(uuid, text)   to authenticated;
grant execute on function public.archive_promotion(uuid)        to authenticated;
grant execute on function public.save_promotion_question(uuid, public.promotion_question_kind, text, text, text, jsonb, uuid) to authenticated;
grant execute on function public.remove_promotion_question(uuid) to authenticated;
