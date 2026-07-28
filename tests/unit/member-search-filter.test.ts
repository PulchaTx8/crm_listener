import { describe, expect, it } from 'vitest';
import { escapeLikePattern, quoteForOrFilter } from '@/services/members';

/**
 * Inverts quoteForOrFilter's own escaping: strips the wrapping quotes, then
 * un-escapes `\\` and `\"` back to `\` and `"` in one left-to-right pass —
 * so each case below can assert a genuine round trip
 * (unquote(quoteForOrFilter(x)) === x) rather than merely eyeballing the
 * escaped string.
 */
function unquote(escaped: string): string {
  expect(escaped.startsWith('"')).toBe(true);
  expect(escaped.endsWith('"')).toBe(true);
  const inner = escaped.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      out += inner[i + 1];
      i++;
    } else {
      out += inner[i];
    }
  }
  return out;
}

/**
 * True only if every `"` between quoteForOrFilter's own wrapping pair is
 * itself preceded by the backslash that escapes it — a bare, unescaped `"`
 * reaching here would end the PostgREST quoted token early and hand
 * whatever follows back to filter-list syntax, which is the exact attack
 * quoting exists to close.
 */
function hasNoBareQuoteInside(escaped: string): boolean {
  const inner = escaped.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      i++; // the next character is escaped, whatever it is — skip it too
      continue;
    }
    if (inner[i] === '"') return false;
  }
  return true;
}

/**
 * A minimal, quote-aware comma counter — PostgREST's own or()-list grammar:
 * a comma inside a properly double-quoted span (escaped quotes included) is
 * not a clause separator; one outside any quoted span is. Used only to prove
 * containment in the embedding test below, not a stand-in for the real
 * filter-list parser.
 */
function countTopLevelCommas(clauseList: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < clauseList.length; i++) {
    const ch = clauseList[i];
    if (ch === '\\' && inQuotes) {
      i++; // skip the escaped character, same rule the value's own encoding uses
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) count++;
  }
  return count;
}

describe('quoteForOrFilter', () => {
  // Nine hostile PostgREST or()-filter payloads (Task 8 review) — each is a
  // plausible way a search term could try to escape the quoted value
  // quoteForOrFilter wraps it in and inject new filter-list syntax: an extra
  // clause, an early-closed group, a nested and()/or(). Every case must
  // round-trip to its own original value AND must not smuggle a bare,
  // unescaped double quote past the wrapping pair — the two things that
  // together prove the value stays a literal, not filter syntax.
  it.each([
    ['"),full_name.ilike."%', 'closes the value and the clause, opens a new ilike clause'],
    ['and(id.eq.1)', 'a bare and() group, harmless unless it escapes the quoting'],
    ['x.eq.1)', 'an unmatched closing parenthesis'],
    ['a"b', 'a single embedded double quote'],
    ['a\\b', 'a single embedded backslash'],
    ['a\\"b', 'a backslash immediately followed by a quote'],
    ['a,b', 'an embedded comma, the clause-list separator'],
    ['a(b)c', 'embedded parentheses, the clause-grouping characters'],
    ['\\"leading', 'a backslash-quote pair at the very start'],
  ])('round-trips %s (%s) with no bare quote inside', (hostile) => {
    const escaped = quoteForOrFilter(hostile);
    expect(unquote(escaped)).toBe(hostile);
    expect(hasNoBareQuoteInside(escaped)).toBe(true);
  });

  it('leaves an already-safe value wrapped but otherwise unchanged', () => {
    expect(quoteForOrFilter('plain')).toBe('"plain"');
  });

  it('stays contained when embedded in a real .or() clause list, adding no clause of its own', () => {
    // Mirrors exactly what listOrganizationMembers builds (services/
    // members.ts): several ilike clauses over one escaped, quoted value,
    // joined by top-level commas. A hostile term that broke out of its own
    // quoting would surface here as an extra top-level clause — counting
    // them, not merely inspecting the term in isolation, is what proves
    // containment in the shape the real query actually uses.
    const hostile = '"),full_name.ilike."%,or(id.eq.1';
    const wildcard = quoteForOrFilter(`%${hostile}%`);
    const clauseList = [
      `full_name.ilike.${wildcard}`,
      `phone.ilike.${wildcard}`,
      `email.ilike.${wildcard}`,
    ].join(',');
    // Three clauses joined by comma means exactly two top-level separators —
    // any more would mean the hostile value smuggled a fourth clause past
    // its own quoting.
    expect(countTopLevelCommas(clauseList)).toBe(2);
  });
});

