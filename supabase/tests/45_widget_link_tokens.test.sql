begin;
select plan(10);

-- Block 19a (D2). mint_widget_link and consume_widget_link: the single-use
-- door a hashtag answer opens. Fixtures follow 39_widget_installations (one
-- Organization, one Station, one enabled installation) with a fresh member
-- per assertion, so the two-minute window one assertion exercises can never
-- leak into the next one's fixture.

-- ---------------------------------------------------------------------------
-- 8. TWO CONCURRENT CONSUMES, GENUINELY. This runs FIRST, out of numeric
-- order, and is the one part of this file that does not rely on the final
-- rollback for cleanup -- both are consequences of the same fact.
--
-- A second call in THIS session, after the first has returned, is sequential
-- by construction: the first call's whole round trip -- including its
-- UPDATE -- completes before the second can even be sent. Assertion 7 already
-- covers that case, and a select-then-update implementation passes it just as
-- well as the correct one, because neither call's SELECT can ever overlap the
-- other's UPDATE. Proving the UPDATE's own predicate is what decides ties
-- needs two statements actually in flight at once, which needs two separate
-- backend connections -- so this uses dblink to open two, and
-- dblink_send_query (not dblink()) to fire both without waiting on either,
-- so their execution genuinely overlaps rather than merely being issued from
-- one script.
--
-- dblink is a real, separate connection, so it cannot see this transaction's
-- own uncommitted writes -- read-committed isolation applies across sessions
-- same as it would to two browser tabs. So the row this assertion races over
-- is committed here, on purpose, before either dblink call, and deleted
-- again explicitly a few statements down. This file still leaves the
-- database exactly as it found it; it just cannot do that through ROLLBACK
-- for this one row, the way every other assertion below does.
--
-- host=db is the Supabase CLI's own internal Docker alias for this database,
-- not something this project invented, and it resolves inside the server's
-- own network namespace regardless of the client's. postgres/postgres is the
-- fixed local Supabase dev credential, safe to write in the clear here
-- because this file only ever runs with --local. dblink itself refuses a
-- passwordless (trust) connection for a non-superuser caller even when one is
-- reachable, which 127.0.0.1 is in this stack -- host=db is what actually
-- authenticates.
create extension if not exists dblink with schema extensions;

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000801', 'Org widget link tokens (race)');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000801',
   'Station widget link tokens (race)', 'America/Sao_Paulo');
insert into public.widget_installations (id, organization_id, company_id, public_key, enabled) values
  ('00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-000000000801',
   '00000000-0000-0000-0000-000000000802', 'pw_8888000011112222333344', true);
insert into public.members (id, organization_id) values
  ('00000000-0000-0000-0000-000000000804', '00000000-0000-0000-0000-000000000801');

create temporary table t8_mint as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000804', 'MUSIC') as code;

commit;

select extensions.dblink_connect('race_a', 'host=db port=5432 dbname=postgres user=postgres password=postgres');
select extensions.dblink_connect('race_b', 'host=db port=5432 dbname=postgres user=postgres password=postgres');

select extensions.dblink_send_query('race_a',
  format('select public.consume_widget_link(%L)::text', (select code from t8_mint)));
select extensions.dblink_send_query('race_b',
  format('select public.consume_widget_link(%L)::text', (select code from t8_mint)));

create temporary table t8_result_a as select * from extensions.dblink_get_result('race_a') as t(claims text);
create temporary table t8_result_b as select * from extensions.dblink_get_result('race_b') as t(claims text);

select extensions.dblink_disconnect('race_a');
select extensions.dblink_disconnect('race_b');

select ok(
  (
    select count(*) from (
      select claims::jsonb ->> 'ok' as ok from t8_result_a
      union all
      select claims::jsonb ->> 'ok' as ok from t8_result_b
    ) x where ok = 'true'
  ) = 1
  and (
    select count(*) from (
      select claims::jsonb ->> 'reason' as reason from t8_result_a
      union all
      select claims::jsonb ->> 'reason' as reason from t8_result_b
    ) x where reason = 'unusable'
  ) = 1,
  'two genuinely concurrent consumes -- separate backend connections, both in flight at once -- have exactly one winner');

begin;
delete from public.widget_link_tokens  where member_id = '00000000-0000-0000-0000-000000000804';
delete from public.widget_installations where id = '00000000-0000-0000-0000-000000000803';
delete from public.members              where id = '00000000-0000-0000-0000-000000000804';
delete from public.companies            where id = '00000000-0000-0000-0000-000000000802';
delete from public.organizations        where id = '00000000-0000-0000-0000-000000000801';
commit;

