begin;
select plan(9);

-- Block 19a (D6). The two hashtags a Station configures, and the door that
-- writes them: set_service_hashtags. Fixtures follow 39_widget_installations
-- (one Organization, one Station, one installation) and 43_shows (a role that
-- actually holds the permission, checked inside the function's own body
-- rather than only by RLS).
--
-- THREE STATIONS. A holds the installation everything is written to. B holds
-- a LIVE promotion whose hashtag exists only to prove assertion 7: a hashtag
-- belongs to a Station, so the same tag at B must never block a write at A.
-- C holds neither an installation nor a promotion -- it exists only to prove
-- assertion 9, that a Station nobody has configured a widget for is refused
-- rather than silently updating zero rows.

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000601', 'Org service hashtags');

insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000602', '00000000-0000-0000-0000-000000000601',
   'Station A hashtags', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000603', '00000000-0000-0000-0000-000000000601',
   'Station B hashtags', 'America/Sao_Paulo'),
  ('00000000-0000-0000-0000-000000000604', '00000000-0000-0000-0000-000000000601',
   'Station C hashtags (no installation)', 'America/Sao_Paulo');

insert into public.widget_installations (id, organization_id, company_id, public_key) values
  ('00000000-0000-0000-0000-000000000606', '00000000-0000-0000-0000-000000000601',
   '00000000-0000-0000-0000-000000000602', 'pw_9999888877776666555544');

-- LIVE promotions (deleted_at and cancelled_at both null) at A and at B,
-- each carrying a hashtag the assertions below collide against.
insert into public.promotions
  (organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
values
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000602',
   'Promo Station A', now() - interval '1 day', now() + interval '30 days', true, '#EUQUERO'),
  ('00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000603',
   'Promo Station B', now() - interval '1 day', now() + interval '30 days', true, '#SORTEIO');

-- A CALLER WITH templates.manage AT A AND AT C -- not at B, because no
-- assertion ever calls the door for B; B only supplies the "another
-- Station's" promotion assertion 7 needs.
insert into public.roles (id, organization_id, name) values
  ('00000000-0000-0000-0000-000000000607', '00000000-0000-0000-0000-000000000601', 'Templates Manager');
insert into public.role_permissions (role_id, permission_code) values
  ('00000000-0000-0000-0000-000000000607', 'templates.manage');
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000608', 'service-hashtags-probe@example.test');
insert into public.company_memberships (user_id, company_id, organization_id, role_id) values
  ('00000000-0000-0000-0000-000000000608', '00000000-0000-0000-0000-000000000602',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000607'),
  ('00000000-0000-0000-0000-000000000608', '00000000-0000-0000-0000-000000000604',
   '00000000-0000-0000-0000-000000000601', '00000000-0000-0000-0000-000000000607');

-- ---------------------------------------------------------------------------
-- 2. No session yet, so has_permission is false and the door refuses before
--    touching a row -- the same shape 39_widget_installations proves for
--    upsert_widget_installation. Run first, deliberately: every assertion
--    after this one needs the authorized session, and this is the one
--    assertion that needs its absence.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Teste', '#Teste2')
$$, '42501', null, 'a caller without templates.manage is refused');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 1. The ordinary write. Both columns land, in one call.
-- ---------------------------------------------------------------------------
select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', '#Testando', '#Ajuda');

-- RLS on widget_installations is on with NO POLICY (0159's own comment), so
-- reading the row back to check it -- rather than through a door, since this
-- task creates none -- has to happen outside the `authenticated` role, the
-- same way 39_widget_installations reads the table directly only after a
-- `reset role`.
reset role;

select is(
  (select coalesce(music_hashtag, '<null>') || ':' || coalesce(service_hashtag, '<null>')
     from public.widget_installations
    where company_id = '00000000-0000-0000-0000-000000000602'),
  '#Testando:#Ajuda',
  'set_service_hashtags writes both columns');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 3. widget_installations_hashtag_shape, hit through the door rather than
--    against the table directly -- the same grammar promotions_hashtag_shape
--    (0040) states, stated again because a CHECK cannot reference another
--    table's constraint. A plain table CHECK violation, so 23514 -- the code
--    every other shape/shape-pair test in this suite expects (03_promotions,
--    06_whatsapp, 09_draws), not the 22023 this function reserves for the
--    business rule it raises itself (assertions 5 and 6 below).
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', 'SemCerquilha', '#Ajuda2')
$$, '23514', null, 'a hashtag not matching the shape is refused');

-- ---------------------------------------------------------------------------
-- 4. widget_installations_hashtags_differ -- also a table CHECK, so also
--    23514. "EUQUERO" spelled two ways proves the comparison is
--    case-insensitive, not merely a string-equality guard.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Igual', '#IGUAL')
$$, '23514', null, 'the two hashtags being equal, ignoring case, is refused');

-- ---------------------------------------------------------------------------
-- 5-6. A LIVE promotion's hashtag wins the match (D3), so a Station hashtag
--      equal to one would never answer. Refused by the function's own
--      explicit raise, hence 22023 -- and refused whichever case it is typed
--      in, because the promotion above was stored as '#EUQUERO'.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#EUQUERO', '#Outro')
$$, '22023', null, 'a hashtag equal to a LIVE promotion''s hashtag at that Station is refused');

select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#Euquero', '#Outro2')
$$, '22023', null, 'and the comparison ignores case');

-- ---------------------------------------------------------------------------
-- 7. A hashtag belongs to a Station. #SORTEIO is Station B's live promotion,
--    scoped out of the clash query by company_id, so Station A may use it.
-- ---------------------------------------------------------------------------
select lives_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000602', '#SORTEIO', '#Premio')
$$, 'a hashtag equal to a promotion''s at another Station is accepted');

-- ---------------------------------------------------------------------------
-- 8. NULL clears a column. service_hashtag is passed back unchanged
--    ('#Premio', exactly what Station A already stores from assertion 7) to
--    prove clearing music_hashtag is not treated as a collision with the
--    value already sitting in the row it is writing to.
-- ---------------------------------------------------------------------------
select public.set_service_hashtags(
  '00000000-0000-0000-0000-000000000602', null, '#Premio');

reset role;

select is(
  (select coalesce(music_hashtag, '<null>') || ':' || coalesce(service_hashtag, '<null>')
     from public.widget_installations
    where company_id = '00000000-0000-0000-0000-000000000602'),
  '<null>:#Premio',
  'null clears a column, and clearing is not a collision with itself');

set local role authenticated;
set local request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000608", "role": "authenticated"}';

-- ---------------------------------------------------------------------------
-- 9. Station C holds templates.manage for this same caller and NO
--    installation row. The UPDATE matches nothing; the door raises P0002
--    rather than reporting success over zero rows written.
-- ---------------------------------------------------------------------------
select throws_ok($$
  select public.set_service_hashtags(
    '00000000-0000-0000-0000-000000000604', '#Novo', '#Novo2')
$$, 'P0002', null, 'a Station with no installation is refused, not a silent no-op');

reset role;

select * from finish();
rollback;
