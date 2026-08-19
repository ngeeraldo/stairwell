// scripts/write-spec-pair.ts
//
// Writes a pulled spec's output files into a directory, as a single atomic
// unit. Used by scripts/pull-spec.sh, which is a thin wrapper: fetch the JSON
// from export-spec.ts, hand it to this module.
//
// TWO FILES AGAIN, and so the name is right again:
//   - spec.md         — the build contract, TRACKED in git.
//   - conversation.md — the transcript slice behind that spec version,
//                       GITIGNORED (see .gitignore, lib/spec/conversation.ts,
//                       CLAUDE.md > Data safety).
// It wrote spec.md and mockup.html until the mockup-loop removal (plan
// 2026-08-19-remove-the-mockup-loop, Task 6), then spec.md alone, and now
// spec.md beside the conversation that produced it (plan
// 2026-08-19-change-only-specs, Task 7) — a change-only spec says what
// changed, not what the friend meant.
//
// THE ATOMICITY GUARANTEE IS LOAD-BEARING AGAIN rather than vestigial. With
// one file, rollback only protected against a half-written file. With two,
// there is a second failure mode that matters more: spec.md committed and
// conversation.md not, leaving a NEW contract beside the OLD conversation —
// two files that disagree, both looking perfectly well-formed, with nothing
// on disk saying which pull each came from. Either both are new or both are
// old; a builder never reads a mismatched pair. The guards below are written
// over a LIST for exactly that reason, and the commit-rollback case is
// pinned by a test that fails the SECOND file's commit and asserts the first
// is restored (tests/scripts/writeSpecPair.test.ts).
//
// This used to be a `node -e` string embedded in pull-spec.sh. It moved out
// specifically so the atomic-write guarantee below is a plain, directly
// importable function instead of shell-embedded JS that could only be
// fault-injected through symlink/permission/directory tricks against a real
// filesystem — brittle, platform-dependent, and (round 3 of the step-4
// review) too imprecise to prove that the guard meant to cover a given
// failure is the one that actually catches it. See
// tests/scripts/writeSpecPair.test.ts: each guard below is verified by
// injecting a fake `renameSync` (or `statSync`, or `writeFileSync`) that
// fails for exactly the call the guard is meant to catch, nothing else — and
// by deleting each guard in turn and confirming only its own test goes red.
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readFileSync,
  renameSync as realRenameSync,
  statSync as realStatSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { join } from 'node:path'

export type SpecContent = { spec_md: string; conversation_md: string }

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

/** One output file, mid-write. */
type Target = {
  path: string
  tmp: string
  backup: string
  body: string
  backedUp: boolean
}

/**
 * Best-effort cleanup inside a rollback. A temp or a stale landed file that
 * cannot be removed is untidy; it is not a correctness failure, and throwing
 * from a rollback would replace the real error with a cosmetic one.
 */
function quietly(fn: () => void): void {
  try {
    fn()
  } catch {}
}

/**
 * Put every moved-aside original back where it was.
 *
 * Every target is attempted even if one throws — with two files, abandoning
 * the loop on the first failure would leave the OTHER file missing as well,
 * which is the exact state this module exists to prevent. Failures are
 * returned rather than thrown so the caller can report the ORIGINAL error
 * (the thing that actually went wrong) alongside them.
 */
function restoreBackups(fs: FsOps, targets: Target[]): string[] {
  const failures: string[] = []
  for (const target of targets) {
    if (!target.backedUp) continue
    try {
      fs.renameSync(target.backup, target.path)
      target.backedUp = false
    } catch (err) {
      failures.push(
        `${target.path} could not be restored (its previous contents are at ${target.backup}): ` +
          `${(err as Error).message}`,
      )
    }
  }
  return failures
}

/**
 * Rethrow the original failure — or, if the rollback ALSO failed, a single
 * error naming both. A rollback failure is a named residual (see the guard
 * doc below), and the one thing it must never be is silent: it is the case
 * where a `.bak` file on disk is the only copy of something.
 */
function rethrow(err: unknown, rollbackFailures: string[]): never {
  if (rollbackFailures.length === 0) throw err
  throw new Error(
    `${(err as Error).message}\n\n` +
      'AND the rollback that followed did not complete:\n' +
      rollbackFailures.map((f) => `  - ${f}`).join('\n'),
  )
}

