/**
 * How many prizes the picker behind the Prizes tab's Link control shows at once.
 *
 * Pure, and deliberately NOT in services/promotions.ts, for the same reason
 * promotion-situation.ts is not: that module is `server-only`, and the Prizes
 * tab is a client component. It needs this number to say "showing the first
 * fifty" truthfully, and importing it from there drags the whole service —
 * `import 'server-only'` and all — into the browser bundle, which is a build
 * error rather than a subtle one.
 *
 * One number in one place rather than a copy in the sentence and another in the
 * query, which is how a screen comes to announce a cut at a figure the RPC no
 * longer uses. `list_linkable_prizes` (0051) is where the cut is actually made,
 * with `limit 51`: it reads one row past this page and that extra row, not a
 * full page, is what tells the screen the list was truncated. The two numbers
 * are one apart on purpose — a Station holding exactly fifty prizes returns
 * fifty and must not be told about a truncation that did not happen — so if
 * this constant is ever changed, 0051's limit has to move with it.
 */
export const LINKABLE_PRIZE_PAGE_SIZE = 50;
