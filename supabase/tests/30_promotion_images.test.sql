begin;
select plan(14);

-- Block 14. A promotion's two pictures, and the one rule that decides the shape
-- of everything else: neither is writable through update_promotion.

-- Structure ------------------------------------------------------------------

select has_column('public', 'promotions', 'thumb_url', 'a promotion has a thumb');
select col_is_null('public', 'promotions', 'thumb_url', 'and may have none');

-- THE ASSERTION THIS BLOCK EXISTS FOR. update_promotion replaces every field it
-- takes on every call. With the banner uploaded rather than typed, a p_art_url
-- still on that function would be written null by every ordinary Save -- a
-- promotion whose banner disappears when somebody fixes a typo in its name.
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_promotion', 'update_promotion')
      and 'p_art_url' = any(p.proargnames)),
  0::bigint,
  'the art left both promotion write doors, so a Save cannot delete a banner');

select is(
  (select count(*) from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('set_promotion_thumb', 'set_promotion_art')
      and grantee = 'anon'),
  0::bigint,
  'neither setter is reachable by anon -- the hole 0050 closed for Block 4a');

-- Fixtures -------------------------------------------------------------------

insert into public.organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000d1', 'Org images');
insert into public.companies (id, organization_id, name, timezone) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1',
   'Station images', 'America/Sao_Paulo');

insert into public.promotions
  (id, organization_id, company_id, name, starts_at, ends_at)
values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000e1', 'Pictured', '2026-09-01Z', '2026-09-30Z');

-- The relaxed https rule ------------------------------------------------------
--
-- 0144 widened promotions_art_https to accept loopback, because the address is
-- now built by the server from NEXT_PUBLIC_SUPABASE_URL and in development that
-- origin is http://127.0.0.1:54321. Asserted in both directions: a relaxation
-- nobody measures is one that quietly becomes "any http at all".

select lives_ok(
  $$update public.promotions
       set whatsapp_enabled = true, hashtag = '#PIC',
           use_art = true,
           art_url = 'http://127.0.0.1:54321/storage/v1/object/public/artwork/x?v=1'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'a loopback address is accepted, because development''s Storage is http');

select throws_ok(
  $$update public.promotions
       set art_url = 'http://example.com/banner.jpg'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null,
  'and any other http host is still refused, which is what Meta will not fetch');

select lives_ok(
  $$update public.promotions
       set art_url = 'https://example.com/banner.jpg'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  'https is accepted as it always was');

select throws_ok(
  $$update public.promotions
       set thumb_url = 'not-an-address'
     where id = '00000000-0000-0000-0000-0000000000f1'$$,
  '23514', null,
  'a thumb that is not an address at all is refused');

-- enqueue_artwork_erasure -----------------------------------------------------
--
-- 0087 has no give-up threshold by design, so a queued key that names nothing
-- retries for ever. That is why this function proves the address before
-- queueing rather than deriving the key and hoping.

select lives_ok(
  $$select public.enqueue_artwork_erasure(
      'https://x.supabase.co/storage/v1/object/public/artwork/promotion-banners/'
        || '00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000f1?v=1',
      'promotion-banners/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000f1')$$,
  'our own address is queued');

select is(
  (select count(*) from public.storage_erasure_queue where bucket = 'artwork'),
  1::bigint,
  'and exactly one row was written');

select lives_ok(
  $$select public.enqueue_artwork_erasure(
      'https://someone-elses-server.example/banner.jpg',
      'promotion-banners/00000000-0000-0000-0000-0000000000e1/00000000-0000-0000-0000-0000000000f1')$$,
  'an address hosted elsewhere is accepted quietly');

select is(
  (select count(*) from public.storage_erasure_queue where bucket = 'artwork'),
  1::bigint,
  'and queued nothing, because a key naming no object would retry for ever');

-- set_promotion_art's own refusal --------------------------------------------
--
-- promotions_whatsapp_shape does not admit a banner on a promotion that does
-- not use WhatsApp. Refused with a sentence, because a constraint failure
-- reaches the operator as "could not save" with no field to point at.
--
-- No session is established here, so has_permission answers false and the
-- permission check fires first. That is what this pair actually proves -- the
-- gate is BEFORE the work, in the order attach_delivery_receipt established.

select throws_ok(
  $$select public.set_promotion_art('00000000-0000-0000-0000-0000000000f1', 'https://x/y')$$,
  '42501', null,
  'a caller without promotions.edit is refused before anything is written');

select throws_ok(
  $$select public.set_promotion_thumb('00000000-0000-0000-0000-000000000fff', 'https://x/y')$$,
  'P0002', null,
  'a promotion that is not there is P0002, not a silent no-op');

select * from finish();
rollback;
