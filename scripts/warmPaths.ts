// scripts/warmPaths.ts
//
// WHICH paths the dev warm-up compiles. Pure: no network, no spawn, no
// side effects on import.
//
// SPLIT OUT OF scripts/dev.ts FOR A CONCRETE REASON. That file calls spawn()
// at module scope, so importing it to reach these functions STARTS A DEV
// SERVER — which is exactly what tests/scripts/dev.test.ts was doing on every
// run, leaking a Next process each time. A module whose import has side
// effects cannot be unit tested, and discovery is the half that most needs
// testing: warming a stale list looks identical to warming a complete one,
// right up until a friend's flow 403s mid-connect.
//
// Why the warm-up exists at all is documented in scripts/dev.ts and
// docs/local-dev.md.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What a dynamic segment becomes.
 *
 * The value is irrelevant — Next compiles the route module as soon as a
 * request MATCHES the pattern, long before the handler inspects the segment.
 * It is deliberately not a real slug so that a warm request can never be
 * mistaken for a real one in a log.
 */
const PLACEHOLDER = 'warmup'

/**
 * Every API route, discovered from the filesystem.
 *
 * DISCOVERED RATHER THAN LISTED, and that is the whole point: a hand-kept list
 * would be correct on the day it was written and quietly wrong the first time
 * someone adds a route — which is precisely the moment this is needed most.
 *
 * Exported and pure so tests/scripts/dev.test.ts can pin it without a network
 * or a server.
 */
export function apiRoutePaths(apiDir: string): string[] {
  const found: string[] = []

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // `[user]` and `[...slug]` alike collapse to one placeholder segment.
        const segment = /^\[.+\]$/.test(entry.name) ? PLACEHOLDER : entry.name
        walk(join(dir, entry.name), [...segments, segment])
      } else if (/^route\.tsx?$/.test(entry.name)) {
        found.push(`/api/${segments.join('/')}`)
      }
    }
  }

  walk(apiDir, [])
  return found.sort()
}

/**
 * Every PAGE, discovered from the filesystem exactly as the routes are.
 *
 * PAGES NEED THIS AS MUCH AS ROUTES DO, and this function used to warm only
 * the registered dashboards — which was the same mistake in a smaller place.
 * `app/plaid/oauth/page.tsx` was added afterwards, was not a dashboard, and so
 * was never warmed; loading it in the middle of an OAuth bank connection
 * compiled it for the first time, wiped the keymap, and 403'd the exchange
 * that came seconds later. A hand-drawn subset is wrong the moment someone
 * adds a page, which is precisely when it matters.
 *
 * So: walk `app/`, take every `page.tsx`, and warm all of them.
 *
 *   - `(group)` segments are Next route groups and do NOT appear in the URL,
 *     so `app/(auth)/login/page.tsx` is `/login`.
 *   - `[dynamic]` segments collapse to the placeholder, same as routes.
 */
export function pagePaths(appDir: string): string[] {
  const found: string[] = []

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // `_private` and `api` are not pages; api is walked by apiRoutePaths.
        if (entry.name === 'api' || entry.name.startsWith('_')) continue
        const next = /^\(.+\)$/.test(entry.name)
          ? segments // route group: contributes nothing to the URL
          : [...segments, /^\[.+\]$/.test(entry.name) ? PLACEHOLDER : entry.name]
        walk(join(dir, entry.name), next)
      } else if (/^page\.tsx?$/.test(entry.name)) {
        found.push(`/${segments.join('/')}`)
      }
    }
  }

  walk(appDir, [])
  return [...new Set(found)].sort()
}
