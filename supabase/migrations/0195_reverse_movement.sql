-- supabase/migrations/0195_reverse_movement.sql

-- Block 23, Task 3: the one door behind every Arquivar button.
--
-- THE LEDGER IS NOT EDITED. 0026's own comment states the rule -- "No role
-- holds UPDATE or DELETE on it -- the immutability is a grant, not a
-- convention" -- and this door does not want either grant. Archiving writes a
-- SECOND movement in the opposite direction, pointing at the first through
-- reverses_movement_id. The balance corrects itself by arithmetic, which is
-- why no other query in this database -- the reconciliation panel (0028), the
-- dashboards, the stock list -- has to learn that reversals exist.
--
-- The owner chose this over a cancelled_at flag on 2026-08-14 (design D1). The
-- flag reads more simply in one list and moves the definition of "the balance"
-- out of one sum and into every place that computes one.
--
-- ---------------------------------------------------------------------------
-- THREE CORRECTIONS TO THIS TASK'S OWN BRIEF, each made against the live
-- database rather than against the plan's text. The plan itself flagged the
-- first two as "verify before trusting"; the third it could not have known.
--
-- 1. apply_inventory_movement takes FOURTEEN arguments, not thirteen. The
--    brief's body calls it positionally against an order that never existed:
--    the live function was already at nine before this block (0047 appended
--    p_promotion_prize_id), and 0194 appended five more.
--
--    WHAT THE BRIEF'S POSITIONAL CALL ACTUALLY DOES, measured rather than
--    reasoned about -- its exact thirteen-argument body run in a rolled-back
--    transaction against this database, once on an entry carrying an invoice
--    and once on an exit carrying none:
--
--      SQLSTATE=42883
--      function public.apply_inventory_movement(uuid, uuid,
--        inventory_movement_type, integer, text, text, text, unknown, text,
--        numeric, numeric, unknown, uuid) does not exist
--
--    Both cases, identically. It fails LOUDLY, on the first reversal anybody
--    attempts, for two reasons that do not depend on each other: the brief's
--    `case ... then 'available' else null end` resolves to text rather than
--    inventory_bucket, and v_m.invoice_number (text) has no implicit coercion
--    to p_promotion_prize_id (uuid). PL/pgSQL resolves an overload by STATIC
--    argument type, so an exit reversal -- where all three invoice values are
--    null at runtime -- resolves exactly as the entry case does. There is no
--    interleaving in which this is quiet. And had the types been made to line
--    up, the shift puts p_movement_id on p_show_id, which
--    inventory_movements_show_reference (0193) refuses with 23514 on anything
--    but a RESERVATION -- also measured, also loud.
--
--    So the case for naming is NOT that it averted a silent corruption; the
--    schema had two loud defences here and would have used them. It is that
--    fourteen positional arguments cannot be read -- nobody checking this call
--    against the signature counts to fourteen correctly twice -- and that the
--    call is one appended parameter away from breaking, at which point the
--    breakage is again loud but again nobody's plan. Named arguments bind to
--    intent rather than to a position that keeps moving, which is why 0194's
--    four doors already use them.
--
-- 2. apply_inventory_movement DOES refuse an insufficient bucket, and this
--    door pre-checks anyway. The live function raises
--    'only % unit(s) are in %, and % were requested' with errcode 23514 --
--    verified in the live body, not assumed. Two reasons that is not enough
--    here. 23514 is check_violation: this repository spends 22023 on business
--    refusals and reserves the constraint classes for the constraints
--    themselves, and a screen that maps error codes to messages would file
--    the single most common refusal in this block under "a constraint broke".
--    And the message speaks in buckets ("are in available"), which names the
--    ledger's own vocabulary rather than the operator's question, which is
--    "why can I not archive this entry?". So the check below runs first and
--    says the second thing. apply_inventory_movement's own check is left
--    exactly where it is and remains the backstop -- see the comment on the
--    check itself for the one case that still reaches it.
--
-- 3. THE REVERSAL DOES NOT CARRY THE ORIGINAL'S INVOICE NUMBER, and cannot.
--    The design spec asks for it in one sentence (S5: "carrying the original's
--    invoice_number so the pair reads as a pair") and forbids it in another
--    (S4, shipped as inventory_movements_invoice_reference in 0193: the
--    invoice trio is permitted on INITIAL_ENTRY, PURCHASE_ENTRY, MANUAL_ENTRY
--    and BARTER_ENTRY and must be null everywhere else). An entry's reversal
--    is a MANUAL_EXIT, so copying the trio onto it is not a debatable design
--    choice -- it is a row the database refuses with 23514, and this door
--    would fail on the first entry anybody archived.
--
--    Two independent reasons the constraint has the better of the argument.
--    First, "the pair reads as a pair" is already true without the copy:
--    reverses_movement_id names the original, and it is exactly what 0196's
--    read follows to fill reversed_at and reversal_id. Second, an invoice
--    number repeated on a reversal makes every future
--    `sum(total_amount) where invoice_number = ...` count that invoice TWICE
--    rather than cancel it -- both rows carry a positive amount, because
--    quantities in this ledger are positive and direction lives in the bucket
--    pair. Copying it would corrupt the very sum D3 indexed the column for.
--    Reported to the coordinator rather than resolved unilaterally.
-- ---------------------------------------------------------------------------
--
-- WHAT THIS DOOR REFUSES, and why the refusals are the feature:
--   * a movement in a Station the caller cannot act in, and a movement id that
--     names nothing -- one answer, 42501, for both (see the gated read);
--   * anything that is not a plain entry or exit. A draw, a delivery, a
--     promotion link each have their own screen and their own door, with rules
--     this door does not know. A general-purpose eraser is exactly what a
--     ledger must not have -- and note that this refusal is not defence in
--     depth but load-bearing: without it, a DRAW would be mirrored into a
--     MANUAL_ENTRY (its to_bucket is not `available`, so it takes the exit
--     branch) and this door would invent available stock out of units already
--     committed to a winner, breaking no constraint on the way;
--   * a movement already reversed -- the unique index in 0193 is the truth,
--     this check is the sentence;
--   * a reversal the stock cannot pay for.
--
-- WHAT THIS DOOR DOES NOT REFUSE, said out loud because it looks like an
-- omission: reversing a reversal. A reversal is an ordinary MANUAL_EXIT or
-- MANUAL_ENTRY, so it appears in the opposite tab with an Arquivar button of
-- its own, and pressing it writes a third movement undoing the second. That is
-- coherent rather than a loop: inventory_movements_reversal_unique makes each
-- individual movement reversible at most once, so no depth of chain can refund
-- one movement twice, and every step is a real arithmetic correction. It is
-- also the only way an operator can undo a mis-click, which refusing it would
-- take away while leaving them free to type the same correction by hand
-- without the link.
--
-- LOCKS. This door is not lock-free, and the order matters.
-- inventory_movements_reversal_company_fk (0193) makes every insert that sets
-- reverses_movement_id take an implicit FOR KEY SHARE on the movement it
-- references, and that insert happens inside apply_inventory_movement, which
-- takes the balance row's FOR UPDATE first. Reached naively, this door would
-- therefore take the balance lock and THEN the referenced movement's key
-- share -- the OPPOSITE order from release_reservation (0194), the only other
-- writer of that column, which takes FOR UPDATE on the reservation before
-- calling the writer at all. There is no cycle today only because the two
-- target different kinds of row: a reversal targets an entry or an exit, a
-- release targets a RESERVATION, and this door refuses a RESERVATION outright.
-- That is a true statement about today's movement types and a fragile thing to
-- rest on, so the gated read below takes FOR UPDATE on the original FIRST.
-- The order is then movement, prize, balance, movement-again (already held) --
-- identical to release_reservation's, and no longer dependent on the two doors
-- never meeting on one row. The lock buys a second thing on its own: without
-- it, two callers archiving the same entry at once both read "not yet
-- reversed", both proceed, and the loser meets the unique index as a bare
-- 23505 instead of the sentence this door raises.

-- p_note carries NO default, which is the shape record_stock_exit,
-- reserve_stock and release_reservation all have and the shape the design spec
-- states (S5: reverse_movement(p_movement_id uuid, p_note text)). A defaulted
-- parameter that the body then refuses is a signature advertising "optional"
-- over a contract that says otherwise; here the note is required, so the
-- signature says so too. The runtime check below is still needed on top of it,
-- for the same reason the siblings carry one: a caller can pass an explicit
-- null, or a string of spaces.
create function public.reverse_movement(p_movement_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor     uuid := auth.uid();
  v_m         record;
  v_note      text := nullif(trim(coalesce(p_note, '')), '');
  v_new_type  public.inventory_movement_type;
  v_available integer;
  v_id        uuid;
begin
  -- The gated read: the row and the permission resolved TOGETHER, 0093's idiom
  -- (0101, 0102) applied to a door whose subject is a movement id rather than a
  -- Station id. A movement in a Station the caller cannot act in and a movement
  -- id that names nothing are one answer from outside, which is the whole point
  -- of resolving them in one query rather than finding the row and then judging
  -- it.
  --
  -- The permission is the one the ORIGINAL movement's kind required, not a code
  -- of this door's own (design D8's second half): undoing a purchase entry is
  -- the same authority as making one, and a separate inventory.reverse would be
  -- a code nobody holds until somebody remembers to grant it.
  --
  -- The lateral exists so that list of movement types appears ONCE. It has to
  -- be read twice -- to choose the permission for the WHERE, and again below to
  -- choose the mirror direction -- and two copies of one list is two places for
  -- a future movement type to be added to only one. The planner flattens the
  -- lateral into the index scan's filter, so it costs a plan node of nothing;
  -- `for update of m` is what keeps the locking clause on the table rather than
  -- on the derived subquery, which cannot be locked.
  --
  -- inventory.view is the fallback for a type this door cannot reverse. It is
  -- deliberately NOT required of the entry and exit paths -- those take
  -- inventory.entry and inventory.exit and nothing more -- but a caller who
  -- cannot even SEE a movement (0029's read policy is gated on exactly this
  -- code) has no business learning from a 22023 that it exists and what kind of
  -- movement it is.
  select m.*, k.needed
    into v_m
    from public.inventory_movements m
    cross join lateral (
      select case
               when m.movement_type in
                 ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'BARTER_ENTRY')
                 then 'inventory.entry'
               when m.movement_type in ('MANUAL_EXIT', 'TRANSFER_EXIT')
                 then 'inventory.exit'
             end as needed
    ) k
   where m.id = p_movement_id
     and public.has_permission(coalesce(k.needed, 'inventory.view'), m.company_id)
   for update of m;

  if not found then
    raise log 'reverse_movement denied: actor=% movement=%', v_actor, p_movement_id;
    raise exception 'permission denied' using errcode = '42501';
  end if;

  -- A reversal must say why. Every sibling door that takes stock out of a
  -- bucket already refuses a blank note with this code -- record_stock_exit,
  -- reserve_stock and release_reservation, all in 0194 -- and a reversal is
  -- the row in the Saidas tab a reader most wants explained: it is not a sale
  -- or a transfer, it is somebody undoing a colleague's entry, and "why" is
  -- the only thing on it that is not derivable from the pair.
  --
  -- Placed immediately after the permission check and before every refusal
  -- that reads the ROW, which is where the three siblings put theirs: a
  -- complaint about the caller's own arguments should not depend on anything
  -- about the movement, so it cannot be used to tell two movements apart.
  if v_note is null then
    raise exception 'a note is required to reverse a movement' using errcode = '22023';
  end if;

  if v_m.needed is null then
    raise exception 'only a stock entry or a stock exit can be reversed here'
      using errcode = '22023';
  end if;

  -- The check the index already makes true, restated for the message. The
  -- predicate matches inventory_movements_reversal_unique's own exactly,
  -- RESERVATION_RELEASE exclusion included: a reservation is released in
  -- instalments, so several releases legitimately point at one movement. That
  -- can never actually happen to a row that got this far -- release_reservation
  -- only ever points at a RESERVATION, which the refusal above already turned
  -- away -- but a check that silently disagrees with its index is worse than
  -- one that restates it.
  perform 1 from public.inventory_movements
   where reverses_movement_id = p_movement_id
     and movement_type <> 'RESERVATION_RELEASE';

  if found then
    raise exception 'this movement has already been reversed' using errcode = '22023';
  end if;

  -- The mirror. An entry is undone by a manual exit and an exit by a manual
  -- entry: the reversal is itself an ordinary movement, so every projection and
  -- every report that already understands entries and exits understands it too.
  -- Derived from `needed` rather than from the original's bucket pair, so it
  -- reads off the same list the permission did -- a future entry type landing
  -- somewhere other than `available` cannot make the two disagree.
  --
  -- inventory_movements_reversal_reference (0193) permits reverses_movement_id
  -- on MANUAL_ENTRY, MANUAL_EXIT and RESERVATION_RELEASE alone, so these two
  -- are not merely the natural choice, they are the only pair available without
  -- a new enum value -- which would need its own migration, for the reason 0192
  -- exists. The cost, stated plainly: in the Entradas and Saidas histories a
  -- reversal is indistinguishable from a genuine manual movement except by
  -- reverses_movement_id being non-null, and that column is what 0196's read
  -- projects to tell them apart.
  v_new_type := case
    when v_m.needed = 'inventory.entry' then 'MANUAL_EXIT'::public.inventory_movement_type
    else 'MANUAL_ENTRY'::public.inventory_movement_type
  end;

  -- Reversing an entry takes units back out of `available`, and there may no
  -- longer be enough there: an entry of 10 whose stock has since been sold,
  -- transferred or reserved cannot be undone by arithmetic that would drive the
  -- bucket negative. Reversing an EXIT has no source bucket at all and so
  -- cannot fail this way, which is why the check is guarded rather than
  -- unconditional.
  --
  -- Read without a lock of its own, deliberately. Locking the balance row here
  -- would put this door's balance lock BEFORE the prize's FOR SHARE, while
  -- apply_inventory_movement -- and therefore every other writer in this
  -- schema -- takes the prize first; one door disagreeing with five about that
  -- order is a worse trade than the narrow race this leaves open. The race is
  -- that a concurrent exit can empty the bucket between this read and
  -- apply_inventory_movement's own sufficiency check, which holds the balance
  -- lock and is authoritative. The outcome in that case is a refusal with 23514
  -- and the writer's own message instead of 22023 and this one: a worse
  -- sentence for a rare interleaving, never a wrong balance.
  if v_new_type = 'MANUAL_EXIT' then
    select b.available into v_available
    from public.inventory_balances b
    where b.company_id = v_m.company_id and b.prize_id = v_m.prize_id;

    -- No balance row means no stock, not "unknown": every movement written
    -- through apply_inventory_movement bootstraps one, so a prize with a
    -- movement and no balance row can only come from a direct insert, and zero
    -- is the honest reading of it either way. Spelled out because
    -- NULL < integer is NULL rather than true, and this check would otherwise
    -- fall straight through.
    v_available := coalesce(v_available, 0);

    if v_available < v_m.quantity then
      raise exception 'only % unit(s) are available, and % are needed to reverse this entry',
        v_available, v_m.quantity
        using errcode = '22023';
    end if;
  end if;

  -- BY NAME, not by position -- see correction 1 in this file's header. Every
  -- parameter this call does not name is left at its own default of null, which
  -- is what each of them must be here: no idempotency key (a reversal is driven
  -- by a button on one row, and the row's own uniqueness index is what makes a
  -- double press a refusal rather than a duplicate), no promotion prize (this
  -- door refuses every type that may name one), no invoice trio (correction 3),
  -- and no show.
  v_id := public.apply_inventory_movement(
    p_company_id => v_m.company_id,
    p_prize_id   => v_m.prize_id,
    p_type       => v_new_type,
    p_quantity   => v_m.quantity,
    p_from       => case when v_new_type = 'MANUAL_EXIT'
                         then 'available'::public.inventory_bucket end,
    p_to         => case when v_new_type = 'MANUAL_ENTRY'
                         then 'available'::public.inventory_bucket end,
    p_note       => v_note,
    p_idempotency_key => null,
    p_reverses   => p_movement_id
  );

  -- target_id is the movement that was ARCHIVED, not the one that was written:
  -- apply_inventory_movement already logged the new row under
  -- 'inventory_movement', and what this trail is asked six months later is "who
  -- archived that entry". The reversal's id travels in the detail, so the pair
  -- is reachable from either side.
  insert into public.audit_logs
    (actor_id, action, target_table, target_id, organization_id, company_id, detail)
  values
    (v_actor, 'reverse_movement', 'inventory_movements', p_movement_id,
     v_m.organization_id, v_m.company_id,
     jsonb_build_object('reversal_id', v_id,
                        'movement_type', v_m.movement_type,
                        'quantity', v_m.quantity));

  return v_id;
