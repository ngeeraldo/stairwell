// lib/db/reshape.ts
import type { PlatformDb } from './platform'

/**
 * The column set each sacred table must have. Keys are hardcoded literals —
 * nothing here is caller-supplied, which is what makes the interpolation into
 * the statements below safe.
 */
const EXPECTED: Record<string, readonly string[]> = {
  transcripts: [
    'id',
    'account_id',
    'session_id',
    'conversation_id',
    'prompt_sha',
    'role',
    'body',
    'at',
  ],
  metrics: ['id', 'account_id', 'event', 'data', 'at'],
}

/**
 * Bring the sacred tables up to the current shape, before schema.sql runs.
 *
 * CLAUDE.md > Sacred data forbids migrating transcripts and metrics. This is
 * not a migration: neither table has ever had a production writer, so a stale
 * shape means an empty table that was created but never used. Dropping it lets
 * schema.sql recreate it — with its triggers and indexes, which is why this
 * must run BEFORE the schema exec, not after.
 *
 * If a stale table is NOT empty, the assumption above is wrong. Throw rather
 * than destroy. What that actually costs, stated plainly because someone will
 * read this during an incident: getDb() is lazy, so this runs on the first
 * database touch, not at boot — the process starts healthy and then 500s on
 * every request that reaches a database. deploy/smoke.sh's login step touches
 * the database, so the deploy does fail loudly. There is no rollback
 * (deploy/deploy.sh says so in its own words), so the site stays down until a
 * human intervenes. History is untouched, which is the point of throwing.
 */
export function reshapeSacredTables(db: PlatformDb): void {
  for (const [table, expected] of Object.entries(EXPECTED)) {
    const info = db.pragma(`table_info(${table})`) as { name: string }[]
    if (info.length === 0) continue // Does not exist yet; schema.sql creates it.

    const present = new Set(info.map((c) => c.name))
    const missing = expected.filter((c) => !present.has(c))
    if (missing.length === 0) continue

    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number
    }
    if (n > 0) {
      throw new Error(
        `${table} is missing column(s) ${missing.join(', ')} but holds ${n} row(s). ` +
          'CLAUDE.md > Sacred data: append-only tables are never migrated. ' +
          'Resolve this by hand before deploying.',
      )
    }

    db.exec(`DROP TABLE ${table}`)
  }
}
