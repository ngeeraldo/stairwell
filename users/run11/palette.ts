// users/run11/palette.ts
//
// The colours the Spending pie is drawn with, and the one place they are
// written down. The CHART draws them (./SpendingPie.tsx) and the LEGEND draws
// swatches from the same array (./dashboard.tsx) — two copies of a palette are
// two things that can drift apart, and a legend whose swatch does not match its
// slice is worse than no legend at all.
//
// It is a plain module rather than an export from the chart component so that
// the server component can import it without pulling a 'use client' module into
// its own graph for a list of strings.
//
// ─── WHERE THESE VALUES COME FROM, AND THE CHECK THEY PASSED ───────────────
//
// The data-viz skill's validated categorical palette, slots 1-7 in its own
// fixed order. That order is the colourblind-safety mechanism rather than a
// preference: it was chosen among orderings that clear every adjacent-pair
// gate. Run against the light surface (this app is light-mode only — see
// app/globals.css, "no dark mode, no theme toggle", so there is deliberately
// no second set of values here):
//
//   Lightness band        PASS   all 7 inside L 0.43-0.77
//   Chroma floor          PASS   all 7 >= 0.1
//   CVD separation        PASS   worst adjacent dE 9.1 (protan)
//   Normal-vision floor   PASS   worst adjacent dE 19.6
//   Contrast vs surface   WARN   three slots below 3:1
//
// THE CONTRAST WARN IS NOT DISMISSED, it is paid for. Three of these sit below
// 3:1 against the page, and the rule for that is "relief required — visible
// labels or a table view". The legend beside the pie IS the table view: every
// slice appears there as a row carrying its name, its amount and its share in
// ordinary text. That is also what keeps identity from being colour-alone,
// which no chart in this repo may rely on.
//
// DO NOT ADD AN EIGHTH COLOUR to draw a ninth category. Past the seventh the
// remainder folds into "Other" (`foldIntoOther` in ./queries.ts) — a generated
// or recycled hue is how a palette stops being checkable.

/**
 * Slice colours, in the fixed order the validator cleared.
 *
 * Assigned by RANK — the largest slice takes slot 1 — which means a re-filing
 * that changes the order also changes which colour a category wears. That is a
 * knowing trade: the pie's whole job is "what is biggest", so it is sorted by
 * amount, and the alternative (a colour pinned to a category name forever)
 * cannot survive the fold into "Other" anyway. The legend carries the name on
 * every row, so nothing on this screen is identified by colour alone.
 */
export const SLICE_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
] as const

/**
 * The fold bucket's colour: a deliberate neutral, and the one value here that
 * is not a categorical hue.
 *
 * "Other" is not a category — it is the absence of one — so it reads as grey on
 * purpose and is excluded from the chroma floor the seven above must clear.
 */
export const OTHER_COLOR = '#8a8a85'

/** The colour for the slice at `index`, folding to the neutral past the seven. */
export function sliceColor(index: number): string {
  return SLICE_COLORS[index] ?? OTHER_COLOR
}
