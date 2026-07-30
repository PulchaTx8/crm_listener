begin;
select plan(20);

-- Structure -------------------------------------------------------------------

select has_table('public', 'promotion_prizes', 'promotion_prizes exists');
select has_table('public', 'promotion_prize_balances', 'promotion_prize_balances exists');

select is(relrowsecurity, true, 'RLS enabled on promotion_prizes')
  from pg_class where oid = 'public.promotion_prizes'::regclass;
select is(relrowsecurity, true, 'RLS enabled on promotion_prize_balances')
  from pg_class where oid = 'public.promotion_prize_balances'::regclass;

select ok(not has_table_privilege('authenticated', 'public.promotion_prizes', 'INSERT'),
          'authenticated may not link a prize directly');
select ok(not has_table_privilege('service_role', 'public.promotion_prize_balances', 'UPDATE'),
          'service_role may not write the per-promotion projection directly');

select has_column('public', 'inventory_movements', 'promotion_prize_id',
                  'the ledger can name a promotion link');

-- Fixtures ---------------------------------------------------------------------
-- Two Stations in one Organization: the second exists only for the
-- cross-Station link below.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000004b1', 'Org 4b');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004b1',
   'Station 4b One', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000004c2', '00000000-0000-0000-0000-0000000004b1',
   'Station 4b Two', 'America/Sao_Paulo');

insert into public.prizes (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Bicycle'),
  ('00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Headphones'),
  ('00000000-0000-0000-0000-0000000004a9', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c2', 'Prize in the other Station');

insert into public.promotions (id, organization_id, company_id, name, starts_at, ends_at) values
  ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1', 'Prize host', '2026-08-01Z', '2026-08-31Z');

insert into public.promotion_prizes
  (id, promotion_id, prize_id, organization_id, company_id) values
  ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-0000000004d1',
   '00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000004b1',
   '00000000-0000-0000-0000-0000000004c1');

-- The link proves its Station structurally ------------------------------------

select throws_ok(
  $$insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
    values ('00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004a9',
            '00000000-0000-0000-0000-0000000004b1',
            '00000000-0000-0000-0000-0000000004c1')$$,
  '23503', null, 'a prize from another Station cannot be linked');

select throws_ok(
  $$insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
    values ('00000000-0000-0000-0000-0000000004d1',
            '00000000-0000-0000-0000-0000000004a1',
            '00000000-0000-0000-0000-0000000004b1',
            '00000000-0000-0000-0000-0000000004c1')$$,
  '23505', null, 'the same prize cannot be linked twice while the first link is live');

-- The partial index is what makes the relink possible; a plain unique index
-- would refuse it, and only this case tells the two apart.
update public.promotion_prizes set deleted_at = now()
 where id = '00000000-0000-0000-0000-0000000004e1';

prepare relink as
  insert into public.promotion_prizes (promotion_id, prize_id, organization_id, company_id)
  values ('00000000-0000-0000-0000-0000000004d1',
          '00000000-0000-0000-0000-0000000004a1',
          '00000000-0000-0000-0000-0000000004b1',
          '00000000-0000-0000-0000-0000000004c1');
select lives_ok('relink', 'a prize can be linked again after its link was unwound');

-- Delete before undeleting: the relink above left a second live row for the
-- same (promotion_id, prize_id) pair, and undeleting 4e1 while that row is
-- still live would itself collide with promotion_prizes_live_unique.
delete from public.promotion_prizes
 where id <> '00000000-0000-0000-0000-0000000004e1';
update public.promotion_prizes set deleted_at = null
 where id = '00000000-0000-0000-0000-0000000004e1';

-- The projection ---------------------------------------------------------------

-- Run before the legitimate row below exists: promotion_prize_id is this
-- table's primary key, so once the live row for 4e1 is inserted a second
-- attempt would collide on the key before the foreign key below ever ran.
select throws_ok(
  $$insert into public.promotion_prize_balances
      (promotion_prize_id, prize_id, company_id, organization_id)
    values ('00000000-0000-0000-0000-0000000004e1',
            '00000000-0000-0000-0000-0000000004a2',
            '00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004b1')$$,
  '23503', null, 'a balance row may not name a prize its link is not for');

insert into public.promotion_prize_balances
  (promotion_prize_id, prize_id, company_id, organization_id, linked, drawn)
values ('00000000-0000-0000-0000-0000000004e1',
        '00000000-0000-0000-0000-0000000004a1',
        '00000000-0000-0000-0000-0000000004c1',
        '00000000-0000-0000-0000-0000000004b1', 5, 2);

select throws_ok(
  $$update public.promotion_prize_balances set drawn = 6
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'drawn may not exceed linked');

-- D4's floor, stated as the table check rather than only as an RPC guard: this
-- is the case that stays red if unlink_prize_from_promotion's own check is
-- removed.
select throws_ok(
  $$update public.promotion_prize_balances set linked = 1
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'linked may not be pushed below what has been drawn');

select throws_ok(
  $$update public.promotion_prize_balances set linked = -1, drawn = -1
     where promotion_prize_id = '00000000-0000-0000-0000-0000000004e1'$$,
  '23514', null, 'a negative bucket is refused');

-- The ledger's new column -------------------------------------------------------

select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_LINK', 1,
            'available', 'linked')$$,
  '23514', null, 'a PROMOTION_LINK that names no promotion is refused');

select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_UNLINK', 1,
            'linked', 'available')$$,
  '23514', null, 'a PROMOTION_UNLINK that names no promotion is refused');

-- The other half of the same check. Block 6 widens it to DRAW and DELIVERY;
-- until then a movement that could name a promotion but must not is exactly
-- what this refuses.
select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, promotion_prize_id)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a1', 'MANUAL_ENTRY', 1,
            null, 'available', '00000000-0000-0000-0000-0000000004e1')$$,
  '23514', null, 'a movement that is not a link may not name a promotion');

-- Three columns in the foreign key, not two: this is the case that a
-- (promotion_prize_id, company_id) key would let through.
select throws_ok(
  $$insert into public.inventory_movements
      (organization_id, company_id, prize_id, movement_type, quantity,
       from_bucket, to_bucket, promotion_prize_id)
    values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
            '00000000-0000-0000-0000-0000000004a2', 'PROMOTION_LINK', 1,
            'available', 'linked', '00000000-0000-0000-0000-0000000004e1')$$,
  '23503', null, 'a link movement may not name a link that is for another prize');

prepare linked_movement as
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity,
     from_bucket, to_bucket, promotion_prize_id)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
          '00000000-0000-0000-0000-0000000004a1', 'PROMOTION_LINK', 3,
          'available', 'linked', '00000000-0000-0000-0000-0000000004e1');
select lives_ok('linked_movement', 'a PROMOTION_LINK naming its own link is legal');

-- Every row the ledger already holds stays legal: the column is nullable and
-- the check exempts every type that is not a link.
prepare plain_entry as
  insert into public.inventory_movements
    (organization_id, company_id, prize_id, movement_type, quantity, from_bucket, to_bucket)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1',
          '00000000-0000-0000-0000-0000000004a1', 'MANUAL_ENTRY', 10, null, 'available');
select lives_ok('plain_entry', 'a movement that names no promotion is still legal');

select * from finish();
rollback;
