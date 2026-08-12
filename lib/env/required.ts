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

  for (const [i, raw] of text.split('\n').entries()) {
    const lineNumber = i + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const hash = line.indexOf('#')
    const decl = (hash === -1 ? line : line.slice(0, hash)).trim()
    const purpose = hash === -1 ? '' : line.slice(hash + 1).trim()

    const parts = decl.split(/\s+/)
    const name = parts[0]
    const severity = parts[1]

    // Never interpolate unvalidated line content into a thrown message —
    // NAME SEVERITY has no slot for a value, but a line that violates the
    // format could still carry one (`FOO=secret REQUIRED`), and a caller
    // that logs a caught parse error must not be able to print it. Report
    // the line number instead, so a human can open the file and look.
    if (parts.length !== 2 || name === undefined || severity === undefined) {
      throw new Error(
        `deploy/required-env: line ${lineNumber}: expected "NAME SEVERITY"`,
      )
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        `deploy/required-env: line ${lineNumber}: first field is not a valid variable name`,
      )
    }
    if (!SEVERITIES.includes(severity)) {
      // The name has already passed the identifier check above, so it is
      // safe to print. The severity token has not been validated — do not
      // print it.
      throw new Error(
        `deploy/required-env: line ${lineNumber}: unknown severity for ${name} ` +
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
