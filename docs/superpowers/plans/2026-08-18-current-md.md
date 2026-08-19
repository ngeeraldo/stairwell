# `current.md` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat agent an accurate, builder-written description of the dashboard as it actually exists, so it stops reasoning about a dashboard it has never seen.

**Architecture:** Each built dashboard gains `users/<slug>/current.md` — five required sections plus frontmatter, overwritten every build, parsed by a new `lib/build/currentState.ts` modelled directly on `lib/build/notes.ts`. `app/api/chat/route.ts` reads it and passes the body to `runTurn`, which appends it to the system prompt exactly the way `OPENER_ALREADY_SENT` is appended today. No database change, no new dependency, no model call.

**Tech Stack:** TypeScript, Next.js App Router, vitest, bash.

**Spec:** `docs/superpowers/specs/2026-08-18-built-is-truth-design.md`

## Global Constraints

- **This is plan 1 of 2.** Plan 2 implements the loop change (change-only specs, no confirmation, no mockup, `agent-v7.md`). Nothing here removes the mockup, the confirmation card, or `authorSpec`'s base. **After this plan lands the drift is NOT yet fixed** — the chat agent knows the truth, `authorSpec` still does not.
- **Do not work on `main`.** Nico creates the branch. Run `git branch --show-current` first and stop if it says `main` (CLAUDE.md > Onboarding).
- **Prompts are added, never edited.** `agent-v6.md` is a new file; `agent-v5.md` is not touched (unified-loop ledger D13).
- **`current.md` never carries user values.** It is committed to the repo. Describe shape — a panel, a computation, a rule — never a row, a value, or a merchant (CLAUDE.md > Dashboard folder conventions).
- **Tests run with `npx vitest run`.** Scope with a path. A commit touching `lib/` needs a test under `tests/`; a commit touching `users/<name>/` needs one under `users/<name>/tests/` (Gate B).
- **`version: 0` means "predates the spec loop"** and can never be announced. `devone` and `devtwo` are hand-written and have no spec version; the parser accepts 0 and the announce gate in plan 2 requires equality with an `n >= 1`, so a 0 file can never satisfy it.

---

### Task 1: The `current.md` parser

**Files:**
- Create: `lib/build/currentState.ts`
- Test: `tests/build/currentState.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `CurrentState` (`{ slug: string; version: number; body: string }`), `parseCurrentState(text: string): CurrentState`, `readCurrentState(slug: string, usersDir?: string): CurrentState | null`, `currentStatePath(slug, usersDir?): string`, `class CurrentStateError extends Error`, `SECTION_HEADINGS: readonly string[]`.

Note the deliberate asymmetry with `lib/build/notes.ts`: `readBuildNotes` throws `NotesMissingError` when the file is absent, but `readCurrentState` returns `null`. An absent note blocks an announcement; an absent `current.md` must NOT block a chat turn — a friend with no dashboard yet has no file and must still be able to talk.

`body` is the whole post-frontmatter text, unsplit. The parser proves the five headings are present and correctly spelled, then hands the prose through untouched — spec §D8, "a body parser is a second thing that drifts".

- [ ] **Step 1: Write the failing test**

Create `tests/build/currentState.test.ts`:

```typescript
// tests/build/currentState.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CurrentStateError,
  currentStatePath,
  parseCurrentState,
  readCurrentState,
} from '@/lib/build/currentState'

const GOOD = `---
slug: sam
version: 3
---

## What this is for
Keeping an eye on the weekly takeaway spend.

## Screens
One screen, "Spending".

## Panels
Weekly takeaway total. Counts the current week only, Monday to Sunday.

## What can be entered
Nothing by hand — everything is synced.

## Deliberately not included
A monthly view. Asked for and turned down: the week is the unit they think in.
`

