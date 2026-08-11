/**
 * Next.js instrumentation hook — runs once per runtime instance at process
 * startup. Its only job here is to schedule lib/session/keymap.ts's sweep()
 * so a live SQLCipher key does not sit resident in memory until the process
 * happens to restart (design spec: "expiry is enforced on access and by a
 * sweep interval").
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
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { sweep, SWEEP_INTERVAL_MS } = await import('@/lib/session/keymap')
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()
}
