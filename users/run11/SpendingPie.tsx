'use client'

// users/run11/SpendingPie.tsx
//
// The wedges of the "Where it went" panel — spec v3's pie of the last 30 days
// of card and bank spending, one slice per category.
//
// ─── why this is a CLIENT component ────────────────────────────────────────
//
// Recharts is a client library; there is no server-rendering path for it. That
// is the only reason. Everything this file could decide has been decided
// before it is called.
//
// ─── the component rule, arm 2 ─────────────────────────────────────────────
//
// docs/dashboard-build-rules.md §3: a component deriving scales, layout or
// geometry from values is SANCTIONED, GUARDED BY A STATES CHECK — degenerate
// data (empty, single-point, all-identical, NaN) must render the panel's empty
// state as host elements and never mount the component at all.
//
// THAT GUARD IS IN ./dashboard.tsx, NOT HERE, and it has to be: a guard inside
// this file would run after the component had already mounted, which is the
// thing the rule forbids. What the caller proves before rendering this:
//
//   * at least one slice;
//   * every `amount` finite and > 0 (`categoryTotals` drops anything that nets
//     to zero or less, so a wedge can never be zero-width or negative);
//   * `share` already computed against a positive total.
//
// So there is no degenerate input left for this file to handle, and it
// deliberately does not re-check — a second copy of the states check is a
// second answer to "what counts as drawable".
//
// ─── it decides nothing ────────────────────────────────────────────────────
//
// Labels, colours, ordering, the fold into "Other" and every formatted number
// arrive as props. A client component's body never runs in this dashboard's own
// vitest suite (lib/ui/useWriteAction.ts records the same limitation about its
// own guard), so a rule left in this file would be a rule nothing in
// users/run11/tests/ can check. `foldIntoOther` and `categoryTotals` are in
// ./queries.ts for exactly that reason, and ./palette.ts owns the colours so
// the legend beside this chart cannot disagree with a wedge.
//
// ─── no animation on arrival ───────────────────────────────────────────────
//
// `isAnimationActive={false}`. docs/dashboard-ui-ux-guidelines.md > Delight:
// "The glance is never gated on motion — no entrance choreography, no
// count-up-from-zero on load. The dashboard is readable the frame it renders."
// Recharts animates a pie's sweep by default, which is exactly that.
//
// ─── a fixed size rather than a ResponsiveContainer ────────────────────────
//
// ResponsiveContainer measures its parent on the client, so it renders nothing
// in the server HTML and the panel jumps when it settles. A pie is a circle
// with a natural size and nothing to gain from being fluid, so it is drawn at a
// fixed square that fits inside the 375px container with room to spare, and the
// panel around it is what reflows.
import { Cell, Pie, PieChart, Tooltip } from 'recharts'

export type PieSlice = {
  /** The category as the friend reads it — already humanised by the caller. */
  label: string
  /** Net dollars out. Always finite and > 0; see the header. */
  amount: number
  /** Share of the window, 0..1. */
  share: number
  /** From ./palette.ts, so the legend's swatch and this wedge cannot differ. */
  color: string
  /** Preformatted, so this file holds no formatting rule of its own. */
  amountLabel: string
  shareLabel: string
}

/**
 * The hover layer, which a chart in this repo ships by default.
 *
 * It repeats what the legend already says rather than revealing anything new —
 * on a pie, pointing at a wedge and being told what it is IS the interaction,
 * and a tooltip that appeared only for hidden data would make the legend look
 * incomplete.
 *
 * Typed loosely because Recharts' own payload type is generic over the data
 * shape and carries `any` through it; the only field read is `payload`, which
 * is the datum handed to <Pie> below.
 */
function SliceTooltip({ active, payload }: { active?: boolean; payload?: { payload: PieSlice }[] }) {
  const slice = payload?.[0]?.payload
  if (active !== true || slice === undefined) return null
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-medium text-popover-foreground">{slice.label}</p>
      <p className="text-muted-foreground tabular-nums">
        {slice.amountLabel} · {slice.shareLabel}
      </p>
    </div>
  )
}

export function SpendingPie({ slices, title }: { slices: PieSlice[]; title: string }) {
  return (
    // role="img" with a name, because the SVG itself is a pile of paths: a
    // screen reader gets the summary here and the numbers from the legend
    // beside it, which is ordinary text and the actual accessible surface.
    <div role="img" aria-label={title} className="shrink-0">
      <PieChart width={248} height={248}>
        <Pie
          data={slices}
          dataKey="amount"
          nameKey="label"
          cx="50%"
          cy="50%"
          outerRadius={112}
          isAnimationActive={false}
          // A 2px surface gap between fills, so two adjacent wedges of similar
          // colour still read as two wedges.
          stroke="var(--background)"
          strokeWidth={2}
        >
          {slices.map((slice) => (
            <Cell key={slice.label} fill={slice.color} />
          ))}
        </Pie>
        <Tooltip content={<SliceTooltip />} />
      </PieChart>
    </div>
  )
}
