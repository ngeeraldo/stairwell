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
   * OPTIONAL, not because a real render ever omits it — app/[user]/page.tsx
   * always passes one — but because none of the four dashboards live on this
   * branch today export a `screens` list yet (task 22 is the first task of
   * Part D; migrating each dashboard onto declared screens is later work).
   * Their own tests call the component directly with a DashboardProps object
   * that has no reason to know this field exists. Required-but-unread would
   * force every one of those call sites to change for a value nothing reads
   * yet; optional keeps this task's blast radius at the two files it is
   * actually about.
   */
  screen?: string
}

export type DashboardComponent = (
  props: DashboardProps,
) => ReactElement | Promise<ReactElement>

/**
 * A place in the app, per the spec prompt's own words. `id`/`title`/`order`
 * mirror lib/spec/schema.ts's `Screen` fields exactly — never a second
 * source that could drift from what the spec promised.
 */
export type DashboardScreen = { id: string; title: string; order: number }

/**
 * `screens` is OPTIONAL on the module for the same migration-period reason
 * `DashboardProps.screen` is optional above: none of the four dashboards
 * registered on this branch export it yet, and lib/dashboard/registry.ts's
 * `Record<string, () => Promise<DashboardModule>>` type-checks every one of
 * them against this shape at compile time — a required field here does not
 * fail at runtime, it fails `npx tsc --noEmit` for every dashboard that
 * hasn't been migrated, which is all of them today.
 *
 * app/[user]/page.tsx treats `undefined` and a declared `[]` differently on
 * purpose (see the comment above its screens-resolution call): `undefined`
 * is "not migrated yet", a known, harmless, present-day state that degrades
 * to no tab strip; a dashboard that explicitly exports `screens: []` has
 * opted into the contract and gotten it wrong, which is the real defect
 * `activeScreen`'s throw exists to surface.
 */
export type DashboardModule = {
  default: DashboardComponent
  screens?: DashboardScreen[]
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
