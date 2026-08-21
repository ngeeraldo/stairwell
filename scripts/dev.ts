/**
 * `npm run dev` — Next's dev server, with every API route compiled up front.
 *
 * ── THE PROBLEM THIS EXISTS FOR ─────────────────────────────────────────────
 *
 * Next compiles a route the first time it is requested, and that compilation
 * RE-EVALUATES THE SERVER MODULE GRAPH. lib/session/keymap.ts holds its
 * derived keys in a module-level `const keys = new Map()` — deliberately, since
 * a key may never be serialized or persisted — so a fresh module instance is an
 * EMPTY map, and every unlocked session in the process silently becomes locked.
 *
 * The symptom is brutal to diagnose because it lands mid-flow. Observed while
 * building the Plaid connect flow:
 *
 *     POST .../plaid/link-token 200            <- key present, works
 *     ✓ Compiled /api/users/[user]/plaid/connect
 *     [plaid_connect] refused: session not unlocked   <- key gone
 *     POST .../plaid/connect 403
 *
 * Two routes with identical auth checks, seconds apart, in one process. The
 * friend did nothing wrong and the code is not wrong; the second route had
 * simply never been served before.
 *
 * It bites hardest on exactly the flows that are hardest to test by hand: any
 * multi-step journey whose LATER routes are only reached after the earlier
 * ones, so the compile always lands in the middle.
 *
 * ── WHY WARMING AT STARTUP IS FREE ──────────────────────────────────────────
 *
 * Compiling resets the keymap, so warming has a cost — but at startup nobody
 * has unlocked yet, so there is no key to lose. Doing it here and only here is
 * what makes it harmless.
 *
 * PRODUCTION IS UNAFFECTED and needs nothing: `next build` compiles every route
 * ahead of time, so nothing compiles on demand and the keymap is never reset.
 * The production version of this behaviour is intended and documented — "a
 * deploy leaves users logged in but locked" (architecture-overview.md §2).
 *
 * ── THE RESIDUAL, STATED RATHER THAN HIDDEN ─────────────────────────────────
 *
 * EDITING a route file still recompiles it and still drops every key. Nothing
 * here can prevent that, and it is much less confusing than the original
 * problem: you changed a file, so being asked for your password again is at
 * least legible. If you are mid-flow when you save, unlock and start over.
 */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { registeredSlugs } from '../lib/dashboard/registry'
import { apiRoutePaths, pagePaths } from './warmPaths'
import { SESSION_COOKIE } from '../lib/session/cookie'

const PORT = process.env.PORT ?? '3000'
const ORIGIN = `http://localhost:${PORT}`

/** How long to wait for the dev server to start listening before giving up. */
const BOOT_TIMEOUT_MS = 60_000
const POLL_MS = 250

async function waitForServer(): Promise<boolean> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      // /login is public and needs no session, so a 200 here means "listening"
      // and nothing more.
      const response = await fetch(`${ORIGIN}/login`)
      if (response.ok) return true
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  return false
}

/**
 * The dashboards, by their REAL slugs.
 *
 * pagePaths already warms `app/[user]/page.tsx` under a placeholder, which
 * compiles the page — but not the dashboard component itself, which
 * lib/dashboard/registry.ts loads through a dynamic import that only runs for
 * a slug that is actually registered. A placeholder slug renders the
 * not-built card and never touches that chunk, so the first real visit would
 * still compile it, mid-session.
 */
function dashboardPagePaths(): string[] {
  return registeredSlugs()
    .map((slug) => `/${slug}`)
    .sort()
}

async function warm(paths: string[]): Promise<number> {
  let compiled = 0
  for (const path of paths) {
    try {
      await fetch(`${ORIGIN}${path}`, {
        // GET for a page, POST for a route. A page has no POST handler and
        // would answer 405 without compiling the component underneath.
        method: path.startsWith('/api/') ? 'POST' : 'GET',
        // A DUMMY COOKIE, and it is load-bearing. middleware.ts answers an
        // /api/ request with NO session cookie with a bare 401 and never
        // reaches the route — so the route would not compile, and warming
        // would silently do nothing. Middleware only checks that the cookie is
        // PRESENT (`request.cookies.has`), so any value gets past it; the
        // route's own four checks then refuse this properly, which is exactly
        // what we want. Nothing is authenticated by warming.
        headers: { Cookie: `${SESSION_COOKIE}=warmup` },
      })
      compiled += 1
    } catch {
      // A route that refuses to compile is a real problem, but it is the dev
      // server's problem to report — warming must never be the thing that
      // stops `npm run dev` from coming up.
    }
  }
  return compiled
}

const child = spawn('npx', ['next', 'dev'], { stdio: 'inherit', env: process.env })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code) => process.exit(code ?? 0))

void (async () => {
  if (!(await waitForServer())) {
    console.error('\n[warm] dev server did not come up; skipping route warm-up')
    return
  }
  const appDir = resolve(__dirname, '..', 'app')
  const routes = apiRoutePaths(join(appDir, 'api'))
  const pages = pagePaths(appDir)
  const dashboards = dashboardPagePaths()
  const all = [...new Set([...routes, ...pages, ...dashboards])]
  const compiled = await warm(all)
  console.error(
    `\n[warm] compiled ${compiled}/${all.length} — ` +
      `${routes.length} api routes, ${pages.length} pages, ${dashboards.length} dashboards — ` +
      'unlocking now will survive the whole flow\n',
  )
})()
