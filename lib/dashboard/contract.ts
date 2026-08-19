import type { ReactElement } from 'react'
import type { UserDb } from '@/lib/db/userDb'

/**
 * What a bespoke dashboard is handed: its own slug, and an open read-only
 * handle on its own database. It cannot obtain anyone else's, because it is
 * never given one — app/[user]/page.tsx calls openUserDb with the slug it has
 * already authorised, and the dashboard never calls it at all.
 *
 * There is no `source` field and no undefined-`db` case. The page calls a
 * dashboard only once it holds a real handle, so a dashboard has no "what if
 * there is no data" branch to get wrong. Step 6 widens this when there is a
 * second source to distinguish.
 */
export type DashboardProps = {
  slug: string
  db: UserDb
  /**
   * Today, as 'YYYY-MM-DD', in the FRIEND'S timezone — computed once per
   * request by app/[user]/page.tsx and handed down.
   *
   * A dashboard never derives this. That is not a style preference: the write
   * path (the walk route) files a tap under a day, and if a dashboard computed
   * its own "today" from a clock the two could disagree about the calendar
   * without either looking wrong. They did disagree — see lib/time/dayKey.ts —
   * and the fix is that there is now exactly one place a day comes from.
   *
   * `tests/users/noLocalDay.test.ts` enforces it across every user folder,
   * including ones that do not exist yet.
   */
  today: string
  /**
   * The friend's IANA timezone, for units COARSER than a day.
   *
   * `today` covers the common case and is authoritative. This is for a
   * dashboard that buckets by month or week and therefore has to turn stored
   * instants into the friend's calendar itself — `dayKey(row.at, timeZone)`.
   * users/devone/queries.ts is the worked example.
   *
   * It can be `undefined` on the very first response of a new session, before
   * the browser has told the server anything; `dayKey` falls back to UTC.
   */
  timeZone: string | undefined
  /**
   * Which of the dashboard's own `screens` is active for this render — the
   * id of one entry in the `screens` array the dashboard's own module
   * exports, never a second source. app/[user]/page.tsx resolves this
   * through `activeScreen` before calling the dashboard, so by the time a
   * dashboard sees it, it is already validated against its own declared
   * list — never an arbitrary `?screen=` value.
   *
   * STILL OPTIONAL as of task 23, deliberately, and for a different reason
   * than task 22's original one (that reason — no dashboard declared
   * `screens` yet — is gone now that all four do). `DashboardModule.screens`
   * below was tightened to required because it has exactly one producer per
   * dashboard (the module's own export) and zero legitimate readers who don't
   * care about its value, so making it required costs nothing and buys real
   * enforcement. `screen` is different: EVERY one of the four dashboards has
   * exactly one screen and none branches on this prop, and every one of their
   * own tests calls the component directly with a DashboardProps object built
   * for readability, not completeness. Requiring it would force each of those
   * call sites — dozens across four folders, plus every scaffold's tests
   * hereafter — to name a field their dashboard does not read, for no
   * type-safety gain: app/[user]/page.tsx's call site still writes
   * `screen: active?.id`, not `active.id` — `active` is computed from a
   * ternary that keeps a `DashboardScreen | undefined` shape on purpose (the
   * `undefined` arm is defense in depth for a module that fails the
   * now-required `screens` field some other way than the type system, see
   * `DashboardModule` below), so the one real producer of this prop is
   * itself written against the optional case, not a case that could drop the
   * `?`. A component that starts branching on it gets full type coverage on
   * that branch the moment it's written, optional or not. Revisit if a
   * second screen ever needs page.tsx itself to prove it always passes one.
   */
  screen?: string
}

export type DashboardComponent = (
  props: DashboardProps,
) => ReactElement | Promise<ReactElement>

/**
 * A place in the app. `id`/`title`/`order` mirror lib/spec/schema.ts's
 * `Screen` fields exactly — but that type is a FROZEN reader now, describing
 * the whole-surface rows already in `specs`, not what a spec says today.
 *
 * A change-only spec (lib/spec/change.ts) carries no ids at all: it names a
 * screen the way the friend does. So a `title` still comes from what the
 * spec asked for, while `id` and `order` are the BUILDER's — chosen at build
 * time and written down in users/<slug>/current.md's `## Screens`, which is
 * what the next build and the chat agent both read. The field triple stays
 * aligned with `Screen` so a dashboard built against an older whole-surface
 * spec still means exactly what it meant then.
 */
export type DashboardScreen = { id: string; title: string; order: number }

/**
 * REQUIRED as of task 23: all four dashboards registered in
 * lib/dashboard/registry.ts now export `screens`, so
 * `Record<string, () => Promise<DashboardModule>>` enforces it at compile
 * time for every one of them — and for anything registered from here on —
 * rather than leaving it to a runtime sweep or Task 24 alone. It was
 * OPTIONAL through task 22 for exactly the reason a required field would
 * have broken: no dashboard exported it yet, and a required-but-missing
 * field fails `npx tsc --noEmit`, not a test.
 *
 * A dashboard that gets it wrong (an explicit `screens: []`) still fails at
 * RUNTIME, not compile time — TypeScript can enforce "an array exists", not
 * "the array is non-empty". `activeScreen` still throws on that case (see
 * below), and app/[user]/page.tsx's own `renderDashboard` still catches that
 * throw the same way it catches a throwing `Dashboard()` call, turning it
 * into `dashboard_error` rather than a 500. That `screens === undefined`
 * branch in app/[user]/page.tsx's `renderDashboard` is now unreachable
 * through the registry's real types — CORRECTED there final review, Minor 5,
 * after this paragraph outlived being true — and is left as defense in
 * depth rather than deleted, since the array is still supplied by a
 * `Promise<DashboardModule>` resolved dynamically at runtime, not proven by
 * the type system alone.
 */
export type DashboardModule = {
  default: DashboardComponent
  screens: DashboardScreen[]
}

/**
 * Resolves the search param to one of the dashboard's own declared screens.
 *
 * Sorts by `order`, not array position — CLAUDE.md's screens carry an
 * explicit order for exactly this reason, and an author is free to declare
 * them out of sequence.
 *
 * Falls back to the lowest-order screen for anything that isn't a live id,
 * rather than throwing: `?screen=` is user input (typed, bookmarked, or a
 * stale link from a dashboard that dropped a tab), and a typo must not be a
 * dead end — it lands on the same surface a bare `/<slug>` would.
 *
 * The empty-list case is different in kind, not degree: a REGISTERED
 * dashboard declaring zero screens is not user input, it is the dashboard's
 * own module violating its contract, and papering over it with a synthetic
 * screen would hide that defect behind a page that quietly renders nothing
 * useful. It throws, and the caller's existing dashboard_error path — the
 * same one that already catches a throwing Dashboard() call — is what turns
 * it into "This dashboard failed to load" instead of a 500.
 */
export function activeScreen(
  screens: DashboardScreen[],
  requested: string | undefined,
): DashboardScreen {
  if (screens.length === 0) {
    throw new Error('activeScreen: a registered dashboard must declare at least one screen')
  }
  const sorted = [...screens].sort((a, b) => a.order - b.order)
  const match = requested === undefined ? undefined : sorted.find((s) => s.id === requested)
  return match ?? sorted[0]!
}
