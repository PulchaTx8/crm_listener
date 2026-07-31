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
export const STATUS_LABELS: Record<ParticipationStatus, string> = {
  VALID: 'Counted',
  DUPLICATE: 'Already entered',
  TOO_SOON: 'Came back too soon',
  OVER_LIMIT: 'Past their limit',
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
