-- Block 11b, D7. Neither bucket has ever carried a size limit or a MIME list.
--
-- An operator can upload two gigabytes of HTML as a delivery receipt today and
-- have it served back as HTML from a signed URL, because the upload stores
-- whatever `file.type` the browser claimed (src/services/winners.ts) and the
-- bucket has no opinion at all.
--
-- HERE, AND NOT ONLY IN THE ACTION, because this is the one check no client can
-- go around. The validation added to attachReceiptAction in the same block
-- exists so the operator reads "that file is 40 MB" instead of a raw Storage
-- error; it is not the boundary and the code there says so.
update storage.buckets
   set file_size_limit    = 10485760,  -- 10 MiB: a phone photograph, comfortably
       allowed_mime_types = array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/heic',   -- what an iPhone actually uploads
         'application/pdf'
       ]
 where id = 'delivery-receipts';

-- The reports bucket gets the wall and NO list, deliberately.
--
-- Its content type comes from FORMAT_CONTENT_TYPES (src/lib/reports/types.ts),
-- a frozen server-side map no client can influence -- and one of its three
-- values is `text/csv; charset=utf-8`, a PARAMETERISED type that an allow-list
-- of `text/csv` may well refuse. Adding a check whose only possible effect is
-- to break a working export is the opposite of hardening.
--
-- 100 MiB is far above anything the 50,000-row ceiling (REPORT_ROW_CEILING) can
-- produce and still bounds a runaway.
update storage.buckets
   set file_size_limit = 104857600
 where id = 'reports';
