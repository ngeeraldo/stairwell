// scripts/write-spec-pair.ts
//
// Writes a confirmed spec's two output files (spec.md, mockup.html) into a
// directory as a single unit. Used by scripts/pull-spec.sh, which is a thin
// wrapper: fetch the JSON from export-spec.ts, hand it to this module.
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

export type SpecPairContent = { spec_md: string; mockup_html: string }

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
 * Write `content` into `dir/spec.md` and `dir/mockup.html`. Four guards, in
 * order, each independently fault-injectable and independently tested:
 *
 *   1. Precondition — refuse upfront if either final path exists and is
 *      not a plain file (most plausibly: a stray directory). Nothing is
 *      touched if this fires.
 *   2. Write — both payloads go to same-directory temp files first. If the
 *      second write throws, whatever temp file already exists is removed
 *      before the error propagates.
 *   3. Move-aside — any EXISTING final pair is renamed to `.bak` paths
 *      before the new one is committed. If the second move-aside throws,
 *      whichever one already moved is put straight back.
 *   4. Commit — the two temp files are renamed into their final paths. If
 *      the second commit rename throws, whichever of the two new files
 *      already landed is removed and the old pair is restored from its
 *      backup (or left absent, for a first-ever write with no prior pair).
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
  content: SpecPairContent,
  fsOps: FsOps = REAL_FS_OPS,
): void {
  const fs = fsOps
  fs.mkdirSync(dir, { recursive: true })

  const specPath = join(dir, 'spec.md')
  const mockupPath = join(dir, 'mockup.html')
  const specTmp = join(dir, '.spec.md.tmp')
  const mockupTmp = join(dir, '.mockup.html.tmp')
  const specBackup = join(dir, '.spec.md.bak')
  const mockupBackup = join(dir, '.mockup.html.bak')

  // 1. Precondition.
  for (const p of [specPath, mockupPath]) {
    if (fs.existsSync(p) && !fs.statSync(p).isFile()) {
      throw new Error(`${p} exists and is not a regular file — refusing to write`)
    }
  }

  // 2. Write both payloads to temp files before touching either final
  // path. If the second write throws (disk full, a permission change, the
  // process killed between them), clean up whatever was already written
  // and exit — spec.md and mockup.html are untouched either way.
  try {
    fs.writeFileSync(specTmp, content.spec_md)
    fs.writeFileSync(mockupTmp, content.mockup_html)
  } catch (err) {
    for (const p of [specTmp, mockupTmp]) {
      try {
        fs.unlinkSync(p)
      } catch {}
    }
    throw err
  }

  // 3. Move any EXISTING pair aside before committing the new one, so a
  // failure below can put it straight back. Track success with booleans,
  // not existsSync on the backup path afterward — a backup path can exist
  // for reasons unrelated to whether the rename onto it, this run,
  // actually succeeded.
  const hadSpec = fs.existsSync(specPath)
  const hadMockup = fs.existsSync(mockupPath)
  let specBackedUp = false
  let mockupBackedUp = false

  try {
    if (hadSpec) {
      fs.renameSync(specPath, specBackup)
      specBackedUp = true
    }
    if (hadMockup) {
      fs.renameSync(mockupPath, mockupBackup)
      mockupBackedUp = true
    }
  } catch (err) {
    // Nothing new has been committed yet — just put back what this step
    // already moved, then clean up the temp files and fail.
    if (specBackedUp) fs.renameSync(specBackup, specPath)
    if (mockupBackedUp) fs.renameSync(mockupBackup, mockupPath)
    for (const p of [specTmp, mockupTmp]) {
      try {
        fs.unlinkSync(p)
      } catch {}
    }
    throw err
  }

  // 4. Commit: rename each temp file into place. Each call is a single,
  // near-instant same-directory syscall (no data copy) — about as small a
  // window as fs gives without hand-rolled two-phase-commit machinery this
  // single-operator tool does not need. If the SECOND rename throws for an
  // ordinary, catchable reason (ENOENT, EPERM, a quota error), undo
  // whichever of the two already landed and restore the old pair from its
  // backup — an ordinary failure here must not leave spec.md holding the
  // new proposal next to a stale (or missing) mockup.html, which is worse
  // than either being absent: nothing about the pair LOOKS wrong.
  try {
    fs.renameSync(specTmp, specPath)
    fs.renameSync(mockupTmp, mockupPath)
  } catch (err) {
    try {
      fs.unlinkSync(specPath)
    } catch {}
    try {
      fs.unlinkSync(mockupPath)
    } catch {}
    if (specBackedUp) fs.renameSync(specBackup, specPath)
    if (mockupBackedUp) fs.renameSync(mockupBackup, mockupPath)
    // A failed rename() never moves its source: whichever of specTmp/
    // mockupTmp did NOT make it into place (most commonly the second one,
    // since the first already succeeded and so is already gone) is still
    // sitting here and must not be left behind next to a restored pair.
    for (const p of [specTmp, mockupTmp]) {
      try {
        fs.unlinkSync(p)
      } catch {}
    }
    throw err
  }

  // Success: nothing left to restore.
  if (specBackedUp) {
    try {
      fs.unlinkSync(specBackup)
    } catch {}
  }
  if (mockupBackedUp) {
    try {
      fs.unlinkSync(mockupBackup)
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
  writeSpecPair(dir, JSON.parse(json) as SpecPairContent)
  console.log(`Wrote ${dir}/spec.md and ${dir}/mockup.html`)
}
