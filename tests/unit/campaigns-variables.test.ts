import { describe, expect, it } from 'vitest';

/**
 * Block 29d-2, Task 7 addendum, section 3. The two channels do not share a
 * variable notation, and this is the resolver that builds each shape: a
 * positional string[] for WHATSAPP (in the template's own `variables` order)
 * and a named {name, value}[] for EMAIL (one entry per placeholder the
 * body/subject actually names). Both are PURE functions -- no I/O, nothing to
 * fake -- so they are proven directly here rather than through a Supabase
 * fake the way tests/unit/campaign-drain.test.ts proves drainCampaigns'
 * orchestration.
 *
 * `NEXT_PUBLIC_SITE_URL` is set before the dynamic import for the same
 * reason tests/unit/campaign-drain.test.ts sets it: `@/services/campaigns`
 * reaches `@/lib/env` at module load (through resolveMailer/
 * resolveWhatsAppTransport, this file's own env-resolved seams), and `env`
 * is computed once, from `process.env`, the instant that module is imported.
 */
process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.test';

const { buildWhatsAppVariableValues, buildEmailVariableValues, extractEmailVariables, UnresolvableEmailPlaceholderError } =
  await import('@/services/campaigns');

const STATION_NAME = 'Radio Nova';

describe('buildWhatsAppVariableValues', () => {
  it("resolves each of the four campaign-resolvable values, in the template's own order", () => {
    const values = buildWhatsAppVariableValues(
      ['LISTENER_FIRST_NAME', 'LISTENER_FULL_NAME', 'LISTENER_CITY', 'STATION_NAME'],
      { fullName: 'Maria Silva', city: 'Recife' },
      STATION_NAME,
    );
    expect(values).toEqual(['Maria', 'Maria Silva', 'Recife', 'Radio Nova']);
  });

  it('repeats a variable in the array once per position it holds, positionally', () => {
    // A template that greets by name twice: {{1}} and {{3}} both name
    // LISTENER_FIRST_NAME. The order this function returns must be the
    // order the template's own `variables` column holds, not deduplicated --
    // deduplicating here would desynchronise the array from the {{n}}
    // positions the body actually uses.
    const values = buildWhatsAppVariableValues(
      ['LISTENER_FIRST_NAME', 'STATION_NAME', 'LISTENER_FIRST_NAME'],
      { fullName: 'Ana', city: null },
      STATION_NAME,
    );
    expect(values).toEqual(['Ana', 'Radio Nova', 'Ana']);
  });

  it('splits the first name on the first run of whitespace, mirroring split_part(btrim(...), \' \', 1) (0112)', () => {
    const values = buildWhatsAppVariableValues(
      ['LISTENER_FIRST_NAME'],
      { fullName: '  Maria   Aparecida Silva ', city: null },
      STATION_NAME,
    );
    expect(values).toEqual(['Maria']);
  });

  it('resolves a missing full_name or city to an empty string, never a placeholder throw', () => {
    const values = buildWhatsAppVariableValues(
      ['LISTENER_FIRST_NAME', 'LISTENER_FULL_NAME', 'LISTENER_CITY'],
      { fullName: null, city: null },
      STATION_NAME,
    );
    expect(values).toEqual(['', '', '']);
  });

  it('returns an empty array for a fixed-text template with no positions at all', () => {
    expect(buildWhatsAppVariableValues([], { fullName: 'Ana', city: 'Recife' }, STATION_NAME)).toEqual([]);
  });
});