end;
$$;

-- A newly created function carries the default EXECUTE grant to PUBLIC, which
-- would put this door in front of `anon` as well as every authenticated
-- caller. Revoked first, then granted to authenticated alone -- the shape every
-- movement RPC in 0027 and 0194 already has.
revoke execute on function public.reverse_movement(uuid, text) from public;
grant execute on function public.reverse_movement(uuid, text) to authenticated;

comment on function public.reverse_movement(uuid, text) is
  'Archives a stock entry or a stock exit by writing its opposite (design D1): the ledger is append-only, so a correction is a second movement carrying reverses_movement_id, never an edit or a flag. Gated on the permission the ORIGINAL movement''s kind required -- inventory.entry to undo an entry, inventory.exit to undo an exit -- resolved in the same query that finds the row, so a movement in an unreachable Station and a movement id that names nothing both answer 42501. Refuses with 22023: a blank or absent note (mandatory, as it is on record_stock_exit, reserve_stock and release_reservation -- a reversal is the row in the history that most needs a reason, and p_note carries no default so the signature says so too), anything that is not a plain entry or exit (a draw, a delivery and a promotion link are undone by their own doors), a movement already reversed (inventory_movements_reversal_unique is the truth, the check is the sentence), and a reversal the available bucket cannot pay for, naming the shortfall. The reversal does NOT carry the original''s invoice number -- inventory_movements_invoice_reference (0193) permits the trio on entry types alone, and reverses_movement_id is what pairs the two rows. Takes FOR UPDATE on the original before calling apply_inventory_movement, which puts this door''s locks in the same order as release_reservation''s and makes the second-reversal refusal atomic instead of a race against the unique index.';
