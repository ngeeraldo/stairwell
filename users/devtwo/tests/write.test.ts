// users/devtwo/tests/write.test.ts
//
// Per-user tests/ must cover write paths, not just rendering (unified-loop
// design File 02 §5). Before this file, users/devtwo/tests/ covered reads
// (queries.test.ts) and the seed (seed.test.ts); the only write-path
// coverage anywhere was tests/routing/walkRoute.test.ts, which is platform
// scope and knows nothing about this user's queries.
//
// The reason this specific gap matters is the step-6a ledger's headline
// defect: seed.py always marked today walked, and dashboard.tsx hides the
// tap control once today is walked. Each half was correct on its own — the
// seed was a reasonable "already walked today" fixture, and hiding a
// redundant control is reasonable UI — and the composition meant a friend
// would meet "WALKED / Marked for today" on handover morning, about a dog
// nobody had actually walked, with no way left to log it. Reviewing either
// half in isolation could not have found that: it only exists where the
// write path and the read path meet. So every test below does BOTH —
// inserts through the write path, then reads back through queries.ts — not
// one half in isolation.
//
// Built from schema.sql, not synthetic.db: the point is to exercise the
// shape a real write actually lands in (the one devtwo.db is created under —
// see schema.sql's own header on that), not whatever shape seed.py's
// generator happens to produce this run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UserDb } from '@/lib/db/userDb'
import { currentStreak, last30, walkedOn } from '@/users/devtwo/queries'

const SCHEMA = resolve(__dirname, '..', 'schema.sql')

let dir: string
let db: UserDb

/**
 * The exact statement app/api/users/[user]/walk/route.ts runs on a tap
 * (INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)), reproduced here
 * rather than imported: a platform route must not be imported by a user's
 * test any more than by a user's queries.ts (queries.ts's own header names
 * this same boundary, which is also why dayKey logic is duplicated instead
 * of shared). `at`'s value never matters to any assertion below — only
 * `day`, the primary key idempotency turns on, does.
 */
function insertWalk(handle: UserDb, day: string): void {
  handle.prepare('INSERT OR IGNORE INTO walks (day, at) VALUES (?, ?)').run(day, 1)
}

function countWalks(handle: UserDb): number {
  return (handle.prepare('SELECT COUNT(*) AS n FROM walks').get() as { n: number }).n
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-write-'))
  db = new Database(join(dir, 'synthetic.db'))
  db.exec(readFileSync(SCHEMA, 'utf8'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a tap through the write path is what the queries read back', () => {
  it('a tap becomes a walked day the queries can see', () => {
    insertWalk(db, '2026-08-13')
    expect(walkedOn(db, '2026-08-13')).toBe(true)
  })

  it('a second tap on the same day changes nothing', () => {
    // Idempotent by primary key, not by a read-then-write. If this ever
    // needed a check-then-insert instead, a double tap would race — see
    // schema.sql's header and the route's own comment above the statement.
    insertWalk(db, '2026-08-13')
    insertWalk(db, '2026-08-13')
    expect(countWalks(db)).toBe(1)
  })

  it('a fresh insert extends the streak the panel renders', () => {
    // The composed product, not the halves: step 6a's headline defect
    // existed only where the write path and the read path met.
    insertWalk(db, '2026-08-12')
    insertWalk(db, '2026-08-13')
    expect(currentStreak(db, '2026-08-13')).toBe(2)
  })

  it('the 30-day rate moves when a day is logged', () => {
    const before = last30(db, '2026-08-13').walked
    insertWalk(db, '2026-08-13')
    expect(last30(db, '2026-08-13').walked).toBe(before + 1)
  })
})
