// tests/env/required.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { missingFrom, parseRequiredEnv } from '@/lib/env/required'

describe('parseRequiredEnv', () => {
  it('parses name, severity, and purpose', () => {
    expect(parseRequiredEnv('FOO REQUIRED  # why foo matters')).toEqual([
      { name: 'FOO', severity: 'REQUIRED', purpose: 'why foo matters' },
    ])
  })

  it('accepts an entry with no purpose', () => {
    expect(parseRequiredEnv('BAR DEGRADED')).toEqual([
      { name: 'BAR', severity: 'DEGRADED', purpose: '' },
    ])
  })

  it('ignores blank lines and full-line comments', () => {
    const text = ['# a heading', '', '   ', 'FOO REQUIRED', '# trailing note'].join('\n')
    expect(parseRequiredEnv(text).map((v) => v.name)).toEqual(['FOO'])
  })

  it('rejects an unknown severity rather than silently downgrading it', () => {
    // A typo'd severity must not quietly become the permissive case — that
    // would turn a blocking variable into a warning with no signal.
    expect(() => parseRequiredEnv('FOO REQUIRD')).toThrow(/severity/i)
  })

  it('rejects a malformed line rather than skipping it', () => {
    expect(() => parseRequiredEnv('FOO')).toThrow(/NAME SEVERITY/)
    expect(() => parseRequiredEnv('FOO REQUIRED EXTRA')).toThrow(/NAME SEVERITY/)
  })

  it('never returns a value even if someone writes one into the list', () => {
    // The file format has no slot for a value, but a well-meaning edit could
    // add `FOO=secret REQUIRED`. That must fail loudly, not parse into
    // something carrying the secret.
    expect(() => parseRequiredEnv('FOO=supersecret REQUIRED')).toThrow()
  })

  it('rejects a name with a hyphen', () => {
    expect(() => parseRequiredEnv('FOO-BAR REQUIRED')).toThrow()
  })

  it('rejects a name starting with a digit', () => {
    expect(() => parseRequiredEnv('1FOO REQUIRED')).toThrow()
  })

  it('does not leak the line content when the field count is wrong', () => {
    // A well-meaning edit could add an extra field carrying a value
    // (`FOO REQUIRED SUPERSECRET-VALUE`). The thrown message must not
    // reproduce it — only the line number and expected format.
    let message = ''
    try {
      parseRequiredEnv('FOO REQUIRED SUPERSECRET-VALUE')
    } catch (err) {
      message = String(err)
    }
    expect(message).toMatch(/NAME SEVERITY/)
    expect(message).not.toContain('SUPERSECRET-VALUE')
  })

  it('does not leak the name field when it fails the identifier check', () => {
    // `FOO=secret` fails the identifier regex; the thrown message must not
    // print the field, since it may be exactly the smuggled value.
    let message = ''
    try {
      parseRequiredEnv('FOO=SUPERSECRET-VALUE REQUIRED')
    } catch (err) {
      message = String(err)
    }
    expect(message).not.toContain('SUPERSECRET-VALUE')
  })

  it('does not leak the severity token when it is unknown', () => {
    // The name has already been validated by this point, so it is safe to
    // print — but the severity token has not been, and could itself be a
    // smuggled value.
    let message = ''
    try {
      parseRequiredEnv('FOO SUPERSECRET-VALUE')
    } catch (err) {
      message = String(err)
    }
    expect(message).toMatch(/severity/i)
    expect(message).not.toContain('SUPERSECRET-VALUE')
  })
})

describe('missingFrom', () => {
  const vars = parseRequiredEnv(['A REQUIRED', 'B DEGRADED'].join('\n'))

  it('returns only the absent ones', () => {
    expect(missingFrom(vars, new Set(['A'])).map((v) => v.name)).toEqual(['B'])
  })

  it('returns nothing when all are present', () => {
    expect(missingFrom(vars, new Set(['A', 'B']))).toEqual([])
  })

  it('returns everything when the set is empty', () => {
    expect(missingFrom(vars, new Set()).map((v) => v.name)).toEqual(['A', 'B'])
  })

  it('returns nothing when there are no vars to check', () => {
    expect(missingFrom([], new Set(['A']))).toEqual([])
  })
})

describe('the shipped deploy/required-env', () => {
  const shipped = parseRequiredEnv(readFileSync('deploy/required-env', 'utf8'))

  it('parses, and is not empty', () => {
    expect(shipped.length).toBeGreaterThan(0)
  })

  it('lists PLATFORM_DB as REQUIRED', () => {
    // Its absence silently falls back to the SYNTHETIC database
    // (lib/db/instance.ts), so production would serve loudly-fake data with
    // every health check green. That is the reason the tier exists.
    expect(shipped.find((v) => v.name === 'PLATFORM_DB')?.severity).toBe('REQUIRED')
  })

  it('lists ANTHROPIC_API_KEY, which appears nowhere in our source', () => {
    // The SDK reads it internally. A list derived by scanning process.env
    // would miss it — and its absence is what took chat down on the first
    // live deploy. See spec section 2.1.
    expect(shipped.find((v) => v.name === 'ANTHROPIC_API_KEY')?.severity).toBe('DEGRADED')
  })

  it('gives every entry a purpose', () => {
    for (const v of shipped) {
      expect(v.purpose, `${v.name} has no purpose comment`).not.toBe('')
    }
  })
})
