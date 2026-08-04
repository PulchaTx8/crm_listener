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

  it('ticking an already-staged row removes it', () => {
    const staged = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: candidate() });
    const untoggled = stagingReducer(staged, { type: 'toggle', candidate: candidate() });
    expect(untoggled.staged).toEqual([]);
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

  it('refuses to name a survivor that was never staged', () => {
    const state = stagingReducer(EMPTY_STAGING, { type: 'name-survivor', id: candidate().id });
    expect(state.survivorId).toBeNull();
  });

  it('reset clears everything, the same as leaving the screen would', () => {
    const staged = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: candidate() });
    expect(stagingReducer(staged, { type: 'reset' })).toEqual(EMPTY_STAGING);
  });
});

describe('losersOf / canSubmitMerge', () => {
  it('a lone staged row named survivor has no losers, and cannot submit', () => {
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: candidate() });
    state = stagingReducer(state, { type: 'name-survivor', id: candidate().id });
    expect(losersOf(state)).toEqual([]);
    expect(canSubmitMerge(state)).toBe(false);
  });

  it('two staged rows with no survivor named cannot submit', () => {
    const one = candidate();
    const two = candidate({ id: '22222222-0000-0000-0000-000000000002' });
    let state = stagingReducer(EMPTY_STAGING, { type: 'toggle', candidate: one });
    state = stagingReducer(state, { type: 'toggle', candidate: two });
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
    expect(childCountLabel('SONG', 412)).toBe('412 requests');
  });

  it('names the right noun for an artist/label/genre merge — songs, not requests', () => {
    expect(childCountLabel('ARTIST', 3)).toBe('3 songs');
    expect(childCountLabel('LABEL', 3)).toBe('3 songs');
    expect(childCountLabel('GENRE', 3)).toBe('3 songs');
  });

  it('a show merge moves requests, the same as a song merge', () => {
    expect(childCountLabel('SHOW', 7)).toBe('7 requests');
  });

  it('keeps the noun singular for exactly one', () => {
    expect(childCountLabel('SONG', 1)).toBe('1 request');
  });

  it('zero is shown plainly, not hidden as a dash', () => {
    expect(childCountLabel('GENRE', 0)).toBe('0 songs');
  });

  it('formats a large count with the codebase house locale', () => {
    expect(childCountLabel('SONG', 1234)).toBe('1,234 requests');
  });
});

describe('mergeConfirmationText', () => {
  it('names the survivor, the loser count and the real number that moves', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [
      candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 400 }),
      candidate({ id: '33333333-0000-0000-0000-000000000003', childCount: 12 }),
    ];
    expect(mergeConfirmationText('SONG', survivor, losers)).toBe(
      'Merge 2 records into “Sozinho”? 412 requests will move. This cannot be undone.',
    );
  });

  it('uses the child noun for the kind — songs, not requests, for an artist merge', () => {
    const survivor = candidate({ label: 'Caetano' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 3 })];
    expect(mergeConfirmationText('ARTIST', survivor, losers)).toBe(
      'Merge 1 record into “Caetano”? 3 songs will move. This cannot be undone.',
    );
  });

  it('keeps every noun singular when the count is exactly one', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 1 })];
    expect(mergeConfirmationText('SONG', survivor, losers)).toBe(
      'Merge 1 record into “Sozinho”? 1 request will move. This cannot be undone.',
    );
  });

  it('says plainly that zero will move — a legitimate outcome, not hidden', () => {
    const survivor = candidate({ label: 'Sozinho' });
    const losers = [candidate({ id: '22222222-0000-0000-0000-000000000002', childCount: 0 })];
    expect(mergeConfirmationText('SONG', survivor, losers)).toBe(
      'Merge 1 record into “Sozinho”? 0 requests will move. This cannot be undone.',
    );
  });
});
