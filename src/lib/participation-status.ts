import type { Database } from '@/lib/supabase/database.types';

/**
 * What the participations grid, the filters and the import result all call the
 * outcome of one attempt.
 *
 * Pure, and deliberately NOT in services/participations.ts: that module is
 * `server-only`, and the grid, the filter bar and the import result are client
 * components. Block 4b hit a build error importing a value across that line and
 * had to move it mid-task; @/lib/promotion-situation.ts and
 * @/lib/linkable-prizes.ts are the two precedents. A type-only import from a
 * `server-only` module survives bundling because it is erased; a Record of
 * labels does not, which is why these live here rather than there.
 *
 * The type is taken from the generated enum rather than re-typed as a union of
 * four string literals. 0052 owns the vocabulary, and a hand-written copy of it
 * here is a second place that has to be remembered when Block 5 or Block 6
 * touches the enum — the Records below then fail to compile, which is exactly
 * the reminder a hand-written union would not give.
 */
export type ParticipationStatus = Database['public']['Enums']['participation_status'];

/**
 * The four statuses in the order the filter offers them: the one that counted,
 * then the three reasons an attempt did not, ordered as an operator would ask
 * about them — already in, came back too soon, ran out of entries.
 *
 * Annotated rather than `as const` so that a value dropped from this list is
 * still a type error at every use site expecting the full vocabulary, and
 * matching SITUATION_ORDER's own shape in the promotions screen.
 */
export const PARTICIPATION_STATUSES: readonly ParticipationStatus[] = [
  'VALID',
  'DUPLICATE',
  'TOO_SOON',
  'OVER_LIMIT',
];

/**
 * Written from the listener's side rather than the database's: an operator
 * looking at a refused row wants to know what the person did, not which branch
 * of apply_participation they landed in.
 *
 * None of these says "wrong answer". No status ever means that — whether the
 * quiz was answered correctly is a draw-time question Block 6 derives from the
 * answers, and a wrong answer refuses nobody (participation_status' own
 * comment in 0052).
 */
export const STATUS_LABEL_KEYS: Record<ParticipationStatus, string> = {
  VALID: 'participationCounted',
  DUPLICATE: 'participationAlreadyEntered',
  TOO_SOON: 'participationCameBackTooSoon',
  OVER_LIMIT: 'participationPastTheirLimit',
};

/**
 * The same four outcomes as a full sentence, for the two writing surfaces: the
 * manual form reporting what happened to one attempt, and the import reporting
 * what happened to a line of a file.
 *
 * They exist because a LABEL is not enough there. On the list a badge reading
 * "Already entered" sits in a column headed Status beside a row that is plainly
 * on the record, so the operator can see that nothing was lost. On a form that
 * has just been submitted the same two words, alone, read as a refusal —
 * "already entered, so I did not write it down" — which is the exact opposite
 * of what the database did, and of what design spec D5 exists to say. Three of
 * these four sentences therefore state twice over that the entry WAS recorded
 * and say why it will not be drawn.
 *
 * Here rather than in either form: both render them, both are client
 * components, and one wording in one place is what stops the manual door and
 * the import telling an operator two different things about one status — the
 * same drift apply_participation is shared to prevent underneath.
 */
export const STATUS_MEANING_KEYS: Record<ParticipationStatus, string> = {
  VALID: 'participationMeaningCounted',
  DUPLICATE: 'participationMeaningAlreadyEntered',
  TOO_SOON: 'participationMeaningCameBackTooSoon',
  OVER_LIMIT: 'participationMeaningPastTheirLimit',
};

/**
 * One strong colour for the entries that count and one muted family for the
 * three that do not. The three refusals deliberately share a look: they are the
 * same answer to the operator's question — this one is not in the draw — and
 * three different colours would suggest a ranking between them that does not
 * exist. Same palette SITUATION_CLASSES uses, so the two grids read alike.
 */
export const STATUS_CLASSES: Record<ParticipationStatus, string> = {
  VALID: 'bg-emerald-100 text-emerald-900',
  DUPLICATE: 'bg-muted text-muted-foreground',
  TOO_SOON: 'bg-muted text-muted-foreground',
  OVER_LIMIT: 'bg-muted text-muted-foreground',
};
