-- supabase/migrations/0194_inventory_doors_widened.sql

-- Block 23, Task 2: apply_inventory_movement widened to carry Task 1's five
-- columns, and the four movement RPCs that reach it widened to let an
-- operator set them.
--
-- ---------------------------------------------------------------------------
-- A CORRECTION TO THIS TASK'S OWN BRIEF, MADE BEFORE WRITING A LINE OF THIS
-- FILE. The brief's Step 3 gives this drop statement for apply_inventory_movement:
--
--   drop function if exists public.apply_inventory_movement(
--     uuid, uuid, public.inventory_movement_type, integer,
--     public.inventory_bucket, public.inventory_bucket, text, text);
--
-- That is 0027's original eight-argument signature. It is not what is live.
-- 0047 (Block 4, "the second projection") already dropped that eight-argument
-- form and replaced it with a NINE-argument one, appending
-- p_promotion_prize_id uuid default null -- 0047's own header names this
-- exact trap: "create or replace cannot change a function's argument list: it
-- would create a second, nine-argument overload and leave the eight-argument
-- one in place... every eight-argument call is AMBIGUOUS... and raises 42725
-- at call time." Confirmed live, not assumed: `select p.oid::regprocedure
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace where
-- n.nspname = 'public' and p.proname = 'apply_inventory_movement'` against a
-- freshly `db:reset` database returns exactly one row, the nine-argument one.
-- Using the brief's eight-argument DROP IF EXISTS here would have found
-- nothing (silently -- IF EXISTS swallows a wrong signature the same way it
-- swallows a genuinely absent one), and a plain CREATE OR REPLACE for the
-- fourteen-argument function below would then have produced a THIRD,
-- coexisting overload -- the exact failure mode this task's own top-level
-- instructions warn about, reproduced by trusting a brief instead of the
-- database. The drop below targets the live nine-argument signature.
--
-- A SECOND correction, this one to the brief's guidance for the four doors.
-- The brief says record_stock_entry, record_stock_exit, reserve_stock and
-- release_reservation can each be `create or replace`d, since each only
-- appends new parameters with defaults. Tested directly against this
-- database before believing it:
--
--   create function zz_test.foo(a int, b text) returns text ...;
--   create or replace function zz_test.foo(a int, b text, c int default null) returns text ...;
--   select zz_test.foo(1, 'x'::text);
--   -- ERROR:  function zz_test.foo(integer, text) is not unique
--   -- HINT:  Could not choose a best candidate function.
--
-- CREATE OR REPLACE FUNCTION matches an existing function by its full
-- parameter type list, not by name alone and not by "ignoring the ones that
-- have defaults." Appending a parameter -- even a defaulted one -- always
-- produces a distinct catalog entry, never a true replacement. With both the
-- old and the new entry live, an old-arity call is not silently routed to the
-- stale function (which would at least be a known, named failure mode); it
-- becomes genuinely ambiguous and raises 42725 at every call site in
-- 04_promotion_prizes, 09_draws, 10_delivery, 11_filtered_hat,
-- 12_deadline_clock and 12b_deadline_sweep. This is exactly what 0047's own
-- header already documented for apply_inventory_movement and what 0077's
-- header names as the reason `create or replace` was safe there ("the
-- argument list is the same, so 0047's reason for dropping... does not
-- apply"). The rule is general, not specific to one function, so it is
-- applied here to all five: every function in this file is DROPPED and
-- recreated, none merely replaced. The four doors' DROP statements omit IF
-- EXISTS on purpose, for the same reason as apply_inventory_movement's: a
-- wrong signature should fail this migration loudly at db:reset, not vanish
-- into a silent no-op that leaves an overload behind.
-- ---------------------------------------------------------------------------

-- apply_inventory_movement, recreated from the LIVE body (dumped with
-- pg_get_functiondef against a freshly `db:reset` database, per this task's
-- own instructions and 0195's header elsewhere in this block for the
-- identical discipline against list_movements) -- not from 0027's, 0030's,
-- 0047's or 0077's text. The live body has drifted from all four: it now
-- shares its balance-row bootstrap with adjust_stock through
-- ensure_inventory_balance_row (0030), and it also locks and projects
-- promotion_prize_balances when a movement names a promotion_prize_id (0047,
-- 0077). None of that machinery is touched here. The five new parameters are
-- appended after the nine that already exist, all defaulted to null, and
-- threaded into the one INSERT this function makes -- nothing else changes.
drop function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer,
  public.inventory_bucket, public.inventory_bucket, text, text, uuid);

create function public.apply_inventory_movement(
  p_company_id         uuid,
  p_prize_id           uuid,
  p_type               public.inventory_movement_type,
  p_quantity           integer,
  p_from               public.inventory_bucket,
  p_to                 public.inventory_bucket,
  p_note               text,
  p_idempotency_key    text,
  p_promotion_prize_id uuid default null,
  p_invoice_number     text default null,
  p_unit_amount        numeric default null,
  p_total_amount       numeric default null,
  p_show_id            uuid default null,
  p_reverses           uuid default null
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

  -- Taken here — immediately after the FOR UPDATE on inventory_balances and
  -- before the movement is appended — rather than beside the arithmetic below,
  -- so the lock order is the same for every caller; a replay that returns early
  -- will have bootstrapped an all-zero row and written nothing to it, which is
  -- exactly what ensure_inventory_balance_row already does on the same path.
  if p_promotion_prize_id is not null then
    perform public.ensure_promotion_prize_balance_row(
      p_promotion_prize_id, p_prize_id, p_company_id, v_org);

    perform 1 from public.promotion_prize_balances
     where promotion_prize_id = p_promotion_prize_id
       for update;
  end if;

  -- Append first, so a replay is decided before anything is moved. ON CONFLICT
  -- on the idempotency index returns no row, which is how we know.
  --
  -- promotion_prize_id travels on the movement itself, so the ledger — not only
  -- the projection — records which link the units moved under, and
  -- reconcile_inventory (0048) can rebuild one from the other.
  -- inventory_movements_promotion_reference (0045, widened in 0077) is what
  -- refuses the two ways that can be wrong: a link or draw movement naming no
  -- promotion, and any other movement type naming one.
  --
  -- Block 23, Task 2: the same reasoning now covers invoice_number,
  -- unit_amount, total_amount (entries only), reserved_for_show_id
  -- (reservations only) and reverses_movement_id (reversals and releases
  -- only) — inventory_movements_invoice_reference, _show_reference and
  -- _reversal_reference (0193) are what refuse a movement writing one of these
  -- outside the kind it belongs to.
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, note, idempotency_key, actor_id, promotion_prize_id,
     invoice_number, unit_amount, total_amount, reserved_for_show_id, reverses_movement_id)
  values
    (v_org, p_company_id, p_prize_id, p_type, p_quantity,
     p_from, p_to, nullif(trim(coalesce(p_note, '')), ''), p_idempotency_key, v_actor,
     p_promotion_prize_id,
     nullif(trim(coalesce(p_invoice_number, '')), ''), p_unit_amount, p_total_amount,
     p_show_id, p_reverses)
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

  -- This reads movement_type, which the bucket arithmetic above deliberately
  -- does not. The reasoning, and the tripwire for an unknown type, now live in
  -- project_promotion_prize_movement (0077).
  if p_promotion_prize_id is not null then
    perform public.project_promotion_prize_movement(p_promotion_prize_id, p_type, p_quantity);
  end if;

  -- The detail gains promotion_prize_id as a final key rather than omitting it
  -- when there is none: it is null on every movement that names no promotion,
  -- so every row Block 2 already writes keeps the same shape and the audit log
  -- stays readable by one query instead of two.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'inventory_movement', 'inventory_movements', v_id, v_org, p_company_id,
     jsonb_build_object('prize_id', p_prize_id, 'type', p_type, 'quantity', p_quantity,
                        'from', p_from, 'to', p_to,
                        'promotion_prize_id', p_promotion_prize_id));

  return v_id;
end;
$$;

-- This is a plain create, and a newly created function carries the default
-- EXECUTE grant to PUBLIC — without this line every role in the database
-- could call the ledger's single writer directly and bypass every permission
-- check the movement RPCs make. No grant to authenticated follows: this
-- function is SECURITY INVOKER and reachable only from inside a SECURITY
-- DEFINER body, where it runs with that body's privileges — the same shape
-- 0027 and 0047 both established and this migration does not change.
revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid, text, numeric, numeric, uuid, uuid) from public;

comment on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, public.inventory_bucket, public.inventory_bucket, text, text, uuid, text, numeric, numeric, uuid, uuid) is
  'Private ledger mechanics shared by every movement RPC: locks the balance row (bootstrap shared with adjust_stock via ensure_inventory_balance_row, 0030), locks the per-promotion balance row when the movement names one, appends the movement (a replay is detected via ON CONFLICT on the partial unique index over (company_id, idempotency_key)), moves the buckets, moves the per-promotion figure, and writes the audit row. Block 23, Task 2 appended five parameters — p_invoice_number, p_unit_amount, p_total_amount, p_show_id, p_reverses — after the nine that already existed, all defaulted to null and threaded straight into the INSERT; 0193''s own CHECK constraints, not this function, refuse each one on the movement kinds it does not belong to. Dropped and recreated rather than replaced, exactly as 0047 was: CREATE OR REPLACE cannot change an argument list without leaving the prior arity as a second, ambiguous overload. SECURITY INVOKER, EXECUTE granted to nobody.';

-- ---------------------------------------------------------------------------
-- The four doors. record_stock_entry and reserve_stock's histories show
-- their live bodies have never drifted from 0027's text (checked the same way
-- as apply_inventory_movement, with pg_get_functiondef against a freshly
-- reset database) — 0027 is the only migration that has ever touched any of
-- the four. Each is dropped and recreated for the reason given at the top of
-- this file.
-- ---------------------------------------------------------------------------

drop function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text);

-- Restricted to the four entry kinds; DRAW, DELIVERY and the rest move through
-- their own Blocks and must not become reachable by handing this function a
-- different label for the same shape of movement. This refusal already
-- existed before this task (0027) — checked directly against the live body
-- before writing this file — so the only change here is widening the allowed
-- list to include BARTER_ENTRY (design D4): without it, a Permuta entry would
-- fall through to the 22023 refusal below rather than ever reaching
-- apply_inventory_movement, and the invoice-trio CHECK constraint from 0193
-- would never even get a chance to fire.
create function public.record_stock_entry(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_type            public.inventory_movement_type,
  p_quantity        integer,
  p_note            text default null,
  p_idempotency_key text default null,
  p_invoice_number  text default null,
  p_unit_amount     numeric default null,
  p_total_amount    numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
begin
  -- Existence only: apply_inventory_movement re-resolves the Organization from
  -- the prize itself, which also proves the prize belongs to THIS Station —
  -- the stricter fact. Resolving it again here would just be a second, weaker
  -- copy of that same proof.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.entry', p_company_id) then
    raise log 'record_stock_entry denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.entry required' using errcode = '42501';
  end if;

  if p_type not in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY') then
    raise exception 'record_stock_entry does not accept movement type %', p_type
      using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, p_type, p_quantity, null, 'available', p_note, p_idempotency_key,
    p_invoice_number => p_invoice_number,
    p_unit_amount    => p_unit_amount,
    p_total_amount   => p_total_amount
  );
end;
$$;

revoke execute on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric) from public;
grant execute on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric) to authenticated;

comment on function public.record_stock_entry(uuid, uuid, public.inventory_movement_type, integer, text, text, text, numeric, numeric) is
  'Adds available stock. Gated on inventory.entry. Restricted to INITIAL_ENTRY, PURCHASE_ENTRY, MANUAL_ENTRY and (Block 23) BARTER_ENTRY — any other type is refused with 22023, a refusal that already existed before Block 23 and is only widened here. Block 23 also appended p_invoice_number, p_unit_amount, p_total_amount, threaded through by name (not position) into apply_inventory_movement so they land regardless of where its own parameter list grows next.';

drop function public.record_stock_exit(uuid, uuid, integer, text, text);

-- Restricted to the two exit kinds, the same shape record_stock_entry already
-- has for its own four. Before Block 23 this function had no p_type at all
-- and always wrote MANUAL_EXIT; now the caller chooses, and the refusal below
-- is new — added here, not merely widened, because there was no vocabulary to
-- refuse before this task gave the door a second exit type to accept.
create function public.record_stock_exit(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null,
  p_type            public.inventory_movement_type default 'MANUAL_EXIT'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.exit', p_company_id) then
    raise log 'record_stock_exit denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.exit required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to record a stock exit' using errcode = '22023';
  end if;

  if p_type not in ('MANUAL_EXIT', 'TRANSFER_EXIT') then
    raise exception 'record_stock_exit does not accept movement type %', p_type
      using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, p_type, p_quantity, 'available', null, v_note, p_idempotency_key
  );
end;
$$;

revoke execute on function public.record_stock_exit(uuid, uuid, integer, text, text, public.inventory_movement_type) from public;
grant execute on function public.record_stock_exit(uuid, uuid, integer, text, text, public.inventory_movement_type) to authenticated;

comment on function public.record_stock_exit(uuid, uuid, integer, text, text, public.inventory_movement_type) is
  'Removes available stock. Gated on inventory.exit. Note is mandatory. Block 23 appended p_type, defaulted to MANUAL_EXIT so every pre-existing five-argument call keeps writing exactly what it always wrote; TRANSFER_EXIT is the only other value accepted (Envio para outra emissora, design D4) and anything else is refused with 22023, the same shape record_stock_entry already used for its own type list.';

drop function public.reserve_stock(uuid, uuid, integer, text, text);

-- Unchanged apart from p_show_id (design D7): a programme reservation is a
-- reservation with an owner and nothing more, so this door does no more than
-- pass the id through — apply_inventory_movement writes it, and
-- inventory_movements_show_reference (0193) is what would refuse it on
-- anything but a RESERVATION, which this door only ever writes. A show
-- belonging to a different Station is refused by
-- inventory_movements_show_company_fk (0193) with 23503, the same class of
-- error a mismatched category or promotion already produces elsewhere in this
-- schema rather than a bespoke existence check duplicating what the
-- constraint already proves.
create function public.reserve_stock(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null,
  p_show_id         uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_note  text := nullif(trim(coalesce(p_note, '')), '');
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.reserve', p_company_id) then
    raise log 'reserve_stock denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.reserve required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to reserve stock' using errcode = '22023';
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, 'RESERVATION', p_quantity, 'available', 'reserved', v_note, p_idempotency_key,
    p_show_id => p_show_id
  );
end;
$$;

revoke execute on function public.reserve_stock(uuid, uuid, integer, text, text, uuid) from public;
grant execute on function public.reserve_stock(uuid, uuid, integer, text, text, uuid) to authenticated;

comment on function public.reserve_stock(uuid, uuid, integer, text, text, uuid) is
  'Moves available stock into reserved (RESERVATION). Gated on inventory.reserve. Note is mandatory. Block 23 appended p_show_id (design D7): null is an anonymous hold, a real id is a programme reservation, and inventory_movements_show_reference (0193) is what would refuse the column outside a RESERVATION — this door only ever writes one, so it never can.';

drop function public.release_reservation(uuid, uuid, integer, text, text);

-- The one door with real arithmetic added in this task (design D5). Before
-- Block 23, releasing was a bare quantity out of the reserved bucket with no
-- way to say which reservation shrank; p_reservation_id makes the RESERVATION
-- row itself the thing a release points at, and its remaining quantity is
-- its own quantity minus every release already pointing at it — the same
-- arithmetic the Reservas screen (0195/23d) will show on each row.
--
-- p_reservation_id stays optional (defaulted to null) for the same reason
-- every other appended parameter here is: release_reservation's own five-
-- argument callers, if any exist by the time this ships, keep working
-- unchanged, releasing stock with no reservation attribution exactly as
-- release_reservation always did. When it IS given, the reservation is
-- looked up scoped to BOTH p_company_id and p_prize_id, so a reservation id
-- belonging to a different Station or a different prize within the same
-- Station reads as "not found" (P0002) rather than as a cross-prize
-- confusion the caller has to reason about — the same choice archive_prize
-- and update_prize already make for a mismatched category id.
--
-- The reservation row is locked FOR UPDATE before the arithmetic below reads
-- it, closing a race no pgTAP file (single connection, single statement at a
-- time) can exercise but a real caller can: two concurrent releases against
-- the same reservation, each individually within what it independently read
-- as "remaining," could together over-release it, because
-- apply_inventory_movement's own sufficiency check reads inventory_balances
-- (the whole prize's reserved bucket, summed across every reservation on it)
-- and would not catch an over-release of ONE reservation while the prize's
-- total reserved stock is still sufficient. No other function in this schema
-- takes an EXPLICIT lock on an inventory_movements row (checked by grep
-- before adding this one). inventory_movements_reversal_company_fk (0193)
-- does take an IMPLICIT one — any insert that sets reverses_movement_id
-- takes FOR KEY SHARE on the row it references — but today this door is the
-- only writer of that column on a row this FOR UPDATE also touches, and it
-- takes its own FOR UPDATE first, so there is genuinely no cycle yet. Task
-- 3's reverse_movement will become the second writer of reverses_movement_id
-- and will reach these same two locks — this FOR UPDATE, and the FK's
-- implicit FOR KEY SHARE on whatever it reverses — possibly in the opposite
-- order; getting that ordering right is that task's own problem, not one
-- this comment can settle in advance.
create function public.release_reservation(
  p_company_id      uuid,
  p_prize_id        uuid,
  p_quantity        integer,
  p_note            text,
  p_idempotency_key text default null,
  p_reservation_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_note      text := nullif(trim(coalesce(p_note, '')), '');
  v_reserved  integer;
  v_released  integer;
  v_remaining integer;
  v_existing  uuid;
begin
  -- Existence only — see record_stock_entry's comment for why apply_inventory_movement's
  -- own resolution from the prize is the fact that matters.
  perform 1 from public.companies where id = p_company_id and deleted_at is null;

  if not found then
    raise exception 'station not found: %', p_company_id using errcode = 'P0002';
  end if;

  if not public.has_permission('inventory.reserve', p_company_id) then
    raise log 'release_reservation denied: actor=% company=%', v_actor, p_company_id;
    raise exception 'permission denied: inventory.reserve required' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'a note is required to release a reservation' using errcode = '22023';
  end if;

  -- Fix round 1: resolve a replay BEFORE the arithmetic below reads anything.
  -- apply_inventory_movement's own ON CONFLICT replay path (0027) only fires
  -- once this function has already called it — which is after v_released has
  -- been summed. A retry carrying the same idempotency key would therefore
  -- count its own first attempt in that sum and refuse itself with 22023,
  -- reporting a remainder that is a lie about what actually happened. Guarded
  -- on p_idempotency_key is not null and scoped to (company_id,
  -- idempotency_key) — the exact partial unique index apply_inventory_
  -- movement's own INSERT ... ON CONFLICT already keys on — so this is the
  -- same replay, found earlier rather than differently. Left unconditional on
  -- p_reservation_id: a replay of the pre-Block-23 anonymous-release shape
  -- (p_reservation_id null) already worked correctly through apply_inventory_
  -- movement's own path, and this earlier check returns the identical id for
  -- it too, just without first bootstrapping a balance-row lock nothing ends
  -- up needing.
  if p_idempotency_key is not null then
    select id into v_existing
    from public.inventory_movements
    where company_id = p_company_id and idempotency_key = p_idempotency_key;

    if found then
      return v_existing;
    end if;
  end if;

  if p_reservation_id is not null then
    select quantity into v_reserved
    from public.inventory_movements
    where id = p_reservation_id
      and company_id = p_company_id
      and prize_id = p_prize_id
      and movement_type = 'RESERVATION'
    for update;

    if not found then
      raise exception 'reservation not found in this station: %', p_reservation_id using errcode = 'P0002';
    end if;

    select coalesce(sum(quantity), 0) into v_released
    from public.inventory_movements
    where reverses_movement_id = p_reservation_id
      and movement_type = 'RESERVATION_RELEASE';

    v_remaining := v_reserved - v_released;

    if p_quantity > v_remaining then
      raise exception 'only % unit(s) remain on this reservation, and % were requested', v_remaining, p_quantity
        using errcode = '22023';
    end if;
  end if;

  return public.apply_inventory_movement(
    p_company_id, p_prize_id, 'RESERVATION_RELEASE', p_quantity, 'reserved', 'available', v_note, p_idempotency_key,
    p_reverses => p_reservation_id
  );
end;
$$;

revoke execute on function public.release_reservation(uuid, uuid, integer, text, text, uuid) from public;
grant execute on function public.release_reservation(uuid, uuid, integer, text, text, uuid) to authenticated;

comment on function public.release_reservation(uuid, uuid, integer, text, text, uuid) is
  'Moves reserved stock back to available (RESERVATION_RELEASE). Gated on inventory.reserve — the same code reserve_stock uses. Note is mandatory. Block 23 appended p_reservation_id (design D5): when given, it must name a live RESERVATION in this Station and this prize (P0002 otherwise, FOR UPDATE locked before the arithmetic below reads it), and the release is refused with 22023, naming the remainder, when it exceeds that reservation''s own quantity minus every RESERVATION_RELEASE already pointing at it. inventory_movements_reversal_unique (0193) deliberately excludes RESERVATION_RELEASE from its one-reversal-per-movement rule, so several releases legitimately point at one reservation — that is what "remaining" sums over. p_reservation_id left null behaves exactly as this door always did: a release with no reservation to attribute it to and no arithmetic to check. Fix round 1: a replay carrying p_idempotency_key is resolved by this function itself, before the arithmetic runs — a retry would otherwise count its own first attempt in the remaining-quantity sum and refuse itself with 22023 instead of returning the original movement.';
