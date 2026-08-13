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
export type DashboardProps = { slug: string; db: UserDb }

export type DashboardComponent = (
  props: DashboardProps,
) => ReactElement | Promise<ReactElement>

export type DashboardModule = { default: DashboardComponent }
