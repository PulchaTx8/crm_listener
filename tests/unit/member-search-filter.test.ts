import { describe, expect, it } from 'vitest';
import { quoteForOrFilter } from '@/services/members';

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