/**
 * Decodes a backslash-escaped ILIKE pattern using the identical
 * "a backslash means the following character is literal" rule
 * escapeLikePattern's own three `.replace()` calls all produce (the same
 * shape unquote, above, already relies on for quoteForOrFilter's separate
 * escaping layer). Used only to invert escapeLikePattern for the
 * composed-pipeline tests below — not a general ILIKE pattern interpreter,
 * and correct only because escapeLikePattern never escapes anything but
 * `\`, `%` and `_`.
 */
function decodeLikeEscapes(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '\\') {
      out += pattern[i + 1];
      i++;
    } else {
      out += pattern[i];
    }
  }
  return out;
}

describe('escapeLikePattern composed with quoteForOrFilter — the actual pipeline listOrganizationMembers builds', () => {
  // A prior version of this file tested quoteForOrFilter alone: none of its
  // nine payloads contained `%`, `_` or `\`, and none went through
  // escapeLikePattern at all, so nothing in it would have failed had
  // escapeLikePattern been deleted outright (Task 8 re-review). These cases
  // exercise the real two-layer expression, `quoteForOrFilter(\`%${escapeLikePattern(term)}%\`)`,
  // and would fail if either layer's escaping regressed or if
  // escapeLikePattern's call were ever removed from that expression.
  it.each([
    ['50%', 'a literal percent — ILIKE\'s own wildcard character'],
    ['a_b', 'a literal underscore — ILIKE\'s own single-character wildcard'],
    ['a\\b', 'a literal backslash — ILIKE\'s own escape character'],
    ['50%_off\\per\\cent', 'all three combined in one term'],
    ['plain', 'no special characters, as a sanity check on the composed shape'],
  ])('matches %s (%s) as a literal substring, never as a wildcard', (term) => {
    const filterValue = quoteForOrFilter(`%${escapeLikePattern(term)}%`);

    // Layer 1: reverse quoteForOrFilter's own escaping — what PostgREST
    // would hand back as the raw ILIKE pattern text.
    const likePattern = unquote(filterValue);

    // The two wildcard markers THIS FILE adds (not the caller's term) are
    // the very first and very last characters, and must be bare — a `%`
    // that instead came from the caller's own term would survive
    // escapeLikePattern as `\%`, two characters, not one, and so could
    // never land exactly at position 0 or the very end on its own.
    expect(likePattern[0]).toBe('%');
    expect(likePattern[likePattern.length - 1]).toBe('%');

    const middle = likePattern.slice(1, -1);

    // Layer 2: reverse escapeLikePattern's own escaping on everything
    // between those two markers. If escapeLikePattern were deleted (or
    // its call in listOrganizationMembers removed), the middle would still
    // often decode back to the same text — a `%` sitting unescaped decodes
    // to itself just as `\%` does — so this alone would not always catch
    // the regression; the bare-wildcard scan below is what does.
    expect(decodeLikeEscapes(middle)).toBe(term);

    // The property that actually distinguishes "escaped" from "not
    // escaped": no BARE (unescaped) % or _ survives inside the middle. A
    // term's own % or _ must always be preceded by the backslash
    // escapeLikePattern adds — anything unescaped here would be
    // interpreted by ILIKE as a real wildcard instead of the literal
    // character the search box promised, which is exactly what removing
    // escapeLikePattern from the pipeline would cause.
    for (let i = 0; i < middle.length; i++) {
      if (middle[i] === '\\') {
        i++; // the next character is escaped, whatever it is — skip it too
        continue;
      }
      expect(middle[i]).not.toBe('%');
      expect(middle[i]).not.toBe('_');
    }
  });
});
