begin;
select plan(2);

select has_table('public', 'rate_limit_counters', 'rate_limit_counters existe');
select has_function('public', 'rate_limit_hit', 'função rate_limit_hit existe');

select * from finish();
rollback;
