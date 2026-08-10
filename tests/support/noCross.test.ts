import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { regeneratePlatform, regenerateUser } from './synthetic'

let root: string
let platformTarget: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stairwell-cross-'))
  platformTarget = join(root, 'platform', 'dev', 'synthetic.db')
  mkdirSync(join(root, 'platform', 'dev'), { recursive: true })
  mkdirSync(join(root, 'users', 'testgen'), { recursive: true })
  writeFileSync(
    join(root, 'users', 'testgen', 'seed.py'),
    [
      'import sqlite3, sys',
      'db = sqlite3.connect(sys.argv[1])',
      'db.execute("CREATE TABLE IF NOT EXISTS spend (merchant TEXT)")',
      'db.execute("INSERT INTO spend VALUES (\'COFFEE PALACE TEST\')")',
      'db.commit()',
      '',
    ].join('\n'),
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('synthetic regeneration', () => {
  it('writes the platform database to its own target', () => {
    const written = regeneratePlatform(platformTarget)
    expect(written).toBe(platformTarget)
  })

  it('regenerating a user leaves the platform database byte-identical', () => {
    regeneratePlatform(platformTarget)
    const before = readFileSync(platformTarget)

    regenerateUser('testgen', { root })

    expect(readFileSync(platformTarget).equals(before)).toBe(true)
  })

  it('regenerating the platform leaves the user database byte-identical', () => {
    const userTarget = regenerateUser('testgen', { root })
    const before = readFileSync(userTarget)

    regeneratePlatform(platformTarget)

    expect(readFileSync(userTarget).equals(before)).toBe(true)
  })

  it('writes the user database inside that user folder and nowhere else', () => {
    const userTarget = regenerateUser('testgen', { root })
    expect(userTarget).toBe(join(root, 'users', 'testgen', 'synthetic.db'))
  })
})
