-- supabase/migrations/0260_international_phone.sql

-- Block 30d, item 1b. One canonical shape for a telephone number: the
-- international form, digits only.
--
-- THE PREFIX CANNOT DECIDE, AND THAT IS THE WHOLE DESIGN. Brazil's country
-- code is 55 and Santa Maria's area code is also 55, so '5599998888' is a
-- NATIONAL number that opens with its own country's code. Only the length
-- separates the two, which is the rule whatsapp_local_phone (0062) already
-- applies in the other direction: it strips 55 at lengths 12 and 13 and never
-- at 10 or 11.
--
-- A ROW EXISTS ONLY FOR A COUNTRY WHOSE NATIONAL NUMBERING WAS VERIFIED, and
-- everything else is returned unchanged. That is deliberate and it is the safe
-- direction: an untouched number is no worse than what this database stores
-- today, while a wrong prefix would create exactly the duplicate listener this
-- item exists to stop. Adding a country is one row here plus its case in
-- supabase/tests/72_international_phone.test.sql.
create or replace function public.country_phone_rule(p_alpha2 text)
returns table (calling_code text, national_min integer, national_max integer)
language sql
immutable
set search_path = pg_catalog, public
as $$
  select r.calling_code, r.national_min, r.national_max
  from (values
    ('BR', '55',  10, 11),
    ('PT', '351',  9,  9),
    ('ES', '34',   9,  9),
    ('US', '1',   10, 10),
    ('CA', '1',   10, 10)
  ) as r(alpha2, calling_code, national_min, national_max)
  where r.alpha2 = upper(btrim(coalesce(p_alpha2, '')));
$$;

comment on function public.country_phone_rule(text) is
  'The calling code and the national length range for one ISO 3166-1 alpha-2 country, or no row. Holds only countries whose national numbering has been verified -- international_phone returns the digits unchanged for every other, which is why an absent row is a safe answer rather than a gap. US and CA share calling code 1 on purpose: this function composes numbers and never decomposes them, so the many-to-one is not an ambiguity here.';

-- The digits as the Cloud API wants them, or the digits unchanged when no rule
-- can decide.
--
-- THE INTERNATIONAL RANGE IS TESTED FIRST. For every rule here the two ranges
-- are disjoint (Brazil: 12-13 international against 10-11 national), so the
-- order is not load-bearing today -- it is stated so that a country added later
-- with overlapping ranges fails towards leaving a number alone rather than
-- towards prefixing one that already has a prefix.
create or replace function public.international_phone(p_phone text, p_country text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_digits text := public.normalize_phone(p_phone);
  v_rule   record;
begin
  if v_digits is null then
    return null;
  end if;

  select * into v_rule from public.country_phone_rule(p_country);
  if not found then
    return v_digits;
  end if;

  if length(v_digits) between length(v_rule.calling_code) + v_rule.national_min
                          and length(v_rule.calling_code) + v_rule.national_max
     and left(v_digits, length(v_rule.calling_code)) = v_rule.calling_code then
    return '+' || v_digits;
  end if;

  if length(v_digits) between v_rule.national_min and v_rule.national_max then
    return '+' || v_rule.calling_code || v_digits;
  end if;

  return v_digits;
end;
$$;

comment on function public.international_phone(text, text) is
  'One telephone number in the form this database already stores: a leading plus, then the country code, then the national number, and no other punctuation -- the shape every members.phone row in production already carries. Goes through normalize_phone (0031) for the comparison rather than stripping punctuation itself, so it cannot drift from members.phone_normalized, the generated column whose value decides who is who; that column drops the plus, so identity is unaffected by it. IDEMPOTENT: running this over its own output returns the same string, which is what makes the 0262 repair safe to re-run. Returns the digits UNCHANGED AND UNPREFIXED when country_phone_rule has no row for the country and when the length matches neither range -- refusing would stop a listener registering because an administrator left a select empty, guessing would split one person into two rows, and a plus in front of a number whose country nobody established would be a claim this function has not earned. Block 30d, item 1b: the doors that write a phone all call this, so the widget, the console, the spreadsheet and the bot cannot come to disagree about what a number is.';

revoke execute on function public.country_phone_rule(text) from public;
revoke execute on function public.international_phone(text, text) from public;
grant execute on function public.country_phone_rule(text) to authenticated, service_role;
grant execute on function public.international_phone(text, text) to authenticated, service_role;
