-- supabase/migrations/0174_show_vocabularies.sql

-- Block 18. The two closed vocabularies a programme is described by.
--
-- Alone in this file, though NOT for the reason 0166 and 0170 were: `create
-- type` and a statement using it can share a transaction perfectly well, unlike
-- ALTER TYPE ... ADD VALUE. They are separated so the vocabulary has one place
-- to be read, and so adding a sixth kind later is a file somebody can review on
-- its own.
--
-- ENUMS RATHER THAN TEXT, and that is the owner's requirement rather than a
-- preference: filters are coming -- which requests arrived during a programme's
-- hours, how many entries came from programmes of a given age rating. A
-- free-text kind is ten spellings of "Jornalismo" and no report.

create type public.show_kind as enum
  ('MUSICAL', 'NEWS', 'TALK_SHOW', 'SPORTS', 'ENTERTAINMENT');

create type public.show_age_rating as enum ('L', '10', '12', '14', '16', '18');

comment on type public.show_kind is
  'What a programme is, Block 18 (D2). The five the owner named: Musical, Jornalismo, Talk Show, Esportes, Entretenimento. Stored in English like every other enum in this schema; the screen translates.';

comment on type public.show_age_rating is
  'Brazilian classificação indicativa, Block 18 (D1). L is Livre; the rest are the age in years, as text rather than integers so the enum reads the way the classification is written and sorts in its own declaration order.';
