import { describe, expect, it } from 'vitest';
import { showFormSchema } from '@/schemas/shows';

const base = {
  companyId: '00000000-0000-0000-0000-000000000001',
  name: 'Manhã Total',
  kind: 'MUSICAL',
  ageRating: 'L',
  startsOn: '2026-01-01',
  bands: [{ days: [1, 2, 3, 4, 5], starts: '10:00', ends: '12:30' }],
};

describe('showFormSchema', () => {
  it('accepts a programme with one band', () => {
    expect(showFormSchema.safeParse(base).success).toBe(true);
  });

  /**
   * D3 and D7's required set. The columns are nullable so the four programmes
   * that predate Block 18 survive; the requirement lives here and in save_show.
   */
  it('refuses a programme missing any of the four required fields', () => {
    for (const missing of ['name', 'kind', 'ageRating', 'startsOn'] as const) {
      expect(showFormSchema.safeParse({ ...base, [missing]: '' }).success, missing).toBe(false);
    }
  });

  it('refuses a programme with no band at all', () => {
    expect(showFormSchema.safeParse({ ...base, bands: [] }).success).toBe(false);
  });

  it('refuses a band with no day ticked', () => {
    expect(
      showFormSchema.safeParse({ ...base, bands: [{ days: [], starts: '10:00', ends: '12:30' }] })
        .success,
    ).toBe(false);
  });

  it('refuses a weekday outside 1..7, which is the range the database checks', () => {
    for (const day of [0, 8, -1]) {
      expect(
        showFormSchema.safeParse({ ...base, bands: [{ days: [day], starts: '10:00', ends: '12:30' }] })
          .success,
      ).toBe(false);
    }
  });

  /**
   * The overnight case is VALID input, not an error: save_show splits it on
   * write. A form that refused it would be refusing the one shape this block
   * went to trouble to support.
   */
  it('accepts an overnight band', () => {
    expect(
      showFormSchema.safeParse({ ...base, bands: [{ days: [6], starts: '23:00', ends: '02:00' }] })
        .success,
    ).toBe(true);
  });

  /** Equal hours are a mistake in either direction, and the database has no CHECK for it. */
  it('refuses a band that starts and ends at the same minute', () => {
    expect(
      showFormSchema.safeParse({ ...base, bands: [{ days: [1], starts: '10:00', ends: '10:00' }] })
        .success,
    ).toBe(false);
  });

  it('refuses an end date before the start', () => {
    expect(showFormSchema.safeParse({ ...base, endsOn: '2025-12-31' }).success).toBe(false);
    expect(showFormSchema.safeParse({ ...base, endsOn: '2026-01-01' }).success).toBe(true);
  });

  /** D7: blank is the indeterminate case, not a missing value to complain about. */
  it('treats a blank end date as indeterminate', () => {
    expect(showFormSchema.parse({ ...base, endsOn: '' }).endsOn).toBeUndefined();
    expect(showFormSchema.parse(base).endsOn).toBeUndefined();
  });

  it('refuses a kind or an age rating this product does not have', () => {
    expect(showFormSchema.safeParse({ ...base, kind: 'PODCAST' }).success).toBe(false);
    expect(showFormSchema.safeParse({ ...base, ageRating: '21' }).success).toBe(false);
  });

  it('refuses a field this product does not know', () => {
    expect(showFormSchema.safeParse({ ...base, deletedAt: '2026-01-01' }).success).toBe(false);
  });
});
