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
// TWO FILES AGAIN — spec.md and conversation.md (plan
// 2026-08-19-change-only-specs, Task 7) — after a spell writing spec.md
// alone. That restores the fault-injection idiom the two-file version used:
// each guard is faulted on the SECOND of two operations, so the rollback has
// a real first file to undo rather than an empty directory that would look
// identical whether the catch block ran or not. The property that matters is
// unchanged: delete any one guard in the source and only that guard's own
// test below goes red.
//
// The load-bearing case is 'guard 4' below. spec.md is the build contract and
// conversation.md is what the friend meant by it; committing one without the
// other leaves two files that disagree, both well-formed, with nothing on
// disk recording which pull each came from.
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
 * implementation. `fn` is the FsOps key to override; `shouldFail` is checked
 * against the arguments actually passed.
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
  conversation_md: '# First pull conversation TEST\n\n## user\n\nCOFFEE PALACE TEST said A.\n',
}
const CONTENT_B = {
  spec_md: '# Second pull TEST\n\nCOFFEE PALACE TEST content B.\n',
  conversation_md: '# Second pull conversation TEST\n\n## user\n\nCOFFEE PALACE TEST said B.\n',
}

/** The paths writeSpecPair works with, for a given directory. */
function paths(d: string) {
  return {
    spec: join(d, 'spec.md'),
    specTmp: join(d, '.spec.md.tmp'),
    specBackup: join(d, '.spec.md.bak'),
    conversation: join(d, 'conversation.md'),
    conversationTmp: join(d, '.conversation.md.tmp'),
    conversationBackup: join(d, '.conversation.md.bak'),
  }
}

/** No temp or backup file survives a completed call, successful or not. */
function expectNoLeftovers(d: string): void {
  const p = paths(d)
  expect(existsSync(p.specTmp)).toBe(false)
  expect(existsSync(p.specBackup)).toBe(false)
  expect(existsSync(p.conversationTmp)).toBe(false)
  expect(existsSync(p.conversationBackup)).toBe(false)
}

