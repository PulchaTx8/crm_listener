-- supabase/migrations/0210_songwriters_rename.sql

-- Block 28. The table and the column Block 27 named for a category.
--
-- INVENTORY IS NOT TOUCHED. public.prize_categories, prizes.category_id,
-- save_prize_category and archive_prize_category keep their names: that is a
-- different domain governed by inventory.catalogue, and 0205's own table
-- comment records that the two were kept apart deliberately. The two words were
-- always going to look like one thing to a find-and-replace; they are not.
--
-- The indexes, constraints and the policy are renamed too — including the three
-- Postgres named for us (pkey and the two column fkeys), which the eye finds
-- just as fast in a \d. Leaving any of them would put "category" in eleven
-- places a reader would meet while looking for why the table is called
-- something else.

alter table public.music_categories rename to songwriters;

alter table public.songwriters
  rename constraint music_categories_company_org_fk to songwriters_company_org_fk;
alter table public.songwriters
  rename constraint music_categories_name_not_blank to songwriters_name_not_blank;
alter table public.songwriters
  rename constraint music_categories_id_company_unique to songwriters_id_company_unique;
alter table public.songwriters
  rename constraint music_categories_pkey to songwriters_pkey;
alter table public.songwriters
  rename constraint music_categories_created_by_fkey to songwriters_created_by_fkey;
alter table public.songwriters
  rename constraint music_categories_organization_id_fkey to songwriters_organization_id_fkey;

alter index public.music_categories_legacy_unique rename to songwriters_legacy_unique;
alter index public.music_categories_company_idx   rename to songwriters_company_idx;

alter policy music_categories_select_music_view on public.songwriters
  rename to songwriters_select_music_view;

comment on table public.songwriters is
  'The people who WROTE a Station''s songs, one per song (Block 28, D3). Shipped in Block 27 as music_categories and renamed here: the owner meant songwriter, and a schema saying one thing while the screen says another is a misreading waiting for whoever reads it next. Names are deliberately not unique, the same D2/D3 ruling music_genres carries. NOT public.prize_categories, which is a different domain governed by inventory.catalogue.';

alter table public.songs rename column category_id to songwriter_id;

alter table public.songs
  rename constraint songs_category_company_fk to songs_songwriter_company_fk;
alter index public.songs_category_idx rename to songs_songwriter_idx;

comment on column public.songs.songwriter_id is
  'Block 27 as category_id, Block 28 under its right name. Nullable: the whole catalogue predates the column, so requiring one would make every existing song unsavable — the same reason label_id and genre_id are nullable (0098).';
