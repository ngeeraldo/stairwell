// tests/db/reshape.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reshapeSacredTables } from '@/lib/db/reshape'
import { openPlatformDb } from '@/lib/db/platform'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-reshape-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A database carrying the pre-step-2 shape of both sacred tables. */
function legacyDb(path: string) {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL,
      role TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE metrics (
      id INTEGER PRIMARY KEY, account_id INTEGER,
      event TEXT NOT NULL, at INTEGER NOT NULL
    );
  `)
  return db
}

describe('reshapeSacredTables', () => {
  it('drops an empty table whose shape is stale', () => {
    const db = legacyDb(join(dir, 'synthetic.db'))
    reshapeSacredTables(db)
    const info = db.pragma('table_info(transcripts)') as { name: string }[]
    expect(info).toHaveLength(0)
    db.close()
  })

  it('leaves an already-current table alone', () => {
    const db = openPlatformDb(join(dir, 'synthetic.db'))
    reshapeSacredTables(db)
    const names = (db.pragma('table_info(transcripts)') as { name: string }[])
      .map((c) => c.name)
    expect(names).toContain('conversation_id')
    db.close()
  })

  it('refuses to drop a stale table that holds rows, naming table and count', () => {
    const db = legacyDb(join(dir, 'synthetic.db'))
    db.prepare(
      "INSERT INTO transcripts (account_id, role, body, at) VALUES (1, 'user', 'hi', 100)",
    ).run()
    expect(() => reshapeSacredTables(db)).toThrow(/transcripts.*1 row/s)
    // And the row is still there — a refusal must not be destructive.
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as {
      n: number
    }
    expect(n).toBe(1)
    db.close()
  })

  it('is a no-op on a database where the tables do not exist yet', () => {
    const db = new Database(join(dir, 'synthetic.db'))
    expect(() => reshapeSacredTables(db)).not.toThrow()
    db.close()
  })

  it('leaves the append-only triggers in place after openPlatformDb reshapes', () => {
    // The whole point of reshaping BEFORE the schema exec: dropping a table
    // drops its triggers, and schema.sql must be the thing that puts them
    // back. If the order were reversed the table would come back unguarded.
    const path = join(dir, 'synthetic.db')
    legacyDb(path).close()
    const db = openPlatformDb(path)
    db.prepare(
      `INSERT INTO transcripts
       (account_id, session_id, conversation_id, prompt_sha, role, body, at)
       VALUES (1, 's', 'c', 'p', 'user', 'hi', 100)`,
    ).run()
    expect(() => db.prepare("UPDATE transcripts SET body = 'x'").run()).toThrow(
      /append-only/,
    )
    db.close()
  })
})
