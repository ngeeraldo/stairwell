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
}

export type DashboardComponent = (
  props: DashboardProps,
) => ReactElement | Promise<ReactElement>

export type DashboardModule = { default: DashboardComponent }
