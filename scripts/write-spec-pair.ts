// scripts/write-spec-pair.ts
//
// Writes a confirmed spec's output file (spec.md) into a directory. Used by
// scripts/pull-spec.sh, which is a thin wrapper: fetch the JSON from
// export-spec.ts, hand it to this module.
//
// USED TO WRITE TWO FILES — spec.md and mockup.html, as a single atomic unit
// — before the mockup-loop removal (plan 2026-08-19-remove-the-mockup-loop,
// Task 6): nothing composes or serves mockup HTML any more, so
// export-spec.ts stopped emitting it and this module dropped the second
// file. The name (`writeSpecPair`, this file's own) is unchanged — renaming
// it was not part of that task, and a "pair" now reads as "the pair of
// temp-write and commit-rename", not "two files".
//
// The atomicity GUARANTEE is weaker with one file — there is no longer a
// second file whose absence or staleness could make a half-written pair look
// wrong — but the ROLLBACK behaviour is still worth keeping: a half-written
// spec.md (a partial write, or a commit rename that fails partway) is worse
// than an untouched one.
//
// This used to be a `node -e` string embedded in pull-spec.sh. It moved out
// specifically so the atomic-write guarantee below is a plain, directly
// importable function instead of shell-embedded JS that could only be
// fault-injected through symlink/permission/directory tricks against a real
// filesystem — brittle, platform-dependent, and (round 3 of the step-4
// review) too imprecise to prove that the guard meant to cover a given
// failure is the one that actually catches it. See
// tests/scripts/writeSpecPair.test.ts: each guard below is verified by
// injecting a fake `renameSync` (or `statSync`) that fails for exactly the
// call the guard is meant to catch, nothing else — and by deleting each
// guard in turn and confirming only its own test goes red.
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  renameSync as realRenameSync,
  statSync as realStatSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type SpecContent = { spec_md: string }

/**
 * The filesystem operations writeSpecPair needs, as an injectable seam —
 * the same shape as lib/chat/turn.ts taking its Anthropic client as a
 * parameter (CLAUDE.md > Testing). A test overrides exactly the one
 * function it needs to fail, and passes everything else straight through
 * to the real implementation, so the fault lands on the exact call the
 * guard under test is meant to catch.
 */
export type FsOps = {
  existsSync: (path: string) => boolean
  mkdirSync: (path: string, options: { recursive: true }) => void
  renameSync: (oldPath: string, newPath: string) => void
  statSync: (path: string) => { isFile(): boolean }
  unlinkSync: (path: string) => void
  writeFileSync: (path: string, data: string) => void
}

export const REAL_FS_OPS: FsOps = {
  existsSync: realExistsSync,
  mkdirSync: realMkdirSync,
  renameSync: realRenameSync,
  statSync: realStatSync,
  unlinkSync: realUnlinkSync,
  writeFileSync: realWriteFileSync,
}

/**
 * Write `content` into `dir/spec.md`. Four guards, in order, each
 * independently fault-injectable and independently tested:
 *
 *   1. Precondition — refuse upfront if the final path exists and is not a
 *      plain file (most plausibly: a stray directory). Nothing is touched
 *      if this fires.
 *   2. Write — the payload goes to a same-directory temp file first. If the
 *      write throws, the temp file (if it landed at all) is removed before
 *      the error propagates.
 *   3. Move-aside — an EXISTING final file is renamed to a `.bak` path
 *      before the new one is committed. If that rename throws, nothing has
 *      been committed yet — the temp file is cleaned up and the original is
 *      left exactly where it was.
 *   4. Commit — the temp file is renamed into its final path. If that
 *      rename throws, the backup (if there was one) is restored, so an
 *      ordinary failure here never leaves spec.md missing or half-written.
 *
 * What none of the four can cover, and no amount of code here can close: a
 * kill signal (SIGKILL) landing anywhere in this sequence — the process is
 * dead before any catch block runs, no matter how this is written — and an
 * ordinary failure striking AGAIN during a rollback that is already in
 * progress. Both are accepted, named residuals, not silently pretended
 * away as covered.
 */
export function writeSpecPair(
  dir: string,
  content: SpecContent,
  fsOps: FsOps = REAL_FS_OPS,
): void {
  const fs = fsOps
  fs.mkdirSync(dir, { recursive: true })

  const specPath = join(dir, 'spec.md')
  const specTmp = join(dir, '.spec.md.tmp')
  const specBackup = join(dir, '.spec.md.bak')

  // 1. Precondition.
  if (fs.existsSync(specPath) && !fs.statSync(specPath).isFile()) {
    throw new Error(`${specPath} exists and is not a regular file — refusing to write`)
  }

  // 2. Write the payload to a temp file before touching the final path. If
  // the write throws (disk full, a permission change, the process killed
  // mid-write), clean up whatever was already written and exit — spec.md is
  // untouched either way.
  try {
    fs.writeFileSync(specTmp, content.spec_md)
  } catch (err) {
    try {
      fs.unlinkSync(specTmp)
    } catch {}
    throw err
  }

  // 3. Move an EXISTING file aside before committing the new one, so a
  // failure below can put it straight back. Tracked with a boolean, not
  // existsSync on the backup path afterward — a backup path can exist for
  // reasons unrelated to whether the rename onto it, this run, actually
  // succeeded.
  const hadSpec = fs.existsSync(specPath)
  let specBackedUp = false

  try {
    if (hadSpec) {
      fs.renameSync(specPath, specBackup)
      specBackedUp = true
    }
  } catch (err) {
    // Nothing new has been committed yet — just clean up the temp file and
    // fail. The original spec.md is exactly where it was: this rename never
    // reached the point of moving it.
    try {
      fs.unlinkSync(specTmp)
    } catch {}
    throw err
  }

  // 4. Commit: rename the temp file into place. A single, near-instant
  // same-directory syscall (no data copy) — about as small a window as fs
  // gives without hand-rolled two-phase-commit machinery this
  // single-operator tool does not need. If it throws for an ordinary,
  // catchable reason (ENOENT, EPERM, a quota error), restore the old file
  // from its backup — an ordinary failure here must not leave spec.md
  // missing, which is worse than either the old or the new content.
  try {
    fs.renameSync(specTmp, specPath)
  } catch (err) {
    try {
      fs.unlinkSync(specPath)
    } catch {}
    if (specBackedUp) fs.renameSync(specBackup, specPath)
    // A failed rename() never moves its source: specTmp is still sitting
    // here and must not be left behind next to a restored file.
    try {
      fs.unlinkSync(specTmp)
    } catch {}
    throw err
  }

  // Success: nothing left to restore.
  if (specBackedUp) {
    try {
      fs.unlinkSync(specBackup)
    } catch {}
  }
}

if (process.argv[1]?.endsWith('write-spec-pair.ts')) {
  const dir = process.argv[2]
  const json = process.argv[3]
  if (!dir || !json) {
    console.error('usage: tsx scripts/write-spec-pair.ts <dir> <json>')
    process.exit(2)
  }
  writeSpecPair(dir, JSON.parse(json) as SpecContent)
  console.log(`Wrote ${dir}/spec.md`)
}
