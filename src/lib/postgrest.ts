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
 * src/lib/keyset.ts (cursor values). This project already shipped this exact
 * escaping rule hand-copied twice in Block 3 and fixed in only one of the two
 * copies; keeping a single implementation is how that stops being possible.
 */
export function quoteForOrFilter(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
