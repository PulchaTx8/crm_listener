'use client';

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { Slice } from '@/schemas/dashboards';
import {
  CHART_LEGEND_STYLE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
  chartColorAt,
} from './chart-colors';

/**
 * A part-to-whole split as a donut — `participation_status`, `prize_cycle`:
 * a handful of slices with no shared axis to tell them apart, so (unlike
 * the other three charts here) each slice gets its own palette slot in
 * fixed order (`dataviz` skill: identity is the job, so this is the one
 * chart in the set where colour varies per data point).
 *
 * A legend is always rendered — the dependable identity channel for ≥2
 * slices, never color-matching alone — keyed to each slice's own `label`.
 * No percentage is computed or shown: a payload can omit a category behind
 * D13 (`withheld`), so a share-of-displayed-total here could read as
 * complete when it isn't. The absolute `count` each slice already carries
 * is what the tooltip and legend show.
 */
export function SplitDonut({ data, label }: { data: Slice[]; label: string }) {
  return (
    <figure aria-label={label} className="h-80 w-full" data-testid="chart-split-donut">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
          <Pie
            data={data}
            dataKey="count"
            nameKey="label"
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={2}
            stroke="hsl(var(--card))"
            strokeWidth={2}
          >
            {data.map((slice, index) => (
              <Cell key={slice.id ?? slice.key ?? slice.label} fill={chartColorAt(index)} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Legend wrapperStyle={CHART_LEGEND_STYLE} />
        </PieChart>
      </ResponsiveContainer>
    </figure>
  );
}
