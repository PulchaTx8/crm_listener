begin;
select plan(2);

-- Block 6d: the clock, the pile it makes, and the way back.
--
-- Fixtures live in the ...00d0xx range. 09_draws.test.sql owns ...00a0xx
-- through ...00a3xx and 10_delivery.test.sql owns ...00b0xx; a collision
-- would fail in whichever file ran second.

select ok(
  'RETURN_PENDING' = any (enum_range(null::public.winner_status)::text[]),
  'winner_status carries RETURN_PENDING');
select ok(
  'RETURN_PENDING_CANCEL' = any (enum_range(null::public.inventory_movement_type)::text[]),
  'inventory_movement_type carries RETURN_PENDING_CANCEL');

select * from finish();
rollback;
