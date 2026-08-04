begin;
select plan(9);

-- Block 7b, Task 1: the history table, and the kind that drives all five
-- doors. The doors themselves are Task 2; this file grows to cover them.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-00000000e2f1', 'Org 7b merge');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-00000000e2c1', '00000000-0000-0000-0000-00000000e2f1',
   'Station 7b merge', 'America/Sao_Paulo');

-- 1: five kinds, and the order is pinned. SHOW is present because the owner
-- ruled for merge_shows on 2026-08-04, against D3's original four — the two
-- comments 0098 and 0100 carry to the contrary are re-issued below.
select is(
  enum_range(null::public.music_merge_kind)::text[],
  array['SONG', 'ARTIST', 'LABEL', 'GENRE', 'SHOW'],
  'music_merge_kind is the five mergeable entities — shows included');

-- 2-6: the kind resolves to a table, totally. A kind added to the enum without
-- a branch here returns null, and every caller formats that into public."" and
-- fails loudly rather than writing somewhere unintended.
select is(public.music_merge_table('SONG'),   'songs',         'SONG maps to songs');
select is(public.music_merge_table('ARTIST'), 'artists',       'ARTIST maps to artists');
select is(public.music_merge_table('LABEL'),  'record_labels', 'LABEL maps to record_labels');
select is(public.music_merge_table('GENRE'),  'music_genres',  'GENRE maps to music_genres');
select is(public.music_merge_table('SHOW'),   'shows',         'SHOW maps to shows');

-- 7: a merge without a reason is not a merge. The column refuses blank as well
-- as null, because '   ' would satisfy NOT NULL and answer nothing in six
-- months' time.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  values ('00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
          'SONG', gen_random_uuid(), gen_random_uuid(), '   ', 0)
$$, '23514', null, 'a blank reason is refused by the check constraint');

-- 8: the winner cannot be the loser, at the column level as well as in the
-- core — a history row saying a record absorbed itself would be unreadable.
select throws_ok($$
  insert into public.music_merges
    (organization_id, company_id, kind, winner_id, loser_id, reason, children_moved)
  select '00000000-0000-0000-0000-00000000e2f1', '00000000-0000-0000-0000-00000000e2c1',
         'SONG', id, id, 'same', 0
    from (select gen_random_uuid() as id) s
$$, '23514', null, 'a row where the winner is also the loser is refused');

-- 9: authenticated may read the history and may not write it. The only writer
-- is the SECURITY DEFINER core.
select ok(
  not has_table_privilege('authenticated', 'public.music_merges', 'INSERT'),
  'authenticated cannot insert a merge history row directly');

select * from finish();
rollback;
