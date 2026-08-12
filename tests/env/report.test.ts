// tests/env/report.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { reportMissingEnv } from '@/lib/env/report'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-envreport-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const LIST = ['A REQUIRED  # a', 'B DEGRADED  # b'].join('\n')

function metrics() {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string | null
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data ?? 'null') }))
}

describe('reportMissingEnv', () => {
  it('returns nothing and writes nothing when all are present', () => {
    let opened = false
    const missing = reportMissingEnv({
      listText: LIST,
      env: { A: 'x', B: 'y' },
      db: () => {
        opened = true
        return db
      },
      now: () => 1_000,
    })

    expect(missing).toEqual([])
    // D5: a healthy boot must not touch the database at all. getDb() is
    // lazy on purpose, and ledger I3's documented failure mode depends on
    // it — opening here would move a reshape throw into startup.
    expect(opened).toBe(false)
    expect(metrics()).toEqual([])
  })

  it('records an env_missing metric naming the missing variables', () => {
    const missing = reportMissingEnv({
      listText: LIST,
      env: { A: 'x' },
      db: () => db,
      now: () => 1_000,
    })

    expect(missing.map((v) => v.name)).toEqual(['B'])
    const rows = metrics()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toBe('env_missing')
    expect(rows[0]!.data).toMatchObject({
      missing: [{ name: 'B', severity: 'DEGRADED' }],
      required: 0,
      degraded: 1,
    })
  })

  it('counts REQUIRED and DEGRADED separately', () => {
    reportMissingEnv({ listText: LIST, env: {}, db: () => db, now: () => 1 })
    expect(metrics()[0]!.data).toMatchObject({ required: 1, degraded: 1 })
  })

  it('never records a VALUE, only names', () => {
    reportMissingEnv({
      listText: LIST,
      env: { A: 'SUPERSECRET-VALUE' },
      db: () => db,
      now: () => 1,
    })
    expect(JSON.stringify(metrics())).not.toContain('SUPERSECRET-VALUE')
  })

  it('never throws when the database is unavailable', () => {
    // D3: a throw here meets Restart=on-failure and becomes a crash loop
    // against a deploy path with no rollback. Reporting a config problem
    // must never be the thing that takes the site down.
    expect(() =>
      reportMissingEnv({
        listText: LIST,
        env: {},
        db: () => {
          throw new Error('database unavailable')
        },
        now: () => 1,
      }),
    ).not.toThrow()
  })

  it('never throws when the list itself is malformed', () => {
    expect(() =>
      reportMissingEnv({
        listText: 'THIS IS NOT VALID',
        env: {},
        db: () => db,
        now: () => 1,
      }),
    ).not.toThrow()
  })
})
