-- This migration adds one enum value and MUST contain nothing else.
--
-- ALTER TYPE ... ADD VALUE may run inside a transaction block, but the value it
-- adds cannot be USED until that transaction commits. Every migration runs in a
-- transaction, so the first statement that writes 'WHATSAPP' has to live in a
-- later file. That is 0062. Merging the two would fail at db push and pass
-- every test that never ran a real migration — which is the worst combination
-- available.
--
-- p_source is recorded and not consulted: 0054's comment is explicit that it
-- says how a row arrived and decides nothing about who may write it.

alter type public.participation_source add value 'WHATSAPP';