describe('extractEmailVariables', () => {
  it('finds every campaign-resolvable placeholder the body and subject name, deduplicated', () => {
    const found = extractEmailVariables(
      'Oi {{listener_first_name}}, tudo bem? Vem de {{station_name}}!',
      'Novidades da {{station_name}} para {{listener_first_name}}',
    );
    // One entry per DISTINCT variable, not per occurrence -- each name
    // appears twice across body+subject above.
    expect([...found].sort()).toEqual(['LISTENER_FIRST_NAME', 'STATION_NAME'].sort());
  });

  it('matches case-insensitively, the same rule save_marketing_template (0225) and its own schema apply at save time', () => {
    const found = extractEmailVariables('Oi {{Listener_First_Name}}!', '');
    expect(found).toEqual(['LISTENER_FIRST_NAME']);
  });

  it('returns an empty array for a body and subject with no placeholders at all', () => {
    expect(extractEmailVariables('Oi, tudo bem?', 'Novidades')).toEqual([]);
  });

  /**
   * Fix round 1, F7. THE GENUINELY REACHABLE CASE, not merely defensive:
   * save_marketing_template (0225) and marketingTemplateSchema (schemas/
   * templates.ts) both validate a saved EMAIL template's BODY only -- never
   * its SUBJECT -- so a template with a clean body and a subject naming an
   * unresolvable placeholder saves successfully through the ordinary
   * screen, and this is the first place that ever notices.
   */
  it('throws for an unresolvable placeholder in the SUBJECT alone, with a clean body -- the case save time never catches', () => {
    expect(() => extractEmailVariables('Oi, tudo bem?', 'Oferta de {{prize_name}} só hoje')).toThrow(
      UnresolvableEmailPlaceholderError,
    );
  });

  it('throws UnresolvableEmailPlaceholderError for a name outside the campaign-resolvable vocabulary (a SYSTEM-only value)', () => {
    // PRIZE_NAME is a real template_variable (0222) but CAMPAIGN_RESOLVABLE
    // marks it false -- a campaign has no source for it (src/lib/templates/
    // variables.ts's own comment). marketingTemplateSchema (schemas/
    // templates.ts) and save_marketing_template (0225) both already refuse
    // this at save time; this is the defence for a row that bypassed both.
    expect(() => extractEmailVariables('Você ganhou {{prize_name}}!', '')).toThrow(
      UnresolvableEmailPlaceholderError,
    );
  });

  it('throws UnresolvableEmailPlaceholderError for a name outside the whole template_variable vocabulary, naming which one', () => {
    expect(() => extractEmailVariables('Oi {{not_a_real_variable}}', '')).toThrow(
      UnresolvableEmailPlaceholderError,
    );
    // The captured name travels with the error, so the Server Action can
    // show the operator WHICH placeholder is the problem (fix round 1, F7).
    try {
      extractEmailVariables('Oi {{not_a_real_variable}}', '');
      throw new Error('expected extractEmailVariables to throw');
    } catch (cause) {
      expect(cause).toBeInstanceOf(UnresolvableEmailPlaceholderError);
      expect((cause as InstanceType<typeof UnresolvableEmailPlaceholderError>).placeholder).toBe(
        'not_a_real_variable',
      );
    }
  });
});

describe('buildEmailVariableValues', () => {
  it('returns one {name, value} pair per used variable, name lower-cased to match the body\'s own notation', () => {
    const values = buildEmailVariableValues(
      ['LISTENER_FIRST_NAME', 'STATION_NAME'],
      { fullName: 'Maria Silva', city: null },
      STATION_NAME,
    );
    expect(values).toEqual([
      { name: 'listener_first_name', value: 'Maria' },
      { name: 'station_name', value: 'Radio Nova' },
    ]);
  });

  it('resolves a missing field to an empty-string value rather than omitting the entry', () => {
    // Omitting the entry would make substitutePlaceholders (this file's own
    // drain code) treat the placeholder as UNRESOLVED (a hard failure) rather
    // than resolved-but-blank -- two different outcomes for what is really
    // one fact, a listener with no city on file.
    const values = buildEmailVariableValues(['LISTENER_CITY'], { fullName: 'Ana', city: null }, STATION_NAME);
    expect(values).toEqual([{ name: 'listener_city', value: '' }]);
  });
});
