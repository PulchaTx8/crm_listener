/**
 * The chart palette every dashboard component in this file draws from —
 * eight categorical hues in a fixed order, per the `dataviz` skill's method.
 * The order is the CVD-safety mechanism, not cosmetic: it was validated with
 * `validate_palette.js` against both themes (worst adjacent pair, light/dark:
 * CVD ΔE 9.1 / 8.4 against an ≥8 target; normal-vision ΔE 19.6 / 19.3 against
 * a ≥15 floor). Never reorder these slots and never generate a 9th — a
 * dashboard with more than eight categories folds the tail into "Other" or
 * facets, upstream of this component, not by cycling colours here.
 *
 * Every value is `hsl(var(--chart-N))`. The numbers are declared for both
 * `:root` and `.dark` in `src/app/globals.css`, so the same string renders
 * correctly in either theme without this module — or the chart importing
 * it — knowing which theme is active. No hex literal belongs in this file
 * or in any chart component that imports it.
 */
export const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
  'hsl(var(--chart-6))',
  'hsl(var(--chart-7))',
  'hsl(var(--chart-8))',
] as const satisfies readonly string[];

/**
 * The single hue a one-series chart uses (`MonthlyBars`, `BreakdownBars`,
 * `TopList`): one measure across many categories is still one series, so
 * every bar takes the same slot rather than a colour per category — see
 * the `dataviz` skill's colour-formula on nominal categories vs. identity.
 */
export const CHART_PRIMARY = CHART_COLORS[0];

/**
 * The slot for data point `index` in a chart where each point IS its own
 * series (`SplitDonut`'s slices, which have no shared axis to tell them
 * apart). Wrapping past slot 8 is a defensive fallback only — a payload with
 * more than eight slices belongs back at the SQL/service layer to fold into
 * an "Other" bucket, not solved by repeating a colour here.
 */
export function chartColorAt(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? CHART_PRIMARY;
}

// ---------------------------------------------------------------------------
// Shared chrome — grid, axis, tooltip, legend. These read the same semantic
// tokens every other component in the app already themes through (see
// `globals.css` and `tailwind.config.ts`), not new ones invented for charts.
// ---------------------------------------------------------------------------

export const CHART_GRID_STROKE = 'hsl(var(--border))';
export const CHART_AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 12 };
export const CHART_TOOLTIP_CURSOR = { fill: 'hsl(var(--muted))' };

/** `<Tooltip>` box: themed surface, never the series colour bleeding into text. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: 'hsl(var(--popover))',
  borderColor: 'hsl(var(--border))',
  borderRadius: 'var(--radius)',
  fontSize: 12,
};
export const CHART_TOOLTIP_LABEL_STYLE = { color: 'hsl(var(--popover-foreground))', fontWeight: 600 };
/** Row text stays a neutral ink token — identity rides the mark beside it, never the text colour. */
export const CHART_TOOLTIP_ITEM_STYLE = { color: 'hsl(var(--popover-foreground))' };

export const CHART_LEGEND_STYLE = { color: 'hsl(var(--muted-foreground))', fontSize: 12 };
