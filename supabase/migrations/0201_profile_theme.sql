-- supabase/migrations/0201_profile_theme.sql

-- Block 25, D6. The interface theme, chosen by the person reading.
--
-- NULL MEANS SYSTEM, and it also means "never chose" — the two are deliberately
-- not told apart, which is the same ruling 0135 made for `locale`. They resolve
-- identically (no class on <html>, and the browser's own
-- prefers-color-scheme answers), so a third stored value would be a distinction
-- nothing downstream could act on.
--
-- Only 'light' and 'dark' are storable, therefore. A 'system' row would be a
-- value meaning exactly what its absence already means.
alter table public.profiles
  add column theme text
  constraint profiles_theme_supported check (theme in ('light', 'dark'));

comment on column public.profiles.theme is
  'Block 25. The interface theme this person chose, which follows them to any browser. NULL is System — both "I chose to follow my machine" and "I never chose", which resolve identically. It decides what they SEE and nothing else.';

-- THE LINE THIS WHOLE BLOCK FAILS SILENTLY WITHOUT.
--
-- The UPDATE grant on this table is COLUMN-SCOPED: 0006:33 grants
-- `update (full_name)` and nothing else, and 0135 had to add `update (locale)`
-- for the same reason. A new column is therefore writable by nobody until it is
-- named here.
--
-- Two failures hide behind that, and only one of them is loud. A missing column
-- grant raises 42501, which is the kind one. The quiet one belongs to RLS, which
-- refuses by MATCHING NO ROW and raises nothing at all — which is why
-- setThemeAction reads the row back rather than trusting the absence of an
-- error, exactly as setLocaleAction does.
--
-- Only this column. `must_change_password` and `provisional_expires_at` gate the
-- account, and the account they gate does not get to write them —
-- 55_profile_theme.test.sql asserts both halves, so a blanket
-- `grant update on public.profiles` would fail the suite rather than pass it.
grant update (theme) on public.profiles to authenticated;