-- ---------------------------------------------------------------------------
-- Back to the ordinary shape: one transaction, fixtures below, rollback at
-- the very end. Nothing past this point commits anything.
-- ---------------------------------------------------------------------------
begin;

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-000000000701', 'Org widget link tokens');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000701',
   'Station widget link tokens', 'America/Sao_Paulo');
insert into public.widget_installations (id, organization_id, company_id, public_key, enabled) values
  ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000701',
   '00000000-0000-0000-0000-000000000702', 'pw_7777000011112222333344', true);

insert into public.members (id, organization_id) values
  ('00000000-0000-0000-0000-000000000711', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000712', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000713', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000714', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000715', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000716', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000719', '00000000-0000-0000-0000-000000000701'),
  ('00000000-0000-0000-0000-000000000720', '00000000-0000-0000-0000-000000000701');

-- ---------------------------------------------------------------------------
-- 1. A code, and only its digest on the row.
-- ---------------------------------------------------------------------------
create temporary table t1_mint as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000711', 'MUSIC') as code;

select ok(
  (select code from t1_mint) is not null
  and exists (
    select 1 from public.widget_link_tokens
     where member_id = '00000000-0000-0000-0000-000000000711'
       and token_hash = encode(extensions.digest((select code from t1_mint), 'sha256'), 'hex')
  )
  and not exists (
    select 1 from public.widget_link_tokens
     where member_id = '00000000-0000-0000-0000-000000000711'
       and token_hash = (select code from t1_mint)
  ),
  'mint_widget_link returns a code, and the row stores only its SHA-256 digest -- the raw code appears nowhere in the table');

-- ---------------------------------------------------------------------------
-- 2. D2's window. The raw code cannot be re-derived from a stored hash, so a
-- repeat inside two minutes cannot be answered with "the same code" even in
-- principle -- it is answered with NULL, which the caller (see
-- src/services/whatsapp-link.ts) reads as "already sent, say nothing".
-- ---------------------------------------------------------------------------
create temporary table t2_first as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000712', 'MUSIC') as code;
create temporary table t2_second as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000712', 'MUSIC') as code;

select ok(
  (select code from t2_first) is not null
  and (select code from t2_second) is null,
  'minting again inside the two-minute window answers NULL rather than a second code');

-- ---------------------------------------------------------------------------
-- 3. ...only when the purpose matches.
-- ---------------------------------------------------------------------------
create temporary table t3_music as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000713', 'MUSIC') as code;
create temporary table t3_menu as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000713', 'MENU') as code;

select ok(
  (select code from t3_music) is not null
  and (select code from t3_menu) is not null
  and (select code from t3_music) <> (select code from t3_menu),
  'a different purpose for the same listener, inside the same window, is never treated as the same request');

-- ---------------------------------------------------------------------------
-- 4. ...and only when the promotion matches.
-- ---------------------------------------------------------------------------
insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at, whatsapp_enabled, hashtag)
values
  ('00000000-0000-0000-0000-000000000731', '00000000-0000-0000-0000-000000000701',
   '00000000-0000-0000-0000-000000000702', 'Promo X', now() - interval '1 day', now() + interval '30 days', true, '#PromoX'),
  ('00000000-0000-0000-0000-000000000732', '00000000-0000-0000-0000-000000000701',
   '00000000-0000-0000-0000-000000000702', 'Promo Y', now() - interval '1 day', now() + interval '30 days', true, '#PromoY');

create temporary table t4_x as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000714',
  'PROMOTION', '00000000-0000-0000-0000-000000000731') as code;
create temporary table t4_y as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000714',
  'PROMOTION', '00000000-0000-0000-0000-000000000732') as code;

select ok(
  (select code from t4_x) is not null
  and (select code from t4_y) is not null
  and (select code from t4_x) <> (select code from t4_y),
  'and so is a different promotion, for the same listener and the same PROMOTION purpose');

-- ---------------------------------------------------------------------------
-- 5. Minting after the window mints a fresh code. "The old one no longer
-- consumes" needs more than escaping the window to be true: mint_widget_link
-- inserts a second row rather than touching the first, so a row that is
-- merely outside the two-minute look-back is still live -- unexpired,
-- unconsumed -- and would still consume successfully. The window is a resend
-- guard, not an invalidation of what came before it; only expires_at and
-- consumed_at ever gate consume_widget_link (assertion 9 covers expiry on its
-- own). So an "old" link here is backdated on BOTH columns -- created_at,
-- which is what the window itself reads, and expires_at, which is the only
-- column that actually makes a row stop working -- the concrete, honest
-- shape of a link nobody used in time.
-- ---------------------------------------------------------------------------
create temporary table t5_first as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000715', 'MENU') as code;

