/**
 * Block 17a. Parses the origin allowlist a Station's operator types into the
 * console's Widget tab, and turns a validated list into the frame-ancestors
 * value `buildContentSecurityPolicy` (src/lib/security/csp.ts) puts on the
 * wire for the `/w/<publicKey>` route.
 *
 * ORIGIN_PATTERN below is not this file's invention: it is
 * `public.are_origins`'s CHECK, `supabase/migrations/0159_widget_installations
 * .sql`, copied character for character (the only difference is the `\/`
 * escaping a JS regex LITERAL forces on the two literal slashes in
 * "https?://" -- Postgres's regex has no delimiter to escape them for). If
 * the two patterns ever disagree, an operator can type an origin the console
 * accepts and the database refuses -- or worse, the reverse, on whichever
 * other write path skips this parser. One pattern in one place would remove
 * the risk outright, but the CHECK runs in SQL and this has to run in Node
 * before the console even attempts the write, so the string is duplicated on
 * purpose and this comment is what has to keep the two copies honest.
 */
const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

export type ParseOriginsResult =
  | { ok: true; origins: string[] }
  | { ok: false; bad: string };

/**
 * Splits on newline or comma, trims each entry, and validates every one
 * against ORIGIN_PATTERN: a scheme and a host, with an optional port, and
 * NOTHING else -- no path, no trailing slash, no query string. A trailing
 * slash never matches what a browser sends as the ancestor origin, and the
 * failure it causes is "the widget does not load", which nothing logs and no
 * screen shows -- so this refuses at the console instead of failing
 * invisibly at the database CHECK, or worse, in a visitor's browser.
 *
 * Stops at the FIRST invalid entry and names it back, rather than collecting
 * every bad one: the console has a single text field to report against, and
 * an operator fixing one line will hit the next bad line on the next save
 * regardless -- collecting a list here would only add a shape nobody reads.
 *
 * Blank lines are dropped rather than treated as a bad entry. A textarea
 * with trailing whitespace is an artefact of typing, not an operator naming
 * "" as an origin, and refusing it would name an empty string back at them,
 * which tells them nothing they could act on.
 */
export function parseOrigins(input: string): ParseOriginsResult {
  const entries = input
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (!ORIGIN_PATTERN.test(entry)) return { ok: false, bad: entry };
  }

  return { ok: true, origins: entries };
}

/**
 * The frame-ancestors value for an already-validated origin list.
 *
 * THE REFUSAL IS THE DEFAULT. An empty list returns 'none', never a wildcard
 * -- the one thing this function must never do is turn "unconfigured" into
 * "anywhere". The tempting shortcut is
 * `origins.length ? origins.join(' ') : '*'`, read as "stay open until
 * somebody configures it" -- and it is exactly backwards: it would make
 * every widget on the product embeddable from any site on the internet the
 * moment an installation exists with no origins set, or the moment a lookup
 * fails and returns an empty list by accident, and nothing on any screen
 * would say so. `allowed_origins`'s own column comment (0159) states the
 * same rule at the database layer: empty means nowhere, not any.
 */
export function frameAncestorsValue(origins: string[]): string {
  if (origins.length === 0) return "'none'";
  return origins.join(' ');
}
