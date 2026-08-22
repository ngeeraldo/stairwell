// users/run12/dashboard.tsx
//
// run12's dashboard. NOT BUILT YET — this is the scaffold, and everything
// below is meant to be deleted rather than extended.
//
// Build toward users/run12/spec.md — pulled from the confirmed spec by
// ./scripts/pull-spec.sh — and the conversation itself. There is no mockup to
// build toward any more: nothing composes or serves mockup HTML (mockup-loop
// removal, plan 2026-08-19-remove-the-mockup-loop). Once this folder is
// built, users/run12/current.md becomes the next agent's orientation
// document — write it as part of building, per CLAUDE.md > Dashboard folder
// conventions, not as a copy of this comment. users/devone/ is the worked
// reference; docs/dashboard-build-rules.md indexes every rule that applies.
//
// ─── the four rules that survive whatever you replace this with ───
//
// 1. NO SQL HERE. Every statement lives in ./queries.ts, as pure functions
//    taking the `db` handle. Data logic in a .tsx file can only be tested by
//    rendering it.
//
// 2. `today` and `timeZone` are HANDED to this component and it never derives
//    either. Do not reach for Date.now() or new Date() to find out what day it
//    is: the answer would be the droplet's day, the droplet is UTC, and the
//    friend is not. tests/users/noLocalDay.test.ts enforces this over every
//    user folder — including this template, so a scaffold starts correct.
//
// 3. THE COMPONENT RULE HAS THREE ARMS (docs/dashboard-build-rules.md §3).
//    Presentational components — shadcn's Card, Button, anything rendering
//    props as markup without deriving values from them — are TRUSTED; nest
//    them freely. Data-computing components — Recharts, anything deriving a
//    scale or geometry from values — are SANCTIONED, guarded by a states
//    check: degenerate data renders the empty state as host elements and
//    never mounts the component. Interaction controls — lib/ui/WriteAction.tsx
//    below — are SANCTIONED and are the DEFAULT for every write. Outside
//    those three classes, compose host elements only (<div>, <section>,
//    <ul>, ...). The residual for all three arms is the same: app/[user]/page.tsx
//    wraps the direct call to this component's body in a try/catch, but a
//    nested component's body is deferred to Next's own render pass, which
//    runs after that function returns and therefore OUTSIDE the catch. A
//    throw there 500s the page after the `dashboard_open` metric row has
//    already been written — which is why arm 3's mechanics live in
//    lib/ui/, tested once, rather than in code you write per dashboard.
//
// 4. IT MUST RENDER ON AN EMPTY DATABASE. A friend's first session shows their
//    own data, and they have none — there is no synthetic fallback standing in
//    front of it. An empty panel says "nothing logged yet"; it does not show a
//    confident zero, and it never reports days before they started as missed.
//
// Register it in lib/dashboard/registry.ts or it will not render at all:
//   run12: () => import('@/users/run12/dashboard'),
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'

// SCREENS — required, and at least one entry: a REGISTERED dashboard that
// declares zero throws (lib/dashboard/contract.ts's activeScreen). Take the
// id and title from spec.md's own `## Screens` section once a spec is
// confirmed — never invent a second source that could drift from what the
// spec promised. Until then this single placeholder screen is honest: there
// is exactly one thing to see, "under construction".
//
// THE PLATFORM RENDERS THE TAB STRIP, not this file — app/[user]/page.tsx's
// tabStrip reads this array and draws `<a href="?screen=...">` links above
// whatever this component returns. A dashboard never renders its own tabs.
// With one screen (or fewer), the platform renders NO strip at all — a
// single tab is chrome that explains nothing — which is why the component
// below does not branch on `props.screen`: there is only ever one thing to
// show, so nothing reads it yet.
//
// A second screen changes that. `screen` arrives already validated against
// this very array — never a raw, untrusted `?screen=` value, see
// activeScreen — so branching on it is just a comparison. This is the shape
// to copy, not to leave commented out once a real second screen exists:
//
//   export const screens: DashboardScreen[] = [
//     { id: 'morning', title: 'Morning', order: 1 },
//     { id: 'evening', title: 'Evening', order: 2 },
//   ]
//
//   export default function Dashboard({ slug, screen }: DashboardProps) {
//     if (screen === 'evening') {
//       return (
//         <section>
//           <h2>Evening</h2>
//         </section>
//       )
//     }
//     return (
//       <section>
//         <h2>Morning</h2>
//       </section>
//     )
//   }
export const screens: DashboardScreen[] = [{ id: 'morning', title: 'Morning', order: 1 }]

// A WRITE CONTROL, if the spec asks for one. This is the DEFAULT — a write
// control patches the page in place and never navigates. lib/ui/WriteAction.tsx
// owns the pending state, the POST and the refresh; you write none of it.
//
//   import { WriteAction } from '@/lib/ui/WriteAction'
//
//   <WriteAction
//     action={`/api/users/${slug}/<verb>`}
//     payload={{ action: 'add' }}
//     pendingLabel="Saving…"
//   >
//     Log one
//   </WriteAction>
//
// The route it posts to is yours to write — copy
// platform/templates/route/route.ts.tmpl, which carries the four ordered auth
// checks. A dashboard with an entry widget is TWO pieces of work; budget for
// the route while you are reading the spec.

export default function Dashboard({ slug }: DashboardProps) {
  return (
    <section>
      <h2>Under construction</h2>
      <p>{slug}’s dashboard has not been built yet.</p>
    </section>
  )
}
