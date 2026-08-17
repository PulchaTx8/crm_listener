-- supabase/migrations/0222_template_channel_vocabulary.sql

-- Block 29b-1, Task 1. THE TWO VOCABULARIES AND NOTHING ELSE IN THIS FILE.
--
-- Unlike 0219, this separation is for READABILITY and not for correctness:
-- `CREATE TYPE` may share a transaction with its first use. The Postgres rule
-- 0219 states -- that `ALTER TYPE ... ADD VALUE` cannot -- does not apply,
-- because nothing in this block adds a value to an existing type. A reader who
-- has met 0219 will assume otherwise, which is why this paragraph exists.

create type public.message_channel as enum ('WHATSAPP', 'EMAIL');

comment on type public.message_channel is
  'Which door a template speaks through. Two values today; a third (SMS, push) is a later block adding a value rather than a second table -- see the Block 29b-1 design, D1: a campaign points at ONE template and the rule "the campaign''s channel equals its template''s channel" is only expressible in the schema while both channels share a table.';

-- ---------------------------------------------------------------------------
-- The substitutable values, in two families.
--
-- ONE VOCABULARY, NOT TWO. The four campaign-resolvable values are what a
-- marketing template may carry; the three caller-supplied ones are what the two
-- SYSTEM templates already carry and what, until this migration, was free prose
-- in a jsonb array -- a description for a human that no code could act on.
--
-- WHICH FAMILY A VALUE BELONGS TO IS NOT RECORDED HERE. It lives in
-- `CAMPAIGN_RESOLVABLE` (src/lib/templates/variables.ts), a TypeScript record
-- total over this enum, so an eighth value stops that file compiling until
-- somebody decides. A column or a second enum here would be a second place for
-- the same fact, and the compiler cannot check a column.
--
-- ORDER MATTERS. A WhatsApp template's `variables` is POSITIONAL -- index 0 is
-- {{1}} -- so this declaration order is what a reader compares an array
-- against. The resolvable four are first because they are the ones 29d offers.
create type public.template_variable as enum (
  'LISTENER_FIRST_NAME',
  'LISTENER_FULL_NAME',
  'LISTENER_CITY',
  'STATION_NAME',
  'PRIZE_NAME',
  'PICKUP_DEADLINE',
  'VERIFICATION_CODE'
);

comment on type public.template_variable is
  'What a template may substitute. Two families in one type: LISTENER_* and STATION_NAME are resolvable by a campaign from the row it already reads, and PRIZE_NAME / PICKUP_DEADLINE / VERIFICATION_CODE are supplied by the specific caller that enqueues a system template (enqueue_pickup_reminder, widget_request_code) and can never be filled by a campaign. Which family a value is in is held by CAMPAIGN_RESOLVABLE in src/lib/templates/variables.ts, total over this enum, because a compiler can check that and a column cannot.';
