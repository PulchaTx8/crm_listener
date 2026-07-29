/**
 * Escapes a value for interpolation into a PostgREST `.or()`/`.and()` filter
 * list. PostgREST's own filter-list grammar reserves comma and parenthesis
 * as separators; wrapping the whole value in double quotes suspends that
 * parsing for everything between them, and a literal double quote or
 * backslash inside the value is itself backslash-escaped first so the value
 * cannot break out of the quoting it is sitting inside.
 *
 * The one implementation for every module that builds a PostgREST filter
 * string from untrusted input — src/services/members.ts (search terms;
 * re-exported there as `quoteForOrFilter` so existing imports, including
 * tests/unit/member-search-filter.test.ts, need no change) and
 * src/lib/keyset.ts (cursor values). This particular escaping rule has only
 * ever had one implementation; the reason to keep it that way is Block 3's
 * own history with other rules, not this one: `member_reachable`'s
 * reachability rule (0035 calls it directly rather than duplicating it),
 * phone/e-mail normalisation (extracted into `normalize_phone`/
 * `normalize_email`, 0031), and `listCompanyAccess`'s rule (hand-copied once
 * into `station-access.ts`, silently dropping a `suspended` filter in the
 * process) were each hand-copied or nearly so, and each time the fix was to
 * extract one implementation. A second copy of escaping is not a
 * hypothetical risk in this codebase.
 */
export function quoteForOrFilter(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
