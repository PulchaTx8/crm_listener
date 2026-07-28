-- supabase/migrations/0030_inventory_adjustment_semantics.sql

-- Branch-level review, Critical: adjust_stock (0027) reconciled ONLY the
-- `available` bucket against p_counted, but adjustment-form.tsx already tells
-- the operator to count "what is actually on the shelf right now" — and the
-- design spec (§4) puts `reserved` INSIDE the physical total: a reservation
-- commits units, it does not remove them from the Station. So with
-- available = 40, reserved = 10, an operator who correctly counted the whole
-- shelf (50) got available = 50 - 40 = +10 recorded as an ADJUSTMENT_POSITIVE
-- — ten units invented that were never missing, reachable the moment
-- reserve_stock has been used even once, and invisible to reconcile_inventory
-- because the ledger row and the projection agree with each other; only the
-- physical count outside the system disagrees, and the system had no way to
-- hear that.
--
-- Fixed at the RPC, not the form: p_counted is now the PHYSICAL count.
-- `committed` is read under the same balance-row lock as everything else in
-- this function: reserved + linked + awaiting_pickup + pending_return. The
-- new available is p_counted - committed, and the movement recorded is the
-- difference between that and the current available. A count below what is
-- already committed is refused — that state means fewer physical units exist
-- than are already promised elsewhere, which an adjustment cannot express;
-- only a person resolving where the committed units went can.

-- ---------------------------------------------------------------------------
-- Shared bootstrap for inventory_balances. apply_inventory_movement and
-- adjust_stock each used to carry their own copy of the identical
-- ON CONFLICT DO NOTHING insert — benign (the row is all zeros, no figure
-- moves), but 0026's table comment, 0029's own comment and the spec's risk
-- register (§16, risk 1) all state "apply_inventory_movement is the single
-- writer of inventory_balances" as an absolute, and a future auditor grepping
-- for writers found two. Consolidating the INSERT into one function that both
-- call is the code fix for that, rather than a third comment repeating a
-- claim the code no longer quite makes: a property this project keeps saying
-- should be enforced by a grant, not a comment, deserves the same discipline
-- applied to itself. SECURITY INVOKER, EXECUTE granted to nobody — the same
-- shape apply_inventory_movement's own comment describes for itself, reachable
-- only from inside a SECURITY DEFINER body that already holds the table
-- owner's privileges.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_inventory_balance_row(
  p_company_id uuid,
  p_prize_id   uuid,
  p_org        uuid
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.inventory_balances (company_id, prize_id, organization_id)
  values (p_company_id, p_prize_id, p_org)
  on conflict (company_id, prize_id) do nothing;
end;
$$;

revoke execute on function public.ensure_inventory_balance_row(uuid, uuid, uuid) from public;

comment on function public.ensure_inventory_balance_row(uuid, uuid, uuid) is
  'The only INSERT statement against inventory_balances anywhere in the schema. Creates an all-zero (company, prize) row the first time it is touched, so apply_inventory_movement and adjust_stock do not each carry their own copy of the same ON CONFLICT DO NOTHING bootstrap. SECURITY INVOKER, EXECUTE granted to nobody — only reachable from inside a SECURITY DEFINER body, where it runs with that body''s privileges, the same shape apply_inventory_movement (0027) uses for itself. Every arithmetic UPDATE against this table still happens exclusively inside apply_inventory_movement.';