update public.widget_link_tokens
   set created_at = now() - interval '5 minutes',
       expires_at = now() - interval '1 minute'
 where token_hash = encode(extensions.digest((select code from t5_first), 'sha256'), 'hex');

create temporary table t5_second as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000715', 'MENU') as code;

select ok(
  (select code from t5_second) is not null
  and (select code from t5_second) <> (select code from t5_first)
  and (public.consume_widget_link((select code from t5_first)) ->> 'ok') = 'false',
  'minting after the window returns a fresh code, and a link that old -- past both the window and its own expiry -- no longer consumes');

-- ---------------------------------------------------------------------------
-- 6. consume_widget_link answers the claims and burns the row.
-- ---------------------------------------------------------------------------
create temporary table t6_mint as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000716', 'MENU') as code;
create temporary table t6_consume as
select public.consume_widget_link((select code from t6_mint)) as claims;

select ok(
  (select claims ->> 'ok' from t6_consume) = 'true'
  and (select claims ->> 'public_key' from t6_consume) = 'pw_7777000011112222333344'
  and (select (claims ->> 'company_id')::uuid from t6_consume) = '00000000-0000-0000-0000-000000000702'
  and (select (claims ->> 'organization_id')::uuid from t6_consume) = '00000000-0000-0000-0000-000000000701'
  and (select (claims ->> 'member_id')::uuid from t6_consume) = '00000000-0000-0000-0000-000000000716'
  and (select claims ->> 'purpose' from t6_consume) = 'MENU'
  and (select claims -> 'promotion_id' from t6_consume) = 'null'::jsonb
  and (
    select consumed_at is not null from public.widget_link_tokens
     where token_hash = encode(extensions.digest((select code from t6_mint), 'sha256'), 'hex')
  ),
  'consume_widget_link answers the full set of claims and marks the row consumed');

-- ---------------------------------------------------------------------------
-- 7. The sequential second consume -- one session, one code, already spent by
-- assertion 6. Both used and unknown fold into the same 'unusable' answer
-- consume_widget_link's own comment argues for, so this is the answer, not
-- a distinct 'already_used'.
-- ---------------------------------------------------------------------------
select is(
  public.consume_widget_link((select code from t6_mint)) ->> 'reason',
  'unusable',
  'a second consume of the same code refuses -- folded with expired and unknown into one answer, on purpose');

-- ---------------------------------------------------------------------------
-- 9. Expiry is fifteen minutes, checked directly rather than only inferred
-- from the backdated case below -- a wrong constant that still eventually
-- expires would otherwise pass unnoticed. Then the clock is moved rather than
-- waited on, the technique 40_widget_verification already uses for its own
-- expiry case.
-- ---------------------------------------------------------------------------
create temporary table t9_mint as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000719', 'MUSIC') as code;

create temporary table t9_gap as
select expires_at - created_at as gap
  from public.widget_link_tokens
 where token_hash = encode(extensions.digest((select code from t9_mint), 'sha256'), 'hex');

update public.widget_link_tokens
   set expires_at = now() - interval '1 minute'
 where token_hash = encode(extensions.digest((select code from t9_mint), 'sha256'), 'hex');

select ok(
  (select gap from t9_gap) between interval '14 minutes 55 seconds' and interval '15 minutes 5 seconds'
  and (public.consume_widget_link((select code from t9_mint)) ->> 'reason') = 'unusable',
  'expiry is fifteen minutes from mint, and a code past it refuses -- the same unusable answer as used and unknown');

-- ---------------------------------------------------------------------------
-- 10. An installation switched off since minting is a configuration an
-- operator can act on, so it is refused separately from 'unusable'.
-- ---------------------------------------------------------------------------
create temporary table t10_mint as
select public.mint_widget_link(
  '00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000720', 'MENU') as code;

update public.widget_installations
   set enabled = false
 where id = '00000000-0000-0000-0000-000000000703';

select is(
  public.consume_widget_link((select code from t10_mint)) ->> 'reason',
  'unavailable',
  'a code for an installation disabled since minting refuses separately, as unavailable rather than unusable');

select * from finish();
rollback;
