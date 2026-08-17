import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_RESOLVABLE,
  CAMPAIGN_VARIABLES,
  namedPlaceholder,
  variableFromPlaceholder,
} from '@/lib/templates/variables';

describe('the template variable vocabulary', () => {
  it('says which family every value is in', () => {
    // Totality is the compiler's job; this asserts the SPLIT, which the
    // compiler cannot check. A value moved to the wrong family would let 29d
    // offer a campaign something no campaign can resolve.
    expect(CAMPAIGN_RESOLVABLE.LISTENER_FIRST_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.STATION_NAME).toBe(true);
    expect(CAMPAIGN_RESOLVABLE.PRIZE_NAME).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.PICKUP_DEADLINE).toBe(false);
    expect(CAMPAIGN_RESOLVABLE.VERIFICATION_CODE).toBe(false);
  });

  it('offers a campaign exactly the resolvable four', () => {
    expect(CAMPAIGN_VARIABLES).toEqual([
      'LISTENER_FIRST_NAME',
      'LISTENER_FULL_NAME',
      'LISTENER_CITY',
      'STATION_NAME',
    ]);
  });

  it('derives the email notation from the enum rather than declaring it twice', () => {
    expect(namedPlaceholder('LISTENER_FIRST_NAME')).toBe('{{listener_first_name}}');
    expect(namedPlaceholder('STATION_NAME')).toBe('{{station_name}}');
  });

  it('reads a placeholder back to its value', () => {
    expect(variableFromPlaceholder('listener_city')).toBe('LISTENER_CITY');
  });

  it('answers null for a placeholder that names nothing', () => {
    // The screen offers a closed list, so this is a hand-edited body -- and it
    // must be refused rather than substituted with an empty string, which is
    // how a listener reads "Oi !" and nobody finds out.
    expect(variableFromPlaceholder('listener_shoe_size')).toBeNull();
  });

  it('round-trips every value in the vocabulary', () => {
    for (const value of Object.keys(CAMPAIGN_RESOLVABLE) as (keyof typeof CAMPAIGN_RESOLVABLE)[]) {
      const placeholder = namedPlaceholder(value).slice(2, -2);
      expect(variableFromPlaceholder(placeholder)).toBe(value);
    }
  });
});
