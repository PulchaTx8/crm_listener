begin;
select plan(4);

-- ---------------------------------------------------------------------------
-- P5a. THE GROUP READS AND DOES NOT WRITE (design D19).
--
-- The classification has to be DATA rather than a list inside a function. A list
-- drifts the first time a block adds a permission and nobody remembers to
-- exclude it, and the drift is silent in the worst direction: the new code
-- simply becomes writable by every group owner on the platform.
-- ---------------------------------------------------------------------------

select has_column('public', 'permissions', 'kind',
  'every permission says whether it is a read or a write');

select col_not_null('public', 'permissions', 'kind',
  'and none of them may decline to say');

-- The nine reads, NAMED rather than counted, so a tenth is a deliberate edit
-- here and not an off-by-one somebody accepts.
select set_eq(
  $$ select code from public.permissions where kind = 'READ' $$,
  $$ values ('audit.view'), ('inventory.view'), ('members.view'),
            ('messaging.view'), ('music.view'), ('participations.view'),
            ('promotions.view'), ('reports.consolidated'), ('templates.view') $$,
  'and exactly these nine are reads');

-- What makes a future permission safe by default: one added with no kind cannot
-- exist, and one added as WRITE is invisible to the group until somebody decides
-- otherwise in writing.
select is(
  (select count(*)::int from public.permissions where kind = 'WRITE'),
  34,
  'and the other thirty-four are writes');

select * from finish();
rollback;
