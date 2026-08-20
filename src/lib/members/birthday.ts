/**
 * Block 30b. A birthday window, as the Members screen asks it.
 *
 * PURE, so the branch that decides wrap-or-not can be proved without a database
 * or a browser. That branch is where the off-by-one lives: `from > to` is not a
 * mistake to reject but the end-of-year window — 20 December to 5 January — and
 * a filter that refused it would be wrong for the season it exists to serve.
 *
 * NOTHING HERE IS A BOUNDARY. What a caller may read is decided by
 * members_select_reachable (0035); this module only decides which days the
 * question is about.
 */

/** The five shapes the two boxes can produce. */
export type BirthdayWindow =
  | { kind: 'none' }
  | { kind: 'from'; from: number }
  | { kind: 'to'; to: number }
  | { kind: 'between'; from: number; to: number }
  | { kind: 'wraps'; from: number; to: number };

const MONTH_DAY = /^(\d{2})-(\d{2})$/;

/**
 * `MM-DD` as the number `members.birth_md` holds (0257), or null.
 *
 * IT DOES NOT VALIDATE A CALENDAR, and that is deliberate rather than lax. The
 * column stores a DAY OF THE YEAR, not a date, so 29 February is an ordinary
 * value that must be accepted; and 31 April, which nobody is born on, simply
 * matches nothing. Rejecting impossible days here would mean carrying a second
 * calendar and keeping it in step with Postgres's, to prevent an empty result
 * that is already empty.
 *
 * What it DOES reject is anything that is not two digits, a dash and two
 * digits, with the month in 01-12 and the day in 01-31 — because those reach a
 * numeric comparison, and a value outside that range would silently widen or
 * narrow the window rather than being ignored.
 */
export function birthdayCode(monthDay: string | undefined): number | null {
  const match = MONTH_DAY.exec(monthDay ?? '');
  if (!match) return null;

  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return month * 100 + day;
}

/**
 * The two boxes as one window.
 *
 * An unreadable end is DROPPED rather than failing the whole filter: the two
 * boxes are independent, and a hand-edited URL with one broken value should
 * still answer the half that is readable rather than silently listing everybody.
 */
export function birthdayWindow(
  from: string | undefined,
  to: string | undefined,
): BirthdayWindow {
  const start = birthdayCode(from);
  const end = birthdayCode(to);

  if (start === null && end === null) return { kind: 'none' };
  if (start === null) return { kind: 'to', to: end as number };
  if (end === null) return { kind: 'from', from: start };

  // EQUAL IS A RANGE OF ONE, NOT A WRAP. `from > to` is the wrap; `from === to`
  // is somebody asking about a single day, and routing it through the wrap
  // branch would answer "every day of the year except the ones in between",
  // which is the exact opposite.
  return start <= end
    ? { kind: 'between', from: start, to: end }
    : { kind: 'wraps', from: start, to: end };
}
