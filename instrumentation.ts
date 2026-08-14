/**
 * Next.js instrumentation hook — runs once per runtime instance at process
 * startup. It has two jobs here:
 *
 * 1. Schedule lib/session/keymap.ts's sweep() so a live SQLCipher key does
 *    not sit resident in memory until the process happens to restart
 *    (design spec: "expiry is enforced on access and by a sweep interval").
 * 2. Report missing required configuration as a loud witness (design spec
 *    D3) — never a gate. deploy/check-env.sh is the hard gate that blocks a
 *    bad deploy; this only records an env_missing metric and logs a
 *    warning, and it must never throw or take the server down.
 *
 * Guarded to the nodejs runtime: the key map is a module-level singleton
 * that lives only in the main server process. middleware.ts runs on the
 * edge runtime, a separate isolate with no shared memory and no keymap
 * traffic of its own, so scheduling a sweep there would tick against an
 * always-empty map for no reason.
 *
 * setInterval(...).unref() — a ref'd interval would hold the Node event
 * loop open forever and prevent a clean process exit (e.g. in tests or
 * short-lived tooling that imports this module indirectly).
 */
export async function register(): Promise<void> {
  // Wrapped in an if-BLOCK, not an early return. instrumentation.ts is
  // compiled twice — once per runtime — and webpack only prunes an unreached
  // *branch* of an if/else from the module graph at build time; sibling
  // statements after an early `return` are still walked and their imports
  // still resolved even though they can never run. lib/db/instance.ts pulls
  // in better-sqlite3-multiple-ciphers' native bindings (fs/path), which the
  // edge bundle cannot resolve — so under the early-return shape this file
  // fails `next build` (edge runtime) even though NEXT_RUNTIME guards it
  // correctly at runtime. See tests/instrumentation.test.ts.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { sweep, SWEEP_INTERVAL_MS } = await import('@/lib/session/keymap')
    setInterval(sweep, SWEEP_INTERVAL_MS).unref()

    // The loud witness for missing configuration (design spec D3). Never
    // throws, and touches no database unless something is actually missing.
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { reportMissingEnv } = await import('@/lib/env/report')
    const { getDb } = await import('@/lib/db/instance')

    try {
      const listText = readFileSync(
        resolve(process.cwd(), 'deploy/required-env'),
        'utf8',
      )
      const missing = reportMissingEnv({
        listText,
        env: process.env,
        db: getDb,
        now: Date.now,
      })
      for (const v of missing) {
        console.warn(`[env] missing ${v.severity}: ${v.name} — ${v.purpose}`)
      }
    } catch {
      // Reading the list is best-effort too. A missing or unreadable list
      // must not prevent the server from starting.
    }

    // THE OPENER, CHECKED AT BOOT. lib/chat/opening.ts throws rather than
    // writing an empty first impression into an append-only table, which is
    // right — but the call site is a page render, so an unparseable prompt
    // would surface as a 500 on the friend's whole page, chat and logout
    // included. That is the exact failure `dashboardRegion`'s try/catch exists
    // to prevent, arriving through a different door.
    //
    // So it is verified HERE, once, before any request: the same loud-witness
    // shape as the env check above, and never a gate. The suite already fails
    // on an unparseable shipped prompt (tests/chat/opening.test.ts parses
    // whatever AGENT_PROMPT points at), so reaching this line in production
    // means a red suite was pushed past — the console line is what makes that
    // findable in `journalctl -u stairwell` instead of in a friend's browser.
    try {
      const { openingMessage } = await import('@/lib/chat/opening')
      openingMessage()
    } catch (error) {
      console.error(
        `[opening] the agent prompt's opening message is unreadable — new friends will land in an empty chat: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
}
