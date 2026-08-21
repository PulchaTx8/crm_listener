begin;
select plan(10);

-- Block 30c. Two fields a promotion gains -- the certificate (free text, no
-- uniqueness) and the Programme link (an FK scoped to the same Station) -- and
-- the gate 0259 adds to create_promotion and update_promotion, refusing a
-- door to open (or an open door to have its rules blanked) while the entry
-- text itself is empty or whitespace-only. Ten assertions: 1-3 and 9-10 cover
-- the two columns, 4-8 cover the gate.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000030c1', 'Org 30c');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000030a1', '00000000-0000-0000-0000-0000000030c1', 'Station A', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-0000000030b1', '00000000-0000-0000-0000-0000000030c1', 'Station B', 'America/Sao_Paulo');

insert into public.shows (id, organization_id, company_id, name) values
  ('00000000-0000-0000-0000-0000000030f1', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030a1', 'Manha de A'),
  -- A second Station A show, used only by assertions 8-9 below so the update
  -- case can move show_id to a genuinely DIFFERENT value rather than leaving
  -- the one create_promotion already wrote -- a body that dropped p_show_id
  -- from its SET list would pass the "leave it unchanged" case by accident.
  ('00000000-0000-0000-0000-0000000030f3', '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030a1', 'Tarde de A');

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

-- Block 30c D2. The gate: once a door is on, rules must be non-blank -- but
-- refusing the STATE would hold hostage every promotion already door-on and
-- rules-blank (reachable since 0171 made rules nullable), so the gate refuses
-- only the TRANSITION into that shape. Four assertions, one per row of the
-- design's table.
--
-- The role/grant idiom below is copied from
-- 47_promotion_hashtag_collision.test.sql, the suite's own file for calling
-- create_promotion/update_promotion as a real actor rather than as the
-- superuser pgTAP itself runs as -- 03_promotions.test.sql, which the task
-- brief for this file named, only asserts on grants and never seeds one.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000030e1', '00000000-0000-0000-0000-0000000030c1', 'Promotions Manager 30c');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-0000000030e1', 'promotions.create'),
  ('00000000-0000-0000-0000-0000000030e1', 'promotions.edit'),
  -- promotions_select_promotions_view (0044) gates every SELECT on
  -- promotions.view -- without it, assertions 8-9's read-back below sees zero
  -- rows under RLS rather than the row the RPC just wrote, the same reason
  -- 47_promotion_hashtag_collision.test.sql grants it.
  ('00000000-0000-0000-0000-0000000030e1', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000030e2', 'promo-rules-gate-30c@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-0000000030e2', '00000000-0000-0000-0000-0000000030a1',
   '00000000-0000-0000-0000-0000000030c1', '00000000-0000-0000-0000-0000000030e1');

-- The three shapes update_promotion's assertions need below, seeded directly
-- with insert: create_promotion refuses the door-on/rules-blank shape once
-- the gate exists, so ...30d6 in particular could not be produced through the
-- RPC at all.
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at,
   whatsapp_enabled, web_enabled, rules)
values
  -- ...30d4: both doors off, no rules. Assertion 5 turns WhatsApp on.
  ('00000000-0000-0000-0000-0000000030d4', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo D4 seed', now(), now() + interval '30 days',
   false, false, null),
  -- ...30d5: a door on AND rules present. Assertion 6 clears the rules while
  -- leaving that same door on.
  ('00000000-0000-0000-0000-0000000030d5', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo D5 seed', now(), now() + interval '30 days',
   false, true, 'Regras completas da promocao'),
  -- ...30d6: a door on and no rules -- the grandfathered shape 0171 made
  -- reachable, which this gate must still leave editable.
  ('00000000-0000-0000-0000-0000000030d6', '00000000-0000-0000-0000-0000000030c1',
   '00000000-0000-0000-0000-0000000030a1', 'Promo D6 seed', now(), now() + interval '30 days',
   false, true, null);

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-0000000030e2", "role": "authenticated"}';

-- 4: creating with a door on and blank rules is refused.
select throws_ok($$
  select public.create_promotion(
    '00000000-0000-0000-0000-0000000030a1', 'Sem regras',
    now(), now() + interval '10 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true,  -- p_web_enabled
    null)  -- p_rules
$$, '22023', 'a promotion that takes part by WhatsApp or on the website needs its rules',
  'a promotion cannot be created with a door open and no rules');

