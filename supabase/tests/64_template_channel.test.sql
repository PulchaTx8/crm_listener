begin;
select plan(3);

-- Block 29b-1, Task 1. The two vocabularies this block adds.
--
-- SEPARATE FILE FOR THE TYPES, and the reason is readability rather than
-- correctness: `CREATE TYPE` and its first use may share a transaction. The
-- rule 0219 states is about `ALTER TYPE ... ADD VALUE`, which nothing in this
-- block does. A reader who has met 0219 will assume the harder rule applies
-- here; it does not, and this comment is why the split is still worth making.
select has_type('public', 'message_channel', 'message_channel exists');
select has_type('public', 'template_variable', 'template_variable exists');

-- ORDER IS NOT DECORATION for template_variable: a WhatsApp template's
-- `variables` array is POSITIONAL, so the enum's own order is what a reader
-- compares an array against. The campaign-resolvable four come first because
-- they are the ones 29d may offer.
select is(
  enum_range(null::public.template_variable)::text[],
  array['LISTENER_FIRST_NAME', 'LISTENER_FULL_NAME', 'LISTENER_CITY', 'STATION_NAME',
        'PRIZE_NAME', 'PICKUP_DEADLINE', 'VERIFICATION_CODE'],
  'template_variable holds both families, resolvable first');

select * from finish();
rollback;
