# Designing a dashboard - the guidelines

## The user is always right
If a UI/UX request comes from a user, it takes precendence over every default in this doc, provided it:
- Is buildable as is, or by adding a bundled npm dependency (never a CDN or external resource),
- Doesn't violate the privacy promise (no external URLs of any kind),
- Doesn't restyle or relocate platform chrome (privacy toggle,
  synthetic-data banner, screen tabs).

A request that fails one of these gets escalated to Nico, not silently
adjusted or refused.

Everything below is the default — how dashboards get designed when the
user hasn't asked for something else.

## Packages
Default stack: **shadcn/ui on Tailwind.** Use its components and
conventions everywhere they fit — stock defaults are the baseline, not
a starting point to restyle.

Charts: **Recharts** is the default. Every line, bar, and area chart
starts there. Deviate only when Recharts genuinely can't produce the
asked-for experience, and say so in the completion report.

Adding packages:
- Bundled npm dependencies only. Never a CDN, never an external URL,
  never a script or font or image fetched from anywhere. This is the
  privacy promise, not a style preference.
- Prefer solving with what's already installed. A new dependency is a
  per-dashboard cost that every future build inherits — add one when it
  clearly beats what we have, not when it's marginally nicer.
- New dependencies get named in the completion report.

## Layout
Every dashboard targets a **fluid container: ~375px up to a max content
width of 1200px, centered.** Desktop viewports beyond 1200px get
background, not wider content. No fixed widths, no assumed viewport.
One responsive implementation — internals never forked per breakpoint.

- Build mobile-readable first: the morning glance is most likely a
  phone. Desktop gets more columns, not different internals.
- Panel grids: 1 column at phone width, 2–3 at desktop. A panel should
  read well at ~375px; the grid reuses that same panel as a desktop
  cell.
- Test every screen at **375px and 1440px** before calling it done.
  Both must look intentional, not just unbroken.
- Vertical hierarchy is the layout: the most important panel sits at
  the top and reads without scrolling at 375px.
- Text-dense panels cap their measure (~680px) rather than stretching —
  wide space gets more columns, not wider text.

## States

Every panel has four non-happy states. None of them may be silent.

**Empty (no data yet in a real category).** Show what the panel is
waiting for, in the panel's own voice — "No transactions synced yet,"
"Log your first workout to start this chart." Never a blank card, never
a zero that looks like real data (an account showing $0 because it
hasn't synced is a lie; an account showing $0 because it's empty is
data — these must not render identically).

**Pre-existence days.** Panels anchored to in-dashboard behavior
(habits, manual logs, check-ins) start at the dashboard's birth —
days before it existed are unknowable, and never render as missed,
zero, or broken-streak. Panels fed by synced sources (Plaid) show
history as far back as real data exists; backfilled data is data,
not absence. The test: could the user have produced this day's value
before the dashboard existed? If no, the day doesn't render as a
failure. If yes (it was synced), render it.

**Error (a panel's data source failed).** The panel degrades honestly:
it says it couldn't load, in plain words, and never renders stale or
partial data as if it were current. One broken panel never takes down
the dashboard — errors are contained at the panel boundary.

**Login-sync loading.** Some sync runs at login, others triggered by 
button clicks; there is exactly one loading pattern, decided here, not 
per dashboard: panels render immediately with their last-known data plus 
a quiet "updating…"indicator, then settle. No blocking spinner over the 
whole dashboard. Panels with no prior data show their empty state during 
sync, not a skeleton.

## Formatting

Decided once, used everywhere. Per-user divergence only by request.

**Currency.** Whole dollars in glance positions ($1,284, not
$1,284.31); cents only in transaction rows and anywhere the user is
reconciling. Negative amounts get a sign or color, never parentheses.

**Dates.** Relative when recent ("today," "yesterday," "Mon"), absolute
beyond a week ("Aug 12"). Year only when it isn't this year. No
timestamps in glance positions — the morning glance doesn't care about
14:32:07.

**Deltas.** A change reads as direction + magnitude at a glance: arrow
or sign, and color. Color follows meaning, not sign — spending up is
red, savings up is green, weight depends on the user's stated goal.
When a delta's good-direction is ambiguous, ask in the interview; never
guess.

**Timezone.** All day-boundary logic (streaks, "today," daily
rollups) uses the user's timezone — never the server's, and never a
clock the dashboard reads itself.

A dashboard never resolves this. It is handed `today` (their day, as
`YYYY-MM-DD`) and `timeZone` (the IANA name), both resolved once per
request by `app/[user]/page.tsx` from the `stairwell_tz` cookie the
root layout writes. On the first render of a session that cookie does
not exist yet, so `timeZone` is `undefined` and `dayKey` degrades to
UTC. Server and tests stay pinned UTC; the conversion happens at that
one edge.

This is a data-safety rule wearing a formatting rule's clothes, not a
preference: the day is a primary key in a database with no migration
story, so a read and a write that disagree about the calendar write a
row that is wrong forever. It has happened here once already — see
`docs/superpowers/ledgers/friend-timezone.md`, and
`CLAUDE.md` > Dashboard folder conventions for the rule itself.
`tests/users/noLocalDay.test.ts` enforces it: no `Date.now()`, no
zero-argument `new Date()`, and no importing `lib/time/dayKey` into a
`dashboard.tsx`.

## Delight / Animation
All interactivy should feel delightful and alive, nothing should feel static.
Not complex; enough that it feels like a real product.

**Animation responds to the user. It never impersonates the system.**
Data is static after login sync — nothing may pulse, tick, shimmer, or
count up on its own in a way that suggests live updates. A number
animates when the user changes it, not when it renders.

**The glance is never gated on motion.** No entrance choreography, no
staggered panel fade-ins, no count-up-from-zero on load. The dashboard
is readable the frame it renders; delight lives in interaction, not
arrival.

**Fast and physical.** Interaction feedback runs ~100–200ms,
ease-out. If an animation is slow enough to notice as an animation,
it's too slow.

Ex. A simple counter app that has an 'up' and 'down' button and the count as a number.

**Bad:** 
 - Buttons are static on press.
 - The number counts up by itself on page load (impersonates liveness).
 - The number takes half a second to settle (slow enough to notice).

**Good:**
 - Button scales down slightly on press, back up on release.
 - The number pops — a quick scale up/down — when the user changes it.