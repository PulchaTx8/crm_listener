-- Block 6d, Task 1: two words, and nothing else.
--
-- Separate from 0092 for the reason Postgres enforces rather than a
-- preference, and 0082 hit it first: a value added by ALTER TYPE ... ADD VALUE
-- cannot be USED in the same transaction, and 0092's CHECK constraint names
-- RETURN_PENDING_CANCEL as a literal. In one file it fails with
--   ERROR: unsafe use of new value "RETURN_PENDING_CANCEL" of enum type
-- which reads like a mystery and is not one.
--
-- RETURN_PENDING on winner_status restores what the master spec §6 always
-- asked for and Block 6b argued against: an expired deadline moves the unit to
-- pending_return and it RESTS there until an operator finishes. 6b's argument
-- was that the bucket is only passed through; the owner's ruling of 2026-08-03
-- is that it is also rested in. See the design spec, D1.
--
-- RETURN_PENDING_CANCEL is the inverse of RETURN_PENDING exactly as
-- DELIVERY_CANCEL is the inverse of DELIVERY, and is named to say so. It is the
-- way back for a listener who turns up late while the prize is still on the
-- shelf (D2).

alter type public.winner_status add value 'RETURN_PENDING' after 'AWAITING_PICKUP';

alter type public.inventory_movement_type
  add value 'RETURN_PENDING_CANCEL' after 'RETURN_PENDING';
