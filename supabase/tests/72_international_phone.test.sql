begin;
select plan(10);

-- The ordinary Brazilian mobile, typed as an operator types it.
select is(public.international_phone('(11) 99999-8888', 'BR'), '+5511999998888',
  'a national number gains its country code');

-- Already international: unchanged, not double-prefixed.
select is(public.international_phone('+55 11 99999-8888', 'BR'), '+5511999998888',
  'an international number is left alone');

-- IDEMPOTENT, asserted rather than assumed: 0262 re-runs this over stored
-- values, and a function that grew a second '+55' on the second pass would
-- corrupt every row it had already repaired.
select is(public.international_phone(public.international_phone('11999998888', 'BR'), 'BR'),
  '+5511999998888',
  'running it over its own output changes nothing');

-- THE COLLISION THIS FUNCTION EXISTS FOR. 55 is Santa Maria's area code as well
-- as Brazil's country code, so a prefix test would call this international and
-- leave a ten-digit number that can never be dialled.
select is(public.international_phone('(55) 9999-8888', 'BR'), '+555599998888',
  'an area code that equals the country code is still a national number');

select is(public.international_phone('99999-8888', 'BR'), '999998888',
  'a length no rule explains is returned unchanged, and WITHOUT a plus');

select is(public.international_phone('912 345 678', 'PT'), '+351912345678',
  'Portugal is a second country with a verified rule');

select is(public.international_phone('11999998888', 'ZZ'), '11999998888',
  'a country with no rule leaves the digits alone');

select is(public.international_phone('11999998888', null), '11999998888',
  'no country at all leaves the digits alone');

select is(public.international_phone(null, 'BR'), null,
  'no phone is no phone');

select is(public.international_phone('não é telefone', 'BR'), null,
  'text with no digits is null, exactly as normalize_phone answers');

select * from finish();
rollback;
