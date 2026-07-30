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
    -- What has been drawn does not come back: those units are in
    -- awaiting_pickup and belong to a winner.
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
-- cancel_promotion, recreated. Everything 0042 wrote is unchanged — the
-- FOR UPDATE, the reason, the already-cancelled refusal, the already-ended
-- refusal — and the return happens after the row is marked, so a failure
-- anywhere in it takes the cancellation with it.
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
  'Stops a promotion accepting entries before its end, and hands its prizes back (D1). Gated on promotions.cancel. Requires a reason, refuses a promotion already cancelled, and refuses one whose window has already closed — cancelling something already over would only mislabel it, and archiving is what returns that one''s prizes. Every unit still linked and not drawn goes back to available as its own PROMOTION_UNLINK carrying the cancellation as its note, in this transaction; what has been drawn stays where it is, because it belongs to a winner. The number returned is recorded on the audit row.';

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

  -- Before the row is filed away, not after: an archived promotion is one
  -- nobody will open again, and units still counted in its balance would be out
  -- of available with nothing on any screen pointing at them. A cancelled
  -- promotion has already been through this and its links are closed, so the
  -- helper finds nothing and returns 0 — which is why this is safe to run on
  -- every archival rather than only on the ones that skipped cancellation.
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
  'Soft-deletes a promotion, recording who did it, and hands its undrawn prizes back first. Gated on promotions.archive. Refused while the promotion is inside its window and not cancelled: archiving frees the hashtag for another promotion, and doing that while listeners are still texting it would hand their entries to the wrong promotion. Archiving MOVES STOCK, which it did not before Block 4b — an ended, never-cancelled promotion cannot be cancelled (cancel_promotion refuses one whose window has closed) and so had no other way to give its prizes back; the alternative was a new refusal that would have left the operator unlinking by hand first. A promotion already cancelled has nothing left to return.';

-- ---------------------------------------------------------------------------
-- The reachability of 0042's four RPCs, stated as a grant.
--
-- All four have held the default PUBLIC EXECUTE since 4a shipped: 0042 carries
-- exactly one revoke, on the private promotion_write_error helper, and none on
-- create_promotion, update_promotion, cancel_promotion or archive_promotion.
-- Postgres grants EXECUTE to PUBLIC on every newly created function, so anon
-- has been able to call all four all along. Nothing was reachable through them:
-- each resolves has_permission against auth.uid(), which is null for anon, so
-- the call raises 42501 before it touches a row. The hole is that the safety
-- rests entirely on the first `if` of each body — one refactor away from not
-- being safe — where every other write RPC in this project (0027, 0028, 0049,
-- and promotion_write_error one line away in 0042 itself) states its
-- reachability as a grant instead.
--
-- Closed now rather than later because this migration is what changes the
-- stakes: archive_promotion has just become an operation that MOVES STOCK. And
-- it had to be said here explicitly in any case — create or replace preserves
-- an existing ACL, so recreating those two functions above inherited the
-- PUBLIC grant rather than resetting it.
--
-- All four, not only the two recreated above. Leaving the identical gap open on
-- create_promotion and update_promotion because this migration happens not to
-- redefine them would read to the next person as a deliberate distinction, and
-- there is none. The precedent is 0029, which found the same class of hole late
-- — service_role keeping the default ACL's TRUNCATE on four tables nobody had
-- revoked it from — and closed it after somebody noticed. This is that lesson
-- applied on time.
--
-- authenticated only, and deliberately not service_role: services/promotions.ts
-- calls all four through a client carrying the caller's own access token, for
-- the reason its own comment gives — these functions resolve has_permission
-- against auth.uid(), so calling one with the service key would defeat the
-- check it exists to make. Same grid 0049 gave the two linking RPCs.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) from public;
revoke execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) from public;
revoke execute on function public.cancel_promotion(uuid, text)  from public;
revoke execute on function public.archive_promotion(uuid)       from public;

grant execute on function public.create_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) to authenticated;
grant execute on function public.update_promotion(uuid, text, timestamptz, timestamptz, integer, text, boolean, integer, boolean, boolean, text, boolean, text, text, text, public.promotion_requested_field[]) to authenticated;
grant execute on function public.cancel_promotion(uuid, text)   to authenticated;
grant execute on function public.archive_promotion(uuid)        to authenticated;
