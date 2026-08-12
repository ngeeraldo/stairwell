// lib/env/required.ts
//
// Pure parsing and comparison for deploy/required-env. No I/O, no
// process.env, no policy about what to DO with a missing variable — those
// live in the two callers, which need different answers (spec section 3).
//
// NAMES ONLY. Nothing in this module handles an environment variable's
// value, and the file format has no slot for one.

export type Severity = 'REQUIRED' | 'DEGRADED'

export type RequiredVar = {
  name: string
  severity: Severity
  purpose: string
}

const SEVERITIES: readonly string[] = ['REQUIRED', 'DEGRADED']

/**
 * Parse the list. Format per line: `NAME SEVERITY  # purpose`
 *
 * Throws on anything malformed rather than skipping it. A silently dropped
 * line is a variable nobody is checking, which is the exact failure this
 * whole guard exists to prevent.
 */
export function parseRequiredEnv(text: string): RequiredVar[] {
  const out: RequiredVar[] = []

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const hash = line.indexOf('#')
    const decl = (hash === -1 ? line : line.slice(0, hash)).trim()
    const purpose = hash === -1 ? '' : line.slice(hash + 1).trim()

    const parts = decl.split(/\s+/)
    const name = parts[0]
    const severity = parts[1]

    if (parts.length !== 2 || name === undefined || severity === undefined) {
      throw new Error(
        `deploy/required-env: expected "NAME SEVERITY", got: ${raw.trim()}`,
      )
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`deploy/required-env: not a variable name: ${name}`)
    }
    if (!SEVERITIES.includes(severity)) {
      throw new Error(
        `deploy/required-env: unknown severity "${severity}" for ${name} ` +
          `(expected REQUIRED or DEGRADED)`,
      )
    }

    out.push({ name, severity: severity as Severity, purpose })
  }

  return out
}

/** The entries whose names are absent from `present`. */
export function missingFrom(
  vars: RequiredVar[],
  present: Set<string>,
): RequiredVar[] {
  return vars.filter((v) => !present.has(v.name))
}
