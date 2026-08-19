import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * conversation.md is a friend's raw transcript. The guard hook
 * (.claude/hooks/deny-sensitive-files.sh) denies .db and .env files, not
 * markdown, so the .gitignore entries are the only thing standing between a
 * pulled transcript and every clone of this repo forever. A rule with no gate
 * behind it is a paragraph; this is the gate.
 *
 * THE TRANSCRIPT EXISTS AT THREE PATHS, not one. scripts/write-spec-pair.ts
 * writes it byte-for-byte to `.conversation.md.tmp` on every pull, and its
 * rollback deliberately leaves `.conversation.md.bak` behind when a restore
 * fails — a named residual, because at that moment the .bak is the only
 * surviving copy of the previous contents. Git does not ignore dotfiles, so
 * a pattern covering conversation.md alone leaves a whole transcript stageable
 * by `git add -A` at a perfectly ordinary path. Every one of the three is
 * asserted below, and for a folder that does not exist yet as well as one that
 * does: the dangerous moment is the FIRST pull for a new friend.
 */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('conversation.md is never committable', () => {
  it('is ignored for a folder that exists', () => {
    expect(ignored('users/devtwo/conversation.md')).toBe(true)
  })

  it('is ignored for a folder that does not exist yet', () => {
    // The next friend's folder has to be covered before it is created.
    expect(ignored('users/somefriendwhodoesnotexistyet/conversation.md')).toBe(true)
  })

  it.each(['.conversation.md.tmp', '.conversation.md.bak'])(
    'ignores the %s sidecar for a folder that exists',
    (sidecar) => {
      // .tmp holds the transcript byte-for-byte during every pull; .bak is
      // left on disk on purpose when a rollback restore fails. Both are
      // dotfiles, and git ignores nothing merely for starting with a dot.
      expect(ignored(`users/devtwo/${sidecar}`)).toBe(true)
    },
  )

  it.each(['.conversation.md.tmp', '.conversation.md.bak'])(
    'ignores the %s sidecar for a folder that does not exist yet',
    (sidecar) => {
      expect(ignored(`users/somefriendwhodoesnotexistyet/${sidecar}`)).toBe(true)
    },
  )

  it('does not accidentally ignore spec.md, which IS tracked', () => {
    // The patterns must be narrow. spec.md is a designed artifact describing a
    // dashboard and has always been committed.
    expect(ignored('users/devtwo/spec.md')).toBe(false)
  })

  it('does not reach into notes/, where a hand-written file may be committed', () => {
    // The other half of "narrow". `*` does not cross a `/`, so widening the
    // pattern to catch the sidecars must not start swallowing a note somebody
    // wrote by hand and means to commit.
    expect(ignored('users/devtwo/notes/conversation.md')).toBe(false)
  })
})
