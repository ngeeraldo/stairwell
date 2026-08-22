// users/run12/palette.ts
//
// The colours the Spending Breakdown pie is drawn with, and the one place they
// are written down. The CHART draws them (./SpendingPie.tsx) and the LEGEND
// draws its swatches from the same array (./dashboard.tsx) — two copies of a
// palette are two things that can drift apart, and a legend whose swatch does
// not match its slice is worse than no legend at all.
//
// It is a plain module rather than an export from the chart component so that
// the server component can import it without pulling a 'use client' module into
// its own graph for a list of strings.
//
// ─── WHERE THESE VALUES COME FROM, AND THE CHECK THEY PASSED ───────────────
//
// The data-viz skill's validated categorical palette, all EIGHT slots in its
// own fixed order. That order is the colourblind-safety mechanism rather than a
// preference: candidate orderings were enumerated and only those clearing every
// adjacent-pair gate kept. Taking the eight in that order — rather than picking
// eight hues that look nice together — is the entire reason the check below
// passes.
//
// Run against the light surface, and only the light surface: this app is
// light-mode only (app/globals.css — "Light mode only. No dark mode, no theme
// toggle"), so there is deliberately no second set of values here.
//
//   node scripts/validate_palette.js "<the eight below>" --mode light
//
//   Lightness band        PASS   all 8 inside L 0.43-0.77
//   Chroma floor          PASS   all 8 >= 0.1
//   CVD separation        PASS   worst adjacent #eda100↔#1baf7a dE 9.1 (protan)
//   Normal-vision floor   PASS   worst adjacent #e87ba4↔#eda100 dE 19.6
//   Contrast vs surface   WARN   three slots below 3:1
//
// THE CONTRAST WARN IS NOT DISMISSED, IT IS PAID FOR. Aqua, yellow and magenta
// sit below 3:1 against the page, and the rule for that is "relief required —
// visible labels or a table view". The legend beside the pie IS the table view:
// every category appears there as a row carrying its name, its amount and its
// share in ordinary text ink. That is also what keeps identity from being
// colour-alone, which no chart in this repo may rely on.
//
// ─── WHY THERE IS NO NINTH COLOUR, AND WHY THE FRIEND STILL SEES EVERY ─────
// ─── CATEGORY ──────────────────────────────────────────────────────────────
//
// The data-viz skill's own non-negotiable: "Assign categorical hues in fixed
// order, never cycled. A 9th series is never a generated hue — it folds into
// 'Other'." A generated or recycled hue is how a palette stops being checkable,
// so past the eighth the remainder folds (`foldIntoOther` in ./queries.ts).
//
// That does NOT cost the friend the thing spec v1 asked for. "Every category is
// shown — this is not a watchlist of a few chosen categories" is answered by the
// LEGEND, which lists every category in the window with its own amount and its
// own share, folded or not. The fold is a property of the CHART — eight wedges
// is roughly what a pie can carry before it stops answering anything — and the
// panel says out loud how many categories the grey wedge is standing for, so
// nothing is silently dropped. In practice the fold rarely fires at all: Plaid's
// primary categories are a bounded enum and four of them never reach this screen
// (003's `is_internal`), so a 30-day window with more than nine spending
// categories in it is unusual rather than routine.

/**
 * Slice colours, in the fixed order the validator cleared.
 *
 * ASSIGNED BY RANK — the largest slice takes slot 1, and the legend is sorted
 * the same way, so a row's position, its swatch and its wedge are one thing.
 *
 * This is the deliberate exception to the skill's "colour follows the entity,
 * never its rank", and the reason is the pie's own geometry. The validated
 * guarantee above is about ADJACENT SLOTS: slots 1-2 are safe to sit beside
 * each other, 2-3, 3-4, and so on. On a pie sorted biggest-first, adjacent
 * WEDGES are adjacent RANKS — so assigning by rank is what makes the wedge
 * adjacency the pair list that was actually checked. Pinning a colour to a
 * category name instead would put an arbitrary permutation of slots next to
 * each other, and the palette's own notes name the pair that breaks: slot 2
 * beside slot 4 (orange and yellow) fails the normal-vision floor at dE 13.7.
 *
 * The cost is real and is worth stating: a category that moves from third to
 * fourth largest between two mornings changes colour. What absorbs it is that
 * nothing on this screen is identified by colour alone — every legend row
 * carries its category's name in text, immediately beside its swatch and its
 * numbers, so the colour is a lookup key between two things sitting next to
 * each other rather than an identity the friend has to remember across renders.
 */
export const SLICE_COLORS = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const

/**
 * The fold bucket's colour: a deliberate neutral, and the one value here that
 * is not a categorical hue.
 *
 * "Other" is not a category — it is the absence of one — so it reads as grey on
 * purpose, and is excluded from the chroma floor the eight above must clear.
 */
export const OTHER_COLOR = '#8a8a85'

/** The colour for the slice at `index`, folding to the neutral past the eight. */
export function sliceColor(index: number): string {
  return SLICE_COLORS[index] ?? OTHER_COLOR
}
