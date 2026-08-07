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
export function TopList({
  data,
  label,
  covers,
}: {
  data: Slice[];
  label: string;
  /**
   * Cover URL by slice id (Block 13a) — supplied only by the Music
   * dashboard's songs list; genres, promotions and discovery sources have no
   * cover and pass nothing, which leaves the axis exactly as it was.
   */
  covers?: Map<string, string>;
}) {
  const withCovers = covers !== undefined && covers.size > 0;

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
            width={withCovers ? 170 : 140}
            tick={
              withCovers ? <CoverTick data={data} covers={covers as Map<string, string>} /> : CHART_AXIS_TICK
            }
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

/**
 * A category tick that draws the album cover before the title.
 *
 * THE DATUM IS FOUND BY INDEX, NOT BY LABEL. Recharts hands a tick only the
 * axis VALUE — here the song's title — and two songs in one top ten can share
 * a title (a studio cut and a live version, which is exactly the pair a radio
 * has). Matching on the title would then draw one song's cover beside the
 * other's row, and a wrong cover is worse than no cover: it is a confident
 * claim that happens to be false. `payload.index` addresses the row itself.
 *
 * Falls back to the plain label whenever the index is out of range or the song
 * has no cover, so this can only ever degrade to what the axis rendered
 * before.
 */
function CoverTick(props: {
  data: Slice[];
  covers: Map<string, string>;
  x?: number;
  y?: number;
  payload?: { value?: string | number; index?: number };
}) {
  const { data, covers, x = 0, y = 0, payload } = props;

  const datum = typeof payload?.index === 'number' ? data[payload.index] : undefined;
  const url = datum?.id ? covers.get(datum.id) : undefined;
  const text = String(payload?.value ?? '');

  const SIZE = 20;
  // The axis is right-aligned at x, so the whole tick is laid out leftwards
  // from it: the cover sits furthest left, the title between it and the bar.
  const imageX = x - 160;
  const textX = url ? imageX + SIZE + 6 : x - 4;

  return (
    <g>
      {url && (
        <image
          href={url}
          x={imageX}
          y={y - SIZE / 2}
          width={SIZE}
          height={SIZE}
          preserveAspectRatio="xMidYMid slice"
          // Decorative: the title is rendered right beside it, and a screen
          // reader announcing the cover before the title is noise.
          aria-hidden="true"
        />
      )}
      <text
        x={textX}
        y={y}
        textAnchor={url ? 'start' : 'end'}
        dominantBaseline="central"
        fill={CHART_AXIS_TICK.fill}
        fontSize={CHART_AXIS_TICK.fontSize}
      >
        {text}
      </text>
    </g>
  );
}
