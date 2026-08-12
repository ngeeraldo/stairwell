// lib/env/report.ts
//
// The runtime half of the required-env check: the loud witness, not the gate.
// deploy/check-env.sh is the hard gate (design spec D3).
//
// This function NEVER THROWS. A throw reaches instrumentation.ts, which fails
// startup, which meets systemd's Restart=on-failure and becomes a crash loop
// — against a deploy path with no rollback (ledger I3). Crash-looping in front
// of a friend over a config typo is the wrong failure.
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
  try {
    const vars = parseRequiredEnv(deps.listText)
    const present = new Set(
      Object.entries(deps.env)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([name]) => name),
    )
    const missing = missingFrom(vars, present)
    if (missing.length === 0) return []

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
    return missing
  } catch {
    // Deliberately swallowed. See the file comment: this function reporting a
    // problem must never become a bigger problem than the one it reports.
    return []
  }
}