/**
 * Write `content` into `dir/spec.md` and `dir/conversation.md`. Four guards,
 * in order, each independently fault-injectable and independently tested, and
 * each now covering the LIST of targets rather than a single file:
 *
 *   1. Precondition — refuse upfront if ANY final path exists and is not a
 *      plain file (most plausibly: a stray directory). Nothing is touched if
 *      this fires for any of them.
 *   2. Write — every payload goes to a same-directory temp file first. If any
 *      write throws, every temp file written so far is removed before the
 *      error propagates; no final path has been touched.
 *   3. Move-aside — every EXISTING final file is renamed to its `.bak` path
 *      before anything is committed, recorded per target. If a rename throws,
 *      any already-moved originals go straight back, the temps are cleaned
 *      up, and every final file is exactly where it was.
 *   4. Commit — every temp file is renamed into its final path. If a rename
 *      throws, whatever landed is unlinked, every backup is restored, and
 *      every remaining temp is removed. This is the case that matters most:
 *      the first file committing and the second failing would otherwise leave
 *      a new spec.md beside an old conversation.md, and nothing on disk would
 *      say so.
 *
 * Unlinking EVERY final path in step 4's rollback is correct rather than
 * over-broad: step 3 has already moved every pre-existing file to its `.bak`,
 * so at that point a final path exists only if this run just committed it.
 *
 * What none of the four can cover, and no amount of code here can close: a
 * kill signal (SIGKILL) landing anywhere in this sequence — the process is
 * dead before any catch block runs, no matter how this is written — and an
 * ordinary failure striking AGAIN during a rollback that is already in
 * progress, which is reported (see rethrow above) but cannot be repaired from
 * here. Both are accepted, named residuals, not silently pretended away as
 * covered.
 */
export function writeSpecPair(
  dir: string,
  content: SpecContent,
  fsOps: FsOps = REAL_FS_OPS,
): void {
  const fs = fsOps
  fs.mkdirSync(dir, { recursive: true })

  const targets: Target[] = [
    { name: 'spec.md', body: content.spec_md },
    { name: 'conversation.md', body: content.conversation_md },
  ].map(({ name, body }) => ({
    path: join(dir, name),
    tmp: join(dir, `.${name}.tmp`),
    backup: join(dir, `.${name}.bak`),
    body,
    backedUp: false,
  }))

  // 1. Precondition. Checked for EVERY target before anything is written, so
  // a stray directory at conversation.md cannot be discovered halfway
  // through, after spec.md has already been rewritten.
  for (const target of targets) {
    if (fs.existsSync(target.path) && !fs.statSync(target.path).isFile()) {
      throw new Error(`${target.path} exists and is not a regular file — refusing to write`)
    }
  }

  // 2. Write every payload to a temp file before touching any final path. If
  // a write throws (disk full, a permission change, the process killed
  // mid-write), clean up every temp and exit — the final files are untouched
  // either way.
  try {
    for (const target of targets) fs.writeFileSync(target.tmp, target.body)
  } catch (err) {
    for (const target of targets) quietly(() => fs.unlinkSync(target.tmp))
    throw err
  }

  // 3. Move EXISTING files aside before committing anything, so a failure
  // below can put them straight back. Tracked with a boolean per target, not
  // existsSync on the backup path afterward — a backup path can exist for
  // reasons unrelated to whether the rename onto it, this run, actually
  // succeeded.
  try {
    for (const target of targets) {
      if (fs.existsSync(target.path)) {
        fs.renameSync(target.path, target.backup)
        target.backedUp = true
      }
    }
  } catch (err) {
    // Nothing new has been committed yet. Put back any original this loop
    // already moved, clean up the temps, and fail.
    const failures = restoreBackups(fs, targets)
    for (const target of targets) quietly(() => fs.unlinkSync(target.tmp))
    rethrow(err, failures)
  }

  // 4. Commit: rename each temp file into place. A single, near-instant
  // same-directory syscall each (no data copy) — about as small a window as
  // fs gives without hand-rolled two-phase-commit machinery this
  // single-operator tool does not need. It is still TWO syscalls, though, and
  // the gap between them is the whole reason the rollback below exists: if it
  // throws for an ordinary, catchable reason (ENOENT, EPERM, a quota error),
  // undo whatever landed and restore the old files, so the pair on disk is
  // either entirely new or entirely old and never one of each.
  try {
    for (const target of targets) fs.renameSync(target.tmp, target.path)
  } catch (err) {
    for (const target of targets) quietly(() => fs.unlinkSync(target.path))
    const failures = restoreBackups(fs, targets)
    // A failed rename() never moves its source: the remaining temps are still
    // sitting here and must not be left behind next to restored files.
    for (const target of targets) quietly(() => fs.unlinkSync(target.tmp))
    rethrow(err, failures)
  }

  // Success: nothing left to restore.
  for (const target of targets) {
    if (target.backedUp) quietly(() => fs.unlinkSync(target.backup))
  }
}

if (process.argv[1]?.endsWith('write-spec-pair.ts')) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: tsx scripts/write-spec-pair.ts <dir> < payload.json')
    process.exit(2)
  }
  // STDIN, not argv. A whole transcript can exceed ARG_MAX, and the failure
  // would be an exec error from the shell rather than anything this script
  // could report — no message, no partial write, nothing pointing at the
  // conversation being long as the cause.
  const json = readFileSync(0, 'utf8')
  writeSpecPair(dir, JSON.parse(json) as SpecContent)
  console.log(`Wrote ${dir}/spec.md and ${dir}/conversation.md`)
}
