/**
 * Block 28. Four columns off a listener's record, folded into the one string
 * `geocoded_places.place_key` stores and the two geography aggregates join on.
 *
 * PURE, and in `lib/` rather than in the service, because it is called from two
 * sides that must never disagree: `drainGeocodeQueue` writes rows keyed by it,
 * and 0215's aggregates group listeners by the same expression in SQL. If the
 * two ever computed different keys, every listener would look unresolved and
 * the map would be empty with no error anywhere.
 */

export interface PlaceParts {
  /** ISO 3166-1 alpha-2 (0213), or null when neither the listener nor their Station has one. */
  country: string | null;
  state: string | null;
  city: string | null;
  neighbourhood: string | null;
}

/**
 * The words a person types in front of a neighbourhood's name without meaning
 * them as part of it. Longest first, so "bairro da" is consumed before "bairro"
 * can strip half of it and leave "da cohab".
 *
 * `vila` IS NOT HERE and must not be added. "Vila Nova" is a neighbourhood
 * called Vila Nova — stripping it would merge every Vila X in the country with
 * every X, silently, and the map would show one dot where there are two places.
 * The same argument rules out `jardim`, `parque` and `conjunto`.
 */
const LEADING_NOISE = [
  'bairro do ',
  'bairro da ',
  'bairro de ',
  'bairro ',
  'barrio del ',
  'barrio de ',
  'barrio ',
];

/**
 * Lower case, accents stripped, whitespace collapsed. NFD splits a letter from
 * its combining mark and the range below removes the marks, so "São" and "SAO"
 * fold together without a hand-written character map.
 */
function fold(value: string | null): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    // U+0300..U+036F is the combining-marks block, written as escapes rather
    // than as the characters themselves: those are invisible in an editor, and
    // a range typed literally is one careless save away from being a range over
    // nothing that silently stops folding accents.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function foldNeighbourhood(value: string | null): string {
  const folded = fold(value);
  for (const prefix of LEADING_NOISE) {
    if (folded.startsWith(prefix)) return folded.slice(prefix.length).trim();
  }
  return folded;
}

/**
 * The cache key for one place, or `''` when there is no place at all.
 *
 * THE SEGMENTS ARE LABELLED, not merely joined in order, and that is the one
 * decision in this function worth defending. With the four parts concatenated
 * and the absent ones dropped, `{BR, MA, null, null}` and `{BR, null, MA, null}`
 * both come out as `br|ma` — a state and a city called the same thing sharing
 * one coordinate. Keeping the empty slots instead would put `||` in the key,
 * which reads as a neighbourhood whose name is the empty string. Labels cost a
 * few characters in a column read by machines and by the occasional person
 * debugging a map, and they make both failures impossible.
 *
 * A blank part and a missing one produce the SAME key. Every column this reads
 * is written through `nullif(btrim(x), '')` at its own door, so `''` is not a
 * state the schema can reach; treating it as distinct would split one city in
 * two for a difference nobody could see.
 */
export function normalisePlaceKey(parts: PlaceParts): string {
  const segments: string[] = [];
  const push = (label: string, value: string) => {
    if (value) segments.push(`${label}:${value}`);
  };

  push('c', fold(parts.country));
  push('s', fold(parts.state));
  push('t', fold(parts.city));
  push('n', foldNeighbourhood(parts.neighbourhood));

  return segments.join('|');
}

/**
 * The one-line address the geocoder is asked about, most specific first —
 * "Cohab, São Luís, MA, BR". Built from the RAW parts rather than the folded
 * ones: Google reads accents and mixed case perfectly well, and the fold exists
 * to make two spellings one cache entry, not to make the question worse.
 *
 * Returns `''` when there is nothing to ask about, which is the same signal
 * `normalisePlaceKey` gives and lets one guard cover both.
 */
export function placeQuery(parts: PlaceParts): string {
  return [parts.neighbourhood, parts.city, parts.state, parts.country]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(', ');
}
