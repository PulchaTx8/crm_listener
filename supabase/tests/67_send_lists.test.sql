begin;
select plan(8);

-- Block 29d-1. The permissions a send list and, later, a campaign are guarded
-- by. Born beside the feature they guard, which is 0010's own rule.
select is(
  (select count(*)::int from public.permissions
    where code in ('messaging.view', 'messaging.manage', 'messaging.send')),
  3, 'the three messaging permissions exist');

-- SEND IS SEPARATE FROM MANAGE, and that is the whole reason there are three
-- rather than two: approving a send to twenty thousand people is not the act of
-- drafting one, and a Station may want those in different hands.
-- `code` IS the primary key here -- this table has no `id` column.
select isnt(
  (select label from public.permissions where code = 'messaging.send'),
  (select label from public.permissions where code = 'messaging.manage'),
  'send is its own code with its own label, not an alias of manage');

select is(
  (select count(distinct module)::int from public.permissions
    where code like 'messaging.%'),
  1, 'and all three sit in one module, so a role screen groups them together');

select ok(
  (select bool_and(label is not null and label <> '')
     from public.permissions where code like 'messaging.%'),
  'each carries a label, because a role screen shows codes to nobody');

-- Task 2. A list is a name, a Station, and either people or a question.
select has_table('public', 'send_lists', 'the list table exists');
select has_table('public', 'send_list_members', 'and the table holding a fixed list''s people');

select col_is_pk('public', 'send_list_members', array['list_id', 'member_id'],
  'a person appears in a list once -- Requests and Participations are per event, and somebody who asked for twelve songs is one recipient');

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'send_lists'
      and column_name in ('company_id', 'organization_id', 'source', 'kind', 'filters', 'name')) = 6,
  'a list carries its Station, its origin, its kind and the filters that built it');

select finish();
rollback;