-- 5: turning a door on with blank rules is refused.
-- (Seed a promotion with both doors off and no rules first, then update it.)
select throws_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d4', 'Promo D4',
    now(), now() + interval '10 days',
    null, null, false, null, false, true, '#hash30c', null, null, '{}', null,
    false, null)
$$, '22023', 'a promotion that takes part by WhatsApp or on the website needs its rules',
  'a door cannot be opened while the rules are blank');

-- 6: the identical transition, refused for the identical reason, when the
-- rules are whitespace rather than truly empty -- ...30d4 is reusable here
-- because assertion 5's throws_ok rolled its own attempt back, so the row is
-- still door-off/rules-null. update_promotion's own `nullif(btrim(coalesce(
-- p_rules, '')), '')` is what makes whitespace count as blank; this is the
-- assertion that proves it does rather than assuming it from the expression
-- alone.
select throws_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d4', 'Promo D4 espacos',
    now(), now() + interval '10 days',
    null, null, false, null, false, true, '#hash30c2', null, null, '{}', null,
    false, '   ')
$$, '22023', 'a promotion that takes part by WhatsApp or on the website needs its rules',
  'whitespace-only rules trip the gate exactly like blank ones');

-- 7: clearing the rules while a door is on is refused.
select throws_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d5', 'Promo D5',
    now(), now() + interval '10 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true, null)
$$, '22023', 'a promotion that takes part by WhatsApp or on the website needs its rules',
  'the rules cannot be cleared while a door is open');

-- 8: AND THE ONE THAT MUST BE ALLOWED, which is the decision this gate exists
-- to express. A promotion already door-on and rules-blank -- a shape reachable
-- since 0171 made rules nullable -- stays editable. An operator correcting a
-- closing date is not held hostage to a text they may not have.
select lives_ok($$
  select public.update_promotion(
    '00000000-0000-0000-0000-0000000030d6', 'Promo D6 renomeada',
    now(), now() + interval '20 days',
    null, null, false, null, false, false, null, null, null, '{}', null,
    true, null)
$$, 'a promotion already door-on and rules-blank stays editable');

-- 9: create_promotion actually writes p_authorization_certificate and
-- p_show_id rather than accepting and dropping them on the floor -- the
-- failure mode 52_inventory_tabs.test.sql:294 names for p_show_id on a
-- different RPC ("a door that drops p_show_id on the floor leaves this
-- column null here too"). Both doors off here so the gate above is not what
-- this assertion is exercising.
create temporary table t30c_written as
select public.create_promotion(
  '00000000-0000-0000-0000-0000000030a1', 'Promo com certificado',
  now(), now() + interval '10 days',
  null, null, false, null, false, false, null, null, null, '{}', null,
  false, null,
  'CERT-30C2', '00000000-0000-0000-0000-0000000030f1') as id;

select is(
  (select array[authorization_certificate, show_id::text]
     from public.promotions where id = (select id from t30c_written)),
  array['CERT-30C2', '00000000-0000-0000-0000-0000000030f1'],
  'create_promotion writes authorization_certificate and show_id rather than dropping them');

-- 10: update_promotion writes the same two fields, checked on the write door
-- that replaces wholesale rather than the one that inserts -- and to a
-- DIFFERENT certificate and a DIFFERENT show (...30f3, seeded above for
-- exactly this), so a body that just left the old values in place could not
-- pass by coincidence.
select public.update_promotion(
  (select id from t30c_written), 'Promo com certificado renomeada',
  now(), now() + interval '20 days',
  null, null, false, null, false, false, null, null, null, '{}', null,
  false, null,
  'CERT-30C2-B', '00000000-0000-0000-0000-0000000030f3');

select is(
  (select array[authorization_certificate, show_id::text]
     from public.promotions where id = (select id from t30c_written)),
  array['CERT-30C2-B', '00000000-0000-0000-0000-0000000030f3'],
  'update_promotion writes authorization_certificate and show_id rather than dropping them');

select * from finish();
rollback;
