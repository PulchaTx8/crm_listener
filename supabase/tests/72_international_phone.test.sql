begin;
select plan(13);

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

-- 0261. Every Station that predates the column has a country, so the doors can
-- prefix. Asserted as "none left without one" rather than as a count, which
-- would go stale the first time a Station is created.
select is((select count(*) from public.companies where country is null), 0::bigint,
  'no Station is left without a country');

-- 0262. The repair is expressed as a property, not as a row count: after it,
-- no member carries a phone that international_phone would still change.
--
-- COMPARED AGAINST `phone`, NOT `phone_normalized`. The function answers the
-- display form (with its leading plus) and phone_normalized is digits only, so
-- comparing against the generated column would report every correctly repaired
-- row as still needing repair -- a predicate that never settles.
select is(
  (select count(*)
     from public.members m
     join public.member_company_links l on l.member_id = m.id
     join public.companies c on c.id = l.company_id
    where m.phone is not null
      and public.international_phone(m.phone, c.country) is distinct from m.phone),
  0::bigint,
  'no member is left in a form the sanitation would change');

-- Re-running the repair changes nothing, which is what makes it safe to ship
-- twice (a migration re-applied by hand after a failed deploy is ordinary here).
select lives_ok($$
  update public.members m
     set phone = public.international_phone(m.phone, c.country)
    from public.member_company_links l
    join public.companies c on c.id = l.company_id
   where l.member_id = m.id
     and m.phone is not null
     and public.international_phone(m.phone, c.country) is distinct from m.phone
$$, 'the repair is re-runnable and finds nothing to do');

select * from finish();
rollback;
