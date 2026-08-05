'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonthPoint } from '@/schemas/dashboards';
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
 * The twelve-month bar chart every dashboard's `monthly` key feeds. One
 * measure over time is one series, so every bar takes the same palette slot
 * rather than a colour per month (`dataviz` skill: categorical colour encodes
 * *identity*, and there is only one series here) — no legend box for it,
 * either, since the title already says what is plotted.
 *
 * `data` is rendered in the order it arrives. The twelve buckets, their
 * months, and their counts were all resolved in SQL (0118–0120); this
 * component does not sort, fill a missing month, or total anything.
 */
export function MonthlyBars({ data, label }: { data: MonthPoint[]; label: string }) {
  return (
    <figure aria-label={label} className="h-72 w-full" data-testid="chart-monthly-bars">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={CHART_GRID_STROKE} vertical={false} />
          <XAxis
            dataKey="month"
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
