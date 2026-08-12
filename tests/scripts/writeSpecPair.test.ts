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
// Each guard here is verified TWICE: once by running the test and reading
// the assertion, and once by deleting the guard's own try/catch in the
// source and confirming ONLY that guard's test goes red (see the round-3
// fix report for the actual deletion transcript).
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

const CONTENT_A = {
  spec_md: '# First pull TEST\n\nCOFFEE PALACE TEST content A.\n',
  mockup_html: '<!doctype html><html><body>PULL A TEST</body></html>',
}
const CONTENT_B = {
  spec_md: '# Second pull TEST\n\nCOFFEE PALACE TEST content B.\n',
  mockup_html: '<!doctype html><html><body>PULL B TEST</body></html>',
}

describe('writeSpecPair', () => {
  it('writes both files on a fresh, unobstructed pull', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(CONTENT_A.spec_md)
    expect(readFileSync(join(d, 'mockup.html'), 'utf8')).toBe(CONTENT_A.mockup_html)
  })

  it('overwrites both files on a second call, as pull-spec.sh documents', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    writeSpecPair(d, CONTENT_B)
    expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(CONTENT_B.spec_md)
    expect(readFileSync(join(d, 'mockup.html'), 'utf8')).toBe(CONTENT_B.mockup_html)
  })

  describe('guard 1: precondition', () => {
    it('refuses upfront, writing nothing, when a final path exists and is not a plain file', () => {
      const d = makeDir()
      const mockupPath = join(d, 'mockup.html')
      // Simulate "mockup.html exists and is not a regular file" purely via
      // the injected seam — no directory is actually created on disk.
      const fsOps: FsOps = {
        ...REAL_FS_OPS,
        existsSync: (p) => (p === mockupPath ? true : REAL_FS_OPS.existsSync(p)),
        statSync: (p) =>
          p === mockupPath ? { isFile: () => false } : REAL_FS_OPS.statSync(p),
      }

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/not a regular file/)
      expect(existsSync(join(d, 'spec.md'))).toBe(false)
      expect(existsSync(join(d, 'mockup.html'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
    })
  })

  describe('guard 2: write', () => {
    it('cleans up the temp file it already wrote when the second write throws', () => {
      const d = makeDir()
      const mockupTmp = join(d, '.mockup.html.tmp')
      const fsOps = fsThatFails('writeFileSync', (p) => p === mockupTmp)

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/SIMULATED.*writeFileSync/)
      expect(existsSync(join(d, 'spec.md'))).toBe(false)
      expect(existsSync(join(d, 'mockup.html'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
    })
  })

  describe('guard 3: move-aside', () => {
    it('restores the pair it already moved aside when the second move-aside throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — a genuine pre-existing pair
      const specBefore = readFileSync(join(d, 'spec.md'), 'utf8')
      const mockupBefore = readFileSync(join(d, 'mockup.html'), 'utf8')

      const mockupPath = join(d, 'mockup.html')
      const mockupBackup = join(d, '.mockup.html.bak')
      const fsOps = fsThatFails('renameSync', (o, n) => o === mockupPath && n === mockupBackup)

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(specBefore)
      expect(readFileSync(join(d, 'mockup.html'), 'utf8')).toBe(mockupBefore)
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
      expect(existsSync(join(d, '.mockup.html.tmp'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.bak'))).toBe(false)
      expect(existsSync(join(d, '.mockup.html.bak'))).toBe(false)
    })
  })

  describe('guard 4: commit', () => {
    it('restores the original pair, byte-for-byte, when the second commit rename throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — a genuine pre-existing pair
      const specBefore = readFileSync(join(d, 'spec.md'), 'utf8')
      const mockupBefore = readFileSync(join(d, 'mockup.html'), 'utf8')

      const mockupTmp = join(d, '.mockup.html.tmp')
      const mockupPath = join(d, 'mockup.html')
      // Targets ONLY the commit rename (mockupTmp -> mockupPath), not the
      // move-aside rename that also touches mockupPath as a SOURCE
      // (mockupPath -> mockupBackup) — the two are distinguished by which
      // argument is the OLD path, not just which path appears.
      const fsOps = fsThatFails('renameSync', (o, n) => o === mockupTmp && n === mockupPath)

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).toBe(specBefore)
      expect(readFileSync(join(d, 'mockup.html'), 'utf8')).toBe(mockupBefore)
      expect(readFileSync(join(d, 'spec.md'), 'utf8')).not.toContain('Second pull')
      expect(existsSync(join(d, '.spec.md.tmp'))).toBe(false)
      expect(existsSync(join(d, '.mockup.html.tmp'))).toBe(false)
      expect(existsSync(join(d, '.spec.md.bak'))).toBe(false)
      expect(existsSync(join(d, '.mockup.html.bak'))).toBe(false)
    })
  })

})
