'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Slice } from '@/schemas/dashboards';
import {
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_PRIMARY,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_CURSOR,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from './chart-colors';

/**
 * A breakdown as vertical columns — `blocks_by_kind`, `nationality`, `vocal`,
 * `participation_status`, `prize_cycle`: one measure (`count`) sliced by a
 * handful of categories, each already named by `label`. That is one series
 * shown across categories, not one series per category, so every column
 * shares the same palette slot (`dataviz` skill: colour encodes identity, and
 * the categories are already told apart by their position on the axis).
 *
 * Slices render in the order the payload sent them — no re-sorting by count,
 * no folding a low bucket into "Other". Both already happened, or didn't,
 * upstream in 0118–0120.
 */
export function BreakdownBars({ data, label }: { data: Slice[]; label: string }) {
  return (
    <figure aria-label={label} className="h-72 w-full" data-testid="chart-breakdown-bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="label"
            interval={0}
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID_STROKE }}
          />
          <YAxis
            allowDecimals={false}
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            cursor={CHART_TOOLTIP_CURSOR}
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Bar dataKey="count" name={label} fill={CHART_PRIMARY} radius={[4, 4, 0, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
