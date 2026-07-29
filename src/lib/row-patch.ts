/**
 * How a grid changes when a record is saved, archived or created — without
 * re-running the query behind it.
 *
 * The rule that keeps this small, and the reason the whole block exists: a
 * saved row is updated IN PLACE and never moves, and a created row goes to the
 * top regardless of the active sort. Position and filter membership are
 * re-evaluated only when the operator next navigates.
 *
 * Re-sorting here would slide rows around underneath somebody who is halfway
 * through editing forty of them — exactly the experience this pattern exists to
 * protect. The cost is that a row can sit in a position its new value would not
 * earn, or stay visible under a filter it no longer matches, until the next
 * navigation. That is disclosed on screen rather than papered over.
 */

export type RowPatch<T> =
  | { kind: 'save'; row: T }
  | { kind: 'remove'; id: string }
  | { kind: 'create'; row: T };

export interface RowState<T> {
  rows: T[];
  /** Null means "not counted" — the audience screen under its consent filter. */
  total: number | null;
}

export function applyRowPatch<T extends { id: string }>(
  state: RowState<T>,
  patch: RowPatch<T>,
): RowState<T> {
  switch (patch.kind) {
    case 'save': {
      const index = state.rows.findIndex((row) => row.id === patch.row.id);
      // A record can be saved while its row is not on this page at all —
      // opened from a pasted link, for instance. Nothing to patch, and the
      // count did not change either.
      if (index === -1) return state;
      const rows = [...state.rows];
      rows[index] = patch.row;
      return { rows, total: state.total };
    }

    case 'remove': {
      const rows = state.rows.filter((row) => row.id !== patch.id);
      // Only decrement when a row actually left: a remove for something that
      // was never on this page must not make the footer disagree with the
      // database.
      if (rows.length === state.rows.length) return state;
      return { rows, total: state.total === null ? null : state.total - 1 };
    }

    case 'create':
      return {
        rows: [patch.row, ...state.rows],
        total: state.total === null ? null : state.total + 1,
      };
  }
}
