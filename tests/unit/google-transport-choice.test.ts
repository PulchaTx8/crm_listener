import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geocodeTransport } from '@/lib/integrations/google';
import { FakeGeocodeTransport, GEOCODE_FIXTURES } from '@/lib/integrations/google/fake';

/**
 * Block 28. WHICH transport the application picks, and what the fixture one
 * promises.
 *
 * The choice is three-way and each branch is a different product state, which is
 * why none of them can be left to reading: the fixture transport (tests only),
 * the real client (a key is configured), and NULL — no key, the maps are off,
 * design D6. Getting the third wrong does not throw; it renders a map panel that
 * silently asks Google nothing, or worse, one that serves fixtures to a customer.
 */
const KEEP = { fake: process.env.GOOGLE_FAKE, key: process.env.GOOGLE_GEOCODING_KEY };

beforeEach(() => {
  delete process.env.GOOGLE_FAKE;
  delete process.env.GOOGLE_GEOCODING_KEY;
});

afterEach(() => {
  if (KEEP.fake === undefined) delete process.env.GOOGLE_FAKE;
  else process.env.GOOGLE_FAKE = KEEP.fake;
  if (KEEP.key === undefined) delete process.env.GOOGLE_GEOCODING_KEY;
  else process.env.GOOGLE_GEOCODING_KEY = KEEP.key;
});

describe('geocodeTransport', () => {
  it('is null when no key is configured, so the maps are off rather than broken', () => {
    // Design D6. Null is a supported product state, not a misconfiguration —
    // the panel says the map is not configured and the ranked tables are
    // unchanged. The drain reads null as "skip the whole batch".
    expect(geocodeTransport()).toBeNull();
  });

  it('is the real client once a key exists', () => {
    process.env.GOOGLE_GEOCODING_KEY = 'a-key';
    const transport = geocodeTransport();
    expect(transport).not.toBeNull();
    // Not the fake: identity matters here, because the fake answering in
    // production would be silent and wrong rather than loud.
    expect(transport).not.toBeInstanceOf(FakeGeocodeTransport);
  });

  it('serves fixtures ONLY when asked to, and never as a fallback', () => {
    // OPT-IN, and this is the assertion that keeps it so. WhatsApp's transport
    // falls back to its fake when its token is missing, because there a missing
    // token means "not configured"; here a missing key means the maps are off,
    // which is a real state a fallback would hide. A deployment must not be able
    // to serve fixtures by forgetting something.
    process.env.GOOGLE_FAKE = '1';
    expect(geocodeTransport()).toBeInstanceOf(FakeGeocodeTransport);

    // And not by a value that merely looks enabled.
    process.env.GOOGLE_FAKE = 'true';
    expect(geocodeTransport()).toBeNull();

    process.env.GOOGLE_FAKE = '0';
    expect(geocodeTransport()).toBeNull();
  });

  it('prefers the fixture over a real key, so a test run cannot reach Google by accident', () => {
    process.env.GOOGLE_FAKE = '1';
    process.env.GOOGLE_GEOCODING_KEY = 'a-real-key-that-would-cost-money';
    expect(geocodeTransport()).toBeInstanceOf(FakeGeocodeTransport);
  });
});

describe('FakeGeocodeTransport', () => {
  it('answers the fixture for an address it knows', async () => {
    const fake = new FakeGeocodeTransport(GEOCODE_FIXTURES);
    const result = await fake.lookup('Cohab, São Luís, MA, BR');
    expect(result).toEqual({
      latitude: -2.5307,
      longitude: -44.3068,
      precision: 'neighbourhood',
    });
  });

  it('answers null for one it does not, so the drain s failed-and-done path is exercised too', async () => {
    // NOT a throw. If the fake only ever succeeded, every test leaning on it
    // would prove the happy path twice and the "Google does not know this place"
    // path never — and that path is what writes failed_at.
    const fake = new FakeGeocodeTransport(GEOCODE_FIXTURES);
    expect(await fake.lookup('Nowhere at all, Atlantis')).toBeNull();
  });

  it('matches case-insensitively, because the drain builds its query from stored text', async () => {
    const fake = new FakeGeocodeTransport(GEOCODE_FIXTURES);
    expect(await fake.lookup('cohab, são luís, ma, br')).not.toBeNull();
  });

  it('records what it was asked, and asks nothing for a blank query', async () => {
    const fake = new FakeGeocodeTransport(GEOCODE_FIXTURES);
    expect(await fake.lookup('   ')).toBeNull();
    await fake.lookup('Santos, SP, BR');
    // The blank one is absent: a test asserting "Google was asked about N
    // places" must not count a question that was never worth asking.
    expect(fake.asked).toEqual(['Santos, SP, BR']);
  });
});
