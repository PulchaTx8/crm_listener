-- Block 6b, Task 2, second half: the transitions, and what each one does to the
-- promotion's own figures.
--
-- 0045 admitted promotion_prize_id on two movement types, 0077 widened it to
-- four and lifted the projection into its own function so that this block would
-- be four branches rather than a 180-line body restated. This is that block
-- collecting on it.

-- ---------------------------------------------------------------------------
-- The legal transitions. Every arm below except the DELIVERY_CANCEL one is
-- copied VERBATIM from 0026; retyping them from memory is how an arm goes
-- missing, and a missing arm does not announce itself -- it silently forbids a
-- movement some other block depends on.

alter table public.inventory_movements
  drop constraint inventory_movements_legal_transition;

alter table public.inventory_movements
  add constraint inventory_movements_legal_transition check (
       (movement_type in ('INITIAL_ENTRY', 'PURCHASE_ENTRY', 'MANUAL_ENTRY', 'ADJUSTMENT_POSITIVE')
          and from_bucket is null and to_bucket = 'available')
    or (movement_type in ('MANUAL_EXIT', 'ADJUSTMENT_NEGATIVE')
          and from_bucket = 'available' and to_bucket is null)
    or (movement_type = 'RESERVATION'
          and from_bucket = 'available' and to_bucket = 'reserved')
    or (movement_type = 'RESERVATION_RELEASE'
          and from_bucket = 'reserved' and to_bucket = 'available')
    or (movement_type = 'PROMOTION_LINK'
          and from_bucket = 'available' and to_bucket = 'linked')
    or (movement_type = 'PROMOTION_UNLINK'
          and from_bucket = 'linked' and to_bucket = 'available')
    or (movement_type = 'DRAW'
          and from_bucket = 'linked' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'DRAW_CANCEL'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'linked')
    or (movement_type = 'DELIVERY'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'delivered')
    -- The one this block adds. Nothing left the delivered bucket before it, so
    -- a delivery recorded against the wrong winner was permanent -- and the
    -- correction people would reach for, a stock adjustment, fixes the count
    -- and leaves winners saying DELIVERED for ever.
    or (movement_type = 'DELIVERY_CANCEL'
          and from_bucket = 'delivered' and to_bucket = 'awaiting_pickup')
    or (movement_type = 'RETURN_PENDING'
          and from_bucket = 'awaiting_pickup' and to_bucket = 'pending_return')
    or (movement_type = 'RETURN_TO_STOCK'
          and from_bucket = 'pending_return' and to_bucket = 'available')
    or (movement_type = 'WRITE_OFF'
          and from_bucket in ('pending_return', 'awaiting_pickup') and to_bucket = 'written_off')
  );

-- ---------------------------------------------------------------------------
-- Which movements may name a promotion. All nine that touch a promotion's
-- units now do; the entry, exit, reservation and adjustment types still may
-- not, because none of them is about a promotion at all.

alter table public.inventory_movements
  drop constraint inventory_movements_promotion_reference;

alter table public.inventory_movements
  add constraint inventory_movements_promotion_reference check (
    (movement_type in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL',
                       'DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING',
                       'RETURN_TO_STOCK', 'WRITE_OFF')
       and promotion_prize_id is not null)
    or (movement_type not in ('PROMOTION_LINK', 'PROMOTION_UNLINK', 'DRAW', 'DRAW_CANCEL',
                              'DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING',
                              'RETURN_TO_STOCK', 'WRITE_OFF')
       and promotion_prize_id is null)
  );

comment on column public.inventory_movements.promotion_prize_id is
  'Which promotion link this movement is part of. Required for the nine types that move a promotion''s own units -- PROMOTION_LINK, PROMOTION_UNLINK, DRAW, DRAW_CANCEL, DELIVERY, DELIVERY_CANCEL, RETURN_PENDING, RETURN_TO_STOCK and WRITE_OFF -- and forbidden for every other, none of which is about a promotion at all.';

-- ---------------------------------------------------------------------------
-- The projection. Four of this block's five types change nothing about what the
-- promotion spent, and each says so in a branch of its own.

create or replace function public.project_promotion_prize_movement(
  p_promotion_prize_id uuid,
  p_type               public.inventory_movement_type,
  p_quantity           integer
)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_type = 'PROMOTION_LINK' then
    update public.promotion_prize_balances
       set linked = linked + p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'PROMOTION_UNLINK' then
    update public.promotion_prize_balances
       set linked = linked - p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'DRAW' then
    update public.promotion_prize_balances
       set drawn = drawn + p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;
  elsif p_type = 'DRAW_CANCEL' then
    update public.promotion_prize_balances
       set drawn = drawn - p_quantity, updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;

  elsif p_type in ('DELIVERY', 'DELIVERY_CANCEL', 'RETURN_PENDING', 'WRITE_OFF') then
    -- Deliberately nothing, and written as a branch rather than left to fall
    -- through to the else below.
    --
    -- `linked` counts the units this promotion took out of stock and has not
    -- given back; `drawn` counts how many of those were drawn. A prize handed
    -- over, or handed over and un-handed, or on its way back, or destroyed, was
    -- still spent BY this promotion -- none of those four is the promotion
    -- returning a unit to general stock, which is the only thing that changes
    -- either figure.
    --
    -- The else raises XX000 on purpose (0047's tripwire, which fired on Block
    -- 6a's first DRAW and did its job). A silent fallthrough is exactly the
    -- failure it exists to catch, so "nothing happens here" has to be said out
    -- loud or it cannot be told apart from "nobody thought about this".
    null;

  elsif p_type = 'RETURN_TO_STOCK' then
    -- The one that does move them. The unit leaves the promotion for general
    -- stock, so it is neither linked nor drawn any more. Without BOTH
    -- decrements it would be counted twice -- once in inventory_balances.available
    -- and once in this promotion's Resto (linked - drawn) -- and the second
    -- count is the one nobody would notice.
    update public.promotion_prize_balances
       set linked = linked - p_quantity,
           drawn  = drawn  - p_quantity,
           updated_at = now()
     where promotion_prize_id = p_promotion_prize_id;

  else
    raise exception
      'apply_inventory_movement cannot project movement type % onto a promotion prize', p_type
      using errcode = 'XX000';
  end if;
end;
$$;

comment on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) is
  'Moves the per-promotion figures for one movement. The ONE home of the rule that says which movement type touches linked and which touches drawn, called only from apply_inventory_movement (0047) and lifted out of its body in 0077 so that Block 6b could add its types here rather than restate a 180-line function. Driven by movement_type and never by the bucket pair: linked counts units committed to the promotion and is not decremented by a draw or by a delivery. RETURN_TO_STOCK is the only type that decrements either figure, because it is the only one that gives a unit back to general stock. DELIVERY, DELIVERY_CANCEL, RETURN_PENDING and WRITE_OFF have an explicit do-nothing branch rather than falling through to the XX000 the else raises -- a silent no-op is the failure that tripwire exists to catch. PRIVATE: SECURITY INVOKER, EXECUTE granted to nobody.';

revoke execute on function public.project_promotion_prize_movement(uuid, public.inventory_movement_type, integer) from public;