describe('writeSpecPair', () => {
  it('writes both files on a fresh, unobstructed pull', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    expect(readFileSync(paths(d).spec, 'utf8')).toBe(CONTENT_A.spec_md)
    expect(readFileSync(paths(d).conversation, 'utf8')).toBe(CONTENT_A.conversation_md)
    expectNoLeftovers(d)
  })

  it('overwrites both files on a second call, as pull-spec.sh documents', () => {
    const d = makeDir()
    writeSpecPair(d, CONTENT_A)
    writeSpecPair(d, CONTENT_B)
    expect(readFileSync(paths(d).spec, 'utf8')).toBe(CONTENT_B.spec_md)
    expect(readFileSync(paths(d).conversation, 'utf8')).toBe(CONTENT_B.conversation_md)
    expectNoLeftovers(d)
  })

  describe('guard 1: precondition', () => {
    it('refuses upfront, writing nothing, when a final path exists and is not a plain file', () => {
      const d = makeDir()
      const p = paths(d)
      // Faulted on the SECOND target specifically: the precondition must be
      // checked for EVERY file before ANY is written, so a stray directory at
      // conversation.md cannot be discovered after spec.md was rewritten.
      // Simulated purely via the injected seam — no directory is created.
      const fsOps: FsOps = {
        ...REAL_FS_OPS,
        existsSync: (path) => (path === p.conversation ? true : REAL_FS_OPS.existsSync(path)),
        statSync: (path) =>
          path === p.conversation ? { isFile: () => false } : REAL_FS_OPS.statSync(path),
      }

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/not a regular file/)
      expect(existsSync(p.spec)).toBe(false)
      expect(existsSync(p.conversation)).toBe(false)
      expectNoLeftovers(d)
    })
  })

  describe('guard 2: write', () => {
    it('cleans up every temp file when a write throws', () => {
      const d = makeDir()
      const p = paths(d)
      // Faulted on the SECOND write: the FIRST temp file has genuinely landed
      // on disk by then, so "no temp files survive" actually depends on the
      // catch block rather than being true vacuously.
      const fsOps = fsThatFails('writeFileSync', (path) => path === p.conversationTmp)

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/SIMULATED.*writeFileSync/)
      expect(existsSync(p.spec)).toBe(false)
      expect(existsSync(p.conversation)).toBe(false)
      expectNoLeftovers(d)
    })
  })

  describe('guard 3: move-aside', () => {
    it('puts both originals back when a move-aside throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — genuine pre-existing files
      const p = paths(d)

      // Faulted on the SECOND move-aside: spec.md has ALREADY been renamed to
      // its .bak by then, so this proves the rollback restores it rather than
      // leaving the pair with spec.md missing.
      const fsOps = fsThatFails(
        'renameSync',
        (from, to) => from === p.conversation && to === p.conversationBackup,
      )

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(p.spec, 'utf8')).toBe(CONTENT_A.spec_md)
      expect(readFileSync(p.conversation, 'utf8')).toBe(CONTENT_A.conversation_md)
      expectNoLeftovers(d)
    })
  })

  describe('guard 4: commit', () => {
    it('restores the original file, byte-for-byte, when the FIRST commit rename throws', () => {
      const d = makeDir()
      writeSpecPair(d, CONTENT_A) // real, unobstructed pull — genuine pre-existing files
      const p = paths(d)

      // Targets ONLY the commit rename (specTmp -> spec), not the move-aside
      // rename that also touches spec as a SOURCE (spec -> specBackup) — the
      // two are distinguished by which argument is the OLD path, not just by
      // which path appears.
      const fsOps = fsThatFails('renameSync', (from, to) => from === p.specTmp && to === p.spec)

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(readFileSync(p.spec, 'utf8')).toBe(CONTENT_A.spec_md)
      expect(readFileSync(p.conversation, 'utf8')).toBe(CONTENT_A.conversation_md)
      expect(readFileSync(p.spec, 'utf8')).not.toContain('Second pull')
      expectNoLeftovers(d)
    })

    it('rolls the ALREADY-COMMITTED first file back when the SECOND commit throws', () => {
      // THE CASE THE ATOMICITY EXISTS FOR. spec.md has already been renamed
      // into place with the NEW contents when conversation.md's commit fails.
      // Without the rollback the directory is left holding a new build
      // contract beside the old conversation — two files that disagree, both
      // well-formed, with nothing on disk saying which pull each came from.
      const d = makeDir()
      writeSpecPair(d, CONTENT_A)
      const p = paths(d)

      const fsOps = fsThatFails(
        'renameSync',
        (from, to) => from === p.conversationTmp && to === p.conversation,
      )

      expect(() => writeSpecPair(d, CONTENT_B, fsOps)).toThrow(/SIMULATED.*renameSync/)
      // Both old, neither new: the pair is consistent.
      expect(readFileSync(p.spec, 'utf8')).toBe(CONTENT_A.spec_md)
      expect(readFileSync(p.spec, 'utf8')).not.toContain('Second pull')
      expect(readFileSync(p.conversation, 'utf8')).toBe(CONTENT_A.conversation_md)
      expectNoLeftovers(d)
    })

    it('leaves a FRESH directory empty when the second commit throws', () => {
      // The same mismatched-pair hazard with NO backups in play — a first
      // pull into a folder that does not exist yet, which is how every
      // dashboard starts. Nothing was moved aside, so restoring backups
      // cannot undo the first file: the rollback has to unlink what actually
      // landed. Found by deleting that step and watching every other test in
      // this file stay green.
      const d = makeDir()
      const p = paths(d)
      const fsOps = fsThatFails(
        'renameSync',
        (from, to) => from === p.conversationTmp && to === p.conversation,
      )

      expect(() => writeSpecPair(d, CONTENT_A, fsOps)).toThrow(/SIMULATED.*renameSync/)
      expect(existsSync(p.spec)).toBe(false)
      expect(existsSync(p.conversation)).toBe(false)
      expectNoLeftovers(d)
    })

    it('reports the rollback failure alongside the original one, never silently', () => {
      // The named residual: an ordinary failure striking AGAIN during a
      // rollback already in progress. It cannot be repaired from here, but it
      // must not be swallowed — the .bak file left behind is then the only
      // copy of the previous contents, and the operator has to be told where.
      const d = makeDir()
      writeSpecPair(d, CONTENT_A)
      const p = paths(d)

      const fsOps = fsThatFails(
        'renameSync',
        (from, to) =>
          // the commit of the second file, and then its own restore
          (from === p.conversationTmp && to === p.conversation) ||
          (from === p.conversationBackup && to === p.conversation),
      )

      // One call only: a second one would start from the state this one left
      // behind and take a different path through the guards.
      let caught: Error | undefined
      try {
        writeSpecPair(d, CONTENT_B, fsOps)
      } catch (err) {
        caught = err as Error
      }

      expect(caught).toBeDefined()
      // Both failures are named: the one that started it, and the one during
      // the rollback — with the path the only surviving copy is now at.
      expect(caught!.message).toMatch(/SIMULATED.*renameSync/)
      expect(caught!.message).toMatch(/rollback that followed/)
      expect(caught!.message).toContain(p.conversationBackup)
      // spec.md was still restored — the restore loop does not abandon the
      // other target when one of them fails.
      expect(readFileSync(p.spec, 'utf8')).toBe(CONTENT_A.spec_md)
      expect(existsSync(p.conversationBackup)).toBe(true)
    })
  })
})
