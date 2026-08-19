'use client'

// users/run9/TrendChart.tsx
//
// The 7-day daily trend, as a bar chart. A CLIENT component, and the only one
// under users/ — everything else run9 renders is a server component composing
// host elements.
//
// ─── why this is allowed to exist, and what guards it ───
//
// CLAUDE.md's dashboard rules say a dashboard composes only host elements: a
// nested function component's body is deferred to React's own render pass,
// which runs after app/[user]/page.tsx's renderDashboard has already returned,
// and therefore OUTSIDE the try/catch that turns a broken dashboard into a
// degraded panel instead of a 500 with the chat surface gone.
//
// Nico's ruling of 2026-08-19 carves out a sanctioned exception and states its
// guard, and both halves matter:
//
//   Data-computing components (Recharts, and anything that derives scales,
//   layout, or geometry from values) are a sanctioned exception to
//   host-elements-only, GUARDED BY THE STATES RULE: degenerate data (empty,
//   single-point, all-identical, NaN) renders the panel's empty state as host
//   elements and never mounts the component. The empty-database first render
//   must show empty states, not charts. Purely presentational components are
//   trusted like shadcn's. Accepted residual: a throw on well-formed props
//   lands outside the catch.
//
// So THIS FILE IS NEVER REACHED ON DEGENERATE DATA. dashboard.tsx decides
// that before rendering anything (see `chartable` there), which is what keeps
// the accepted residual to "a throw on well-formed props" rather than "a throw
// on the first screen a friend ever sees".
//
// It reads no clock and holds no state: every day, count and label arrives
// fully resolved from queries.ts. Worth saying explicitly because
// tests/users/noLocalDay.test.ts sweeps users/*/dashboard.tsx and
// users/*/queries.ts by name and does NOT see this file — run9 is the first
// folder to have a third .tsx, so that sweep has a blind spot here that it did
// not have before.
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
  /** The weekly baseline, drawn as a reference line. Absent on day one. */
  average?: number
}) {
  const todayLabel = data[data.length - 1]?.label

  return (
    // Fluid, never a fixed width: the container is 375px on a phone and up to
    // 1200px on a desktop, and the chart is sized by its parent in both.
    <div className="h-48 w-full">
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
            // The whole point of the average panel, drawn where it is
            // readable: the spec calls it "a baseline to read the daily trend
            // against", and a number in a separate card is a baseline the
            // reader has to hold in their head.
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
            // in. Delight lives in the hover/press above, not in arrival.
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell
                key={d.day}
                // Today is the comparison the panel exists to serve, so it is
                // the one bar that carries the accent.
                fill={d.label === todayLabel ? 'var(--primary)' : 'var(--chart-1)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
