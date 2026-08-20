begin;
select plan(3);

-- Block 30c. Two fields a promotion gains, and the rule that the entry text
-- cannot be blank once a door is open. This task covers the columns; the gate's
-- own cases are appended by 0259's task.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030c1', 'Org 30c');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030a1', '00000000-0000-0000-0000-0000000030c1', 'Station A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000030b1', '00000000-0000-0000-0000-0000000030c1', 'Station B', 'America/Sao_Paulo');

insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000030f1', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030a1', 'Manha de A');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-0000000030d1', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A', now(), now() + interval '30 days');

-- 1: the certificate is free text and carries NO uniqueness, deliberately (D1).
-- A second promotion may hold the same number: the number is issued outside this
-- system, which has no way to know whether two promotions sharing one is an error
-- or a licence covering both.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, authorization_certificate)
values
  ('00000000-0000-0000-0000-0000000030d2', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A2', now(), now() + interval '30 days', 'CERT-1'),
  ('00000000-0000-0000-0000-0000000030d3', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo A3', now(), now() + interval '30 days', 'CERT-1');
select is(
  (select count(*)::int from public.promotions where authorization_certificate = 'CERT-1'),
  2, 'two promotions may carry the same certificate number');

-- 2: a Programme of the SAME Station attaches.
update public.promotions set show_id = '00000000-0000-0000-0000-0000000030f1'
 where id = '00000000-0000-0000-0000-0000000030d1';
select is(
  (select show_id from public.promotions where id = '00000000-0000-0000-0000-0000000030d1'),
  '00000000-0000-0000-0000-0000000030f1'::uuid, 'a Programme of the same Station attaches');

-- 3: and one from ANOTHER Station cannot be represented at all. The FK is
-- composite on (show_id, company_id), which is how this schema makes a
-- cross-Station reference impossible rather than merely unlikely -- the same
-- device promotion_questions (0041) and promotions itself already use.
insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000030f2', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030b1', 'Manha de B');
select throws_ok($$
  update public.promotions set show_id = '00000000-0000-0000-0000-0000000030f2'
   where id = '00000000-0000-0000-0000-0000000030d1'
$$, '23503', null, 'a Programme from another Station cannot be attached');

select * from finish();
rollback;
