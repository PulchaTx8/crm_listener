'use client';

import { Bar, BarChart, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Slice } from '@/schemas/dashboards';
import {
  CHART_AXIS_TICK,
  CHART_PRIMARY,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_CURSOR,
  CHART_TOOLTIP_ITEM_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from './chart-colors';

/**
 * A ranked list as horizontal bars — `discovery_source`, `first_contact_origin`,
 * `top.songs`, `top.genres`, `top.promotions`: long-named categories read
 * better as rows than as columns (`dataviz` skill: horizontal bars for many
 * or long-named categories). One measure, one palette slot; the value is
 * direct-labeled at the bar's tip rather than left to an axis, since a
 * ranked top-N list is read by its numbers, not by scale position.
 *
 * The ranking itself — which entries are here and in what order — is
 * whatever `top.songs` etc. already resolved in SQL. This component neither
 * re-sorts by count nor trims the list to a "top N" of its own.
 */
export function TopList({ data, label }: { data: Slice[]; label: string }) {
  return (
    <figure aria-label={label} className="h-80 w-full" data-testid="chart-top-list">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 32, left: 8, bottom: 0 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            width={140}
            tick={CHART_AXIS_TICK}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={CHART_TOOLTIP_CURSOR}
            contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
            labelStyle={CHART_TOOLTIP_LABEL_STYLE}
            itemStyle={CHART_TOOLTIP_ITEM_STYLE}
          />
          <Bar dataKey="count" name={label} fill={CHART_PRIMARY} radius={[0, 4, 4, 0]} maxBarSize={20}>
            <LabelList dataKey="count" position="right" style={{ fill: 'hsl(var(--foreground))' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  );
}
