import { describe, expect, it } from 'vitest';
import { provenanceLines, visibleColumns } from '@/lib/reports/provenance';

const base = {
  reportType: 'PARTICIPATIONS' as const,
  stationNames: ['Station One'],
  filters: { promotion_id: 'abc', from: '2026-08-01' },
  requestedByLabel: 'Ana',
  requestedAt: '2026-08-05T12:00:00Z',
  rowCount: 12,
};

describe('the provenance block', () => {
  it('names every withheld column and the permission that would carry it', () => {
    const lines = provenanceLines({
      ...base,
      withheld: ['name', 'phone', 'cpf_last_digits'],
    });
    const text = lines.join('\n');

    expect(text).toContain('name (needs members.view)');
    expect(text).toContain('phone (needs members.view)');
    expect(text).toContain('cpf_last_digits (needs members.view)');
    // The distinction the whole contract rests on, said in the file itself.
    expect(text).toContain('ABSENT from this file rather than empty');
  });

  /**
   * Silence is the failure mode. A file that says nothing about withholding is
   * indistinguishable from one that quietly dropped a column -- so "nothing was
   * withheld" has to be stated, not implied by an absent line.
   */
  it('says so explicitly when nothing was withheld', () => {
    const text = provenanceLines({ ...base, withheld: [] }).join('\n');
    expect(text).toContain('Withheld columns: none');
    expect(text).toContain('every column of this report');
  });

  it('carries the report, the stations, the filters, the requester and the count', () => {
    const text = provenanceLines({ ...base, withheld: [] }).join('\n');
    expect(text).toContain('Participations');
    expect(text).toContain('Station One');
    expect(text).toContain('promotion_id=abc');
    expect(text).toContain('Ana');
    expect(text).toContain('Rows: 12');
  });

  it('says "none" rather than an empty list when there are no filters', () => {
    const text = provenanceLines({ ...base, filters: {}, withheld: [] }).join('\n');
    expect(text).toContain('Filters: none');
  });
});

describe('visibleColumns', () => {
  it('drops exactly the withheld keys and keeps the order of the rest', () => {
    const columns = visibleColumns('PARTICIPATIONS', ['name', 'phone', 'cpf_last_digits']);
    const keys = columns.map((column) => column.key);

    expect(keys).not.toContain('name');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('cpf_last_digits');
    expect(keys).toEqual(['station', 'promotion', 'status', 'source', 'participated_at']);
  });

  it('keeps every column when nothing is withheld', () => {
    expect(visibleColumns('PARTICIPATIONS', [])).toHaveLength(8);
  });
});
