begin;
select plan(7);

-- Block 16. The Organization stops being a name nobody can see or edit.

select has_column('public', 'organizations', 'tax_id', 'an organization can carry a CNPJ');
select has_column('public', 'organizations', 'billing_entity', 'and say who issues the invoice');
select has_column('public', 'organizations', 'suspended_at', 'and be blocked');

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000f1', 'Org profile');

-- Design D7. The default is what is true today: nothing has ever been recorded
-- at the group level, so the group cannot be the emitter until somebody says so.
select is(
  (select billing_entity::text from public.organizations
    where id = '00000000-0000-0000-0000-0000000000f1'),
  'STATIONS', 'a new organization invoices per station until told otherwise');

-- Fourteen digits and nothing else. Punctuation is stripped before it arrives,
-- the way normalize_phone (0031) treats a telephone, so two people typing the
-- same company two different ways produce one value.
select throws_ok(
  $$update public.organizations set tax_id = '12.345.678/0001-99'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a CNPJ with punctuation is refused; the caller normalises it');

select lives_ok(
  $$update public.organizations set tax_id = '12345678000199'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'and fourteen bare digits are accepted');

-- The pair shape every archival column in this schema uses: a time AND a
-- person, or neither. A block with no author is a block nobody can be asked
-- about.
select throws_ok(
  $$update public.organizations set suspended_at = now()
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null, 'a block with no author is refused');

select * from finish();
rollback;
