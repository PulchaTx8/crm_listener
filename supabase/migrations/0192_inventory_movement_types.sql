-- supabase/migrations/0192_inventory_movement_types.sql

-- Block 23, Task 1: two words the stock vocabulary was missing.
--
-- ALONE IN THIS FILE, AND THAT IS NOT TIDINESS. PostgreSQL refuses to USE a
-- value added by ALTER TYPE ... ADD VALUE inside the transaction that added it,
-- and Supabase runs one migration file per transaction. A single file that adds
-- BARTER_ENTRY and then writes a check constraint naming 'BARTER_ENTRY' fails
-- with "unsafe use of new value of enum type" on every machine, every db:reset.
-- 0193 is the file that reads them.
--
-- Both are the owner's decision of 2026-08-14 (design D4): the operator picks
-- from a fixed list rather than typing a reason, so that "how much came in by
-- barter this year" is a sum rather than a search through free text.

alter type public.inventory_movement_type add value 'BARTER_ENTRY';
alter type public.inventory_movement_type add value 'TRANSFER_EXIT';
