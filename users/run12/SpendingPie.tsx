'use client'

// users/run12/SpendingPie.tsx
//
// The wedges of "Where my money went (last 30 days)" — spec v1's pie of the
// last 30 days of checking and credit-card spending, one slice per category,
// biggest to smallest so the largest categories are obvious at a glance.
//
// ─── why this is a CLIENT component ────────────────────────────────────────
//
// Recharts is a client library; there is no server-rendering path for it. That
// is the only reason. Everything this file could decide has been decided before
// it is called.
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
// vitest suite, so a rule left in this file would be a rule
// users/run12/tests/ cannot check. `foldIntoOther` and `categoryTotals` are in
// ./queries.ts for exactly that reason, and ./palette.ts owns the colours so
// the legend beside this chart cannot disagree with a wedge.
//
// ─── no labels ON the wedges, and that was a measurement ───────────────────
//
// Spec v1 asks that "each slice is labelled with the category and its
// percentage share". THE LEGEND BESIDE THIS CHART IS THAT LABELLING, in text
// ink, one row per category carrying its name, its amount and its share.
//
// Text drawn INSIDE a wedge was tried and rejected on a number rather than on
// taste: the palette's slot 1 (#2a78d6) reaches only 4.42:1 against white and
// 4.28:1 against near-black, so no ink clears 4.5:1 on it at the size a wedge
// label would be, and a chart whose labels are legible on seven slices and
// marginal on the eighth is worse than one that puts them all in the same place.
// Text OUTSIDE the wedges with leader lines needs horizontal room this panel
// does not have at 375px, and buying it with a second layout would fork the
// panel's internals per breakpoint — which
// docs/dashboard-ui-ux-guidelines.md > Layout forbids by name.
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
// in the server HTML and the panel jumps when it settles. A pie is a circle with
// a natural size and nothing to gain from being fluid, so it is drawn at a fixed
// square that fits inside the 375px container with room to spare, and the panel
// around it is what reflows — one column on a phone, chart-beside-legend on the
// desktop browser window spec v1 says this is actually read in.
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
 * On a pie, pointing at a wedge and being told what it is IS the interaction —
 * it is the one thing the legend cannot do, since a legend row cannot tell you
 * which wedge your eye is already on. It repeats what the legend says rather
 * than revealing anything new: a tooltip that appeared only for hidden data
 * would make the legend look incomplete.
 *
 * Typed loosely because Recharts' own payload type is generic over the data
 * shape and carries `any` through it; the only field read is `payload`, which is
 * the datum handed to <Pie> below.
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
    // screen reader gets the summary here and the numbers from the legend beside
    // it, which is ordinary text and the actual accessible surface.
    <div role="img" aria-label={title} className="shrink-0">
      <PieChart width={276} height={276}>
        <Pie
          data={slices}
          dataKey="amount"
          nameKey="label"
          cx="50%"
          cy="50%"
          outerRadius={130}
          isAnimationActive={false}
          // A 2px surface gap between fills, so two adjacent wedges of similar
          // colour still read as two wedges. It is the spacer the data-viz mark
          // specs ask for between adjacent fills, and it is also the secondary
          // encoding that makes the adjacent-pair CVD result in ./palette.ts
          // mean what it says on a chart with no gaps drawn.
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
