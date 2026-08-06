-- Block 12a, D2. The interface language, chosen by the person reading.
--
-- NULL means "never chose", which is a different thing from "chose English":
-- the resolution order is the profile, then this browser's cookie, then what
-- the browser asks for, then English. A default of 'en' here would swallow the
-- middle two before either was ever consulted.
--
-- IT GOVERNS WHAT SOMEBODY READS AND NOTHING ELSE (D1). No stored value is ever
-- rewritten because a person switched language; what they typed is theirs, in
-- whatever alphabet they typed it. That is why this block adds one column to
-- one table and no language columns anywhere else.
alter table public.profiles
  add column locale text
  constraint profiles_locale_supported check (locale in ('en', 'pt', 'es'));

comment on column public.profiles.locale is
  'Block 12a. The interface language this person chose, which follows them to any browser. NULL means they never chose. It decides what they READ -- never what is stored, ordered or matched.';

-- The UPDATE grant on this table is COLUMN-SCOPED: 0006 grants
-- `update (full_name)` and nothing else. A new column is therefore writable by
-- nobody until it is named here, and the failure mode is the quiet one -- an
-- update that touches no granted column is not an error, it is zero rows, so
-- the Server Action reports success and the choice simply does not persist.
--
-- Only this column. `must_change_password` and `provisional_expires_at` gate
-- the account, and the account they gate does not get to write them.
grant update (locale) on public.profiles to authenticated;
