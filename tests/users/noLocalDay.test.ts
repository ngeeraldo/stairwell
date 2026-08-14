// tests/users/noLocalDay.test.ts
//
// NOTHING UNDER users/ MAY ASK A CLOCK WHAT DAY IT IS.
//
// The bug this exists to prevent has already happened once. `dayKey` derived
// the day from the process's local calendar, the process runs on a UTC
// droplet, and devtwo's tap from the evening of 2026-08-13 is stored as
// 2026-08-14 — permanently, because `day` is the primary key of a database
// with no migration story. The read side had the same bug independently:
// devtwo's dashboard derived its own `today` the same way, so the read and the
// write could disagree about the calendar without either being obviously
// wrong.
//
// Fixing those two sites fixes today. This is what fixes tomorrow. There will
// be three bespoke dashboards, then more, each written fresh against a spec by
// somebody who has not read this file — and every one of them will need "what
// day is it". The rule has to hold at sites that do not exist yet, which no
// assertion inside any one user's own tests can do. Same reasoning, and the
// same shape, as tests/spec/sandbox.test.ts.
//
// WHAT IS FORBIDDEN, and what is deliberately allowed:
//
//   1. Date.now()            — asking the clock. Always wrong here.
//   2. new Date() with NO arguments — the same clock read wearing a different
//      hat. `new Date(row.at)` and `new Date(y, m, d)` are fine and necessary;
//      only the no-argument form is a clock.
//   3. importing lib/time/dayKey in dashboard.tsx — a dashboard is HANDED its
//      `today` as a prop. queries.ts MAY import and call it: turning a stored
//      instant into the friend's day is legitimate, and every finance
//      dashboard will do it (users/devone/queries.ts does).
//
// Rules 1 and 2 compose with rule 3 to close the obvious dodge — queries.ts
// may hold the formatter, but it has nothing to feed it except stored data.
//
// TESTS ARE EXCLUDED, and that is not a loophole. A test constructing a
// fixture instant from Date.now() is not a dashboard asking what day it is;
// it is a test choosing an instant. What ships to a friend is dashboard.tsx
// and queries.ts, and those are what this sweeps.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SLUG_PATTERN } from '@/lib/auth/slug'

const REPO = resolve(__dirname, '..', '..')
const USERS = join(REPO, 'users')
const TEMPLATES = join(REPO, 'platform', 'templates', 'dashboard')

/** The two files a friend's dashboard actually ships. */
const SHIPPED = ['dashboard.tsx', 'queries.ts'] as const

type Source = { label: string; file: string; text: string }

/**
 * The file with its comments removed.
 *
 * The sweep asks whether the code CALLS a clock, and a comment saying
 * "dayKeyOf(Date.now()) is what this used to do" is not a call — it is the
 * explanation of why the rule exists, sitting in the file the rule is about.
 * Without this, the sweep forbade documenting the bug in the one place the
 * documentation belongs, which it duly did on the first run.
 *
 * Crude on purpose: it will also blank a `//` inside a string literal. Nothing
 * under users/ has one, and the failure mode is a sweep that reads slightly
 * less than the file rather than slightly more — it can miss nothing that is
 * actually executable.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ')
}

function userSources(): Source[] {
  if (!existsSync(USERS)) return []
  const out: Source[] = []
  for (const entry of readdirSync(USERS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG_PATTERN.test(entry.name)) continue
    for (const file of SHIPPED) {
      const path = join(USERS, entry.name, file)
      if (!existsSync(path)) continue
      out.push({ label: `users/${entry.name}/${file}`, file, text: readFileSync(path, 'utf8') })
    }
  }
  return out
}

function templateSources(): Source[] {
  return SHIPPED.flatMap((file) => {
    const path = join(TEMPLATES, `${file}.tmpl`)
    if (!existsSync(path)) return []
    return [{ label: `template ${file}.tmpl`, file, text: readFileSync(path, 'utf8') }]
  })
}

const ALL = [...userSources(), ...templateSources()]

describe('no dashboard asks a clock what day it is', () => {
  it('finds real files to sweep, and both kinds of them', () => {
    // Without this the it.each blocks below are vacuous on an empty tree:
    // zero cases, zero failures, a green suite that checked nothing. Both
    // KINDS matter — the rules differ between dashboard.tsx and queries.ts,
    // so a sweep that happened to see only one kind would leave the other
    // rule unexercised.
    expect(ALL.length).toBeGreaterThan(0)
    expect(ALL.some((s) => s.file === 'dashboard.tsx')).toBe(true)
    expect(ALL.some((s) => s.file === 'queries.ts')).toBe(true)
    // EVERY template, by name, not "at least one". A drill removed
    // queries.ts.tmpl from the tree and the whole sweep stayed green, because
    // dashboard.tsx.tmpl was still there to satisfy a `length > 0` guard —
    // and the scaffold is precisely where a new dashboard inherits its habits
    // from, so a template silently dropping out of coverage is the failure
    // this sweep exists to make impossible.
    expect(templateSources().map((s) => s.file).sort()).toEqual([...SHIPPED].sort())
  })

  it.each(ALL.map((s) => [s.label, s] as const))('%s never calls Date.now()', (_label, source) => {
    expect(code(source.text)).not.toMatch(/\bDate\.now\s*\(/)
  })

  it.each(ALL.map((s) => [s.label, s] as const))(
    '%s never calls new Date() with no arguments',
    (_label, source) => {
      // The hole the first draft of this sweep left open: `new Date()` reads
      // the same clock Date.now() does. `new Date(row.at)` is untouched.
      expect(code(source.text)).not.toMatch(/new\s+Date\s*\(\s*\)/)
    },
  )

  it.each(
    ALL.filter((s) => s.file === 'dashboard.tsx').map((s) => [s.label, s] as const),
  )('%s does not import dayKey — it is handed its day', (_label, source) => {
    expect(code(source.text)).not.toMatch(/from\s+['"]@\/lib\/time\/dayKey['"]/)
  })

  it('lets queries.ts use dayKey on a STORED instant, which is the legitimate case', () => {
    // Asserted as a positive, not just left unforbidden: users/devone/queries.ts
    // buckets a calendar month and genuinely needs the formatter. If a future
    // tightening banned the import outright, this is the test that would argue
    // back — and it is the exact contradiction that had to be resolved before
    // this branch was built.
    const devone = ALL.find((s) => s.label === 'users/devone/queries.ts')
    expect(devone, 'users/devone/queries.ts should exist to make this concrete').toBeDefined()
    expect(code(devone!.text)).toMatch(/from\s+['"]@\/lib\/time\/dayKey['"]/)
  })
})
