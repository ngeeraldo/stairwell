// tests/scripts/writeSpecPair.test.ts
//
// Unit-level coverage of scripts/write-spec-pair.ts's four guards, each
// fault-injected precisely: a fake FsOps function that throws for exactly
// the one call the guard under test is meant to catch, and delegates every
// other call to the real fs implementation. No symlink loops, no chmod, no
// pre-created blocking directories — the round-3 finding was that those
// techniques against pull-spec.sh as a whole could not tell two adjacent
// guards apart (a fault meant for the commit-rename guard was actually only
// ever reaching the move-aside guard, and the test suite could not tell).
//
// ONE FILE NOW, not two. write-spec-pair.ts dropped mockup.html as of the
// mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop, Task 6) —
// nothing composes or serves mockup HTML any more. The two-file guards used
// to be tested by faulting the SECOND of two writes/renames; with one file
// there is no second operation, so each guard here is faulted on its own
// single operation instead. The property that matters is unchanged: delete
// any one guard in the source and only that guard's own test below goes red
// (see the round-3 fix report for the two-file version's deletion
// transcript — the same exercise applies here, guard for guard).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REAL_FS_OPS, writeSpecPair, type FsOps } from '@/scripts/write-spec-pair'

let dir: string

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

function makeDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-write-spec-pair-'))
  return dir
}

/**
 * REAL_FS_OPS with exactly one function swapped for a fake that throws when
 * called with the given arguments, and otherwise delegates to the real
 * implementation. `fn` is the FsOps key to override; `matchArgs` is checked
 * with a simple deep-ish equality over the arguments actually passed.
 */
function fsThatFails<K extends keyof FsOps>(
  fn: K,
  shouldFail: (...args: Parameters<FsOps[K]>) => boolean,
): FsOps {
  const real = REAL_FS_OPS[fn] as (...args: unknown[]) => unknown
  const faked = ((...args: unknown[]) => {
    if (shouldFail(...(args as Parameters<FsOps[K]>))) {
      throw new Error(`SIMULATED (test): ${String(fn)} failed for ${JSON.stringify(args)}`)
    }
    return real(...args)
  }) as FsOps[K]
  return { ...REAL_FS_OPS, [fn]: faked }
}

const CONTENT_A = { spec_md: '# First pull TEST\n\nCOFFEE PALACE TEST content A.\n' }
const CONTENT_B = { spec_md: '# Second pull TEST\n\nCOFFEE PALACE TEST content B.\n' }

describe('writeSpecPair', () => {
  it('writes the file on a fresh, unobstructed pull', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(CONTENT_A.spec_md)
  })

  it('overwrites the file on a second call, as pull-spec.sh documents', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    writeSpecPair(d, CONTENT_B)
    expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(CONTENT_B.spec_md)
  })

  describe('guard 1: precondition', () => {
    it('refuses upfront, writing nothing, when the final path exists and is not a plain file', () => {
      const d = makeDir()
      const specPath = join(d, 'spec.md')
      // Simulate "spec.md exists and is not a regular file" purely via the
      // injected seam — no directory is actually created on disk.
      const fsOps: FsOps = {
        ...REAL_FS_OPS,
        existsSync: (p) => (p === specPath ? true : REAL_FS_OPS.existsSync(p)),
        statSync: (p) => (p === specPath ? { isFile: () => false } : REAL_FS_OPS.statSync(p)),
      }

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/not a regular file/)
      expect(existsSync(join(d, 'spec.md'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
    })
  })

  describe('guard 2: write', () => {
    it('cleans up the temp file when the write throws', () => {
      const d = makeDir()
      const specTmp = join(d, '.spec.md.tmp')
      // With ONE file, a fake that throws before writing anything would make
      // this assertion pass whether or not the catch block's cleanup runs —
      // the file was never created either way, so "it's gone" proves
      // nothing. (The two-file version avoided this because the SECOND
      // write's failure had to clean up the FIRST write's real temp file.)
      // This fake performs the REAL write first — so specTmp genuinely lands
      // on disk — and then throws, simulating a failure that surfaces AFTER
      // the write syscall completed (a quota or fsync error). Only then does
      // "specTmp is gone afterward" actually depend on the catch block.
      const fsOps: FsOps = {
        ...REAL_FS_OPS,
        writeFileSync: (p, data) => {
          if (p !== specTmp) return REAL_FS_OPS.writeFileSync(p, data)
          REAL_FS_OPS.writeFileSync(p, data)
          throw new Error(`SIMULATED (test): writeFileSync failed for ${JSON.stringify([p])}`)
        },
      }

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/SIMULATED.*writeFileSync/)
      expect(existsSync(join(d, 'spec.md'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
    })
  })

  describe('guard 3: move-aside', () => {
    it('leaves the original file untouched when the move-aside throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — a genuine pre-existing file
      const before = readFileSync(join(d, 'spec.md'), 'utf8')

      const specPath = join(d, 'spec.md')
      const specBackup = join(d, '.spec.md.bak')
      const fsOps = fsThatFails('renameSync', (o, n) => o === specPath && n === specBackup)

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(before)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.bak'))).toBe(false)
    })
  })

  describe('guard 4: commit', () => {
    it('restores the original file, byte-for-byte, when the commit rename throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — a genuine pre-existing file
      const before = readFileSync(join(d, 'spec.md'), 'utf8')

      const specTmp = join(d, '.spec.md.tmp')
      const specPath = join(d, 'spec.md')
      // Targets ONLY the commit rename (specTmp -> specPath), not the
      // move-aside rename that also touches specPath as a SOURCE
      // (specPath -> specBackup) — the two are distinguished by which
      // argument is the OLD path, not just which path appears.
      const fsOps = fsThatFails('renameSync', (o, n) => o === specTmp && n === specPath)

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(before)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).not.toContain('Second pull')
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.bak'))).toBe(false)
    })
  })
})
