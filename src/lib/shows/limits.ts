/**
 * Block 30e, D1. How many programmes one Station's screen will draw.
 *
 * The Programmes screen shows every programme rather than a page of them, in
 * both its views: a week grid cannot page — a week is a week — and paging the
 * list beside it would leave the two views disagreeing about how many programmes
 * exist. This is the ceiling on that promise, and the screen SAYS when it cut the
 * list rather than letting it look whole: a cap nobody is told about is how a
 * screen comes to claim a completeness it does not have.
 *
 * 500 is a number no radio station's programme list approaches — the seeded
 * Stations carry four. It exists so a runaway import cannot turn this screen into
 * a full-table render.
 *
 * IN ITS OWN MODULE because both ends need it: `services/shows.ts` is
 * `server-only` and cannot hand a value to the client component that renders the
 * notice.
 */
export const SHOW_LIST_MAX = 500;
