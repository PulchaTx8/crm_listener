begin;
select plan(9);

-- Block 15. A Station gets the record a radio station actually has.

select has_column('public', 'companies', 'thumb_url', 'a Station can have a picture');
select has_column('public', 'companies', 'frequency_khz', 'and a dial frequency');
select has_column('public', 'companies', 'city', 'and an address');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a3', 'Org profile');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a3',
   'Station profile', 'America/Sao_Paulo');

-- Mirrors prizes_photo_shape (0145): the column never holds a value that lands
-- verbatim in an <img src> without at least being an address.
select throws_ok(
  $$update public.companies set thumb_url = 'not-an-address'
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a picture that is not an address is refused');

-- Half a coordinate is worse than none: it renders a pin in the Atlantic, or
-- silently drops the Station off a map that has no way to say why.
select throws_ok(
  $$update public.companies set latitude = -23.55
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a latitude with no longitude is refused');

select lives_ok(
  $$update public.companies set latitude = -23.55, longitude = -46.63
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  'and the pair together is accepted');

select throws_ok(
  $$update public.companies set latitude = 91, longitude = 0
     where id = '00000000-0000-0000-0000-0000000000b3'$$,
  '23514', null, 'a latitude off the planet is refused');

-- The picture has ONE writer, and it is not the wholesale-replace one. 0144 and
-- 0145 both document what happens otherwise: the next ordinary Save clears a
-- picture somebody uploaded a moment earlier.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_company_profile'
      and 'p_thumb_url' = any(p.proargnames)),
  0::bigint,
  'update_company_profile cannot touch the picture, so a save cannot clear it');

-- No session, so is_platform_admin() is false. The gate is before the work.
select throws_ok(
  $$select public.update_company_profile(
      '00000000-0000-0000-0000-0000000000b3', null, null, null, null,
      'Sao Paulo', 'SP', null, 'FM', 98500, null, null)$$,
  '42501', null, 'editing a Station requires the platform admin');

select * from finish();
rollback;