-- ---------------------------------------------------------------------------
-- apply_inventory_movement, re-declared to call the shared bootstrap above.
-- No other change: the locking, the replay detection, the sufficiency check
-- and the audit write are all identical to 0027's version.
-- ---------------------------------------------------------------------------
create or replace function public.apply_inventory_movement(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_type            public.inventory_movement_type,
  p_quantity        integer,
  p_from            public.inventory_bucket,
  p_to              public.inventory_bucket,
  p_note            text,
  p_idempotency_key text
)
returns uuid
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_actor    uuid := auth.uid();
  v_org      uuid;
  v_id       uuid;
  v_current  integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be a positive whole number' using errcode = '22023';
  end if;

  -- The prize must be live and belong to this Station. The composite foreign key
  -- proves the Station; it cannot see deleted_at, because it references a
  -- non-partial constraint — a foreign key cannot reference a partial index.
  -- FOR SHARE holds this row against archive_prize's FOR UPDATE on the same
  -- prize. archive_prize's own guard reads inventory_balances, which does not
  -- exist yet for a prize's first-ever movement — locking a row that is not
  -- there locks nothing — so without a lock on the prize itself, a movement
  -- could read the prize as live here, archive_prize could see zero stock and
  -- archive it, and this call could still go on to write stock onto a prize
  -- that is now archived. This lock, plus archive_prize's, closes that
  -- regardless of whether a balance row exists.
  select organization_id into v_org
  from public.prizes
  where id = p_prize_id and company_id = p_company_id and deleted_at is null
    for share;

  if not found then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this is the prize's first movement, then lock it.
  -- Shared with adjust_stock (0030) so there is exactly one INSERT statement
  -- against this table anywhere in the schema — see
  -- ensure_inventory_balance_row's own comment.
  perform public.ensure_inventory_balance_row(p_company_id, p_prize_id, v_org);

  perform 1 from public.inventory_balances
   where company_id = p_company_id and prize_id = p_prize_id
     for update;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor)
  on conflict (company_id, idempotency_key) where idempotency_key is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    -- A replay. Return the original movement and touch nothing else: the balance
    -- already reflects it.
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if v_id is null then
      raise exception 'movement could not be recorded' using errcode = 'XX000';
    end if;
    return v_id;
  end if;

  -- Source sufficiency. The CHECK constraints would also refuse this, but
  -- they would refuse it with a constraint name; the caller deserves the number.
  if p_from is not null then
    execute format('select %I from public.inventory_balances where company_id = $1 and prize_id = $2', p_from)
      into v_current using p_company_id, p_prize_id;

    -- The bootstrap insert above guarantees the row exists, so this is never
    -- actually NULL today — but that guarantee is implicit, and NULL < integer
    -- is NULL, not true, which would let the sufficiency check below fall
    -- through silently and the subsequent UPDATE touch zero rows: a movement
    -- recorded in the ledger that never reached the projection.
    v_current := coalesce(v_current, 0);

    if v_current < p_quantity then
      raise exception 'only % unit(s) are in %, and % were requested', v_current, p_from, p_quantity
        using errcode = '23514';
    end if;

    execute format(
      'update public.inventory_balances set %I = %I - $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_from, p_from
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  if p_to is not null then
    execute format(
      'update public.inventory_balances set %I = %I + $1, updated_at = now() where company_id = $2 and prize_id = $3',
      p_to, p_to
    ) using p_quantity, p_company_id, p_prize_id;
  end if;

  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to));

  return v_id;
end;
$$;

-- create or replace function does not restate a role's EXECUTE grant, but it
-- DOES reset the function to LANGUAGE-default SECURITY INVOKER and re-grant
-- nothing to PUBLIC beyond the default — 0027's own revoke already stripped
-- PUBLIC's implicit grant, and nothing here re-adds it, so restating the
-- revoke is defensive rather than load-bearing. Restated anyway so this
-- migration is self-contained and does not rely on 0027 having run first
-- doing the right thing silently.
revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text) from public;

comment on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text) is
  'Private ledger mechanics shared by every movement RPC: locks the balance row (its bootstrap now shared with adjust_stock via ensure_inventory_balance_row, 0030), appends the movement (a replay is detected via ON CONFLICT on the partial unique index over (company_id, idempotency_key) and returns the original movement with the balance untouched), moves the buckets, and writes the audit row. SECURITY INVOKER, EXECUTE granted to nobody — only reachable from inside a SECURITY DEFINER body, where it runs with that body''s privileges. Idempotency keys are scoped to the Station (company_id), not to a prize: a client that reuses a key such as "retry-1" across two different prizes in the same Station will silently get the first prize''s movement back on the second call. Takes FOR SHARE on the prize row; archive_prize takes FOR UPDATE on that same row before it counts physical stock — this is what stops a movement and an archival interleaving into stranded stock when the prize has no balance row yet.';

