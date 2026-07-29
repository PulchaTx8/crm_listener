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

/**
 * Escapes ILIKE's own two pattern metacharacters (`%`, `_`) — and the
 * backslash that would otherwise become their escape character — so a
 * literal `%` or `_` typed into the search box (a plausible fragment of an
 * e-mail address, for instance) is matched as that literal character rather
 * than treated as a wildcard. Without this, searching for a literal "%"
 * silently matched every row the caller could already reach, which looks
 * like a match but means something the search box never promised.
 *
 * Every caller applies it BEFORE adding the `%term%` wildcard markers, so
 * those two markers stay real wildcards while anything the caller typed does
 * not: `quoteForOrFilter(\`%${escapeLikePattern(term)}%\`)`. Both search
 * builders in this codebase do exactly that — listOrganizationMembers
 * (services/members.ts) and listPrizesPage (services/inventory.ts).
 *
 * It lived in services/members.ts until Block 3b gave the inventory list a
 * server-side search of its own; it moved here rather than being imported
 * across services, beside quoteForOrFilter, whose comment above explains why
 * this codebase keeps exactly one copy of a rule like this.
 * tests/unit/member-search-filter.test.ts exercises it composed with
 * quoteForOrFilter, which is how it is always used — a re-review found the
 * original test covered only quoteForOrFilter alone, with no case containing
 * `%`, `_` or `\`, so nothing in it would have caught this function being
 * deleted entirely.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
