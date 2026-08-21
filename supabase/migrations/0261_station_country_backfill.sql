-- supabase/migrations/0261_station_country_backfill.sql

-- Block 30d, D5. Prefixing a national telephone number needs a country, and
-- every Station that exists predates companies.country (0213, Block 28) -- all
-- six carried null when this block was written, measured 2026-08-21.
--
-- 'BR' ON THE OWNER'S CONFIRMATION of 2026-08-21 that all six are Brazilian
-- radios. It is a fact about this deployment, not a default: a Station created
-- after this gets its country from the console's select, and one that somehow
-- has none stores phone numbers exactly as it does today (international_phone
-- returns the digits unchanged), which is a smaller harm than refusing a
-- listener's registration.
update public.companies
   set country = 'BR'
 where country is null;
