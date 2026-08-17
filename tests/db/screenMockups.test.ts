// tests/db/screenMockups.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { insertScreenMockups, readScreenMockups } from '@/lib/db/screenMockups'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-screenmockups-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('spec_screen_mockups', () => {
  it('round-trips fragments for one spec', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: '<section>a</section>' }], 100)
    expect(readScreenMockups(db, 7).get('morning')).toBe('<section>a</section>')
  })

  it('keeps versions apart', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    insertScreenMockups(db, 8, [{ screenId: 'morning', html: 'b' }], 200)
    expect(readScreenMockups(db, 7).get('morning')).toBe('a')
    expect(readScreenMockups(db, 8).get('morning')).toBe('b')
  })

  it('rejects UPDATE and DELETE at the database', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    expect(() => db.prepare('UPDATE spec_screen_mockups SET html = ?').run('x')).toThrow(
      /append-only/,
    )
    expect(() => db.prepare('DELETE FROM spec_screen_mockups').run()).toThrow(/append-only/)
  })

  it('rejects a duplicate screen on one spec', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    expect(() => insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'b' }], 100)).toThrow()
  })

  it('returns an empty map for a spec with no fragments', () => {
    expect(readScreenMockups(db, 99).size).toBe(0)
  })

  it('writes all fragments for one spec, in a single insert call', () => {
    insertScreenMockups(
      db,
      7,
      [
        { screenId: 'morning', html: 'a' },
        { screenId: 'evening', html: 'b' },
      ],
      100,
    )
    const rows = readScreenMockups(db, 7)
    expect(rows.get('morning')).toBe('a')
    expect(rows.get('evening')).toBe('b')
    expect(rows.size).toBe(2)
  })

  it('rolls back the whole set when one fragment in the batch is invalid', () => {
    // A duplicate screen_id within the SAME call collides with the unique
    // index partway through the transaction. If the insert were not
    // transactional, 'morning' would land and 'evening' would not — a half-
    // written set that composes into a document with a screen silently
    // missing, which is exactly what the brief forbids.
    expect(() =>
      insertScreenMockups(
        db,
        7,
        [
          { screenId: 'morning', html: 'a' },
          { screenId: 'morning', html: 'a-again' },
          { screenId: 'evening', html: 'b' },
        ],
        100,
      ),
    ).toThrow()
    const rows = readScreenMockups(db, 7)
    expect(rows.size).toBe(0)
  })
})
