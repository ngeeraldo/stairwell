// lib/env/report.ts
//
// The runtime half of the required-env check: the loud witness, not the gate.
// deploy/check-env.sh is the hard gate (design spec D3).
//
// This function NEVER THROWS. A throw reaches instrumentation.ts, which fails
// startup, which meets systemd's Restart=on-failure and becomes a crash loop
// — against a deploy path with no rollback (ledger I3). Crash-looping in front
// of a friend over a config typo is the wrong failure.
//
// Two separately-guarded regions, not one try wrapping everything. Parsing
// and diffing already compute the answer (`missing`) before the metric write
// ever runs. If that write throws — a transient lock, a disk error — the
// answer that was already correct must not be thrown away with it: the
// caller (instrumentation.ts) still needs `missing` to log its console.warn
// lines even when the database is what's having trouble. So: one try around
// parsing/diffing (nothing to report if the list itself can't be read), and
// a second, independent try around the metric write alone (its failure
// costs only the metric, never the returned list).
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric } from '@/lib/db/appendOnly'
import { missingFrom, parseRequiredEnv, type RequiredVar } from './required'

export type ReportDeps = {
  listText: string
  env: Record<string, string | undefined>
  /**
   * Called ONLY when something is missing. A healthy boot must not open the
   * database: getDb() is lazy by design, and ledger I3's documented failure
   * mode — a reshape problem surfacing as a per-request 500 rather than a
   * failed startup — depends on that laziness (design spec D5).
   */
  db: () => PlatformDb
  now: () => number
}

export function reportMissingEnv(deps: ReportDeps): RequiredVar[] {
  let missing: RequiredVar[]

  try {
    const vars = parseRequiredEnv(deps.listText)
    const present = new Set(
      Object.entries(deps.env)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([name]) => name),
    )
    missing = missingFrom(vars, present)
  } catch {
    // A malformed or unreadable list tells us nothing about the environment,
    // so there is nothing to report. Still never throws: the deploy-time
    // gate is what catches a broken list.
    return []
  }

  if (missing.length === 0) return []

  try {
    appendMetric(deps.db(), {
      accountId: null,
      event: 'env_missing',
      at: deps.now(),
      data: {
        // Names and severities only. Never a value.
        missing: missing.map((v) => ({ name: v.name, severity: v.severity })),
        required: missing.filter((v) => v.severity === 'REQUIRED').length,
        degraded: missing.filter((v) => v.severity === 'DEGRADED').length,
      },
    })
  } catch {
    // The metric write failing must not cost the caller the answer. It
    // still gets `missing` below and can warn, which is the more important
    // of the two signals when the database is the thing having trouble.
  }

  return missing
}
