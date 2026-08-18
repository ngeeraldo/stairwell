// users/run4/dashboard.tsx
//
// run4's dashboard. NOT BUILT YET — this is the scaffold, and everything
// below is meant to be deleted rather than extended.
//
// Build toward users/run4/mockup.html and spec.md, pulled from their
// confirmed spec by ./scripts/pull-spec.sh. users/devone/ is the worked
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
// 3. COMPOSE ONLY HOST ELEMENTS (<div>, <section>, <ul>, ...) — never a nested
//    function component (returning <Foo />, where Foo is itself a function
//    component). app/[user]/page.tsx wraps the direct call to this component's
//    body in a try/catch, but a nested component's body is deferred to Next's
//    own render pass, which runs after that function returns and therefore
//    OUTSIDE the catch. A throw there 500s the page after the `dashboard_open`
//    metric row has already been written.
//
// 4. IT MUST RENDER ON AN EMPTY DATABASE. A friend's first session shows their
//    own data, and they have none — there is no synthetic fallback standing in
//    front of it. An empty panel says "nothing logged yet"; it does not show a
//    confident zero, and it never reports days before they started as missed.
//
// Register it in lib/dashboard/registry.ts or it will not render at all:
//   run4: () => import('@/users/run4/dashboard'),
import type { DashboardProps, DashboardScreen } from '@/lib/dashboard/contract'

// From spec.md's `## Screens`: `### \`walk_now\` — Walk now?`. The id and
// title are the spec's own words, never a second source that could drift
// from what the confirmed spec promised — even though the build below is
// still the scaffold placeholder.
export const screens: DashboardScreen[] = [{ id: 'walk_now', title: 'Walk now?', order: 1 }]

export default function Dashboard({ slug }: DashboardProps) {
  return (
    <section>
      <h2>Under construction</h2>
      <p>{slug}’s dashboard has not been built yet.</p>
    </section>
  )
}
