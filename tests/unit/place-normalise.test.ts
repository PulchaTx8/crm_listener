import { describe, expect, it } from 'vitest';
import { normalisePlaceKey } from '@/lib/places/normalise';

/**
 * Block 28. The key is the whole cache. Get it wrong one way and every listener
 * is a separate place — one geocode each, and a map of one-listener dots. Get it
 * wrong the other and two different Cohabs share a coordinate, which is worse,
 * because it is wrong and looks right.
 */
describe('normalisePlaceKey', () => {
  it('is the exact string 0214 s member_place_key builds, character for character', () => {
    // THE ONE ASSERTION THAT HOLDS TWO LANGUAGES TOGETHER. 0214's
    // member_place_key computes this same key in SQL, because 0215's aggregates
    // group listeners by it and the drain writes rows keyed by it — and no
    // compiler, linter or type sees both sides. So both are pinned to this
    // literal, and 61_places.test.sql asserts it in Postgres.
    //
    // If they ever drift, nothing throws: every listener simply fails to match
    // a place row, the map renders empty, and the coverage line says 0 of N.
    // That is a bug with no error message, which is why it is pinned rather
    // than described.
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Cohab' }),
    ).toBe('c:br|s:ma|t:sao luis|n:cohab');
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: null }),
    ).toBe('c:br|s:ma|t:sao luis');
  });

  it('folds case, accents and whitespace into one key', () => {
    const a = normalisePlaceKey({
      country: 'BR',
      state: 'MA',
      city: 'São Luís',
      neighbourhood: 'Cohab',
    });
    const b = normalisePlaceKey({
      country: 'br',
      state: 'ma',
      city: 'SAO LUIS',
      neighbourhood: '  COHAB ',
    });
    expect(a).toBe(b);
  });

  it('keeps two different cities apart even when the neighbourhood matches', () => {
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Centro' }),
    ).not.toBe(
      normalisePlaceKey({ country: 'BR', state: 'SP', city: 'Santos', neighbourhood: 'Centro' }),
    );
  });

  it('drops the noise a person types in front of a name', () => {
    expect(
      normalisePlaceKey({
        country: 'BR',
        state: 'MA',
        city: 'São Luís',
        neighbourhood: 'Bairro da Cohab',
      }),
    ).toBe(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: 'Cohab' }),
    );
  });

  it('does not treat "Vila" as noise, because it is part of the name', () => {
    // "Vila Nova" is a neighbourhood called Vila Nova, not a "Nova" with a word
    // in front of it. Stripping it would merge every Vila X with every X.
    expect(
      normalisePlaceKey({ country: 'BR', state: 'SP', city: 'Santos', neighbourhood: 'Vila Nova' }),
    ).not.toBe(
      normalisePlaceKey({ country: 'BR', state: 'SP', city: 'Santos', neighbourhood: 'Nova' }),
    );
  });

  it('treats a missing neighbourhood as a city-level place, not as an empty one', () => {
    const cityOnly = normalisePlaceKey({
      country: 'BR',
      state: 'MA',
      city: 'São Luís',
      neighbourhood: null,
    });
    // A key with an empty slot in it would be a place whose neighbourhood is
    // the empty string, which is not a place.
    expect(cityOnly).not.toContain('||');
  });

  it('treats a blank neighbourhood as a missing one', () => {
    // THIS IS A DECISION, and it reverses what the plan proposed. Every text
    // column this key is built from is written through `nullif(btrim(x), '')`
    // at its own door (0213, 0171, 0074), so a stored '' is not a state this
    // schema can reach — and if some future path did produce one, telling it
    // apart from null would split one city into two dots on the map for a
    // difference no operator could see or fix. Same place, same key.
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: '' }),
    ).toBe(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: null }),
    );
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: '   ' }),
    ).toBe(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: null }),
    );
  });

  it('does not let an absent part slide the remaining ones into its place', () => {
    // The trap positional joining sets: with the parts simply concatenated and
    // the empty ones dropped, {BR, null, 'MA'} and {BR, 'MA', null} both become
    // "br|ma" — a state read as a city. Labelled segments are why this passes.
    const stateOnly = normalisePlaceKey({
      country: 'BR',
      state: 'MA',
      city: null,
      neighbourhood: null,
    });
    const cityCalledMA = normalisePlaceKey({
      country: 'BR',
      state: null,
      city: 'MA',
      neighbourhood: null,
    });
    expect(stateOnly).not.toBe(cityCalledMA);
  });

  it('is empty when there is no place at all, so a caller can tell there is nothing to look up', () => {
    expect(normalisePlaceKey({ country: null, state: null, city: null, neighbourhood: null })).toBe(
      '',
    );
  });

  it('collapses runs of inner whitespace, so one typed space cannot make a second place', () => {
    expect(
      normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São  Luís', neighbourhood: null }),
    ).toBe(normalisePlaceKey({ country: 'BR', state: 'MA', city: 'São Luís', neighbourhood: null }));
  });
});
