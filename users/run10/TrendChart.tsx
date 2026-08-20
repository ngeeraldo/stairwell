'use client'

// users/run10/TrendChart.tsx
//
// The last seven days' totals, as a bar chart. A CLIENT component, and the
// only file run10 OWNS that is one — lib/ui/WriteAction.tsx (arm 3, imported
// by dashboard.tsx for the log button) is 'use client' too, but it is platform
// code this dashboard imports rather than writes.
//
// ─── why this is allowed to exist, and what guards it ───
//
// docs/dashboard-build-rules.md §3 states the component rule in three arms:
// presentational components (shadcn's Card, Button) are trusted; data-computing
// ones — this file — are sanctioned, guarded by a states check; interaction
// controls (lib/ui/WriteAction.tsx) are sanctioned and the default for every
// write. Outside those three classes, a dashboard composes host elements only:
// a nested function component's body is deferred to React's own render pass,
// which runs after app/[user]/page.tsx's renderDashboard has already returned,
// and therefore OUTSIDE the try/catch that turns a broken dashboard into a
// degraded panel instead of a 500 with the chat surface gone. That residual is
// accepted for all three arms — it is not what makes this file forbidden;
// nothing does, this arm is sanctioned.
//
// THE GUARD IS IN dashboard.tsx, NOT HERE. `chartable` there decides whether
// this component is mounted at all, so this file is never reached on empty, a
// single point, or a non-finite count — which is what keeps the accepted
// residual to "a throw on well-formed props" rather than "a throw on the first
// screen a friend ever sees".
//
// It reads no clock and holds no state: every day, count and label arrives
// fully resolved from queries.ts. Worth saying explicitly because
// tests/users/noLocalDay.test.ts sweeps users/*/dashboard.tsx and
// users/*/queries.ts by name and does NOT see this file.
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export type TrendPoint = { day: string; count: number; label: string }

export function TrendChart({
  data,
  average,
}: {
  data: TrendPoint[]
  /** The daily average of exactly these bars, drawn as a reference line. */
  average?: number
}) {
  const todayLabel = data[data.length - 1]?.label

  return (
    // Fluid, never a fixed width: the container is 375px on a phone and up to
    // 1200px on a desktop, and the chart is sized by its parent in both. The
    // spec asks for one screen that "works equally well on phone and on a
    // computer browser", so this is the same chart at both, not two.
    <div className="h-52 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -24 }}>
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
          />
          <YAxis
            allowDecimals={false}
            width={40}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
          />
          {average !== undefined && (
            // The average drawn where it can be READ against the bars, which
            // is what "alongside it" asks for: a number in a separate card is
            // a baseline the reader has to hold in their head. It is the mean
            // of exactly these bars (queries.ts's dailyAverage takes the same
            // array), so it can never sit somewhere the bars contradict.
            <ReferenceLine
              y={average}
              stroke="var(--muted-foreground)"
              strokeDasharray="4 4"
            />
          )}
          <Tooltip
            // Interaction feedback, which is the ONLY kind of motion allowed
            // here: it responds to the user rather than impersonating live
            // data (docs/dashboard-ui-ux-guidelines.md, Delight/Animation).
            cursor={{ fill: 'var(--accent)', opacity: 0.4 }}
            contentStyle={{
              borderRadius: '0.5rem',
              border: '1px solid var(--border)',
              background: 'var(--background)',
              fontSize: '0.875rem',
            }}
            labelStyle={{ color: 'var(--muted-foreground)' }}
            // Typed loosely because Recharts' Formatter hands back
            // `ValueType | undefined`; the guard in dashboard.tsx has already
            // proven every count is a finite number, so this narrows rather
            // than defends.
            formatter={(value) =>
              [Number(value), Number(value) === 1 ? 'time' : 'times'] as [number, string]
            }
          />
          <Bar
            dataKey="count"
            radius={[4, 4, 0, 0]}
            // NO ENTRANCE ANIMATION. Recharts grows bars from zero on mount by
            // default, which is exactly the "count-up-from-zero on load" the
            // guidelines forbid: the glance is never gated on motion, and a
            // chart that animates on arrival also reads as data still coming
            // in. Delight lives in the hover and the press, not in arrival.
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell
                key={d.day}
                // Today is the bar the panel above is about, so it is the one
                // that carries the accent.
                fill={d.label === todayLabel ? 'var(--primary)' : 'var(--chart-1)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
