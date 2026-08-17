import { describe, expect, it } from 'vitest';
import {
  ABANDON_MESSAGE,
  DEFAULT_MENU_LINK_TEXT,
  DEFAULT_MUSIC_LINK_TEXT,
  DEFAULT_PROMOTION_LINK_TEXT,
  FIELD_MESSAGE_KEYS,
  FIELD_PROMPTS,
  REFUSAL_MESSAGE,
  SYSTEM_MESSAGE_DEFAULTS,
  resolveSystemMessage,
  type SystemMessageKey,
} from '@/lib/conversation/engine';

/**
 * D2, held to by test rather than by intention: the override is PER TEXT.
 *
 * The plausible wrong implementation is all-or-nothing — a Station with any
 * override at all getting its own map and losing the defaults for everything
 * else. It is invisible until a Station that changed one prompt goes silent on
 * the other nine, which is a listener receiving an empty message, which is the
 * exact failure 0109's table comment says the design exists to prevent.
 */

const ALL_KEYS: SystemMessageKey[] = [
  'REFUSAL',
  'ABANDON',
  'FULL_NAME',
  'ADDRESS',
  'CITY',
  'NEIGHBOURHOOD',
  'AGE',
  'CPF',
  'PASSPORT',
  'DISCOVERY_SOURCE',
  // Block 19a: the three words in front of the link a matched hashtag sends.
  'LINK_MUSIC',
  'LINK_MENU',
  'LINK_PROMOTION',
];

describe('SYSTEM_MESSAGE_DEFAULTS', () => {
  it('is the fifteen texts engine.ts already held, unchanged', () => {
    // The constants stay where they are and BECOME the defaults. If this ever
    // drifts, a Station that overrides nothing starts speaking differently
    // than it did before the block, which is a change nobody asked for.
    expect(SYSTEM_MESSAGE_DEFAULTS).toEqual({
      REFUSAL: REFUSAL_MESSAGE,
      ABANDON: ABANDON_MESSAGE,
      FULL_NAME: FIELD_PROMPTS.full_name,
      ADDRESS: FIELD_PROMPTS.address,
      CITY: FIELD_PROMPTS.city,
      NEIGHBOURHOOD: FIELD_PROMPTS.neighbourhood,
      AGE: FIELD_PROMPTS.age,
      GENDER: FIELD_PROMPTS.gender,
      CPF: FIELD_PROMPTS.cpf,
      PASSPORT: FIELD_PROMPTS.passport,
      DISCOVERY_SOURCE: FIELD_PROMPTS.discovery_source,
      COUNTRY: FIELD_PROMPTS.country,
      LINK_MUSIC: DEFAULT_MUSIC_LINK_TEXT,
      LINK_MENU: DEFAULT_MENU_LINK_TEXT,
      LINK_PROMOTION: DEFAULT_PROMOTION_LINK_TEXT,
    });
  });

  it('has a non-empty default for every key, so the bot can never go mute', () => {
    for (const key of ALL_KEYS) {
      expect(SYSTEM_MESSAGE_DEFAULTS[key].length).toBeGreaterThan(0);
    }
  });

  it('maps each of the ten requested fields to its own distinct key', () => {
    const keys = Object.values(FIELD_MESSAGE_KEYS);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(10);
    // Two fields sharing a key would let one override silently rewrite the
    // other's prompt -- and the pgTAP enum assertion could not see it, because
    // the enum would still have its fifteen values.
    expect(FIELD_MESSAGE_KEYS.full_name).toBe('FULL_NAME');
    expect(FIELD_MESSAGE_KEYS.discovery_source).toBe('DISCOVERY_SOURCE');
    // Block 28's ninth. Named explicitly beside the two above rather than left
    // to the count, because the count alone would accept a country that had
    // been pointed at some other field's key.
    expect(FIELD_MESSAGE_KEYS.country).toBe('COUNTRY');
    // The gender block's tenth, named for the same reason -- and with one more
    // of its own: it is the only field whose prompt is sent with buttons, so a
    // key pointed at the wrong text would produce a question and three answers
    // that do not belong to each other.
    expect(FIELD_MESSAGE_KEYS.gender).toBe('GENDER');
  });
});

describe('resolveSystemMessage', () => {
  it('returns the code default when the Station has overridden nothing', () => {
    // The state a brand-new Station is in, with no backfill and no seed step.
    for (const key of ALL_KEYS) {
      expect(resolveSystemMessage({}, key)).toBe(SYSTEM_MESSAGE_DEFAULTS[key]);
    }
  });

  it('returns the override when the Station has one', () => {
    expect(resolveSystemMessage({ REFUSAL: 'Beleza! Fica pra próxima.' }, 'REFUSAL')).toBe(
      'Beleza! Fica pra próxima.',
    );
  });

  it('KEEPS THE DEFAULTS FOR EVERY TEXT THE STATION DID NOT OVERRIDE', () => {
    // THE ASSERTION THIS FILE EXISTS FOR. One override, twelve defaults. An
    // all-or-nothing resolver -- one that swapped in the Station's map whole
    // once any row existed -- passes the case above and fails here.
    const overrides = { CITY: 'Qual cidade, meu amigo?' };

    expect(resolveSystemMessage(overrides, 'CITY')).toBe('Qual cidade, meu amigo?');

    for (const key of ALL_KEYS.filter((k) => k !== 'CITY')) {
      expect(resolveSystemMessage(overrides, key)).toBe(SYSTEM_MESSAGE_DEFAULTS[key]);
    }
  });

  it('resolves two Stations independently of one another', () => {
    // The spec's own phrasing of D2: two Stations, one overriding and one not.
    // Nothing here is shared state, and this is what says so.
    const loud = { REFUSAL: 'Fica pra próxima, valeu!' };
    const quiet = {};

    expect(resolveSystemMessage(loud, 'REFUSAL')).toBe('Fica pra próxima, valeu!');
    expect(resolveSystemMessage(quiet, 'REFUSAL')).toBe(REFUSAL_MESSAGE);
    expect(resolveSystemMessage(loud, 'ABANDON')).toBe(ABANDON_MESSAGE);
  });

  it('falls back to the default for a blank override rather than sending nothing', () => {
    // 0109's check constraint refuses a blank body and so does its door, so
    // this is the third guard -- and the only one that runs at the moment the
    // message is actually chosen. An empty message reaching a listener is
    // strictly worse than the default it replaced, which is 0109's own words.
    expect(resolveSystemMessage({ ABANDON: '   ' }, 'ABANDON')).toBe(ABANDON_MESSAGE);
    expect(resolveSystemMessage({ ABANDON: '' }, 'ABANDON')).toBe(ABANDON_MESSAGE);
  });

  it('keeps an override that is merely short', () => {
    // The boundary in the other direction, so the blank guard cannot quietly
    // become a minimum length and start discarding a Station's real wording.
    expect(resolveSystemMessage({ CITY: 'Cidade?' }, 'CITY')).toBe('Cidade?');
  });
});
