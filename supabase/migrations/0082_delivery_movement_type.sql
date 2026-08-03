-- Block 6b, Task 2, first half: one word, and nothing else.
--
-- This file exists ONLY to add the enum value, and it is separate from
-- 0083 for a reason Postgres enforces rather than a preference: a value added
-- by ALTER TYPE ... ADD VALUE cannot be USED in the same transaction, and the
-- CHECK constraint in 0083 names 'DELIVERY_CANCEL' as a literal. Putting them
-- in one migration fails with
--   ERROR: unsafe use of new value "DELIVERY_CANCEL" of enum type
-- which reads like a mystery and is not one.
--
-- 0047 hit the neighbouring version of this trap from the other side, when it
-- had to DROP and recreate apply_inventory_movement because create or replace
-- cannot change an argument list.

alter type public.inventory_movement_type add value 'DELIVERY_CANCEL' after 'DELIVERY';