const dirs: string[] = []
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'currentstate-'))
  dirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  return dir
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('parseCurrentState', () => {
  it('reads slug and version from frontmatter', () => {
    const state = parseCurrentState(GOOD)
    expect(state.slug).toBe('sam')
    expect(state.version).toBe(3)
  })

  it('hands the body through unsplit, frontmatter removed', () => {
    const state = parseCurrentState(GOOD)
    expect(state.body).toContain('## What this is for')
    expect(state.body).toContain('the week is the unit they think in')
    expect(state.body).not.toContain('slug: sam')
  })

  it('accepts version 0, meaning it predates the spec loop', () => {
    expect(parseCurrentState(GOOD.replace('version: 3', 'version: 0')).version).toBe(0)
  })

  it('rejects a negative or non-integer version', () => {
    expect(() => parseCurrentState(GOOD.replace('version: 3', 'version: -1'))).toThrow(
      CurrentStateError,
    )
    expect(() => parseCurrentState(GOOD.replace('version: 3', 'version: 2.5'))).toThrow(
      CurrentStateError,
    )
  })

  it('rejects a file with no frontmatter', () => {
    expect(() => parseCurrentState('## What this is for\nhi\n')).toThrow(CurrentStateError)
  })

  it('names a missing section rather than treating it as empty', () => {
    const missing = GOOD.replace(/## Deliberately not included[\s\S]*$/, '')
    expect(() => parseCurrentState(missing)).toThrow(/Deliberately not included/)
  })

  it('rejects a misspelled heading instead of silently dropping it', () => {
    // The failure this exists for: "## Delibrately not included" would leave
    // the real section absent and read as empty, and an empty refusal list is
    // exactly how the agent re-proposes something already turned down.
    expect(() => parseCurrentState(GOOD.replace('## Deliberately not included', '## Delibrately not included'))).toThrow(
      /Delibrately/,
    )
  })

  it('rejects a duplicated section', () => {
    expect(() => parseCurrentState(`${GOOD}\n## Screens\nagain\n`)).toThrow(/duplicate/)
  })

  it('accepts an empty section — an empty answer is a real answer', () => {
    const empty = GOOD.replace(
      'A monthly view. Asked for and turned down: the week is the unit they think in.',
      '',
    )
    expect(() => parseCurrentState(empty)).not.toThrow()
  })
})

describe('readCurrentState', () => {
  it('returns null when the file does not exist', () => {
    // NOT a throw, unlike readBuildNotes. A friend with no dashboard yet has
    // no file and must still be able to hold a conversation.
    const dir = tree({ 'sam/dashboard.tsx': '' })
    expect(readCurrentState('sam', dir)).toBeNull()
  })

  it('reads and parses a file that exists', () => {
    const dir = tree({ 'sam/current.md': GOOD })
    expect(readCurrentState('sam', dir)?.version).toBe(3)
  })

  it('throws on a malformed file rather than returning null', () => {
    // A file that exists but cannot be read is a builder error, not an absent
    // dashboard — silently degrading to null would feed the agent nothing
    // while the folder looks complete.
    const dir = tree({ 'sam/current.md': 'no frontmatter here' })
    expect(() => readCurrentState('sam', dir)).toThrow(CurrentStateError)
  })

  it('names the path it looked at', () => {
    expect(currentStatePath('sam', '/tmp/users')).toBe('/tmp/users/sam/current.md')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/build/currentState.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/build/currentState"`.

- [ ] **Step 3: Write the implementation**

Create `lib/build/currentState.ts`:

```typescript
// lib/build/currentState.ts
//
// What a dashboard IS right now, as the builder describes it after building.
//
// OVERWRITTEN EVERY BUILD, and that is the whole difference from
// lib/build/notes.ts, which this file is otherwise modelled on. A note is
// pinned because scripts/announce-deploy.ts already spoke from it, so editing
// one rewrites the basis of a message a friend holds permanently. Nothing
// permanent points at a current-state description — and it MUST be replaced
// rather than appended to, because a changelog replayed forward is the
// "derive current state from history" failure this artifact exists to remove.
//
// The body is handed through UNSPLIT. This parser proves the five headings
// are present and spelled right, then stops: a body parser is a second thing
// that drifts from what the builder actually writes (design D8).

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export class CurrentStateError extends Error {
  constructor(message: string) {
    super(`current state: ${message}`)
    this.name = 'CurrentStateError'
  }
}

/** In file order. A file must carry all five, and nothing else. */
export const SECTION_HEADINGS = [
  'What this is for',
  'Screens',
  'Panels',
  'What can be entered',
  'Deliberately not included',
] as const

export type CurrentState = {
  slug: string
  /**
   * The spec version this describes, or 0 for a dashboard that predates the
   * spec loop (devone, devtwo — hand-written, never had a spec). The announce
   * gate compares this against a version being announced, which is always
   * >= 1, so a 0 file can never satisfy it. That is correct: those dashboards
   * have nothing to announce.
   */
  version: number
  /** Everything after the frontmatter, verbatim. */
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/

function frontmatter(text: string): Map<string, string> {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new CurrentStateError('no --- frontmatter block at the top of the file')
  const out = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) throw new CurrentStateError(`frontmatter line is not "key: value": ${line}`)
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return out
}

/**
 * Headings, checked and then discarded.
 *
 * An UNKNOWN heading throws rather than being ignored, for the same reason
 * lib/build/notes.ts does it: a typo leaves the real section absent and
 * reading as empty. Here that matters most for "## Deliberately not
 * included", which is the only carrier of a refusal — an empty one is how the
 * agent re-proposes something the friend already turned down.
 */
function checkSections(body: string): void {
  const seen = new Set<string>()
  const parts = body.split(/^## +(.+?) *$/m)
  // parts[0] is whatever preceded the first heading — ignored on purpose.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim()
    if (!(SECTION_HEADINGS as readonly string[]).includes(heading)) {
      throw new CurrentStateError(
        `unknown section "## ${heading}" — expected one of: ${SECTION_HEADINGS.join(', ')}`,
      )
    }
    if (seen.has(heading)) throw new CurrentStateError(`duplicate section "## ${heading}"`)
    seen.add(heading)
  }
  for (const heading of SECTION_HEADINGS) {
    if (!seen.has(heading)) throw new CurrentStateError(`missing section "## ${heading}"`)
  }
}

export function parseCurrentState(text: string): CurrentState {
  const front = frontmatter(text)

  const slug = front.get('slug')
  if (!slug) throw new CurrentStateError('frontmatter is missing slug')

  const rawVersion = front.get('version')
  const version = Number(rawVersion)
  if (rawVersion === undefined || !Number.isInteger(version) || version < 0) {
    throw new CurrentStateError(
      `frontmatter version "${rawVersion ?? ''}" is not a non-negative integer`,
    )
  }

  const body = text.replace(FRONTMATTER, '')
  checkSections(body)

  return { slug, version, body: body.trim() }
}

/**
 * USERS_DIR, matching lib/build/notes.ts:176 exactly — an explicit argument
 * wins, then the env var, then the default, which IS the correct production
 * value.
 *
 * The env arm is not optional. USERS_DIR is a live seam: several route tests
 * (tests/auth/routes.test.ts, tests/invite/registerRoute.test.ts) point the
 * whole app at a temp users tree, and app/api/chat/route.ts reads this module.
 * Omitting it would make this file read the real users/ while every other
 * module read the temp one.
 *
 * Duplicated rather than imported from lib/db/userDb.ts for the reason that
 * file's own comment gives: userDb.ts pulls in a native SQLite binding at
 * module top, and this module is pure text parsing.
 */
function usersRoot(override?: string): string {
  return override ?? process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

export function currentStatePath(slug: string, usersDir?: string): string {
  return join(usersRoot(usersDir), slug, 'current.md')
}

/**
 * ABSENT RETURNS NULL, unlike readBuildNotes, which throws NotesMissingError.
 *
 * The two absences mean different things. A missing note blocks an
 * announcement, which is a thing Nico is standing at a terminal waiting for.
 * A missing current.md is the ordinary state of an account whose dashboard
 * has not been built — and this is read on the chat path, where throwing
 * would take away the conversation of the friend who is furthest from having
 * a dashboard.
 *
 * A file that EXISTS and does not parse still throws: that is a builder
 * error, and degrading it to null would feed the agent nothing while the
 * folder looks complete.
 */
export function readCurrentState(slug: string, usersDir?: string): CurrentState | null {
  const path = currentStatePath(slug, usersDir)
  if (!existsSync(path)) return null
  return parseCurrentState(readFileSync(path, 'utf8'))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/build/currentState.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/build/currentState.ts tests/build/currentState.test.ts
git commit -m "Parse users/<slug>/current.md, the dashboard as it actually is"
```

---

### Task 2: Delete run3, run4 and run8, keeping the coverage run4 carried

**Files:**
- Delete: `users/run3/`, `users/run4/`, `users/run8/`
- Modify: `lib/dashboard/registry.ts:17-23`
- Modify: `tests/users/conventions.test.ts` (a new top-level describe, plus the comment naming run4 at 430-449)
- Test: `tests/users/conventions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo whose only dashboard folders are `devone` and `devtwo`.

Two things run4 and run8 were carrying that must not vanish silently:

1. **run4 is the only folder whose screen id (`walk_now`) distinguishes `SCREEN_ID_PATTERN` from `SLUG_PATTERN`.** `tests/users/conventions.test.ts:436-441` says so in its own comment. Every other folder uses `morning`, which passes both patterns, so deleting run4 makes that sweep check vacuous. Replaced below with an explicit unit test — coverage belongs in a test that states its intent, not in an accidental fixture.
2. **run4 is the repo's only `scaffolded`-state folder.** That branch of the sweep (`complete` but no numbered `.sql`) loses its only live case. Accepted knowingly and recorded in the sweep's own comment — building a fixture folder purely to exercise it would add a permanent fake dashboard to `users/`, which is worse.

`app/api/users/[user]/count/route.ts` and `tests/routing/countRoute.test.ts` are **kept** — see spec §13.1. The route is orphaned but is the repo's only worked example of the four ordered checks on a write, and the test inlines its own copy of run8's migration rather than reading the folder, so it survives untouched.

- [ ] **Step 1: Write the failing test**

`SCREEN_ID_PATTERN` is **not** exported from `lib/` — it is a local const at
`tests/users/conventions.test.ts:43`, used by the sweep at :463. So the
preserved assertion goes in that same file, beside the pattern it is about,
rather than in `tests/dashboard/contract.test.ts`. That keeps the regex defined
once and the coverage adjacent to its subject.

Add to `tests/users/conventions.test.ts` as a top-level `describe`, outside the
per-slug loop, since it sweeps nothing:

```typescript
describe('SCREEN_ID_PATTERN is not SLUG_PATTERN', () => {
  // Held here explicitly since users/run4/ was deleted. Its screens export
  // used `walk_now`, and it was the only folder in the repo where the two
  // patterns disagreed — the sweep below runs over live folders, so with
  // every remaining folder on `morning` (which passes both) it can no longer
  // tell them apart. A deleted fixture must not take a real assertion with
  // it: this states directly what the sweep used to prove incidentally.
  it('accepts an underscore in a screen id, which a slug may not carry', () => {
    expect(SCREEN_ID_PATTERN.test('walk_now')).toBe(true)
    expect(SLUG_PATTERN.test('walk_now')).toBe(false)
  })

  it('still rejects what neither pattern allows', () => {
    expect(SCREEN_ID_PATTERN.test('Walk Now')).toBe(false)
    expect(SCREEN_ID_PATTERN.test('')).toBe(false)
    expect(SCREEN_ID_PATTERN.test('_leading')).toBe(false)
  })
})
```

Both are already in scope: `SCREEN_ID_PATTERN` at :43, `SLUG_PATTERN` imported
for the `users/` entry filter at :105-112. No new imports.

- [ ] **Step 2: Run it to confirm it passes against the current code**

Run: `npx vitest run tests/users/conventions.test.ts`
Expected: PASS. This is not driving new behaviour — it *preserves* an existing
guarantee before the fixture carrying it is deleted. Green first is the point:
it proves the assertion holds now, so a later red means the deletion broke
something real.

- [ ] **Step 3: Delete the folders and their registry lines**

```bash
git rm -r users/run3 users/run4 users/run8
```

Edit `lib/dashboard/registry.ts` so `DASHBOARDS` reads exactly:

```typescript
const DASHBOARDS: Record<string, () => Promise<DashboardModule>> = {
  devone: () => import('@/users/devone/dashboard'),
  devtwo: () => import('@/users/devtwo/dashboard'),
}
```

- [ ] **Step 4: Update the sweep comment that names run4**

In `tests/users/conventions.test.ts`, the comment block at 430-449 explains that these four checks run on every COMPLETE folder rather than every BUILT one, and justifies it by naming run4. Replace the justification, keeping the ruling:

```typescript
    // The four properties `screens: DashboardScreen[]` cannot express as a
    // type, run over every COMPLETE folder — not `whenBuilt`. `screens`
    // comes from dashboard.tsx, one of the five REQUIRED entries that make a
    // folder `complete`; `whenBuilt` additionally requires `hasShape` (a real
    // .sql migration file), which is about the DATA shape and has no
    // relationship to a dashboard's screens.
    //
    // The folder this ruling was made for — run4, complete but with no
    // numbered .sql, and the only one whose screen id (`walk_now`) told
    // SCREEN_ID_PATTERN and SLUG_PATTERN apart — was deleted on 2026-08-18.
    // The ruling stands on its own reasoning above. The id-pattern coverage
    // moved to the SCREEN_ID_PATTERN describe at the top of this
    // file, which states it directly rather than depending on a fixture
    // happening to exist. NO FOLDER IS
    // CURRENTLY IN THE `scaffolded` STATE, so that branch is live but
    // unexercised — a known gap, accepted rather than papered over with a
    // permanent fake dashboard under users/.
```

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. `tests/routing/countRoute.test.ts` must still pass — it builds its own temp tree and never reads `users/run8/`. If it fails, stop: that means it was reading the deleted folder, which contradicts the spec's §13.1 finding and needs re-examining before proceeding.

- [ ] **Step 6: Regenerate synthetic databases and commit**

```bash
npm run synthetic
npx vitest run
git add -A
git commit -m "Delete run3, run4 and run8; keep the screen-id coverage run4 carried

The three run folders were test runs and their builds are throwaway. Deleting
run4 removes the repo's only scaffolded-state folder and the only screens
export whose id distinguishes SCREEN_ID_PATTERN from SLUG_PATTERN, so that
assertion moves beside SCREEN_ID_PATTERN itself, where it states its own
intent. app/api/users/[user]/count/route.ts is kept deliberately: orphaned,
but the only worked example of the four ordered checks on a write."
```

---

### Task 3: Backfill `current.md` for devone and devtwo

**Files:**
- Create: `users/devone/current.md`
- Create: `users/devtwo/current.md`
- Test: `users/devone/tests/currentState.test.ts`, `users/devtwo/tests/currentState.test.ts`

**Interfaces:**
- Consumes: `parseCurrentState` from Task 1.
- Produces: the two files the sweep in Task 4 will require.

Both dashboards predate the spec loop and are hand-written, so both carry `version: 0` (see Global Constraints). Content is drawn from reading `users/<slug>/dashboard.tsx` and `queries.ts` — describe what the panels DO, never what they contain.

- [ ] **Step 1: Write the failing test for devone**

Create `users/devone/tests/currentState.test.ts`:

```typescript
// users/devone/tests/currentState.test.ts
import { describe, expect, it } from 'vitest'
import { readCurrentState } from '@/lib/build/currentState'

describe('devone current.md', () => {
  it('parses', () => {
    const state = readCurrentState('devone')
    expect(state).not.toBeNull()
    expect(state!.slug).toBe('devone')
  })

  it('is version 0 — devone predates the spec loop and can never be announced', () => {
    expect(readCurrentState('devone')!.version).toBe(0)
  })

  it('carries no money amounts or merchant names', () => {
    // The same bound notes carry, checked rather than trusted: this file is
    // committed, and devone's dashboard is about spending. A worked example
    // that leaked a value would be copied.
    const body = readCurrentState('devone')!.body
    expect(body).not.toMatch(/\$\d/)
    expect(body).not.toMatch(/COFFEE PALACE/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run users/devone`
Expected: FAIL — `expect(state).not.toBeNull()` receives `null`.

- [ ] **Step 3: Write the two files**

Create `users/devone/current.md`:

```markdown
---
slug: devone
version: 0
---

## What this is for
Seeing what has been spent recently, and how much of this month has gone on
eating out. devone is the hand-written reference implementation — it predates
the spec loop, so there is no spec version behind it.

## Screens
One screen, `morning`, titled "Spending". It carries both panels below; there
is no tab strip, because the platform draws none for a single screen.

## Panels
**Eating out this month.** A single money figure: everything categorised as
eating out, for the current month in the friend's own time zone. When no
transactions exist at all it says "Nothing logged yet" rather than showing a
zero — a confident zero reads as a claim about their life rather than about
their data.

**Recent transactions.** A list, most recent first, each row showing the day,
the merchant and the amount. Empty state is "No transactions yet."

## What can be entered
Nothing. Every row is synced; this dashboard has no entry widget and no write
path.

## Deliberately not included
Any control that writes. This folder is the worked reference for a read-only
dashboard — the write-path example lives elsewhere.
```

Create `users/devtwo/current.md`:

```markdown
---
slug: devtwo
version: 0
---

## What this is for
Checking whether today's walk has happened, and whether the habit is holding.
devtwo is hand-written and predates the spec loop, so there is no spec version
behind it.

## Screens
One screen, `morning`, titled "Daily walk". It carries all four panels below.

## Panels
**Walked today?** Reads WALKED or NOT YET for the current day, with the day
shown beneath. When the day is not yet marked it offers the tap control; once
marked it says so instead of offering the control again.

**Current streak.** Consecutive days ending today, with the label agreeing in
number — "day in a row" at one, "days in a row" otherwise.

**Last 30 days.** A percentage, with the count it came from underneath.

**Last 14 days at a glance.** One row per day, each marked walked or missed.
Hidden entirely — replaced by "Nothing logged yet" — until something has been
logged. A day before the friend started is not a day they failed, and the
first version of this panel told a friend on their first morning that they
had missed each of the previous fourteen days.

## What can be entered
One tap, marking today walked. It posts to a platform route, never writing
from the dashboard itself, and marks the current day only.

## Deliberately not included
Un-marking a day. There is no control to undo a tap, and no way to mark a day
other than today.
```

- [ ] **Step 4: Write and run the devtwo test**

Create `users/devtwo/tests/currentState.test.ts`:

```typescript
// users/devtwo/tests/currentState.test.ts
import { describe, expect, it } from 'vitest'
import { readCurrentState } from '@/lib/build/currentState'

describe('devtwo current.md', () => {
  it('parses', () => {
    const state = readCurrentState('devtwo')
    expect(state).not.toBeNull()
    expect(state!.slug).toBe('devtwo')
  })

  it('is version 0 — devtwo predates the spec loop and can never be announced', () => {
    expect(readCurrentState('devtwo')!.version).toBe(0)
  })

  it('carries no logged days', () => {
    // devtwo's data IS days. A date in this file would be one of its rows,
    // and this file is committed — the same bound notes/ carries.
    const body = readCurrentState('devtwo')!.body
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('records that a day cannot be un-marked', () => {
    // The refusal is the load-bearing part of this artifact: without it the
    // agent proposes an undo control that was deliberately never built.
    expect(readCurrentState('devtwo')!.body).toMatch(/Un-marking a day/)
  })
})
```

Run: `npx vitest run users/devone users/devtwo`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add users/devone/current.md users/devtwo/current.md \
        users/devone/tests/currentState.test.ts users/devtwo/tests/currentState.test.ts
git commit -m "Backfill current.md for devone and devtwo at version 0"
```

---

### Task 4: Require and parse `current.md` in the folder sweep, and give the builder a template

**Files:**
- Modify: `tests/users/conventions.test.ts`
- Create: `platform/templates/dashboard/current.md.tmpl`
- (Deliberately NOT `scripts/new-dashboard.sh` — see Step 4)

**Interfaces:**
- Consumes: `readCurrentState` (Task 1), the two backfilled files (Task 3), the deletions (Task 2).
- Produces: a sweep that fails any BUILT folder with no `current.md`, or whose
  `current.md` does not name the newest version in `notes/`.

`readdirSync` and `join` are already imported by this file (:11 and its path
import). No new imports beyond `readCurrentState`.

**Gated on `built`, not `complete`.** A scaffolded folder has no shape and nobody has designed anything, so there is nothing true to write — the same reasoning that ships a scaffold with no `001_*.sql`. The scaffold therefore does NOT create `current.md`; the template is copied by the builder when the first version is built, which is the first moment its content can be true.

- [ ] **Step 1: Write the failing test**

Add to `tests/users/conventions.test.ts`, inside the per-slug `describe` block, beside the existing `whenBuilt` checks:

```typescript
    whenBuilt('has a current.md that parses', () => {
      // PRESENCE, unlike notes/ — and the difference is that this sweep CAN
      // know. Which v<n>.md files should exist depends on which versions were
      // built, which lives in the platform database; current.md is exactly one
      // file per built dashboard, and a built dashboard the agent cannot see
      // is the whole defect this artifact exists to fix.
      const state = readCurrentState(slug, USERS)
      expect(state, `${slug} is built but has no current.md`).not.toBeNull()
      expect(state!.slug).toBe(slug)
    })

    whenBuilt('current.md names the newest version that was built', () => {
      // THE STALENESS GATE, and it needs no database — notes/v<n>.md exists
      // on disk for exactly the versions that were built, so the newest note
      // is what current.md must describe.
      //
      // This matters because nothing else catches it: `*.md` is exempt from
      // Gate B (.githooks/pre-commit:152), so a build that edits dashboard.tsx
      // and forgets to rewrite current.md commits green. Without this check
      // the file rots into a description of some earlier version, which is the
      // exact failure the artifact exists to prevent, just slower.
      const versions = readdirSync(join(dir, 'notes'))
        .map((f) => /^v(\d+)\.md$/.exec(f))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
      const state = readCurrentState(slug, USERS)!
      // No notes at all means the folder predates the spec loop — devone and
      // devtwo, hand-written, never had a version. Version 0 says so.
      const expected = versions.length === 0 ? 0 : Math.max(...versions)
      expect(
        state.version,
        `${slug}/current.md says version ${state.version}, newest note is v${expected}`,
      ).toBe(expected)
    })
```

And add the import at the top of that file:

```typescript
import { readCurrentState } from '@/lib/build/currentState'
```

- [ ] **Step 2: Run it to verify it passes for the right reason**

Run: `npx vitest run tests/users/conventions.test.ts`
Expected: PASS — devone and devtwo both have the file from Task 3, and neither
has any `notes/v<n>.md`, so both are expected at version 0 and both say 0.

Now prove the check has teeth:

```bash
mv users/devtwo/current.md /tmp/devtwo-current.md
npx vitest run tests/users/conventions.test.ts
```
Expected: FAIL with "devtwo is built but has no current.md".

```bash
mv /tmp/devtwo-current.md users/devtwo/current.md
npx vitest run tests/users/conventions.test.ts
```
Expected: PASS again. Do not skip this — a presence check that passes because
nothing was ever absent is not a check.

Now prove the staleness check the same way:

```bash
sed -i '' 's/^version: 0$/version: 4/' users/devtwo/current.md
npx vitest run tests/users/conventions.test.ts
```
Expected: FAIL with "devtwo/current.md says version 4, newest note is v0".

```bash
sed -i '' 's/^version: 4$/version: 0/' users/devtwo/current.md
npx vitest run tests/users/conventions.test.ts
```
Expected: PASS. This check is the only thing standing between a build and a
silently stale description, so it gets the same treatment.

- [ ] **Step 3: Write the template**

Create `platform/templates/dashboard/current.md.tmpl`:

```markdown
---
slug: __SLUG__
version: 1
---

## What this is for
One paragraph, in __SLUG__'s own terms. What they open this to find out.

## Screens
Each screen: its id, its title, and what is on it. The platform draws the tab
strip from dashboard.tsx's own `screens` export — say what the screens ARE,
not how they are drawn.

## Panels
Each panel: what it shows, how it behaves, and the edges that were decided.
The edges are the part that matters and the part a spec never has — where a
count stops, which days are blank rather than zero, what an empty state says.

## What can be entered
Every control that writes, and what it writes. "Nothing" is a real answer for
a read-only dashboard.

## Deliberately not included
What was considered and turned down, and why. This is the only place a refusal
survives: without it the agent proposes the same thing again next month.

<!--
  OVERWRITE THIS FILE ON EVERY BUILD. It describes what the dashboard IS, not
  what changed — notes/v<n>.md is the changelog and is added, never edited.
  Bump `version` to the spec version you just built.

  Never put __SLUG__'s data in here. This file is committed to the repo:
  describe shape — a panel, a computation, a rule — never a row, a value, or a
  merchant. The same bound notes/ carries.
-->
```

- [ ] **Step 4: Leave `new-dashboard.sh` alone**

**Do not add the copy command to the scaffold's closing message**, and do not
create `current.md` at scaffold time.

`tests/scripts/newDashboard.test.ts:123` asserts the output does NOT contain
`npm run synthetic`, `npx vitest`, `pull-spec.sh` or `npm run shots`, and its
comment records why: the epilogue used to carry a command list of its own,
which went stale within two days of the runbook being written — it never
learned about the `<slug>/v<n>` branch, so following it built on main. The
ruling is that this message stays a **pointer**, never a sequence. A `sed`
command for `current.md` would be a new command list forming underneath that
pointer, which is exactly the state the test pins as an absence.

The command belongs in `docs/runbook.md`'s build step, which owns the build
sequence — Task 6, Step 3. The format itself is carried by the template's own
trailing comment.

This task therefore touches no shell script.

- [ ] **Step 5: Run the scaffold's own tests and commit**

Run: `npx vitest run tests/scripts/newDashboard.test.ts tests/users/conventions.test.ts`
Expected: PASS, unchanged — `newDashboard.test.ts` should be green with no
edits, because Step 4 changed nothing it looks at. A red there means the
scaffold was modified against Step 4's ruling.

```bash
git add tests/users/conventions.test.ts platform/templates/dashboard/current.md.tmpl
git commit -m "Require current.md on every built dashboard, and template it for the builder"
```

---

### Task 5: Put `current.md` in front of the agent

**Files:**
- Create: `platform/prompts/agent-v6.md`
- Modify: `lib/chat/prompt.ts:21` (`AGENT_PROMPT`)
- Modify: `lib/chat/turn.ts` (`TurnInput`, the system assembly at :266-272)
- Modify: `app/api/chat/route.ts` (the `runTurn` call at :160)
- Test: `tests/chat/turn.test.ts`, `tests/copy/prompts.test.ts`

**Interfaces:**
- Consumes: `readCurrentState` (Task 1).
- Produces: `TurnInput.currentState: string | null`; `CURRENT_STATE_BLOCK` exported from `lib/chat/turn.ts`.

**The route reads the file, not `runTurn`.** `TurnInput` carries `accountId`, not a slug, and the route already knows the user. Passing a plain string keeps `turn.ts` free of filesystem access and makes the behaviour testable without a temp tree.

- [ ] **Step 1: Write the failing test**

Add to `tests/chat/turn.test.ts`:

```typescript
describe('current.md in the system prompt', () => {
  it('appends the dashboard description when one exists', async () => {
    const client = recordingClient()
    await runTurn(deps({ client }), input({ currentState: '## Panels\nA week chart.' }))
    expect(client.lastRequest!.system).toContain('A week chart.')
    expect(client.lastRequest!.system).toContain(CURRENT_STATE_BLOCK)
  })

  it('appends nothing at all when there is no dashboard yet', async () => {
    // The ordinary state of an account mid-interview. An empty labelled block
    // would tell the model there IS a dashboard and it is blank.
    const client = recordingClient()
    await runTurn(deps({ client }), input({ currentState: null }))
    expect(client.lastRequest!.system).not.toContain(CURRENT_STATE_BLOCK)
  })

  it('keeps the opener note when both apply', async () => {
    const client = recordingClient()
    await runTurn(
      deps({ client }),
      input({ currentState: '## Panels\nA week chart.', openerSent: true }),
    )
    expect(client.lastRequest!.system).toContain(OPENER_ALREADY_SENT)
    expect(client.lastRequest!.system).toContain('A week chart.')
  })
})
```

Use the file's existing helpers for `deps`, `input` and the recording client rather than inventing new ones — read the top of `tests/chat/turn.test.ts` and match what is already there. If no recording client exists, the existing tests already assert on what the injected client received; use the same mechanism.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chat/turn.test.ts`
Expected: FAIL — `CURRENT_STATE_BLOCK` is not exported, and `input({ currentState })` is not an accepted field.

- [ ] **Step 3: Wire it through**

In `lib/chat/turn.ts`, add to `TurnInput`:

```typescript
  /**
   * The body of users/<slug>/current.md, or null when the account has no
   * built dashboard.
   *
   * Read by the ROUTE, not here: TurnInput carries an accountId and not a
   * slug, and the route already knows the user. Passing the text keeps this
   * module free of filesystem access and lets a test set it directly.
   */
  currentState: string | null
```

Beside the existing `OPENER_ALREADY_SENT` usage, add the label:

```typescript
/**
 * What the block of current.md is introduced as.
 *
 * A LABEL, not a summary — the body is the builder's own prose and is handed
 * over untouched. Omitted entirely when there is no dashboard: an empty
 * labelled block would tell the model a dashboard exists and is blank, which
 * is a different and wrong thing from having none.
 */
export const CURRENT_STATE_BLOCK =
  "This is their dashboard as it exists right now, written by the builder " +
  'after the last build. It is the truth about what is deployed — trust it ' +
  'over anything earlier in this conversation.'
```

And extend the assembly at :266-272:

```typescript
  const systemWithOpener = openerAlreadySent(rows)
    ? `${system}\n\n${OPENER_ALREADY_SENT}`
    : system

  const systemWithState =
    input.currentState === null
      ? systemWithOpener
      : `${systemWithOpener}\n\n${CURRENT_STATE_BLOCK}\n\n${input.currentState}`

  const merged = applyConfirmationNote(
    toMessages(rows),
    systemWithState,
    confirmationNote(readConfirmations(db, input.accountId), lastAssistantAt),
    CHAT_MODEL,
    input.body === null,
  )
```

In `app/api/chat/route.ts`, at the `runTurn` call, add the field. Read the slug from whatever the route already resolved for its 403 check at :54 — do not resolve it a second way:

```typescript
        currentState: readCurrentState(slug)?.body ?? null,
```

with the import:

```typescript
import { readCurrentState } from '@/lib/build/currentState'
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat`
Expected: PASS. Every existing `runTurn` test now needs `currentState` in its
input, and there is exactly one place to add it: the `input` helper at
`tests/chat/turn.test.ts:216`, which spreads `over` last. One default fixes
every call site:

```typescript
const input = (over: Partial<Parameters<typeof runTurn>[1]> = {}) => ({
  accountId: 1,
  sessionId: 'sess-1',
  body: 'what should I watch?',
  // No dashboard by default: most cases in this file are interview turns,
  // which is the state an account is in before anything is built.
  currentState: null,
  signal: new AbortController().signal,
  ...
```

`deps` is built inline per test rather than by a helper, and nothing in it
changes here.

- [ ] **Step 5: Write `agent-v6.md`**

```bash
cp platform/prompts/agent-v5.md platform/prompts/agent-v6.md
```

Then edit `agent-v6.md` — **only** these changes; everything else stays byte-identical, including all of `## When you have enough`, which is the load-bearing part:

1. In the paragraph beginning "There is one living description of their dashboard: the spec.", replace that sentence with:

> There is one living description of their dashboard, and it is written by the
> builder after each build: what exists right now, given to you above. The spec
> is not that description — it is a record of what was asked for, which the
> build necessarily departs from. Trust the description of what exists.

2. Leave `## Proposing`, `## After they confirm` and the preview language untouched. They are still true on this branch — plan 2 removes them in `agent-v7.md`.

Update `lib/chat/prompt.ts`:

```typescript
/**
 * v6 hands the agent users/<slug>/current.md — the builder's description of
 * what is actually deployed — and tells it to trust that over the spec. Until
 * v6 the agent received no description of the dashboard at all and
 * reconstructed one from the conversation, which is why a second conversation
 * could discuss panels that were never built the way they were proposed.
 */
export const AGENT_PROMPT = 'agent-v6.md'
```

- [ ] **Step 6: Run everything and commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS both. `tests/copy/prompts.test.ts` (or whichever test loads `AGENT_PROMPT`) must still find its opener — if it pins the opening message text, `agent-v6.md` keeps it unchanged, so this should be green. If it goes red, the copy of v5 was edited beyond the one sentence above.

```bash
git add platform/prompts/agent-v6.md lib/chat/prompt.ts lib/chat/turn.ts app/api/chat/route.ts tests/chat/turn.test.ts
git commit -m "Give the agent current.md, and tell it to trust it over the spec

Until now the chat agent received no description of the dashboard at all — a
system prompt and a transcript — and reconstructed one from conversation."
```

---

### Task 6: The runbook

**Files:**
- Modify: `docs/runbook.md` (7.5, 7.6, the standing-rules table, step 10)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

Its own task because the runbook is the thing Nico actually follows at a
terminal, and a wrong line here costs a build. Docs are exempt from Gate B by
path (`.githooks/pre-commit:152`), so there is no test — the verification is
reading it against what the code now does.

Most of the runbook is untouched. Steps 0–6, 8 and 9 do not change in this
plan: the spec pull, the mockup and the announcement are all plan 2's business.

- [ ] **Step 1: Rewrite 7.5 to cover both artifacts**

`### 7.5 Write the build notes` becomes:

```markdown
### 7.5 Write the build notes, and rewrite `current.md`

Two files, and they answer different questions. Write both before you ship.

**`users/$FRIEND/notes/v$V.md`** — what shipped in THIS version. Added, never
edited: step 9 speaks from it, and editing one changes what an already-sent,
permanent announcement was based on. `notes/README.md` in their folder holds
the template and says which sections the friend sees.

**`users/$FRIEND/current.md`** — what the dashboard IS now, after this build.
**Overwritten every time**, because it is the agent's whole picture of what
exists and a changelog is not a picture. If the file is not there yet:

```bash
sed 's/__SLUG__/'"$FRIEND"'/g' platform/templates/dashboard/current.md.tmpl \
  > users/$FRIEND/current.md
```

Then edit it to describe what you actually built, and set `version: $V`.
`tests/users/conventions.test.ts` fails if it is missing, or if its version is
not the newest `notes/v<n>.md` — that check is what stops it rotting, since
`*.md` is exempt from Gate B and a commit will not notice.

The section that earns the most care is `## Deliberately not included`. It is
the only place a refusal survives. Anything the friend considered and turned
down goes there, or the agent proposes it again next month.

Never put their data in either file — both are committed to the repo
(build-rules §2).
```

- [ ] **Step 2: Add one line to 7.6**

In `### 7.6 Commit the build`, after the sentence about Gate B and Gate C, add:

```markdown
`current.md` and the notes are `*.md`, which Gate B exempts — they will not
force a test, and they will not be noticed if you forget them. The sweep in
`npx vitest run tests` is what catches a missing or stale `current.md`, so run
it before you reach step 8.
```

- [ ] **Step 3: Add a standing rule**

In the `## Standing rules` table, immediately after the existing
`Write notes/v<n>.md before announcing` row — the two belong together, and the
contrast between them is the point:

```markdown
| Rewrite `current.md` on every build, and never let it accumulate | It is what the chat agent reads to know what exists. A note is added and never edited because an announcement was based on it; `current.md` is the opposite and must be REPLACED, because an agent that has to replay a changelog to work out the current state is back to guessing. |
```

- [ ] **Step 4: Correct step 10**

`## Step 10 — The next version` currently says step 7 is "the same work as the
first time — including a migration". Add `current.md` to what the second run
redoes, so a Flow B build does not skip it:

```markdown
Step 7 is the same work as the first time — including a migration, which at v2
is the next number rather than `001` (step 7.2), and including a rewritten
`current.md` (step 7.5). The notes are a new file; `current.md` is the same
file, replaced.
```

- [ ] **Step 5: Read it end to end and commit**

Read steps 7 and 10 straight through as if following them for the first time.
The failure this catches is a sequence that no longer flows — a command
referring to a file the previous step no longer creates.

```bash
git add docs/runbook.md
git commit -m "Runbook: write current.md at 7.5, and rewrite it every build"
```

---

### Task 7: CLAUDE.md and the build rules

**Files:**
- Modify: `CLAUDE.md` (Dashboard folder conventions)
- Modify: `docs/dashboard-build-rules.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: CLAUDE.md**

In **Dashboard folder conventions**, after the `notes/` bullet, add a
`current.md` bullet covering: required on every BUILT folder and swept by
`tests/users/conventions.test.ts`, including a check that its version matches
the newest note; **overwritten every build**, unlike `notes/` and unlike
prompts, with the reason stated — nothing permanent points at it, and a
changelog replayed forward is the failure it exists to remove; five required
sections, parser-enforced by `lib/build/currentState.ts`;
`## Deliberately not included` is the only carrier of a refusal; the same
no-user-values bound notes carry; `version: 0` means predates the spec loop.

That section currently says six entries are required. `current.md` is required
for BUILT folders only, so state it as its own condition rather than changing
that count.

Also note, in the same bullet, that the chat agent reads this file — it is the
only artifact in `users/<slug>/` that the running app puts in front of a model.

- [ ] **Step 2: docs/dashboard-build-rules.md**

Add `current.md` to the artifact index in that file's existing form, one line
per rule with a citation on each. It is an index, not a second copy — where it
disagrees with CLAUDE.md or the design doc, the source wins.

Amend the four-folder-states list: `built` now additionally means "has a
`current.md` naming the newest built version".

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/dashboard-build-rules.md
git commit -m "Document current.md: required when built, overwritten every build"
```

---

## Done when

- `npx vitest run` is green.
- `npx tsc --noEmit` is clean.
- `npx next build` succeeds (Gate D runs it on push regardless).
- `users/` holds only `devone` and `devtwo`, both with a parsing `current.md`.
- A chat turn for `devtwo` puts that file's body in the system prompt; a turn for an account with no dashboard puts no block there at all.
- The sweep fails when a `current.md` is removed, and fails when its version does not match the newest `notes/v<n>.md` — both proved by breaking them on purpose, not by assuming.
- `npm run shots` still captures every screen — the deleted folders were not pinned by `screenshots/screens.ts`, but run it before the final commit, because that is the gate that sees what tests cannot.

## Not in this plan

Change-only specs, removing the confirmation card, removing the mockup pipeline, background authoring, the failure alert, the announce rethread, `conversation.md`, and `agent-v7.md`. All of that is plan 2. **The spec drift is not fixed until plan 2 lands** — `authorSpec` still bases every proposal on the last confirmed spec row.
