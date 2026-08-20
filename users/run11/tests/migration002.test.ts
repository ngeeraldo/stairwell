// users/run11/tests/migration002.test.ts
//
// THE DATA-SURVIVAL TEST every migration above 001 owes, in the same commit as
// the migration (2026-08-15 migrations design, D3 — it is what earns full DDL
// under D1). Seed the OLD shape, apply the new file, assert the rows survived.
//
// It matters more than the phrase makes it sound. run11's real database is
// SQLCipher-encrypted under a key that exists only while he is unlocked, so
// 002 runs on HIS machine, on HIS file, at unlock (lib/db/migrate.ts) — there
// is no server-side copy to fall back to and no way for anyone to inspect the
// result. `<slug>.backup.db` is one deep and under the same key. If 002 loses
// rows, they are gone.
//
// 002 only CREATEs, so this ought to be uninteresting — which is exactly why it
// is written down. "It only adds tables" is what everyone believes about their
// own migration, and D3 does not make an exception for the easy ones.
//
// It deliberately does NOT import lib/db/migrate.ts: that runner opens
// encrypted files, takes locks and writes backups, none of which this is about.
// It applies the same files, in the same order, the way tests/support does.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { migrationFilesFor } from '@/tests/support/userMigrations'

const files = migrationFilesFor('run11')
const sqlFor = (number: number) => {
  const path = files.find((f) => basename(f).startsWith(String(number).padStart(3, '0')))
  if (path === undefined) throw new Error(`no migration ${number} for run11`)
  return readFileSync(path, 'utf8')
}

const DAY = '2026-08-19'
const NEXT = '2026-08-20'

/** A database holding ONLY the 001 shape, with a forecast in it. */
function databaseAtV1(): Database.Database {
  const db = new Database(':memory:')
  db.exec(sqlFor(1))
  db.pragma('user_version = 1')
  for (const [index, day] of [DAY, NEXT].entries()) {
    for (let h = 0; h < 24; h += 1) {
      db.prepare(
        `INSERT INTO forecast_hours (at, day, minute_of_day, precip_mm, precip_chance, feels_like_f, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(index * 86_400_000 + h * 3_600_000, day, h * 60, 0.2, 40, 95.5, 1)
    }
    db.prepare(
      'INSERT INTO forecast_days (day, sunrise_minute, sunset_minute, fetched_at) VALUES (?, ?, ?, ?)',
    ).run(day, 413, 1196, 1)
  }
  db.prepare(
    'INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)',
  ).run(1, DAY, 600, 1)
  db.prepare(
    'INSERT INTO forecast_fetches (at, day, minute_of_day, ok) VALUES (?, ?, ?, ?)',
  ).run(2, DAY, 660, 0)
  return db
}

/** What lib/db/migrate.ts does per file: the DDL and the version, together. */
function apply(db: Database.Database, number: number) {
  db.exec('BEGIN')
  db.exec(sqlFor(number))
  db.pragma(`user_version = ${number}`)
  db.exec('COMMIT')
}

describe('users/run11 — 002 does not lose what 001 stored', () => {
  it('leaves every forecast row exactly as it was', () => {
    const db = databaseAtV1()
    try {
      const before = {
        hours: db.prepare('SELECT * FROM forecast_hours ORDER BY at').all(),
        days: db.prepare('SELECT * FROM forecast_days ORDER BY day').all(),
        fetches: db.prepare('SELECT * FROM forecast_fetches ORDER BY id').all(),
      }
      expect(before.hours).toHaveLength(48)

      apply(db, 2)

      // Whole rows, not counts. A migration that dropped and recreated a table
      // would keep the count and lose the contents, and a count-only assertion
      // would sail past exactly the failure D3 exists to catch.
      expect(db.prepare('SELECT * FROM forecast_hours ORDER BY at').all()).toEqual(before.hours)
      expect(db.prepare('SELECT * FROM forecast_days ORDER BY day').all()).toEqual(before.days)
      expect(db.prepare('SELECT * FROM forecast_fetches ORDER BY id').all()).toEqual(
        before.fetches,
      )
    } finally {
      db.close()
    }
  })

  it('adds the two new tables, EMPTY — a migration never seeds rows', () => {
    // D9. Changing a shape must not invent data, and a seeded default 90°F
    // would also make "he has never set this" indistinguishable from "he set
    // it back to 90" — which is the one thing the panel's default branch has
    // to be able to tell apart.
    const db = databaseAtV1()
    try {
      apply(db, 2)
      expect(db.prepare('SELECT count(*) AS c FROM walk_log').get()).toEqual({ c: 0 })
      expect(db.prepare('SELECT count(*) AS c FROM walk_settings').get()).toEqual({ c: 0 })
    } finally {
      db.close()
    }
  })

  it('moves user_version to 2, so it is never applied twice', () => {
    const db = databaseAtV1()
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      apply(db, 2)
      expect(db.pragma('user_version', { simple: true })).toBe(2)
    } finally {
      db.close()
    }
  })

  it('is idempotent if it is ever re-run, rather than throwing on the tables', () => {
    // Not how the runner behaves — it skips anything at or below the recorded
    // version — but `CREATE TABLE IF NOT EXISTS` is what keeps a re-run from
    // refusing the session rather than being a harmless no-op, and a friend
    // locked out of their own data by a re-applied migration is the worst
    // available outcome here.
    const db = databaseAtV1()
    try {
      apply(db, 2)
      db.prepare('INSERT INTO walk_log (day, at) VALUES (?, ?)').run(DAY, 1)
      expect(() => db.exec(sqlFor(2))).not.toThrow()
      expect(db.prepare('SELECT day FROM walk_log').all()).toEqual([{ day: DAY }])
    } finally {
      db.close()
    }
  })

  it('holds walk_settings to exactly one row, at the database', () => {
    // The CHECK (id = 1) in 002 is what makes "a single stored value" a
    // property of the shape rather than something the route is trusted to
    // keep — so no read anywhere has to decide which row wins.
    const db = databaseAtV1()
    try {
      apply(db, 2)
      db.prepare('INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (1, 92, 0)').run()
      expect(() =>
        db.prepare('INSERT INTO walk_settings (id, heat_no_go_f, set_at) VALUES (2, 95, 0)').run(),
      ).toThrow(/CHECK constraint/)
    } finally {
      db.close()
    }
  })

  it('declares exactly the migrations the manifest covers', () => {
    // The manifest's SHA-256 per file is what enforces "an applied migration is
    // never edited" (D2) — a mismatch refuses the session rather than applying
    // something nobody reviewed. tests/users/conventions.test.ts verifies the
    // hashes; this asserts 002 is actually IN the chain, which is the thing a
    // forgotten manifest regeneration would break.
    expect(files.map((f) => basename(f))).toEqual([
      '001_initial.sql',
      '002_walk_log_and_settings.sql',
    ])
  })
})
