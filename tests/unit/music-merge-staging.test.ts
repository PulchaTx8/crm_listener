import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STAGING,
  stagingReducer,
  losersOf,
  canSubmitMerge,
  childrenMovedByMerge,
  childCountLabel,
  mergeConfirmationText,
} from '@/app/(app)/music/maintenance/merge-panel';
import type { MergeCandidate } from '@/services/music';
import en from '../../messages/en.json';

/**
 * The REAL English catalogue, through next-intl's own formatter — not a stub
 * that would only prove the test agrees with itself. So these assertions now
 * also pin what messages/en.json says, which is the half that used to live in
 * the function body.
 */
const t = createTranslator({ locale: 'en', messages: en, namespace: 'music' }) as unknown as (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

/**
 * The Maintenance screen's staging area, tested as pure functions rather
 * than through the component: this project's unit tests run in vitest's
 * `node` environment with no DOM (vitest.config.ts), so there is no render
 * to tick a checkbox on — the same reasoning tests/unit/run-draw-dialog.test.ts's
 * own header gives for its shape, and the precedent
 * tests/unit/participations-filters.test.ts sets for importing pure
 * functions straight out of a 'use client' component file.
 *
 * §5.1 of the design spec: the staging area is React state and nothing
 * else, which is exactly what makes it testable without a database or a
 * browser — the whole reason it was built this way.
 */

function candidate(over: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    id: '11111111-0000-0000-0000-000000000001',
    label: 'Sozinho',
    subLabel: 'Caetano Veloso',
    childCount: 412,
    legacyId: null,
    ...over,
  };
}

describe('stagingReducer', () => {
  it('ticking an unstaged row adds it, naming no survivor yet', () => {
    const state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: candidate() });
    expect(state.staged).toEqual([candidate()]);
    expect(state.survivorId).toBeNull();
  });

  it('ticking an already-staged row removes just that row, not the whole basket', () => {
    // Fix round 1: two rows staged first, so the removal has to leave the
    // OTHER one behind — a do-nothing reducer `(state) => state` would never
    // get either row into `staged` in the first place, and the sanity check
    // below catches that before the removal is even attempted.
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
    expect(state.staged).toEqual([one, two]);

    state = stagingReducer(state, { type: 'toggle', candidate: one });
    expect(state.staged).toEqual([two]);
  });

  it('removing the named survivor clears the survivor too, not only the row', () => {
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 0 });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
    state = stagingReducer(state, { type: 'name-survivor', id: one.id });
    state = stagingReducer(state, { type: 'remove', id: one.id });
    expect(state.survivorId).toBeNull();
    expect(state.staged).toEqual([two]);
  });

  it('removing a row that is not the survivor leaves the survivor named', () => {
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
    state = stagingReducer(state, { type: 'name-survivor', id: one.id });
    state = stagingReducer(state, { type: 'remove', id: two.id });
    expect(state.survivorId).toBe(one.id);
  });

  it('refuses to name a survivor that was never staged, but accepts one that was', () => {
    // Fix round 1: this is the only assertion covering the stale-winner
    // contract, so it has to actually exercise a staged row and an unstaged
    // one, not two calls that both collapse to EMPTY_STAGING against a
    // do-nothing reducer.
    const a = candidate();
    const b = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: a });
    expect(state.staged).toEqual([a]); // sanity: staging actually happened

    // b was never ticked — naming it survivor is refused, and the state
    // before and after this dispatch is compared, not just checked against
    // the reducer's own initial null.
    const before = state.survivorId;
    state = stagingReducer(state, { type: 'name-survivor', id: b.id });
    expect(state.survivorId).toBe(before);
    expect(state.survivorId).toBeNull();

    // a WAS ticked — naming it succeeds. A do-nothing reducer cannot reach
    // this: it never got past the first `toggle` above.
    state = stagingReducer(state, { type: 'name-survivor', id: a.id });
    expect(state.survivorId).toBe(a.id);
  });

  it('reset clears everything, even a fully-built basket with a named survivor', () => {
    // Fix round 1: reset from a basket that actually has two staged rows and
    // a named survivor — not from a single toggle a do-nothing reducer would
    // already show as empty, which made the original assertion trivial.
    const a = candidate();
    const b = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: a });
    state = stagingReducer(state, { type: 'toggle', candidate: b });
    state = stagingReducer(state, { type: 'name-survivor', id: a.id });
    expect(state.staged).toEqual([a, b]); // sanity: the basket is real
    expect(state.survivorId).toBe(a.id);

    expect(stagingReducer(state, { type: 'reset' })).toEqual(EMPTY_STAGING);
  });
});

