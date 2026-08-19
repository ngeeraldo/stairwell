import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * conversation.md is a friend's raw transcript. The guard hook
 * (.claude/hooks/deny-sensitive-files.sh) denies .db and .env files, not
 * markdown, so the .gitignore entry is the only thing standing between a
 * pulled transcript and every clone of this repo forever. A rule with no gate
 * behind it is a paragraph; this is the gate.
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

  it('does not accidentally ignore spec.md, which IS tracked', () => {
    // The pattern must be narrow. spec.md is a designed artifact describing a
    // dashboard and has always been committed.
    expect(ignored('users/devtwo/spec.md')).toBe(false)
  })
})