-- ---------------------------------------------------------------------------
-- adjust_stock, rewritten to reconcile the PHYSICAL count rather than
-- `available` alone. p_counted now means everything on the shelf: available,
-- reserved, linked, awaiting_pickup and pending_return together (design spec
-- §4's own equation). committed = reserved + linked + awaiting_pickup +
-- pending_return, read under the same balance-row lock as available. The new
-- available is p_counted - committed; the movement recorded is the
-- difference between that and the current available. Asking for "free to
-- promise" (i.e. available alone) instead would make the operator subtract
-- the committed units in their head before typing a number — reintroducing
-- exactly the sign-inversion risk the design already rejected once for the
-- available/delta question.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_stock(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_counted         integer,
  p_note            text,
  p_idempotency_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor         uuid := auth.uid();
  v_org           uuid;
  v_note          text := nullif(trim(coalesce(p_note, '')), '');
  v_available     integer;
  v_committed     integer;
  v_new_available integer;
  v_delta         integer;
  v_id            uuid;
begin
  select organization_id into v_org
  from public.companies
  where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.adjust', p_company_id) then
    raise log 'adjust_stock denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.adjust required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to adjust stock' using errcode = '22023';
  end if;

  if p_counted is null or p_counted < 0 then
    raise exception 'the counted figure must be zero or a positive whole number' using errcode = '22023';
  end if;

  -- inventory_balances' foreign key to prizes would refuse a bogus prize_id
  -- anyway, but with a constraint name rather than the message a caller can act
  -- on — same reasoning apply_inventory_movement gives for the sufficiency
  -- check below.
  if not exists (
    select 1 from public.prizes
    where id = p_prize_id and company_id = p_company_id and deleted_at is null
  ) then
    raise exception 'prize not found in this station: %', p_prize_id using errcode = 'P0002';
  end if;

  -- Create the balance row if this prize has never moved, then lock it — same
  -- reasoning as apply_inventory_movement: two concurrent first counts must not
  -- both see zero and race to decide the delta from it. Shared bootstrap with
  -- apply_inventory_movement (0030) — see ensure_inventory_balance_row's own
  -- comment.
  perform public.ensure_inventory_balance_row(p_company_id, p_prize_id, v_org);

  select available, reserved + linked + awaiting_pickup + pending_return
    into v_available, v_committed
  from public.inventory_balances
  where company_id = p_company_id and prize_id = p_prize_id
    for update;

  -- Check for a replay only now that the lock is held. A concurrent call for
  -- the same key holds this same lock for the whole of apply_inventory_movement
  -- (insert and balance update together), so once we have acquired it, that
  -- call's movement — if any — is already committed and visible here. This
  -- runs before the committed-figure refusal and the delta computation below,
  -- so a genuine replay short-circuits before either recomputes anything
  -- against today's (possibly different) figures.
  if p_idempotency_key is not null then
    select id into v_id
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if found then
      -- `available` now already reflects that earlier adjustment, so
      -- recomputing against today's figures would read a stale or zero delta
      -- and silently turn the replay into something other than what actually
      -- happened.
      return v_id;
    end if;
  end if;

  -- p_counted is the PHYSICAL count: everything on the shelf, reserved units
  -- included (spec §4 puts reserved inside the physical total — a
  -- reservation commits units, it does not remove them). Fewer physical
  -- units than are already committed elsewhere is not a state a stock
  -- adjustment can express: something else is wrong (a reservation for units
  -- that never really existed, a miscount, a theft) and a person has to
  -- resolve it before this number can be corrected here.
  if p_counted < v_committed then
    raise exception
      'counted total % is less than the % unit(s) already committed (reserved, linked, awaiting pickup or pending return); a stock adjustment cannot record fewer physical units than are already promised',
      p_counted, v_committed
      using errcode = '23514';
  end if;

  v_new_available := p_counted - v_committed;
  v_delta := v_new_available - v_available;

  -- Counted matches booked: nothing happened, and an adjustment of zero is not
  -- an event worth a ledger row.
  if v_delta = 0 then
    return null;
  end if;

  if v_delta > 0 then
    return public.apply_inventory_movement(
      p_company_id, p_prize_id, 'ADJUSTMENT_POSITIVE', v_delta, null, 'available', v_note, p_idempotency_key
    );
  else
    return public.apply_inventory_movement(
      p_company_id, p_prize_id, 'ADJUSTMENT_NEGATIVE', -v_delta, 'available', null, v_note, p_idempotency_key
    );
  end if;
end;
$$;

revoke execute on function public.adjust_stock(uuid, uuid, integer, text, text) from public;
grant execute on function public.adjust_stock(uuid, uuid, integer, text, text) to authenticated;

comment on function public.adjust_stock(uuid, uuid, integer, text, text) is
  'Reconciles the PHYSICAL count to what is actually on the shelf — not just available. p_counted is available + reserved + linked + awaiting_pickup + pending_return together (design spec §4: a reservation commits units, it does not remove them from the Station). Gated on inventory.adjust. Reads available and committed (reserved + linked + awaiting_pickup + pending_return) under the balance row''s own lock; refuses with 23514, naming both figures, if the count is below what is already committed — fewer physical units than are already promised is not a state an adjustment can express. Otherwise derives new_available = p_counted - committed and records ADJUSTMENT_POSITIVE/ADJUSTMENT_NEGATIVE of the difference against the current available. A NULL return is a well-defined success meaning the physical count matched what was booked and nothing was recorded — every failure path raises, so NULL never means an error. Because a zero-delta count records nothing, its idempotency_key is never persisted, so that one call is not a guaranteed replay: if the balance changes between an original zero-delta call and a retry with the same key, the retry recomputes against the new figures instead of reproducing the original (non-)result. Accepted as an open item — quantity > 0 makes a zero-quantity ledger row unrepresentable, the window is narrow, and the operator''s mandatory note keeps the outcome auditable either way. A genuine non-zero replay IS handled correctly: the idempotency check runs immediately after the balance lock, before either the committed-figure refusal or the delta computation.';

-- The table comment (0026) claimed a single writer in prose; restating it
-- here names the actual mechanism now that the bootstrap moved into its own
-- function, so the claim stays true rather than merely repeated.
comment on table public.inventory_balances is
  'Projection of the ledger per (Station, prize). The only INSERT against this table anywhere in the schema is the shared bootstrap in ensure_inventory_balance_row (0030), called from apply_inventory_movement and adjust_stock, both SECURITY DEFINER; every arithmetic UPDATE is written only by apply_inventory_movement, inside the transaction that appends the movement.';