describe('losersOf / canSubmitMerge', () => {
  it('a lone staged row named survivor has no losers, and cannot submit', () => {
    // Fix round 1: asserts the naming actually took effect (survivorId is
    // the real candidate's id, not the null a do-nothing reducer would
    // still show) before relying on that state for the losers/can-submit
    // checks — otherwise both of those pass trivially against EMPTY_STAGING
    // too (staged.filter(...) on [] is [], and survivorId !== null on null
    // is false).
    const a = candidate();
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: a });
    state = stagingReducer(state, { type: 'name-survivor', id: a.id });
    expect(state.survivorId).toBe(a.id);
    expect(losersOf(state)).toEqual([]);
    expect(canSubmitMerge(state)).toBe(false);
  });

  it('two staged rows with no survivor named cannot submit', () => {
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
    // Fix round 1: sanity check that both rows are really staged — without
    // it, `canSubmitMerge(EMPTY_STAGING) === false` already satisfies the
    // assertion below for a do-nothing reducer.
    expect(state.staged).toEqual([one, two]);
    expect(canSubmitMerge(state)).toBe(false);
  });

  it('a survivor plus at least one other staged row can submit', () => {
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
    state = stagingReducer(state, { type: 'name-survivor', id: one.id });
    expect(losersOf(state)).toEqual([two]);
    expect(canSubmitMerge(state)).toBe(true);
  });
});

describe('childrenMovedByMerge', () => {
  it('sums only the losers, never the survivor', () => {
    const losers = [
      candidate({ childCount: 3 }),
      candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 5 }),
    ];
    expect(childrenMovedByMerge(losers)).toBe(8);
  });

  it('zero — duplicates nobody had used yet — is a real, legitimate sum', () => {
    expect(childrenMovedByMerge([candidate({ childCount: 0 })])).toBe(0);
  });
});

describe('childCountLabel', () => {
  it('names the right noun for a song merge — requests, not songs', () => {
    expect(childCountLabel('SONG', 412, t)).toBe('412 requests');
  });

  it('names the right noun for an artist/label/genre merge — songs, not requests', () => {
    expect(childCountLabel('ARTIST', 3, t)).toBe('3 songs');
    expect(childCountLabel('LABEL', 3, t)).toBe('3 songs');
    expect(childCountLabel('GENRE', 3, t)).toBe('3 songs');
  });

  it('a show merge moves requests, the same as a song merge', () => {
    expect(childCountLabel('SHOW', 7, t)).toBe('7 requests');
  });

  it('keeps the noun singular for exactly one', () => {
    expect(childCountLabel('SONG', 1, t)).toBe('1 request');
  });

  it('zero is shown plainly, not hidden as a dash', () => {
    expect(childCountLabel('GENRE', 0, t)).toBe('0 songs');
  });

  it('formats a large count with the codebase house locale', () => {
    expect(childCountLabel('SONG', 1234, t)).toBe('1,234 requests');
  });
});

describe('mergeConfirmationText', () => {
  it('names the survivor, the loser count and the real number that moves', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [
      candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 400 }),
      candidate({ id: '33333333-0000-0000-0000-000000000003', childCount: 12 }),
    ];
    expect(mergeConfirmationText('SONG', survivor, losers, t)).toBe(
      'Merge 2 records into “Sozinho”? 412 requests will move. This cannot be undone.',
    );
  });

  it('uses the child noun for the kind — songs, not requests, for an artist merge', () => {
    const survivor = candidate({ label: 'Caetano' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 3 })];
    expect(mergeConfirmationText('ARTIST', survivor, losers, t)).toBe(
      'Merge 1 record into “Caetano”? 3 songs will move. This cannot be undone.',
    );
  });

  it('keeps every noun singular when the count is exactly one', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 1 })];
    expect(mergeConfirmationText('SONG', survivor, losers, t)).toBe(
      'Merge 1 record into “Sozinho”? 1 request will move. This cannot be undone.',
    );
  });

  it('says plainly that zero will move — a legitimate outcome, not hidden', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 0 })];
    expect(mergeConfirmationText('SONG', survivor, losers, t)).toBe(
      'Merge 1 record into “Sozinho”? 0 requests will move. This cannot be undone.',
    );
  });
});
