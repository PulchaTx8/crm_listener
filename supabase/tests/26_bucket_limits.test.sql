begin;
select plan(5);

-- Block 11b, D7. The bucket is the barrier no client goes around.
--
-- Asserted because configuration nobody asserts is configuration that returns
-- to its default on the next `db reset` -- and this one is invisible when it
-- does: an upload simply starts succeeding again.

select is(
  (select file_size_limit from storage.buckets where id = 'delivery-receipts'),
  10485760::bigint,
  'a delivery receipt may be ten megabytes at most');

select ok(
  (select allowed_mime_types from storage.buckets where id = 'delivery-receipts')
    @> array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
  'a delivery receipt is a photograph or a scan');

select ok(
  not ((select allowed_mime_types from storage.buckets where id = 'delivery-receipts')
    && array['text/html', 'image/svg+xml', 'application/octet-stream']),
  'and never anything a browser would run');

select is(
  (select file_size_limit from storage.buckets where id = 'reports'),
  104857600::bigint,
  'a report has a runaway wall at a hundred megabytes');

-- Deliberately no list here. Its content type comes from a frozen server-side
-- map, one of whose values is `text/csv; charset=utf-8` -- a parameterised type
-- an allow-list of `text/csv` may refuse. A check that can only break a working
-- export buys the opposite of safety.
select is(
  (select allowed_mime_types from storage.buckets where id = 'reports'),
  null,
  'the reports bucket carries no MIME list, deliberately');

select * from finish();
rollback;
