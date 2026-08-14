// users/devtwo/tests/seed.test.ts
//
// Pins the property that broke on handover day: a FRESHLY GENERATED
// synthetic database must not claim today is already walked. seed.py's
// MISSED set omitted back = 0, so every regenerated synthetic.db said
// WALKED and hid the tap control entirely — on the exact database a friend
// with no real devtwo.db yet would see the morning after deploy.sh
// regenerates it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { afterEach, describe, expect, it } from 'vitest'
import { walkedOn } from '@/users/devtwo/queries'
import { dayKey } from '@/lib/time/dayKey'

const SEED = resolve(__dirname, '..', 'seed.py')

/**
 * This test spawns python3, and tests/users/conventions.test.ts runs this
 * same kind of subprocess as a deploy gate on a droplet that is far slower
 * than a laptop. A false timeout there aborts a real deploy over nothing, so
 * this is per-test, not a raised global testTimeout.
 */
const SUBPROCESS_TIMEOUT_MS = 60_000

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('seed.py', () => {
  it(
    'leaves today unwalked in a freshly generated synthetic database',
    () => {
      dir = mkdtempSync(join(tmpdir(), 'stairwell-devtwo-seed-'))
      const target = join(dir, 'synthetic.db')

      execFileSync('python3', [SEED, target], { stdio: 'pipe' })

      const db = new Database(target, { readonly: true, fileMustExist: true })
      try {
        expect(walkedOn(db, dayKey(Date.now(), 'UTC'))).toBe(false)
      } finally {
        db.close()
      }
    },
    SUBPROCESS_TIMEOUT_MS,
  )
})
