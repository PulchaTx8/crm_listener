begin;
select plan(10);

-- Block 19a, final review fix wave, Important #5. The collision guard was
-- one-directional: set_service_hashtags (0177) already refuses a Station
-- hashtag equal to a live-or-future promotion's own, but nothing refused the
-- REVERSE -- create_promotion and update_promotion never looked at
-- widget_installations.music_hashtag/service_hashtag (0184). Since a
-- promotion's own hashtag wins the match ahead of the Station's two general
-- ones (D3), naming a promotion the same word as the Station's music or
-- service hashtag silently killed that door, with nothing on any screen
-- saying why.
--
-- TWO STATIONS. A holds the two configured hashtags everything below collides
-- with. B holds NEITHER -- it exists only to prove the guard is scoped to
-- its own Station, the same tenancy assertion 44_service_hashtags.test.sql
-- makes for set_service_hashtags itself, mirrored here for the reverse
-- direction.
--
-- Block 30c D2. 0259 added a gate refusing a WhatsApp- or web-enabled
-- promotion whose rules are blank -- not what this file exists to test, so
-- every call below passes `p_rules => 'Regras de teste'` to stay clear of it
-- entirely. Left blank, six of the ten calls would have had nothing standing
-- between them and that gate's 22023. The other four -- the two create and
-- two update throws_ok pairs testing the collision guard itself -- would be
-- refused by THAT guard first regardless, since it runs before the gate, so
-- they never needed rules at all. `p_rules` is the 17th parameter, so it is
-- passed by name on every call below rather than filling every positional
-- slot in between, and on all ten uniformly rather than only the six that
-- strictly need it, so which four those are is not something a future edit to
-- this file has to keep track of.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000701', 'Org promotion hashtag collision');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000701',
   'Station A collision', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000701',
   'Station B collision (no hashtags configured)', 'America/Sao_Paulo');

insert into public.widget_installations
  (id, organization_id, company_id, public_key, music_hashtag, service_hashtag)
values
  ('00000000-0000-0000-0000-000000000706', '00000000-0000-0000-0000-000000000701',
   '00000000-0000-0000-0000-000000000702', 'pw_7777000011112222333344', '#TOCA', '#AJUDA');

insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000707', '00000000-0000-0000-0000-000000000701', 'Promotions Manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000000707', 'promotions.create'),
  ('00000000-0000-0000-0000-000000000707', 'promotions.edit'),
  -- promotions_select_promotions_view (0044) gates every SELECT on
  -- promotions.view -- without it the subqueries below that look a
  -- promotion up by hashtag (rather than by an id already in hand) see zero
  -- rows under RLS, not the row the write door just committed.
  ('00000000-0000-0000-0000-000000000707', 'promotions.view');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000708', 'promo-hashtag-collision@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000000708', '00000000-0000-0000-0000-000000000702',
   '00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000707'),
  ('00000000-0000-0000-0000-000000000708', '00000000-0000-0000-0000-000000000703',
   '00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000707');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000708", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 1-2. create_promotion refuses a hashtag equal to Station A's OWN music
--      hashtag, naming which of the two it collides with -- the exact
--      sentence, not merely the sqlstate, because that is what "naming the
--      Station hashtag it collides with" (the review's own words) requires.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.create_promotion(
    '00000000-0000-0000-0000-000000000702', 'Promo colide musica',
    now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste')
$$, '22023', 'the hashtag #TOCA already belongs to this Station''s music hashtag',
  'create_promotion refuses a hashtag equal to this Station''s own music hashtag');

select throws_ok($$
  select public.create_promotion(
    '00000000-0000-0000-0000-000000000702', 'Promo colide servico',
    now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#AJUDA', p_rules => 'Regras de teste')
$$, '22023', 'the hashtag #AJUDA already belongs to this Station''s service hashtag',
  'create_promotion refuses a hashtag equal to this Station''s own service hashtag, naming which one');

-- ---------------------------------------------------------------------------
-- Second dispatch (regression in the round above). The first version of
-- this guard refused UNCONDITIONALLY -- no window, unlike 0177's own clash
-- check. An ENDED promotion whose hashtag equals the Station's own must
-- save cleanly: 0177's window is `ends_at > now()` precisely because an
-- ended promotion cannot shadow anything (ingest_whatsapp_event never
-- matches outside a promotion's own window), and 0177 already let the
-- Station claim this exact word on that basis. This promotion's id is
-- captured for the "revival" assertion near the end of this file.
-- ---------------------------------------------------------------------------
create temporary table t47_ended as
select public.create_promotion(
  '00000000-0000-0000-0000-000000000702', 'Promo colide mas ja acabou',
  now() - interval '40 days', now() - interval '10 days',
  null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste') as id;

select isnt(
  (select id from t47_ended), null,
  'an ENDED promotion whose hashtag equals the Station''s own music hashtag saves cleanly (mirrors 0177''s ends_at > now() window)');

-- ---------------------------------------------------------------------------
-- 3. Tenancy. The same word at Station B, which has configured neither
--    hashtag, is not this Station's word and is accepted.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.create_promotion(
    '00000000-0000-0000-0000-000000000703', 'Promo Station B mesma palavra',
    now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste')
$$, 'the same hashtag at a different Station, which never configured it, is accepted');

-- ---------------------------------------------------------------------------
-- 4. A non-colliding hashtag at Station A is unaffected -- the guard does not
--    over-refuse. This promotion's id is captured for the update assertions
--    below.
-- ---------------------------------------------------------------------------
create temporary table t47_promo as
select public.create_promotion(
  '00000000-0000-0000-0000-000000000702', 'Promo sem colisao',
  now() - interval '1 day', now() + interval '30 days',
  null, null, false, null, false, true, '#SEMCOLISAO', p_rules => 'Regras de teste') as id;

select isnt(
  (select id from t47_promo), null,
  'create_promotion succeeds for a hashtag that collides with nothing');

-- ---------------------------------------------------------------------------
-- 5-6. update_promotion carries the same guard. Renaming the promotion above
--      to Station A's own music or service hashtag is refused exactly as
--      creating it that way would have been.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.update_promotion(
    (select id from t47_promo), 'Promo sem colisao', now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste')
$$, '22023', 'the hashtag #TOCA already belongs to this Station''s music hashtag',
  'update_promotion refuses renaming a promotion''s hashtag to this Station''s own music hashtag');

select throws_ok($$
  select public.update_promotion(
    (select id from t47_promo), 'Promo sem colisao', now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#AJUDA', p_rules => 'Regras de teste')
$$, '22023', 'the hashtag #AJUDA already belongs to this Station''s service hashtag',
  'update_promotion refuses renaming a promotion''s hashtag to this Station''s own service hashtag');

-- ---------------------------------------------------------------------------
-- 7. Tenancy for the write door too: Station B's promotion may take the word
--    Station A owns as its music hashtag, because it belongs to a different
--    Station.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.update_promotion(
    (select id from public.promotions where hashtag = '#TOCA' and company_id = '00000000-0000-0000-0000-000000000703'),
    'Promo Station B mesma palavra', now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste')
$$, 'update_promotion at a different Station is unaffected by Station A''s own hashtags');

-- ---------------------------------------------------------------------------
-- 8. An ordinary resave -- the hashtag unchanged, colliding with nothing --
--    still lives. The guard runs on every write, not only on a change, and
--    this is the assertion that it does not over-refuse the common case.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.update_promotion(
    (select id from t47_promo), 'Promo sem colisao renomeada', now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#SEMCOLISAO', p_rules => 'Regras de teste')
$$, 'an ordinary resave with no colliding hashtag still lives');

-- ---------------------------------------------------------------------------
-- Second dispatch. The assertion the coordinator named as missing: a resave
-- of an UNCHANGED hashtag is never refused, even when the promotion is
-- revived into a LIVE window and the hashtag it already carried collides
-- with the Station's own -- the guard is skipped on the hashtag being
-- unchanged, independent of the window ("whatever the window says"),
-- because a save that does not touch the hashtag cannot be what introduces
-- a collision. t47_ended is the promotion two assertions after the top of
-- this file proved saves cleanly while ended; this is the same promotion,
-- same hashtag, revived.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.update_promotion(
    (select id from t47_ended), 'Promo colide mas ja acabou, revivida',
    now() - interval '1 day', now() + interval '30 days',
    null, null, false, null, false, true, '#TOCA', p_rules => 'Regras de teste')
$$, 'reviving an ended promotion without touching its already-colliding hashtag is never refused');

select * from finish();
rollback;
