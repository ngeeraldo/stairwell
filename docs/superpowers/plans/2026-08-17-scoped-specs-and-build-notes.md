# Scoped Specs and Build Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record what each build actually shipped and why, announce it in the friend's own terms, and stop regenerating a whole dashboard spec and mockup on every request.

**Architecture:** Three parts on one branch. **A** adds `users/<slug>/notes/v<n>.md` — added never edited — parsed by an anchored parser whose friend-facing half feeds a drafted deploy announcement. **B** changes what the spec-writer is *asked for*: against a current base it emits a patch, and a pure applier produces the whole-surface version that still gets stored and still passes today's validator. **C** makes the mockup per-screen so both the drawing cost and the friend's review burden become proportional to the change.

**Tech Stack:** Next.js App Router, TypeScript, better-sqlite3-multiple-ciphers, vitest, Anthropic SDK (client always injected), bash operator scripts.

**Spec:** `docs/superpowers/specs/2026-08-17-scoped-specs-and-build-notes-design.md`

## Global Constraints

Copied verbatim from the spec and from CLAUDE.md. Every task's requirements implicitly include this section.

- **Branch.** This is platform work, not a dashboard build. Work on `scoped-specs`, never `main`. Check `git branch --show-current` before writing code. Nico creates the branch.
- **Prompts are added, never edited.** New files only: `announce-v1.md`, `spec-v3.md`, `mockup-v4.md`. Never touch `agent-v*.md`, `spec-v1.md`, `spec-v2.md`, `mockup-v1..3.md` — `prompt_sha` is stamped on rows that already exist.
- **`specs`, `transcripts`, `metrics`, `spec_confirmations` are append-only** and trigger-enforced. No UPDATE, no DELETE, no migration, no cleanup. `spec_screen_mockups` (Task 15) joins them under the same rule.
- **No new column on `specs`.** The patch rides inside `payload`, which is already TEXT.
- **`version` stays derived from row position; `based_on_version` stays server-supplied and is read at WRITE time**, immediately before `sealVersion` — never before the model call.
- **Metrics never carry user values.** New metric fields are counts and a mode name only. No panel ids, no titles, no spec content. `metricMessage()` redaction still applies to every error message written.
- **Build notes never contain the friend's data.** They are committed to the repo. Shape, never rows or values.
- **Every third-party client is injected.** `draftAnnouncement` takes a `ChatClient`. No test in the default suite reaches the network.
- **No new dependencies.** Hand-written validators in the existing `SpecShapeError` style (unified-loop D5). No zod.
- **Tests in the same commit** as the logic they cover — `lib/`, `platform/`, `app/` → a test under `tests/`. When a skip is used (`SKIP_TEST_GATE=1`, `SKIP_TYPECHECK=1`, `SKIP_TEST_RUN_GATE=1`, `SKIP_BUILD_GATE=1`), state the reason in the commit message.
- **Run tests with `npx vitest run`.** Scope with a path: `npx vitest run tests/spec`.
- **Never open, read, or query any `*.db` other than `synthetic.db`.** The guard hook denies it; a denial is the rule working.
- **Never edit `synthetic.db` directly** — regenerate with `npm run synthetic`.

**Verification command run at the end of every task:**

```bash
npx vitest run && npx tsc --noEmit
```

---

## File Structure

**Part A — build notes**

| File | Responsibility |
|---|---|
| `lib/build/notes.ts` (new) | Parse one notes file. Frontmatter + four anchored sections. Splits friend-facing from builder-only. Pure — takes text, returns a struct. |
| `platform/prompts/announce-v1.md` (new) | The drafting prompt. Prose only. |
| `lib/chat/draftAnnouncement.ts` (new) | One model call, client injected, structured output, validated. Throws on failure. |
| `lib/chat/announce.ts` (modify) | Split into `announceTarget` (what would be announced, and why not) and `commitAnnouncement` (the transactional write). `announceDeploy` keeps working, implemented on top of both. |
| `scripts/announce-deploy.ts` (modify) | `--send` / `--plain`, notes gate, `## Open` warning. |
| `platform/templates/dashboard/notes/README.md.tmpl` (new) | Scaffolded into every new folder. |
| `scripts/new-dashboard.sh` (modify) | Create `notes/`. |
| `tests/users/conventions.test.ts` (modify) | Shape check on `notes/`. |

**Part B — patch authoring**

| File | Responsibility |
|---|---|
| `lib/spec/patch.ts` (new) | Op types, `PATCH_JSON_SCHEMA`, `SpecPatchError`, `parsePatch`, `applyPatch`. The one place a patch is understood. |
| `lib/spec/validate.ts` (modify) | Export `parsePanel`/`parseScreen` for the patch parser. Preserve `ops` through `parseSpecVersion`. Reject model-authored `ops` in `parseSpecDraft`. |
| `lib/spec/schema.ts` (modify) | `SpecVersion.ops`. |
| `platform/prompts/spec-v3.md` (new) | Patch-authoring prompt. |
| `lib/spec/author.ts` (modify) | Mode selection, patch attempt loop, apply, new metric fields. |

**Part C — proportional preview**

| File | Responsibility |
|---|---|
| `platform/schema.sql` (modify) | `spec_screen_mockups` + triggers. |
| `lib/db/screenMockups.ts` (new) | Insert and read fragments. Appends and reads only, like `lib/db/specs.ts`. |
| `lib/spec/mockupCompose.ts` (new) | The document shell + CSS, `affectedScreens(patch)`, `composeMockup(screens, fragments, only?)`. |
| `platform/prompts/mockup-v4.md` (new) | Emits per-screen fragments against the fixed class list. |
| `lib/spec/author.ts` (modify) | Draw only affected screens, carry unchanged fragments forward, store both. |
| `app/[user]/ChatPanel.tsx`, `app/[user]/page.tsx` (modify) | Card renders the scoped preview. |

---

# PART A — BUILD NOTES

### Task 1: Parse a build-notes file

**Files:**
- Create: `lib/build/notes.ts`
- Test: `tests/build/notes.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BuildNotes`, `FriendFacingNotes`, `BuildNotesError`, `parseBuildNotes(text: string): BuildNotes`, `friendFacing(notes: BuildNotes): FriendFacingNotes`, `SECTION_HEADINGS`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/build/notes.test.ts
import { describe, expect, it } from 'vitest'
import { BuildNotesError, friendFacing, parseBuildNotes } from '@/lib/build/notes'

const GOOD = `---
slug: sam
version: 9
built_at: 2026-08-17
---

## What shipped
The takeaway panel now shows a weekly total.

## Built differently
Weekly rather than daily, because a daily total was almost always zero.

## Open
Nothing.

## Notes for the next build
queries.ts assumes the week starts Monday.
`

describe('parseBuildNotes', () => {
  it('reads frontmatter and all four sections', () => {
    const notes = parseBuildNotes(GOOD)
    expect(notes.slug).toBe('sam')
    expect(notes.version).toBe(9)
    expect(notes.built_at).toBe('2026-08-17')
    expect(notes.what_shipped).toBe('The takeaway panel now shows a weekly total.')
    expect(notes.built_differently).toContain('Weekly rather than daily')
    expect(notes.open).toBe('Nothing.')
    expect(notes.next_build).toContain('starts Monday')
  })

  it('allows an empty Built differently, Open, and Notes section', () => {
    const notes = parseBuildNotes(GOOD.replace('Nothing.', ''))
    expect(notes.open).toBe('')
  })

  it('throws when What shipped is empty — it is the announcement substance', () => {
    const text = GOOD.replace('The takeaway panel now shows a weekly total.', '')
    expect(() => parseBuildNotes(text)).toThrow(BuildNotesError)
  })

  it('throws on a missing section rather than defaulting it to empty', () => {
    const text = GOOD.replace('## Open\nNothing.\n\n', '')
    expect(() => parseBuildNotes(text)).toThrow(/## Open/)
  })

  // A typo'd heading would otherwise silently empty a real section.
  it('throws on an unknown heading', () => {
    const text = GOOD.replace('## Open', '## Opne')
    expect(() => parseBuildNotes(text)).toThrow(/Opne/)
  })

  it('throws on missing frontmatter', () => {
    expect(() => parseBuildNotes(GOOD.split('---\n')[2]!)).toThrow(BuildNotesError)
  })

  it('throws on a non-integer version', () => {
    expect(() => parseBuildNotes(GOOD.replace('version: 9', 'version: nine'))).toThrow(
      /version/,
    )
  })

  it('throws on a built_at that is not YYYY-MM-DD', () => {
    expect(() => parseBuildNotes(GOOD.replace('2026-08-17', '17/08/2026'))).toThrow(
      /built_at/,
    )
  })
})

describe('friendFacing', () => {
  // The structural bound the design rests on: the two builder-only sections
  // are not in the payload at all, so no prompt wording can leak them.
  it('carries What shipped and Built differently, and nothing else', () => {
    const out = friendFacing(parseBuildNotes(GOOD))
    expect(out).toEqual({
      what_shipped: 'The takeaway panel now shows a weekly total.',
      built_differently: 'Weekly rather than daily, because a daily total was almost always zero.',
    })
    expect(JSON.stringify(out)).not.toContain('Monday')
    expect(JSON.stringify(out)).not.toContain('Nothing.')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/build/notes.test.ts`
Expected: FAIL — `Cannot find module '@/lib/build/notes'`.

- [ ] **Step 3: Implement**

```ts
// lib/build/notes.ts
//
// One build's notes, parsed. Written by the builder on the version branch and
// committed with the build; added, never edited, because the announcer speaks
// from this file and an edit would change what an already-sent, permanently
// stored announcement was based on.
//
// THE SECTION SPLIT IS THE POINT. Two sections reach the friend and two do
// not, and that boundary is enforced here — by a parser — rather than by a
// line in a prompt. lib/spec/banner.ts (unified-loop D19) sets the precedent:
// a guarantee the model cannot forget beats a rule it is asked to remember.
//
// Every failure throws. transcripts rejects DELETE, so a half-parsed notes
// file that produced a partial announcement would be permanent —
// lib/chat/opening.ts refuses for exactly the same reason.

export class BuildNotesError extends Error {
  constructor(message: string) {
    super(`build notes: ${message}`)
    this.name = 'BuildNotesError'
  }
}

/** In file order. A file must carry all four, and nothing else. */
export const SECTION_HEADINGS = [
  'What shipped',
  'Built differently',
  'Open',
  'Notes for the next build',
] as const

export type BuildNotes = {
  slug: string
  version: number
  built_at: string
  /** Friend-facing. Never empty. */
  what_shipped: string
  /** Friend-facing. Empty is normal — most builds have no adjustment. */
  built_differently: string
  /** BUILDER-ONLY. A routing instruction, not a disclosure (design §3.5). */
  open: string
  /** BUILDER-ONLY. */
  next_build: string
}

/** Exactly what the drafting call is allowed to see. */
export type FriendFacingNotes = {
  what_shipped: string
  built_differently: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function frontmatter(text: string): Map<string, string> {
  const match = FRONTMATTER.exec(text)
  if (!match) throw new BuildNotesError('no --- frontmatter block at the top of the file')
  const out = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const colon = line.indexOf(':')
    if (colon === -1) throw new BuildNotesError(`frontmatter line is not "key: value": ${line}`)
    out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  return out
}

/**
 * Sections, split on level-2 headings.
 *
 * An UNKNOWN heading throws rather than being ignored. A typo — "## Opne" —
 * would otherwise leave the real section absent and read as empty, which for
 * `## Open` means an unbuilt item silently never routes back to the chat.
 */
function sections(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = body.split(/^## +(.+?) *$/m)
  // parts[0] is whatever preceded the first heading — ignored on purpose, so
  // a file may carry a title or a note above the sections.
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i]!.trim()
    if (!(SECTION_HEADINGS as readonly string[]).includes(heading)) {
      throw new BuildNotesError(
        `unknown section "## ${heading}" — expected one of: ${SECTION_HEADINGS.join(', ')}`,
      )
    }
    if (out.has(heading)) throw new BuildNotesError(`duplicate section "## ${heading}"`)
    out.set(heading, (parts[i + 1] ?? '').trim())
  }
  for (const heading of SECTION_HEADINGS) {
    if (!out.has(heading)) throw new BuildNotesError(`missing section "## ${heading}"`)
  }
  return out
}

export function parseBuildNotes(text: string): BuildNotes {
  const front = frontmatter(text)

  const slug = front.get('slug')
  if (!slug) throw new BuildNotesError('frontmatter is missing slug')

  const rawVersion = front.get('version')
  const version = Number(rawVersion)
  if (!rawVersion || !Number.isInteger(version) || version < 1) {
    throw new BuildNotesError(`frontmatter version "${rawVersion ?? ''}" is not a positive integer`)
  }

  const builtAt = front.get('built_at')
  if (!builtAt || !DATE.test(builtAt)) {
    throw new BuildNotesError(`frontmatter built_at "${builtAt ?? ''}" is not YYYY-MM-DD`)
  }

  const body = text.replace(FRONTMATTER, '')
  const found = sections(body)

  const whatShipped = found.get('What shipped')!
  // The one section that may not be empty: it is the substance of the
  // announcement, and a drafting call handed nothing would invent something.
  if (whatShipped === '') throw new BuildNotesError('"## What shipped" is empty')

  return {
    slug,
    version,
    built_at: builtAt,
    what_shipped: whatShipped,
    built_differently: found.get('Built differently')!,
    open: found.get('Open')!,
    next_build: found.get('Notes for the next build')!,
  }
}

/**
 * The ONLY thing handed to the drafting call.
 *
 * Built by naming two fields, never by deleting two from the whole object: a
 * future section added to BuildNotes must be opted IN here, not remembered
 * out. `## Open` and `## Notes for the next build` can therefore never reach
 * a friend, whatever a prompt says.
 */
export function friendFacing(notes: BuildNotes): FriendFacingNotes {
  return { what_shipped: notes.what_shipped, built_differently: notes.built_differently }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/build/notes.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Prove the friend/builder split is actually load-bearing**

Delete the `what_shipped`/`built_differently` field list in `friendFacing` and return `{ ...notes }`. Re-run. Expected: the `friendFacing` test goes red and nothing else does. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/build/notes.ts tests/build/notes.test.ts
git commit -m "Parse build notes, with the friend-facing split enforced by the parser"
```

---

### Task 2: Read a notes file off disk, keyed to slug and version

**Files:**
- Modify: `lib/build/notes.ts`
- Test: `tests/build/notes.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseBuildNotes`.
- Produces: `notesPath(slug: string, version: number, usersDir?: string): string`, `readBuildNotes(slug: string, version: number, usersDir?: string): BuildNotes`, `NotesMissingError`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to tests/build/notes.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotesMissingError, notesPath, readBuildNotes } from '@/lib/build/notes'

function tempUsers(slug: string, file: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'stairwell-notes-'))
  mkdirSync(join(root, slug, 'notes'), { recursive: true })
  writeFileSync(join(root, slug, 'notes', file), body)
  return root
}

describe('readBuildNotes', () => {
  it('reads users/<slug>/notes/v<n>.md', () => {
    const root = tempUsers('sam', 'v9.md', GOOD)
    expect(readBuildNotes('sam', 9, root).what_shipped).toContain('weekly total')
  })

  it('throws NotesMissingError naming the path it wanted', () => {
    const root = tempUsers('sam', 'v9.md', GOOD)
    expect(() => readBuildNotes('sam', 10, root)).toThrow(NotesMissingError)
    expect(() => readBuildNotes('sam', 10, root)).toThrow(/v10\.md/)
  })

  // Catches a notes file copied from another version and not re-headed.
  it('throws when frontmatter disagrees with the file it was found in', () => {
    const root = tempUsers('sam', 'v10.md', GOOD) // frontmatter says version 9
    expect(() => readBuildNotes('sam', 10, root)).toThrow(/frontmatter/)
  })

  it('throws when frontmatter names a different slug', () => {
    const root = tempUsers('kim', 'v9.md', GOOD) // frontmatter says sam
    expect(() => readBuildNotes('kim', 9, root)).toThrow(/frontmatter/)
  })

  it('builds the path from USERS_DIR when no root is passed', () => {
    expect(notesPath('sam', 9)).toMatch(/users[/\\]sam[/\\]notes[/\\]v9\.md$/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/build/notes.test.ts`
Expected: FAIL — `notesPath` is not exported.

- [ ] **Step 3: Implement**

Add to `lib/build/notes.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Absent notes are their OWN error class, not a BuildNotesError.
 *
 * scripts/announce-deploy.ts distinguishes them: a missing file means "write
 * the notes, then run this again", a malformed one means "fix the file". The
 * two need different sentences at the moment Nico is standing at a terminal
 * after a deploy.
 */
export class NotesMissingError extends Error {
  constructor(public readonly path: string) {
    super(`build notes: no file at ${path} — write it before announcing`)
    this.name = 'NotesMissingError'
  }
}

/**
 * USERS_DIR, matching the rest of the repo — it exists so tests can point at a
 * temp tree, and its default IS the correct production value, which is why
 * deploy/required-env deliberately does not list it.
 */
function usersRoot(override?: string): string {
  return override ?? process.env.USERS_DIR ?? resolve(process.cwd(), 'users')
}

export function notesPath(slug: string, version: number, usersDir?: string): string {
  return join(usersRoot(usersDir), slug, 'notes', `v${version}.md`)
}

/**
 * Read the notes for one built version.
 *
 * The frontmatter is checked AGAINST the path it was found at. A notes file is
 * the most copy-pasteable artifact in the build — the previous version's file
 * with two words changed — and a stale `version:` would make the announcement
 * describe the wrong build, permanently.
 */
export function readBuildNotes(slug: string, version: number, usersDir?: string): BuildNotes {
  const path = notesPath(slug, version, usersDir)
  if (!existsSync(path)) throw new NotesMissingError(path)

  const notes = parseBuildNotes(readFileSync(path, 'utf8'))
  if (notes.slug !== slug || notes.version !== version) {
    throw new BuildNotesError(
      `frontmatter says ${notes.slug} v${notes.version} but the file is ${path}`,
    )
  }
  return notes
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/build/notes.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add lib/build/notes.ts tests/build/notes.test.ts
git commit -m "Read build notes by slug and version, checking frontmatter against the path"
```

---

### Task 3: Scaffold `notes/`, and make the sweep check its shape

**Files:**
- Create: `platform/templates/dashboard/notes/README.md.tmpl`
- Create: `users/devone/notes/README.md`, `users/devtwo/notes/README.md`, `users/run3/notes/README.md`, `users/run4/notes/README.md`
- Modify: `scripts/new-dashboard.sh:96-110`
- Modify: `tests/users/conventions.test.ts`
- Test: `tests/users/conventions.test.ts`, `tests/scripts/newDashboard.test.ts`

**Interfaces:**
- Consumes: Task 1's `SECTION_HEADINGS` (the README quotes the template).
- Produces: a `notes/` directory in every user folder.

- [ ] **Step 1: Write the template**

```markdown
<!-- platform/templates/dashboard/notes/README.md.tmpl -->
# Build notes for __SLUG__

One file per confirmed spec version that was **built**: `v1.md`, `v2.md`, …

**Added, never edited.** `scripts/announce-deploy.ts` speaks from this file;
editing one afterwards changes what an already-sent, permanently stored
announcement was based on.

**Never put __SLUG__'s data in here.** This folder is committed to the repo.
Describe the shape of what was built — a table, a panel, a computation — never
a row, a value, or a merchant. Same bound `metrics` already carries.

Two sections reach __SLUG__ and two do not. `lib/build/notes.ts` enforces that
split; nothing you write in the wrong section gets rescued by a prompt.

```markdown
---
slug: __SLUG__
version: 1
built_at: YYYY-MM-DD
---

## What shipped
Product-level. What __SLUG__ can now see or do that they could not before.
FRIEND-FACING. Must not be empty.

## Built differently
In-spirit adjustments: where the build's shape differs from how the spec
described it, and why it works better this way. FRIEND-FACING. Empty is
normal and correct — most builds have no adjustment worth mentioning.

## Open
Anything in the confirmed spec that did NOT land. BUILDER-ONLY, and a routing
instruction rather than a disclosure: it never reaches __SLUG__. Take it back
to the chat — `scripts/ask-user.ts` for a decision only they can make, a new
proposal for anything that cannot be built as agreed. `announce-deploy.ts`
warns you when this section is non-empty.

## Notes for the next build
Technical residue: what is fragile, why a structure is the way it is, what a
future version should not assume. BUILDER-ONLY.
```
```

- [ ] **Step 2: Create the four existing folders' READMEs**

Copy the template into each, substituting the slug. These hold the **convention**, not a record: no notes are backfilled for builds that predate this, because inventing one would be fabricating a record.

```bash
for slug in devone devtwo run3 run4; do
  mkdir -p "users/$slug/notes"
  sed "s/__SLUG__/$slug/g" platform/templates/dashboard/notes/README.md.tmpl \
    > "users/$slug/notes/README.md"
done
```

- [ ] **Step 3: Write the failing sweep test**

Add inside the `describe.each(slugs)` block in `tests/users/conventions.test.ts`, after the existing `has a migrations/README.md…` test:

```ts
    whenComplete('has a notes/ directory', () => {
      // Required on every complete folder, including scaffolded ones — the
      // directory is the convention, and it must exist before the first build
      // finishes so there is somewhere obvious to write v1.md.
      expect(existsSync(join(dir, 'notes'))).toBe(true)
    })

    whenComplete('has nothing in notes/ but README.md and v<n>.md files', () => {
      // Shape, NOT presence. This sweep cannot know which versions were built —
      // that lives in the platform database, not in this folder — so demanding
      // "at least one note" would be a false failure on devone (hand-written,
      // never had a spec) and on every folder built before this convention.
      // Presence is enforced where the version number is actually known:
      // scripts/announce-deploy.ts.
      const strays = readdirSync(join(dir, 'notes')).filter(
        (f) => f !== 'README.md' && !/^v\d+\.md$/.test(f),
      )
      expect(strays, `unexpected files in notes/: ${strays.join(', ')}`).toHaveLength(0)
    })

    whenComplete('every note in notes/ parses', () => {
      for (const f of readdirSync(join(dir, 'notes')).filter((f) => /^v\d+\.md$/.test(f))) {
        const version = Number(/^v(\d+)\.md$/.exec(f)![1])
        expect(() => readBuildNotes(slug, version, USERS)).not.toThrow()
      }
    })
```

Add the import at the top of the file:

```ts
import { readBuildNotes } from '@/lib/build/notes'
```

- [ ] **Step 4: Run and watch the notes tests fail, then pass**

Run: `npx vitest run tests/users/conventions.test.ts`
Expected before Step 2's directories exist: FAIL on `has a notes/ directory`. After: PASS.

- [ ] **Step 5: Teach the scaffold to create it**

In `scripts/new-dashboard.sh`, change the `mkdir -p` line and add the README copy beside the migrations one:

```bash
  mkdir -p "$dest/tests" "$dest/migrations" "$dest/notes"
```

```bash
  sed "s/__SLUG__/$slug/g" "$src/notes/README.md.tmpl" \
    > "$dest/notes/README.md"
```

- [ ] **Step 6: Test the scaffold**

Add to `tests/scripts/newDashboard.test.ts`, following the existing scaffold-output assertions in that file:

```ts
  it('scaffolds a notes/ directory with its README', () => {
    // <dir> is the temp scaffold this file's existing helper produces.
    expect(existsSync(join(dir, 'notes', 'README.md'))).toBe(true)
    expect(readFileSync(join(dir, 'notes', 'README.md'), 'utf8')).toContain(
      'Added, never edited',
    )
  })
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run tests/users tests/scripts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 8: Commit**

```bash
git add platform/templates/dashboard/notes users/*/notes scripts/new-dashboard.sh \
        tests/users/conventions.test.ts tests/scripts/newDashboard.test.ts
git commit -m "Scaffold users/<slug>/notes/ and sweep its shape"
```

---

### Task 4: The announcement drafting prompt

**Files:**
- Create: `platform/prompts/announce-v1.md`
- Modify: `lib/chat/prompt.ts:51`
- Test: `tests/chat/prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ANNOUNCE_PROMPT = 'announce-v1.md'` exported from `lib/chat/prompt.ts`.

- [ ] **Step 1: Write the prompt**

```markdown
<!-- platform/prompts/announce-v1.md -->
You are writing one short message telling someone their dashboard was just
rebuilt. It is posted into their ongoing chat with the agent they have been
talking to, and it is the first thing they read about this build.

## What you are given

- **What shipped** and **Built differently** — notes from the person who built
  it, written for you, not for them.
- **The change summary** from the version they confirmed — what they asked for,
  in their own words.
- **The last part of their conversation** — so you can leave out what they
  already know.

## What you write

One message. Two or three sentences at most. Their vocabulary, not the
builder's.

**Lead with the news.** They asked for something; it is there now. Say that
first, in the terms they used when they asked.

**Then, only if there is something worth saying, the adjustment.** "Built
differently" means the thing they asked for was built in a shape that works
better. Frame it as what it is — how the thing works — never as a shortfall,
an apology, or a compromise. "It totals by week rather than by day, which
makes the number mean something on a quiet Tuesday" is right. "We couldn't do
it daily" is wrong, and is also not what the note says.

**Saying nothing extra is a complete answer.** Most builds have no adjustment
worth mentioning. When "Built differently" is empty, or says something only a
builder would care about, write the first sentence and stop. Never invent an
adjustment to have a second sentence. An empty section is a real, complete
answer — never pad it.

**Do not repeat what they already know.** They confirmed this design and read a
preview of it. They do not need the dashboard described back to them.

## What you never write

- Anything technical: no table, column, query, migration, route, file, or
  framework. They do not know this software has any of those and do not need to.
- Anything that reads as bad news, a limitation, or an apology.
- A promise about anything future — what comes next, what might be possible,
  when. You do not know, and a promise here is one somebody else has to keep.
- A question. This is an announcement; the conversation continues on its own.
- A greeting, a sign-off, or their name.

## Tone

Warm and direct, like a message from the person who built it — because it is.
Short. No enthusiasm they have not earned.
```

- [ ] **Step 2: Export the name**

In `lib/chat/prompt.ts`, after `MOCKUP_PROMPT`:

```ts
/**
 * The deploy-announcement prompt. Turns one build's friend-facing notes into
 * the sentence that lands in their chat.
 *
 * A drafted announcement is the first GENERATED text this system writes into
 * an append-only transcript, which is why scripts/announce-deploy.ts drafts by
 * default and only sends on --send.
 */
export const ANNOUNCE_PROMPT = 'announce-v1.md'
```

- [ ] **Step 3: Test it loads and hashes**

Add to `tests/chat/prompt.test.ts`:

```ts
  it('loads the announce prompt and hashes it', () => {
    const loaded = loadPrompt(ANNOUNCE_PROMPT)
    expect(loaded.text).toContain('Saying nothing extra is a complete answer')
    expect(loaded.sha).toHaveLength(12)
  })
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/chat/prompt.test.ts && npx tsc --noEmit`
Expected: PASS, clean. Gate B is satisfied by the test; `platform/prompts/*` is Gate-B exempt but `lib/chat/prompt.ts` is not.

- [ ] **Step 5: Commit**

```bash
git add platform/prompts/announce-v1.md lib/chat/prompt.ts tests/chat/prompt.test.ts
git commit -m "Add announce-v1.md, the deploy-announcement drafting prompt"
```

---

### Task 5: Draft an announcement from notes

**Files:**
- Create: `lib/chat/draftAnnouncement.ts`
- Test: `tests/chat/draftAnnouncement.test.ts`

**Interfaces:**
- Consumes: `FriendFacingNotes` (Task 1), `ANNOUNCE_PROMPT` (Task 4), `ChatClient`/`ProposeResult`/`Usage`/`Served` from `lib/chat/client.ts`, `ChatMessage` from `lib/chat/history.ts`.
- Produces: `ANNOUNCE_JSON_SCHEMA`, `MAX_ANNOUNCEMENT_CHARS`, `draftAnnouncement(deps: { client: ChatClient }, input: DraftInput): Promise<DraftResult>`, `DraftResult = { message: string; usage: Usage; served: Served; promptSha: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/chat/draftAnnouncement.test.ts
import { describe, expect, it, vi } from 'vitest'
import { draftAnnouncement, MAX_ANNOUNCEMENT_CHARS } from '@/lib/chat/draftAnnouncement'
import type { ChatClient } from '@/lib/chat/client'

const NOTES = {
  what_shipped: 'The takeaway panel now shows a weekly total.',
  built_differently: 'Weekly rather than daily.',
}

function clientReturning(input: unknown): ChatClient {
  return {
    stream: vi.fn(),
    propose: vi.fn(async () => ({
      input,
      usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
      stop_reason: 'end_turn',
      served: { model_served: 'claude-opus-5', fallback_fired: false },
    })),
  } as unknown as ChatClient
}

const INPUT = {
  notes: NOTES,
  changeSummary: 'Added a takeaway panel.',
  recent: [{ role: 'user' as const, content: 'can I see takeaway spend?' }],
  signal: new AbortController().signal,
}

describe('draftAnnouncement', () => {
  it('returns the drafted message with its usage and prompt sha', async () => {
    const client = clientReturning({ message: 'Your takeaway total is up now.' })
    const result = await draftAnnouncement({ client }, INPUT)
    expect(result.message).toBe('Your takeaway total is up now.')
    expect(result.usage.output).toBe(20)
    expect(result.promptSha).toHaveLength(12)
  })

  // The structural bound from lib/build/notes.ts, asserted at the boundary
  // that actually sends bytes to a model.
  it('sends only the friend-facing notes', async () => {
    const client = clientReturning({ message: 'ok' })
    await draftAnnouncement({ client }, INPUT)
    const sent = JSON.stringify((client.propose as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(sent).toContain('weekly total')
    expect(sent).not.toContain('Monday')
  })

  it('throws on an empty message rather than returning a blank body', async () => {
    const client = clientReturning({ message: '   ' })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow(/empty/)
  })

  it('throws on a message longer than the ceiling', async () => {
    const client = clientReturning({ message: 'x'.repeat(MAX_ANNOUNCEMENT_CHARS + 1) })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow(/too long/)
  })

  it('throws when the reply is not the expected shape', async () => {
    const client = clientReturning({ text: 'wrong key' })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/chat/draftAnnouncement.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/chat/draftAnnouncement.ts
//
// One model call: a build's friend-facing notes in, the sentence that lands in
// their chat out.
//
// It THROWS on every failure and writes nothing. The caller
// (scripts/announce-deploy.ts) decides what to do — refuse, or fall back to the
// fixed sentence under --plain. A silent fallback inside here would produce a
// normal-looking announcement that never read the notes, which is the failure
// nobody would notice.
//
// The client is a parameter, like lib/chat/turn.ts's (CLAUDE.md > Testing).
import type { FriendFacingNotes } from '@/lib/build/notes'
import type { ChatClient, Served, Usage } from './client'
import { CHAT_MODEL } from './client'
import type { ChatMessage } from './history'
import { ANNOUNCE_PROMPT, loadPrompt } from './prompt'

/**
 * A ceiling on the body, not a target. The message goes into an append-only
 * transcript and is read on a phone; a drafting call that returns an essay has
 * misunderstood the job, and a permanent essay is worse than a refusal Nico
 * sees at a terminal and re-runs.
 */
export const MAX_ANNOUNCEMENT_CHARS = 600

/**
 * One field, so the reply cannot arrive wrapped in prose or a markdown fence —
 * the same reasoning as MOCKUP_JSON_SCHEMA. This body is written verbatim into
 * a transcript that rejects DELETE.
 */
export const ANNOUNCE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const

export type DraftInput = {
  notes: FriendFacingNotes
  /** The confirmed version's change_summary — what they asked for. */
  changeSummary: string
  /** The tail of their conversation, so the draft can omit what they know. */
  recent: ChatMessage[]
  signal: AbortSignal
}

export type DraftResult = {
  message: string
  usage: Usage
  served: Served
  /** announce-v1.md's hash, stamped on the transcript row. */
  promptSha: string
}

export class AnnouncementDraftError extends Error {
  constructor(message: string) {
    super(`announcement draft: ${message}`)
    this.name = 'AnnouncementDraftError'
  }
}

/**
 * The notes go in as JSON under an explicit label rather than being pasted in
 * as prose. `built_differently` is routinely EMPTY, and an empty string in a
 * prose block reads as a heading with nothing under it — which is exactly the
 * shape that invites a model to fill it. An explicit `""` is a stated fact.
 */
function userContent(input: DraftInput): string {
  return (
    'The version they confirmed, in their words:\n\n' +
    `${input.changeSummary}\n\n` +
    "The builder's notes on what actually shipped:\n\n" +
    `${JSON.stringify(input.notes, null, 2)}\n\n` +
    'Write the message now.'
  )
}

export async function draftAnnouncement(
  deps: { client: ChatClient },
  input: DraftInput,
): Promise<DraftResult> {
  const prompt = loadPrompt(ANNOUNCE_PROMPT)

  const result = await deps.client.propose({
    system: prompt.text,
    // The recent conversation FIRST, so the draft can tell what they already
    // know; the notes last, as the thing to act on. A trailing user message is
    // also what the API wants to answer.
    messages: [...input.recent, { role: 'user', content: userContent(input) }],
    signal: input.signal,
    schema: ANNOUNCE_JSON_SCHEMA,
  })

  const raw = result.input
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AnnouncementDraftError('reply is not an object')
  }
  const message = (raw as { message?: unknown }).message
  if (typeof message !== 'string') {
    throw new AnnouncementDraftError('reply has no message string')
  }

  const trimmed = message.trim()
  // lib/chat/announce.ts refuses a blank body because ONE such row 400s every
  // later turn for that account, forever. Catching it here means the refusal
  // happens before anything is written rather than inside the transaction.
  if (trimmed === '') throw new AnnouncementDraftError('message is empty')
  if (trimmed.length > MAX_ANNOUNCEMENT_CHARS) {
    throw new AnnouncementDraftError(
      `message is too long (${trimmed.length} chars, ceiling ${MAX_ANNOUNCEMENT_CHARS})`,
    )
  }

  return {
    message: trimmed,
    usage: result.usage,
    served: result.served ?? { model_served: CHAT_MODEL, fallback_fired: false },
    promptSha: prompt.sha,
  }
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/chat/draftAnnouncement.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/draftAnnouncement.ts tests/chat/draftAnnouncement.test.ts
git commit -m "Draft a deploy announcement from a build's friend-facing notes"
```

---

### Task 6: Split announce into decide / commit, and carry a real prompt_sha

**Files:**
- Modify: `lib/chat/announce.ts`
- Test: `tests/chat/announce.test.ts`

**Interfaces:**
- Consumes: `currentSpec`, `hasConfirmedSpecBelow`, `readStoredSpec`, `findAccountBySlug` — all already imported there.
- Produces: `announceTarget(db, slug): AnnounceTarget`, `commitAnnouncement(db, input): void`, `plainBody(headline: string, first: boolean): string`. `announce()` gains an optional `promptSha`. `announceDeploy()` keeps its exact current signature and behaviour.

- [ ] **Step 1: Write the failing tests**

```ts
// add to tests/chat/announce.test.ts, alongside the existing announceDeploy tests
import { announceTarget, commitAnnouncement, plainBody } from '@/lib/chat/announce'

describe('announceTarget', () => {
  it('reports no_confirmed_spec when nothing is confirmed', () => {
    // <db>, <slug> from this file's existing fixture helpers.
    expect(announceTarget(db, 'devtwo')).toEqual({
      ok: false,
      reason: 'no_confirmed_spec',
    })
  })

  it('returns the headline, version and first-ness of the confirmed spec', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'Added a takeaway panel.' })
    const target = announceTarget(db, 'devtwo')
    expect(target.ok).toBe(true)
    if (!target.ok) return
    expect(target.headline).toBe('Added a takeaway panel.')
    expect(target.version).toBe(1)
    expect(target.first).toBe(true)
  })

  it('reports already_announced after a commit', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    commitAnnouncement(db, { ...target, body: 'hello', promptSha: 'abc123abc123', at: 5 })
    expect(announceTarget(db, 'devtwo')).toEqual({
      ok: false,
      reason: 'already_announced',
    })
  })
})

describe('commitAnnouncement', () => {
  it('stamps the drafting prompt sha, not the operator sentinel', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    commitAnnouncement(db, { ...target, body: 'hello', promptSha: 'deadbeef1234', at: 5 })
    const row = db
      .prepare(`SELECT prompt_sha, session_id FROM transcripts ORDER BY id DESC LIMIT 1`)
      .get() as { prompt_sha: string; session_id: string }
    // A drafted sentence was produced by a prompt, so the row names it.
    expect(row.prompt_sha).toBe('deadbeef1234')
    // There is still no session — that sentinel keeps meaning what it says.
    expect(row.session_id).toBe('operator')
  })

  it('refuses a blank body', () => {
    confirmAVersion(db, 'devtwo', { change_summary: 'x' })
    const target = announceTarget(db, 'devtwo')
    if (!target.ok) throw new Error('expected a target')
    expect(() =>
      commitAnnouncement(db, { ...target, body: '  ', promptSha: 'a'.repeat(12), at: 5 }),
    ).toThrow()
  })
})

describe('plainBody', () => {
  it('keeps both fixed sentences verbatim', () => {
    expect(plainBody('X', true)).toBe('Your dashboard is live: X')
    expect(plainBody('X', false)).toBe('Your dashboard was just rebuilt: X')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/chat/announce.test.ts`
Expected: FAIL — `announceTarget` is not exported.

- [ ] **Step 3: Refactor `lib/chat/announce.ts`**

Give `announce()` an optional prompt sha:

```ts
export function announce(
  db: PlatformDb,
  input: { accountId: number; body: string; at: number; promptSha?: string },
): void {
```

and inside the `appendTranscript` call replace `promptSha: OPERATOR_SHA` with:

```ts
    // OPERATOR_SHA means "a human typed this and no prompt produced it".
    // A DRAFTED announcement did have a prompt behind it, so it names that
    // prompt's hash and the sentinel keeps meaning what it says. session_id
    // stays the sentinel either way — there genuinely is no session.
    promptSha: input.promptSha ?? OPERATOR_SHA,
```

Add the three new exports and rewrite `announceDeploy` on top of them:

```ts
/** What an announcement would be about, or why there is nothing to say. */
export type AnnounceTarget =
  | {
      ok: true
      accountId: number
      specId: number
      version: number
      /** The confirmed version's change_summary, or a legacy row's title. */
      headline: string
      /** Whether this is the account's first dashboard (ledger D9). */
      first: boolean
    }
  | { ok: false; reason: 'no_confirmed_spec' | 'already_announced' }

/**
 * Decide, without writing anything and without spending a model call.
 *
 * Split out from announceDeploy so scripts/announce-deploy.ts can answer
 * "is there anything to announce?" BEFORE paying to draft a sentence — and so
 * its dry run can print a draft while writing neither the transcript row nor
 * the deploy_announced metric that would make the real send a no-op.
 */
export function announceTarget(db: PlatformDb, slug: string): AnnounceTarget {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  if (!spec) return { ok: false, reason: 'no_confirmed_spec' }
  if (alreadyAnnounced(db, account.id, spec.id)) {
    return { ok: false, reason: 'already_announced' }
  }

  // The renderer's own discriminator, reused rather than re-implemented: a
  // legacy row has no change_summary field at all.
  const stored = readStoredSpec(spec.payload)
  const headline =
    stored.kind === 'version' ? stored.version.change_summary : stored.payload.title

  return {
    ok: true,
    accountId: account.id,
    specId: spec.id,
    version: spec.version,
    headline,
    first: !hasConfirmedSpecBelow(db, account.id, spec.version),
  }
}

/**
 * The two fixed sentences, unchanged and still fixed chrome.
 *
 * "Rebuilt" is false on the one morning it matters most: a first build had
 * nothing to rebuild. Bounded by hasConfirmedSpecBelow, the same question and
 * the same helper the delivery promise on the card uses (ledger D9), so the
 * sentence that promised the build and the sentence announcing it cannot
 * disagree about which one this was.
 */
export function plainBody(headline: string, first: boolean): string {
  return first
    ? `Your dashboard is live: ${headline}`
    : `Your dashboard was just rebuilt: ${headline}`
}

/**
 * Write the announcement and its guard row, together or not at all.
 *
 * The transaction is the whole idempotency guarantee: two independent INSERTs
 * would leave the failure open where the transcript commits and the metric
 * does not, so the next run sees "not yet announced" and posts a second,
 * permanent duplicate into a table that rejects DELETE.
 */
export function commitAnnouncement(
  db: PlatformDb,
  input: {
    accountId: number
    specId: number
    version: number
    body: string
    /** announce-v1.md's hash, or OPERATOR_SHA for the --plain path. */
    promptSha: string
    at: number
  },
): void {
  db.transaction(() => {
    announce(db, {
      accountId: input.accountId,
      body: input.body,
      at: input.at,
      promptSha: input.promptSha,
    })
    appendMetric(db, {
      accountId: input.accountId,
      event: 'deploy_announced',
      at: input.at,
      data: { spec_id: input.specId, version: input.version },
    })
  })()
}

/**
 * The fixed-sentence path, unchanged in behaviour and still the --plain valve.
 * Now expressed in terms of the two functions above rather than duplicating
 * them, so there is one place that decides and one place that writes.
 */
export function announceDeploy(
  db: PlatformDb,
  slug: string,
  now: () => number,
): AnnounceDeployResult {
  const target = announceTarget(db, slug)
  if (!target.ok) return { announced: false, reason: target.reason }

  commitAnnouncement(db, {
    ...target,
    body: plainBody(target.headline, target.first),
    promptSha: OPERATOR_SHA,
    at: now(),
  })
  return { announced: true }
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean. The existing `announceDeploy` tests must pass **unchanged** — that is the refactor's own control.

- [ ] **Step 5: Prove the transaction test still bites**

Temporarily replace `db.transaction(() => { … })()` in `commitAnnouncement` with two bare calls. Re-run `npx vitest run tests/chat/announce.test.ts`. If nothing goes red, that is unified-loop residual 3 (the atomicity is proven by inspection, not by a test) — note it and restore. Do **not** write a new fault-injection test here; it is out of scope for this branch.

- [ ] **Step 6: Commit**

```bash
git add lib/chat/announce.ts tests/chat/announce.test.ts
git commit -m "Split announce into decide and commit; carry the drafting prompt sha"
```

---

### Task 7: `announce-deploy.ts` drafts, warns, and only sends on --send

**Files:**
- Modify: `scripts/announce-deploy.ts`
- Modify: `deploy/required-env` (comment only)
- Test: `tests/scripts/announceDeploy.test.ts` (new)

**Interfaces:**
- Consumes: `announceTarget`, `commitAnnouncement`, `plainBody` (Task 6), `readBuildNotes`, `friendFacing`, `NotesMissingError` (Tasks 1–2), `draftAnnouncement` (Task 5).
- Produces: `runAnnounce(deps, opts): Promise<AnnounceOutcome>` — an exported, testable function; the CLI wrapper only parses argv and prints.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scripts/announceDeploy.test.ts
import { describe, expect, it, vi } from 'vitest'
import { runAnnounce } from '@/scripts/announce-deploy'

// Fixtures: this file builds a synthetic platform db with one confirmed spec
// and a temp USERS_DIR holding users/sam/notes/v1.md, using the same helpers
// tests/chat/announce.test.ts uses.

describe('runAnnounce', () => {
  it('refuses when the notes file is missing, naming the path', async () => {
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('notes_missing')
    expect(out.message).toMatch(/v1\.md/)
    expect(transcriptCount(db)).toBe(0)
  })

  it('drafts and prints without writing, by default', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce(deps, { slug: 'sam', send: false, plain: false })
    expect(out.kind).toBe('drafted')
    expect(out.body).toBe('Your takeaway total is up now.')
    // The dry run must write NEITHER, or the real send becomes a no-op.
    expect(transcriptCount(db)).toBe(0)
    expect(metricCount(db, 'deploy_announced')).toBe(0)
  })

  it('sends on --send', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('announced')
    expect(transcriptCount(db)).toBe(1)
  })

  it('warns when ## Open is non-empty, and still announces', async () => {
    writeNotes('sam', 1, { open: 'The investment tile needs a connection.' })
    const out = await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('announced')
    expect(out.warnings.join(' ')).toMatch(/Open/)
    // Builder-only: it warns Nico and never reaches the friend.
    expect(lastTranscriptBody(db)).not.toContain('investment')
  })

  it('--plain sends the fixed sentence and makes no model call', async () => {
    writeNotes('sam', 1)
    const client = failingClient()
    const out = await runAnnounce({ ...deps, client }, { slug: 'sam', send: true, plain: true })
    expect(out.kind).toBe('announced')
    expect(lastTranscriptBody(db)).toMatch(/^Your dashboard is live: /)
    expect(client.propose).not.toHaveBeenCalled()
  })

  it('refuses rather than silently falling back when drafting fails', async () => {
    writeNotes('sam', 1)
    const out = await runAnnounce({ ...deps, client: failingClient() }, {
      slug: 'sam', send: true, plain: false,
    })
    expect(out.kind).toBe('draft_failed')
    expect(transcriptCount(db)).toBe(0)
  })

  it('reports already_announced without drafting again', async () => {
    writeNotes('sam', 1)
    await runAnnounce(deps, { slug: 'sam', send: true, plain: false })
    const client = failingClient()
    const out = await runAnnounce({ ...deps, client }, { slug: 'sam', send: true, plain: false })
    expect(out.kind).toBe('already_announced')
    expect(client.propose).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/scripts/announceDeploy.test.ts`
Expected: FAIL — `runAnnounce` is not exported.

- [ ] **Step 3: Implement**

Rewrite `scripts/announce-deploy.ts`, keeping its existing header comment and adding:

```ts
import { readTranscript } from '@/lib/db/appendOnly'
import { toMessages } from '@/lib/chat/history'
import { friendFacing, NotesMissingError, readBuildNotes } from '@/lib/build/notes'
import { announceTarget, commitAnnouncement, plainBody, OPERATOR_SHA } from '@/lib/chat/announce'
import { draftAnnouncement } from '@/lib/chat/draftAnnouncement'
import { anthropicClient } from '@/lib/chat/client'

/** How much conversation the drafter sees, so it can omit what they know. */
const RECENT_TURNS = 12

export type AnnounceOutcome = {
  kind:
    | 'announced'
    | 'drafted'
    | 'already_announced'
    | 'no_confirmed_spec'
    | 'notes_missing'
    | 'notes_invalid'
    | 'draft_failed'
  message: string
  body?: string
  warnings: string[]
}

export type AnnounceDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  usersDir?: string
}

/**
 * The whole command, as a function, so every branch is testable without a
 * subprocess. The CLI below parses argv and prints; it holds no logic.
 *
 * ORDER MATTERS. The target is resolved FIRST: an already-announced version
 * must not pay for a drafting call, and a missing notes file must refuse
 * before one too.
 */
export async function runAnnounce(
  deps: AnnounceDeps,
  opts: { slug: string; send: boolean; plain: boolean },
): Promise<AnnounceOutcome> {
  const warnings: string[] = []
  const target = announceTarget(deps.db, opts.slug)
  if (!target.ok) {
    return {
      kind: target.reason,
      message:
        target.reason === 'already_announced'
          ? `v? already announced to '${opts.slug}' — nothing to do`
          : `no confirmed spec for '${opts.slug}'`,
      warnings,
    }
  }

  let body: string
  let promptSha = OPERATOR_SHA

  if (opts.plain) {
    // The valve. No notes read, no model call: this exists for the moment the
    // API is down and the announcement still has to go out.
    body = plainBody(target.headline, target.first)
  } else {
    let notes
    try {
      notes = readBuildNotes(opts.slug, target.version, deps.usersDir)
    } catch (error) {
      if (error instanceof NotesMissingError) {
        return { kind: 'notes_missing', message: error.message, warnings }
      }
      return {
        kind: 'notes_invalid',
        message: error instanceof Error ? error.message : String(error),
        warnings,
      }
    }

    // A ROUTING INSTRUCTION, NOT A DISCLOSURE (design §3.5). Nico is told, at
    // the one moment he is already looking, that a conversation is owed. It
    // never blocks: what landed should be announced, what did not land needs a
    // chat, and neither should hold up the other.
    if (notes.open.trim() !== '') {
      warnings.push(
        `notes v${target.version} has a non-empty "## Open" — take it back to ` +
          `${opts.slug}'s chat (scripts/ask-user.ts, or a new proposal). It is ` +
          `NOT in this announcement.`,
      )
    }

    try {
      const history = toMessages(readTranscript(deps.db, target.accountId))
      const draft = await draftAnnouncement(
        { client: deps.client },
        {
          notes: friendFacing(notes),
          changeSummary: target.headline,
          recent: history.slice(-RECENT_TURNS),
          signal: new AbortController().signal,
        },
      )
      body = draft.message
      promptSha = draft.promptSha
    } catch (error) {
      // REFUSE, never fall back. A quiet fallback would produce a normal-looking
      // announcement that never read the notes — the failure nobody notices.
      // --plain is the deliberate, named way to send the fixed sentence.
      return {
        kind: 'draft_failed',
        message:
          (error instanceof Error ? error.message : String(error)) +
          '\nRe-run when it is back, or use --plain to send the fixed sentence.',
        warnings,
      }
    }
  }

  if (!opts.send) {
    return {
      kind: 'drafted',
      message: `DRY RUN — nothing written. Re-run with --send to post it.`,
      body,
      warnings,
    }
  }

  commitAnnouncement(deps.db, { ...target, body, promptSha, at: deps.now() })
  return { kind: 'announced', message: `announced v${target.version} to '${opts.slug}'`, body, warnings }
}
```

Then the CLI wrapper:

```ts
if (process.argv[1]?.endsWith('announce-deploy.ts')) {
  const args = process.argv.slice(2)
  const slug = args.find((a) => !a.startsWith('--'))
  const send = args.includes('--send')
  const plain = args.includes('--plain')
  if (!slug) {
    console.error('usage: tsx scripts/announce-deploy.ts <slug> [--send] [--plain]')
    process.exit(2)
  }
  const db = openPlatformDb(process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db')
  try {
    const out = await runAnnounce(
      { db, client: anthropicClient(), now: Date.now },
      { slug, send, plain },
    )
    for (const w of out.warnings) console.error(`warning: ${w}`)
    if (out.body) console.log(`\n${out.body}\n`)
    console.log(out.message)
    // A refusal must not exit 0. Nico is reading a terminal after a deploy and
    // a green exit on "notes missing" is the one that gets skimmed past.
    const failed = ['notes_missing', 'notes_invalid', 'draft_failed', 'no_confirmed_spec']
    if (failed.includes(out.kind)) process.exit(1)
  } finally {
    db.close()
  }
}
```

> If `lib/chat/client.ts` does not export a zero-argument constructor for the real client, use whatever factory `app/api/chat/route.ts` already uses, and name it in the import — do not construct an `Anthropic` instance here.

- [ ] **Step 4: Amend the required-env comment**

In `deploy/required-env`, extend `ANTHROPIC_API_KEY`'s purpose text — the **name** is already listed and the severity does not change:

```
ANTHROPIC_API_KEY  DEGRADED  # Read by @anthropic-ai/sdk. Absent, POST /api/chat returns 503 and logs a chat_error, and scripts/announce-deploy.ts refuses to draft (use --plain to send the fixed sentence); the rest of the site is unaffected.
```

- [ ] **Step 5: Run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add scripts/announce-deploy.ts tests/scripts/announceDeploy.test.ts deploy/required-env
git commit -m "Draft the deploy announcement from notes; dry-run by default, --plain as the valve"
```

---

### Task 8: Document Part A

**Files:**
- Modify: `CLAUDE.md` (Data safety; Dashboard folder conventions; Onboarding)
- Modify: `docs/runbook.md` (step 7, step 9, Standing rules)
- Modify: `docs/dashboard-build-rules.md` (index line)

**Interfaces:** none — documentation only, Gate B exempt by path.

- [ ] **Step 1: CLAUDE.md — Data safety**

Add after the metrics-never-carry-user-values bullet:

```markdown
- **Build notes never carry user values either.** `users/<slug>/notes/v<n>.md`
  is committed to the repo and describes the SHAPE of what was built — a table,
  a panel, a computation — never a row, a value, or a merchant. Same bound as
  `metrics`, applied to a second artifact.
```

- [ ] **Step 2: CLAUDE.md — Dashboard folder conventions**

Add a sixth entry to the required-entries list:

```markdown
  - `notes/` — `README.md`, plus `v<n>.md` for every confirmed version that was
    BUILT. **Added, never edited**, for the same reason prompts are:
    `scripts/announce-deploy.ts` speaks from this file, so an edit changes what
    an already-sent, permanently-stored announcement was based on. Four fixed
    sections; `lib/build/notes.ts` parses them and **two of the four never
    reach the friend** — `## Open` and `## Notes for the next build` are
    builder-only, enforced by the parser rather than by prompt wording.
    `tests/users/conventions.test.ts` checks the folder's SHAPE (no strays,
    every note parses) and deliberately not its presence: the sweep cannot know
    which versions were built. Presence is enforced by `announce-deploy.ts`,
    which refuses to announce v`n` without `notes/v<n>.md`.
```

- [ ] **Step 3: CLAUDE.md — Onboarding**

Add to the bullet list:

```markdown
- **A build that could not deliver something goes back to the chat, never into
  the announcement.** The announcement is an update, not a disclosure: what
  shipped, and any in-spirit adjustment that makes it work better. Anything in
  the confirmed spec that did NOT land goes in `## Open`, which the friend
  never sees, and routes back through `scripts/ask-user.ts` or a new proposal.
  `announce-deploy.ts` warns when that section is non-empty.
```

- [ ] **Step 4: runbook step 7 — writing the notes**

Add at the end of Step 7, before Step 8:

```markdown
### Write the build notes

Before you ship, write `users/$FRIEND/notes/v$V.md`. `notes/README.md` in their
folder holds the template and says which sections the friend sees.

It is the only record of what actually shipped and why — `spec.md` is
overwritten by the next pull and records what was *asked for*. Step 9 speaks
from this file and refuses without it.

Never put their data in it. It is committed to the repo.
```

- [ ] **Step 5: runbook step 9 — draft, read, send**

Replace the single command in Step 9 with:

```markdown
```bash
# 1. Draft it and read it. Writes nothing.
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND"

# 2. Happy with it? Send it.
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND --send"
```

The draft is written from `notes/v$V.md` — what shipped, plus any in-spirit
adjustment worth mentioning — and from what they have already been told, so it
does not repeat the preview back at them. **Read it before sending.**
`transcripts` rejects DELETE; this is the first generated sentence this system
puts in there, and a bad one is permanent.

It refuses, loudly and with exit 1, if `notes/v$V.md` is missing or malformed.
If it warns that `## Open` is non-empty, the announcement is still correct —
but you owe them a chat about the part that did not land, via
`scripts/ask-user.ts` (step 4) or a new proposal.

If the API is down and the announcement has to go out now:

```bash
ssh "$DROPLET" "$STAIRWELL && npx tsx scripts/announce-deploy.ts $FRIEND --send --plain"
```

`--plain` sends the old fixed sentence and makes no model call. It is the only
sanctioned way to announce without reading the notes.
```

- [ ] **Step 6: runbook Standing rules**

Add a row:

```markdown
| Write `notes/v<n>.md` before announcing, and never edit one afterwards | It is the only record of what shipped, and step 9 speaks from it. An edited note changes what an already-sent, permanent announcement was based on. |
| Read the drafted announcement before `--send` | `transcripts` rejects DELETE. It is the first generated sentence this system writes into it. |
```

- [ ] **Step 7: dashboard-build-rules.md**

Add one line to the index, with its citation, matching the file's existing format:

```markdown
- Every built version gets `users/<slug>/notes/v<n>.md`, added never edited;
  two of its four sections never reach the friend.
  — CLAUDE.md > Dashboard folder conventions; docs/runbook.md step 7
```

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs/runbook.md docs/dashboard-build-rules.md
git commit -m "Document build notes: the artifact, the split, and the announce flow"
```

---

# PART B — SCOPED SPEC AUTHORING

### Task 9: Patch types, schema, and parser

**Files:**
- Create: `lib/spec/patch.ts`
- Modify: `lib/spec/validate.ts` (export `parsePanel`, `parseScreen`)
- Test: `tests/spec/patch.test.ts`

**Interfaces:**
- Consumes: `Panel`, `Screen`, `SpecShapeError` from `lib/spec/schema.ts`; `parsePanel`, `parseScreen` newly exported from `lib/spec/validate.ts`.
- Produces: `SpecPatchOp` (8 variants), `SpecPatch`, `SpecPatchError`, `PATCH_JSON_SCHEMA`, `parsePatch(raw: unknown): SpecPatch`.

- [ ] **Step 1: Extract `lib/spec/fields.ts` to break an import cycle**

**Do this first, as its own commit.** Task 11 will have `validate.ts` import `parseOp`
(a value) from `patch.ts`, while this task has `patch.ts` import `parsePanel`,
`parseScreen`, and `parseSpecDraft` (values) from `validate.ts`. That is a runtime
import cycle. ESM tolerates it only because every use sits inside a function body —
a temporal-dead-zone hazard one refactor away from a crash, in the module that is
this repo's last gate before an append-only table.

Move these out of `lib/spec/validate.ts` into a new `lib/spec/fields.ts`, unchanged
except for the two renames: `record`, `text`, `nullableText`, `id`, `textList`,
`oneOf`, `arrayField`, `nonEmptyArray`, `valueSpec`, `entryField`, `entryOrNull`,
`entryWidget`, `requirement`, `panel` → **`parsePanel`**, `screen` → **`parseScreen`**,
`checkInvariants`, `draftFrom`, `parseSpecDraft`.

Export from `fields.ts` everything `validate.ts` or `patch.ts` needs. Then in
`validate.ts`, import what it still uses and **re-export `parseSpecDraft`**, so every
existing call site and test keeps working untouched:

```ts
// lib/spec/validate.ts
import { draftFrom, parseSpecDraft, record, text, arrayField } from './fields'
export { parseSpecDraft } from './fields'
```

Resulting import directions — one way only, no cycle:

```
fields.ts   -> schema.ts
patch.ts    -> fields.ts, schema.ts
validate.ts -> fields.ts, patch.ts
```

`fields.ts` = how ONE spec field is validated. `validate.ts` = how a whole emitted or
stored document is validated. Keep every existing comment with the function it belongs
to — several of them explain why a laundering shortcut was rejected, and they are worth
more than the code.

Verify before moving on: `npx vitest run tests/spec && npx tsc --noEmit` with **no test
file edited**. If a test had to change, the move was not behaviour-preserving.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/spec/patch.test.ts
import { describe, expect, it } from 'vitest'
import { parsePatch, SpecPatchError, PATCH_JSON_SCHEMA } from '@/lib/spec/patch'

const PANEL = {
  id: 'takeaway',
  title: 'Takeaway',
  intent: 'What am I spending on takeaway?',
  display: 'A weekly total.',
  context_of_use: null,
  values: [{ kind: 'synced', id: 'takeaway_spend', module: 'plaid', description: 'x' }],
  entry: null,
}

const MINIMAL = {
  change_summary: 'Renamed the eating-out panel.',
  data_requirements: [],
  open_questions: [],
  ops: [{ op: 'replace_panel', panel: PANEL }],
}

describe('parsePatch', () => {
  it('accepts a minimal patch', () => {
    expect(parsePatch(MINIMAL).ops).toHaveLength(1)
  })

  it('requires change_summary — it is the friend-facing line', () => {
    expect(() => parsePatch({ ...MINIMAL, change_summary: '' })).toThrow(SpecPatchError)
  })

  it('rejects an empty ops list — a patch that changes nothing is not a proposal', () => {
    expect(() => parsePatch({ ...MINIMAL, ops: [] })).toThrow(/ops is empty/)
  })

  it('rejects an unknown op', () => {
    expect(() => parsePatch({ ...MINIMAL, ops: [{ op: 'delete_everything' }] })).toThrow(
      /delete_everything/,
    )
  })

  it('validates a panel inside an op with the whole-surface validator', () => {
    const bad = { ...PANEL, values: [] }
    expect(() => parsePatch({ ...MINIMAL, ops: [{ op: 'replace_panel', panel: bad }] })).toThrow(
      /values is empty/,
    )
  })

  it('rejects a model-authored based_on_version', () => {
    expect(() => parsePatch({ ...MINIMAL, based_on_version: 3 })).toThrow(/based_on_version/)
  })

  it('parses every op kind', () => {
    const ops = [
      { op: 'set_meta', title: 'T', summary: 'S', background: 'B' },
      { op: 'add_screen', screen: { id: 's2', title: 'S2', order: 2, panels: [PANEL] } },
      { op: 'update_screen', id: 's1', title: 'New', order: 1 },
      { op: 'remove_screen', id: 's3' },
      { op: 'add_panel', screen_id: 's1', panel: PANEL },
      { op: 'replace_panel', panel: PANEL },
      { op: 'move_panel', panel_id: 'takeaway', screen_id: 's2' },
      { op: 'remove_panel', id: 'old' },
    ]
    expect(parsePatch({ ...MINIMAL, ops }).ops).toHaveLength(8)
  })
})

describe('PATCH_JSON_SCHEMA', () => {
  it('does not ask the model for based_on_version or ops_count', () => {
    const json = JSON.stringify(PATCH_JSON_SCHEMA)
    expect(json).not.toContain('based_on_version')
    expect(json).not.toContain('ops_count')
  })

  // minItems is outside the supported structured-output subset and would be
  // silently ignored — the real bound lives in parsePatch.
  it('uses no minItems', () => {
    expect(JSON.stringify(PATCH_JSON_SCHEMA)).not.toContain('minItems')
  })
})
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run tests/spec/patch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/spec/patch.ts` (types, schema, parser)**

```ts
// lib/spec/patch.ts
//
// A scoped change to one person's dashboard: what the spec-writer emits when
// there is a current confirmed version to change.
//
// WHY PANEL GRANULARITY. A finer op (set_panel_title) would save ~150 tokens
// against replace_panel and would cost an op vocabulary large enough that the
// validator can no longer be exhaustive. Panels are the unit a friend thinks in
// and the unit lib/spec/diff.ts already reports on, so making them the unit of
// change already gets the win: output proportional to CHANGED PANELS.
//
// The stored row is still the whole surface — applyPatch produces it and
// lib/spec/validate.ts validates it, unchanged. The ops ride alongside so the
// card and the mockup know what actually changed.
// Every import at the top of the file. PANEL_SCHEMA and SCREEN_SCHEMA come
// from schema.ts (Step 5 exports them); the field parsers come from fields.ts
// (Step 1), never from validate.ts — that direction is the cycle.
import {
  PANEL_SCHEMA,
  SCREEN_SCHEMA,
  SpecShapeError,
  type Panel,
  type Screen,
} from './schema'
import { parsePanel, parseScreen } from './fields'

/**
 * Extends SpecShapeError deliberately, and it buys two things for free:
 * lib/spec/author.ts's retry loop already treats a SpecShapeError as the one
 * retryable failure, and metricMessage() already redacts its quoted ids before
 * they reach the append-only metrics log.
 */
export class SpecPatchError extends SpecShapeError {
  constructor(message: string) {
    super(message)
    this.name = 'SpecPatchError'
  }
}

export type SpecPatchOp =
  | { op: 'set_meta'; title: string | null; summary: string | null; background: string | null }
  | { op: 'add_screen'; screen: Screen }
  | { op: 'update_screen'; id: string; title: string; order: number }
  | { op: 'remove_screen'; id: string }
  | { op: 'add_panel'; screen_id: string; panel: Panel }
  | { op: 'replace_panel'; panel: Panel }
  | { op: 'move_panel'; panel_id: string; screen_id: string }
  | { op: 'remove_panel'; id: string }

export const OP_NAMES = [
  'set_meta',
  'add_screen',
  'update_screen',
  'remove_screen',
  'add_panel',
  'replace_panel',
  'move_panel',
  'remove_panel',
] as const

/** What the model emits. `based_on_version` and `ops` on the stored row are
 * the server's; neither is authored here. */
export type SpecPatch = {
  change_summary: string
  data_requirements: unknown[]
  open_questions: string[]
  ops: SpecPatchOp[]
}

const str = { type: 'string' } as const
const nullableStr = { type: ['string', 'null'] } as const

export const PATCH_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    change_summary: str,
    data_requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { table: str, purpose: str, status: str },
        required: ['table', 'purpose', 'status'],
      },
    },
    open_questions: { type: 'array', items: str },
    ops: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { const: 'set_meta' },
              title: nullableStr,
              summary: nullableStr,
              background: nullableStr,
            },
            required: ['op', 'title', 'summary', 'background'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'add_screen' }, screen: SCREEN_SCHEMA },
            required: ['op', 'screen'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { const: 'update_screen' },
              id: str,
              title: str,
              order: { type: 'integer' },
            },
            required: ['op', 'id', 'title', 'order'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'remove_screen' }, id: str },
            required: ['op', 'id'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'add_panel' }, screen_id: str, panel: PANEL_SCHEMA },
            required: ['op', 'screen_id', 'panel'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'replace_panel' }, panel: PANEL_SCHEMA },
            required: ['op', 'panel'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'move_panel' }, panel_id: str, screen_id: str },
            required: ['op', 'panel_id', 'screen_id'],
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: { op: { const: 'remove_panel' }, id: str },
            required: ['op', 'id'],
          },
        ],
      },
    },
  },
  required: ['change_summary', 'data_requirements', 'open_questions', 'ops'],
} as const

function obj(raw: unknown, at: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecPatchError(`${at} is not an object`)
  }
  return raw as Record<string, unknown>
}

function reqText(src: Record<string, unknown>, key: string, at: string): string {
  const value = src[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpecPatchError(`${at}.${key} is not a non-empty string`)
  }
  return value.trim()
}

function optText(src: Record<string, unknown>, key: string, at: string): string | null {
  if (!(key in src) || src[key] === null) return null
  return reqText(src, key, at)
}

function parseOp(raw: unknown, at: string): SpecPatchOp {
  const src = obj(raw, at)
  const op = reqText(src, 'op', at)
  switch (op) {
    case 'set_meta':
      return {
        op,
        title: optText(src, 'title', at),
        summary: optText(src, 'summary', at),
        background: optText(src, 'background', at),
      }
    case 'add_screen':
      return { op, screen: parseScreen(src.screen, `${at}.screen`) }
    case 'update_screen': {
      const order = src.order
      if (typeof order !== 'number' || !Number.isInteger(order)) {
        throw new SpecPatchError(`${at}.order is not an integer`)
      }
      return { op, id: reqText(src, 'id', at), title: reqText(src, 'title', at), order }
    }
    case 'remove_screen':
      return { op, id: reqText(src, 'id', at) }
    case 'add_panel':
      return {
        op,
        screen_id: reqText(src, 'screen_id', at),
        panel: parsePanel(src.panel, `${at}.panel`),
      }
    case 'replace_panel':
      return { op, panel: parsePanel(src.panel, `${at}.panel`) }
    case 'move_panel':
      return {
        op,
        panel_id: reqText(src, 'panel_id', at),
        screen_id: reqText(src, 'screen_id', at),
      }
    case 'remove_panel':
      return { op, id: reqText(src, 'id', at) }
    default:
      throw new SpecPatchError(`${at}.op "${op}" is not one of ${OP_NAMES.join(', ')}`)
  }
}

export function parsePatch(raw: unknown): SpecPatch {
  const src = obj(raw, 'patch')
  // Same rule as parseSpecDraft: the lineage pointer is the server's, and a
  // model-authored one is a hallucination that becomes a permanent row.
  if ('based_on_version' in src) {
    throw new SpecPatchError('based_on_version is supplied by the server and must not be authored')
  }

  const ops = src.ops
  if (!Array.isArray(ops)) throw new SpecPatchError('patch.ops is not an array')
  // The agent prompt already forbids proposing when nothing changed ("a
  // proposal card whose changelog would read 'nothing changed' is a bug").
  // This is that rule made structural.
  if (ops.length === 0) throw new SpecPatchError('patch.ops is empty — a patch must change something')

  const requirements = src.data_requirements
  if (!Array.isArray(requirements)) {
    throw new SpecPatchError('patch.data_requirements is not an array')
  }
  const questions = src.open_questions
  if (!Array.isArray(questions)) throw new SpecPatchError('patch.open_questions is not an array')

  return {
    change_summary: reqText(src, 'change_summary', 'patch'),
    // Passed through untouched: applyPatch hands these to parseSpecDraft, which
    // is the validator that owns their shape. Validating them twice, in two
    // places, is two chances to disagree.
    data_requirements: requirements,
    open_questions: questions.filter((q): q is string => typeof q === 'string'),
    ops: ops.map((o, i) => parseOp(o, `patch.ops[${i}]`)),
  }
}
```

- [ ] **Step 5: Export `PANEL_SCHEMA` and add `SCREEN_SCHEMA` in `lib/spec/schema.ts`**

`PANEL_SCHEMA` is currently a module-private const. Export it, and lift the inline screen object out of `SPEC_JSON_SCHEMA` into an exported `SCREEN_SCHEMA` that `SPEC_JSON_SCHEMA` then references — one declaration, two consumers.

- [ ] **Step 6: Run**

Run: `npx vitest run tests/spec && npx tsc --noEmit`
Expected: PASS, clean. The existing `tests/spec/schema.test.ts` and `validate.test.ts` must pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add lib/spec/patch.ts lib/spec/schema.ts lib/spec/validate.ts tests/spec/patch.test.ts
git commit -m "Add the spec patch: eight panel-granular ops, schema and parser"
```

---

### Task 10: Apply a patch

**Files:**
- Modify: `lib/spec/patch.ts`
- Test: `tests/spec/applyPatch.test.ts`

**Interfaces:**
- Consumes: `SpecPatch`, `SpecPatchError` (Task 9), `SpecVersion`, `SpecDraft`, `parseSpecDraft`.
- Produces: `applyPatch(base: SpecVersion, patch: SpecPatch): SpecDraft`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/spec/applyPatch.test.ts
import { describe, expect, it } from 'vitest'
import { applyPatch, SpecPatchError } from '@/lib/spec/patch'
import type { SpecVersion } from '@/lib/spec/schema'

const panel = (id: string, title = id) => ({
  id, title, intent: 'i', display: 'd', context_of_use: null,
  values: [{ kind: 'entered' as const, id: `${id}_v`, description: 'x' }],
  entry: null,
})

const BASE: SpecVersion = {
  title: 'Sam', summary: 'S', background: 'B', change_summary: 'first',
  screens: [
    { id: 'morning', title: 'Morning', order: 1, panels: [panel('eating_out'), panel('walks')] },
    { id: 'money', title: 'Money', order: 2, panels: [panel('balance')] },
  ],
  data_requirements: [], open_questions: [], based_on_version: null, ops: null,
}

const patch = (ops: unknown[]) => ({
  change_summary: 'c', data_requirements: [], open_questions: [], ops,
}) as never

describe('applyPatch', () => {
  it('copies untouched panels byte for byte — the drift fix', () => {
    const next = applyPatch(BASE, patch([{ op: 'replace_panel', panel: panel('eating_out', 'Takeaway') }]))
    expect(next.screens[0]!.panels[1]).toEqual(BASE.screens[0]!.panels[1])
    expect(next.screens[1]).toEqual(BASE.screens[1])
  })

  it('replaces a panel in place, keeping its position', () => {
    const next = applyPatch(BASE, patch([{ op: 'replace_panel', panel: panel('eating_out', 'Takeaway') }]))
    expect(next.screens[0]!.panels[0]!.title).toBe('Takeaway')
    expect(next.screens[0]!.panels.map((p) => p.id)).toEqual(['eating_out', 'walks'])
  })

  it('carries change_summary from the patch, not the base', () => {
    const next = applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect(next.change_summary).toBe('c')
  })

  it('never leaks based_on_version or ops into the draft', () => {
    const next = applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect('based_on_version' in next).toBe(false)
    expect('ops' in next).toBe(false)
  })

  it('does not mutate the base', () => {
    const before = JSON.stringify(BASE)
    applyPatch(BASE, patch([{ op: 'remove_panel', id: 'walks' }]))
    expect(JSON.stringify(BASE)).toBe(before)
  })

  it('applies ops in order, so one may depend on an earlier one', () => {
    const next = applyPatch(BASE, patch([
      { op: 'add_screen', screen: { id: 'gym', title: 'Gym', order: 3, panels: [panel('reps')] } },
      { op: 'move_panel', panel_id: 'walks', screen_id: 'gym' },
    ]))
    expect(next.screens.find((s) => s.id === 'gym')!.panels.map((p) => p.id)).toEqual(['reps', 'walks'])
    expect(next.screens[0]!.panels.map((p) => p.id)).toEqual(['eating_out'])
  })

  it('sets only the meta fields the op names', () => {
    const next = applyPatch(BASE, patch([
      { op: 'set_meta', title: 'New title', summary: null, background: null },
      { op: 'remove_panel', id: 'walks' },
    ]))
    expect(next.title).toBe('New title')
    expect(next.summary).toBe('S')
  })

  it('throws when an op names a panel that does not exist', () => {
    expect(() => applyPatch(BASE, patch([{ op: 'remove_panel', id: 'ghost' }]))).toThrow(
      /"ghost"/,
    )
  })

  it('throws when add_panel reuses an existing id', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'add_panel', screen_id: 'money', panel: panel('walks') }])),
    ).toThrow(SpecPatchError)
  })

  it('throws when add_screen reuses an existing id', () => {
    expect(() =>
      applyPatch(BASE, patch([
        { op: 'add_screen', screen: { id: 'money', title: 'X', order: 9, panels: [panel('p')] } },
      ])),
    ).toThrow(SpecPatchError)
  })

  it('throws when move_panel targets a screen that does not exist', () => {
    expect(() =>
      applyPatch(BASE, patch([{ op: 'move_panel', panel_id: 'walks', screen_id: 'ghost' }])),
    ).toThrow(/"ghost"/)
  })

  // Emptying a screen is caught by the WHOLE-SURFACE validator, not by a
  // special case here — and its message is already good retry feedback.
  it('rejects a patch that empties a screen, via the existing validator', () => {
    expect(() => applyPatch(BASE, patch([{ op: 'remove_panel', id: 'balance' }]))).toThrow(
      /panels is empty/,
    )
  })

  // The cross-field invariants are the whole-surface validator's too.
  it('rejects a patch that orphans a derived input', () => {
    const derived = {
      ...panel('total'),
      values: [{ kind: 'derived' as const, id: 'total_v', description: 'x', inputs: ['walks_v'] }],
    }
    expect(() =>
      applyPatch(BASE, patch([
        { op: 'add_panel', screen_id: 'money', panel: derived },
        { op: 'remove_panel', id: 'walks' },
      ])),
    ).toThrow(/unknown value/)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/applyPatch.test.ts`
Expected: FAIL — `applyPatch` is not exported.

- [ ] **Step 3: Implement**

Append to `lib/spec/patch.ts`:

```ts
import { parseSpecDraft } from './validate'
import type { SpecDraft, SpecVersion } from './schema'

type Working = { title: string; summary: string; background: string; screens: Screen[] }

function findScreen(work: Working, id: string, op: string): Screen {
  const screen = work.screens.find((s) => s.id === id)
  if (!screen) throw new SpecPatchError(`${op} names screen "${id}", which does not exist`)
  return screen
}

function findPanel(work: Working, id: string, op: string): { screen: Screen; index: number } {
  for (const screen of work.screens) {
    const index = screen.panels.findIndex((p) => p.id === id)
    if (index !== -1) return { screen, index }
  }
  throw new SpecPatchError(`${op} names panel "${id}", which does not exist`)
}

function panelExists(work: Working, id: string): boolean {
  return work.screens.some((s) => s.panels.some((p) => p.id === id))
}

/**
 * Apply a patch to the current confirmed version and return the WHOLE next
 * draft.
 *
 * Pure: no database, no clock, no model, no mutation of `base`. That is what
 * makes the untouched panels a COPY rather than a regeneration, which is the
 * drift half of why this exists.
 *
 * The result is handed to parseSpecDraft — the SAME validator the whole-surface
 * path uses. Every cross-field invariant (unique ids, derived inputs resolve,
 * annotates points at a synced value, no empty screen) is therefore checked
 * exactly once, in one place, with error messages that are already good retry
 * feedback. Nothing here re-implements any of it.
 *
 * The draft is built by NAMING its seven fields, never by spreading `base`:
 * a spread would carry `based_on_version` and `ops` into an object
 * parseSpecDraft rejects outright, and would silently pick up any field a
 * future SpecVersion gains.
 */
export function applyPatch(base: SpecVersion, patch: SpecPatch): SpecDraft {
  const work: Working = {
    title: base.title,
    summary: base.summary,
    background: base.background,
    // structuredClone, so nothing downstream can reach back into the stored
    // version through a shared array or object reference.
    screens: structuredClone(base.screens),
  }

  for (const op of patch.ops) {
    switch (op.op) {
      case 'set_meta':
        if (op.title !== null) work.title = op.title
        if (op.summary !== null) work.summary = op.summary
        if (op.background !== null) work.background = op.background
        break

      case 'add_screen':
        if (work.screens.some((s) => s.id === op.screen.id)) {
          throw new SpecPatchError(`add_screen names screen "${op.screen.id}", which already exists`)
        }
        for (const p of op.screen.panels) {
          if (panelExists(work, p.id)) {
            throw new SpecPatchError(`add_screen carries panel "${p.id}", which already exists`)
          }
        }
        work.screens.push(structuredClone(op.screen))
        break

      case 'update_screen': {
        const screen = findScreen(work, op.id, 'update_screen')
        screen.title = op.title
        screen.order = op.order
        break
      }

      case 'remove_screen': {
        findScreen(work, op.id, 'remove_screen')
        work.screens = work.screens.filter((s) => s.id !== op.id)
        break
      }

      case 'add_panel': {
        const screen = findScreen(work, op.screen_id, 'add_panel')
        if (panelExists(work, op.panel.id)) {
          throw new SpecPatchError(`add_panel names panel "${op.panel.id}", which already exists`)
        }
        screen.panels.push(structuredClone(op.panel))
        break
      }

      case 'replace_panel': {
        // In place, keeping its position: a replace is a relabel or a reshape,
        // never a reorder, and a panel that silently jumped to the end of its
        // screen would register in the diff as a change nobody asked for.
        const { screen, index } = findPanel(work, op.panel.id, 'replace_panel')
        screen.panels[index] = structuredClone(op.panel)
        break
      }

      case 'move_panel': {
        const target = findScreen(work, op.screen_id, 'move_panel')
        const { screen, index } = findPanel(work, op.panel_id, 'move_panel')
        const [moved] = screen.panels.splice(index, 1)
        target.panels.push(moved!)
        break
      }

      case 'remove_panel': {
        const { screen, index } = findPanel(work, op.id, 'remove_panel')
        screen.panels.splice(index, 1)
        break
      }
    }
  }

  return parseSpecDraft({
    title: work.title,
    summary: work.summary,
    background: work.background,
    change_summary: patch.change_summary,
    screens: work.screens,
    data_requirements: patch.data_requirements,
    open_questions: patch.open_questions,
  })
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/spec && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Prove the copy is a copy**

Change `structuredClone(base.screens)` to `base.screens` and re-run. Expected: `does not mutate the base` goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/patch.ts tests/spec/applyPatch.test.ts
git commit -m "Apply a patch to the current version, validated by the whole-surface validator"
```

---

### Task 11: Carry `ops` on the stored version

**Files:**
- Modify: `lib/spec/schema.ts`, `lib/spec/validate.ts`
- Test: `tests/spec/validate.test.ts`

**Interfaces:**
- Consumes: `SpecPatchOp` (Task 9).
- Produces: `SpecVersion.ops: SpecPatchOp[] | null`; `sealVersion(draft, basedOnVersion, ops)`; `parseSpecVersion` preserves `ops`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to tests/spec/validate.test.ts
describe('ops on a stored version', () => {
  it('round-trips through parseSpecVersion', () => {
    const sealed = sealVersion(DRAFT, 3, [{ op: 'remove_panel', id: 'walks' }])
    const read = parseSpecVersion(JSON.stringify(sealed))
    expect(read.ops).toEqual([{ op: 'remove_panel', id: 'walks' }])
  })

  // Null means "authored whole-surface". An empty array would claim it was
  // produced by a patch that changed nothing, which is a different and
  // impossible thing.
  it('is null, not [], for a whole-surface version', () => {
    const read = parseSpecVersion(JSON.stringify(sealVersion(DRAFT, null, null)))
    expect(read.ops).toBeNull()
  })

  it('reads a pre-patch stored row, which has no ops key, as null', () => {
    const { ops, ...withoutOps } = sealVersion(DRAFT, 1, null)
    expect(parseSpecVersion(JSON.stringify(withoutOps)).ops).toBeNull()
  })

  it('rejects a model-authored ops key on the whole-surface path', () => {
    expect(() => parseSpecDraft({ ...DRAFT_INPUT, ops: [] })).toThrow(/ops/)
  })

  it('throws on a stored ops value that is not an array or null', () => {
    const bad = JSON.stringify({ ...sealVersion(DRAFT, 1, null), ops: 'nope' })
    expect(() => parseSpecVersion(bad)).toThrow(SpecShapeError)
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/validate.test.ts`
Expected: FAIL — `sealVersion` takes two arguments.

- [ ] **Step 3: Implement**

In `lib/spec/schema.ts`:

```ts
import type { SpecPatchOp } from './patch'

/**
 * What gets stored: the draft, the server-supplied lineage pointer, and the
 * ops that produced it.
 *
 * `ops` is NULL for a version authored whole-surface (v1, and the one-time
 * fallback for a legacy base). Null says "this version was not produced by a
 * patch"; an empty array would say "it was produced by a patch that changed
 * nothing", which is a different and impossible claim.
 *
 * It rides INSIDE payload, flat beside the version's own fields, because
 * readStoredSpec discriminates on a top-level `screens` array and draftFrom
 * picks named keys. A `{ patch, version }` wrapper would break the
 * discriminator and every consumer with it. No new column on `specs`.
 */
export type SpecVersion = SpecDraft & {
  based_on_version: number | null
  ops: SpecPatchOp[] | null
}
```

In `lib/spec/validate.ts`:

```ts
export function sealVersion(
  draft: SpecDraft,
  basedOnVersion: number | null,
  ops: SpecPatchOp[] | null,
): SpecVersion {
  return { ...draft, based_on_version: basedOnVersion, ops }
}
```

Extend `parseSpecVersion` — the key must be parsed EXPLICITLY, because
`draftFrom` reconstructs from named fields and would otherwise drop it:

```ts
  const rawOps = src.ops
  // Absent reads as null, not as an error: every spec row written before this
  // existed has no `ops` key, and `specs` rejects UPDATE so none can gain one.
  let ops: SpecPatchOp[] | null = null
  if (rawOps !== undefined && rawOps !== null) {
    if (!Array.isArray(rawOps)) throw new SpecShapeError('ops is neither an array nor null')
    ops = rawOps.map((o, i) => parseOp(o, `ops[${i}]`))
  }
  return sealVersion(draftFrom(src), based, ops)
```

Export `parseOp` from `lib/spec/patch.ts` for that call.

And in `parseSpecDraft`, beside the existing `based_on_version` guard:

```ts
  if ('ops' in src) {
    throw new SpecShapeError('ops is supplied by the server and must not be authored')
  }
```

- [ ] **Step 4: Fix every `sealVersion` call site**

`lib/spec/author.ts` and the tests. Pass `null` at each for now — Task 13 gives the real value.

Run: `npx tsc --noEmit` and fix what it names.

- [ ] **Step 5: Run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/schema.ts lib/spec/validate.ts lib/spec/patch.ts lib/spec/author.ts tests/spec
git commit -m "Carry the patch ops on the stored spec version, flat inside payload"
```

---

### Task 12: The patch-authoring prompt

**Files:**
- Create: `platform/prompts/spec-v3.md`
- Modify: `lib/chat/prompt.ts`
- Test: `tests/chat/prompt.test.ts`

**Interfaces:**
- Produces: `SPEC_PATCH_PROMPT = 'spec-v3.md'`.

- [ ] **Step 1: Write the prompt**

Base it on `spec-v2.md`'s field documentation — the panel, value and entry
sections are unchanged and must be restated in full, since this prompt replaces
rather than supplements it. Replace v2's "What you emit" and "Ids are the
load-bearing rule" sections with:

```markdown
## What you emit

A PATCH: only what changes. The dashboard's current confirmed version is given
to you below, and everything in it that you do not mention stays exactly as it
is. You are not rewriting the dashboard — you are describing the change to it.

A panel nobody mentioned this time is a panel you say nothing about. Do not
re-emit it to keep it; re-emitting is how it gets subtly reworded.

Your patch is a `change_summary`, the current `data_requirements` and
`open_questions` lists in full, and a list of `ops`.

## The ops

- **`set_meta`** — the dashboard's `title`, `summary`, or `background`. Give
  `null` for any of the three that is unchanged. Only emit this op at all if
  one of them genuinely changed.
- **`add_screen`** — a whole new screen with its panels.
- **`update_screen`** — a screen's `title` and `order`. Both are required; give
  the current value for the one that did not change.
- **`remove_screen`** — by id. Its panels go with it.
- **`add_panel`** — a whole new panel, and the `screen_id` it goes on.
- **`replace_panel`** — a whole panel, replacing the one with the same id. This
  is how you relabel, reshape, or re-source an existing panel. It keeps its
  position on its screen.
- **`move_panel`** — a panel to a different screen, unchanged otherwise.
- **`remove_panel`** — by id.

Ops apply in the order you give them, so a later op may rely on an earlier one
— add a screen, then move a panel onto it.

At least one op. A patch that changes nothing is not a proposal; if nothing
changed, you should not have been called.

## Ids are the load-bearing rule

Every screen, panel, and value in the current version already has an `id`. An
id belongs to exactly that thing forever.

To change something that exists, name its EXISTING id. A changed title next to
an unchanged id is how a rename is expressed — it tells a builder "this is the
same panel, relabelled" rather than "the old one was deleted and a new one
appeared." Never invent a fresh id for something that already exists, and never
point an id at a different thing than the one it was assigned to.

New ids — for genuinely new screens, panels and values — are lowercase slugs:
letters and digits in one or more runs separated by single underscores,
`eating_out`, never `Eating-Out` or `eatingOut`. A new id must not collide with
any id already in the current version.

Every removal has to be named in `change_summary`. A patch where an id quietly
disappears is indistinguishable from a mistake unless you say so.
```

Keep v2's `change_summary`, `data_requirements`, `open_questions`, panel,
value, and entry field documentation verbatim, and keep its "What the dashboard
can be built from" and "No mockup" sections verbatim.

- [ ] **Step 2: Export it**

```ts
/**
 * The PATCH-authoring prompt, used when there is a current confirmed version in
 * the current shape to change. v1 and a legacy base still go through
 * SPEC_PROMPT and emit the whole surface — see lib/spec/author.ts.
 */
export const SPEC_PATCH_PROMPT = 'spec-v3.md'
```

- [ ] **Step 3: Test**

```ts
  it('loads the patch prompt and hashes it', () => {
    const loaded = loadPrompt(SPEC_PATCH_PROMPT)
    expect(loaded.text).toContain('A PATCH: only what changes')
    expect(loaded.sha).not.toBe(loadPrompt(SPEC_PROMPT).sha)
  })
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run tests/chat/prompt.test.ts && npx tsc --noEmit
git add platform/prompts/spec-v3.md lib/chat/prompt.ts tests/chat/prompt.test.ts
git commit -m "Add spec-v3.md, the patch-authoring prompt"
```

---

### Task 13: Author by patch when there is a base to patch

**Files:**
- Modify: `lib/spec/author.ts`
- Test: `tests/spec/author.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9–12.
- Produces: unchanged `authorSpec` signature. New metric fields `authoring_mode` and `ops_count`; new `spec_error` kind `patch_failed`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to tests/spec/author.test.ts
describe('authoring mode', () => {
  it('authors WHOLE for a first version', async () => {
    // no confirmed spec
    await authorSpec(deps, input)
    expect(lastMetric(db, 'spec_proposed').authoring_mode).toBe('whole')
    expect(storedVersion(db).ops).toBeNull()
    expect(client.propose.mock.calls[0][0].system).toContain('the complete next version')
  })

  it('authors WHOLE against a legacy base — it has no ids to patch', async () => {
    confirmLegacySpec(db, accountId)
    await authorSpec(deps, input)
    expect(lastMetric(db, 'spec_proposed').authoring_mode).toBe('whole')
  })

  it('authors a PATCH against a current base', async () => {
    confirmCurrentSpec(db, accountId, BASE)
    clientReturns({ change_summary: 'c', data_requirements: [], open_questions: [],
                    ops: [{ op: 'remove_panel', id: 'walks' }] })
    await authorSpec(deps, input)
    const metric = lastMetric(db, 'spec_proposed')
    expect(metric.authoring_mode).toBe('patch')
    expect(metric.ops_count).toBe(1)
  })

  it('stores the applied WHOLE surface alongside the ops', async () => {
    confirmCurrentSpec(db, accountId, BASE)
    clientReturns({ change_summary: 'c', data_requirements: [], open_questions: [],
                    ops: [{ op: 'remove_panel', id: 'walks' }] })
    await authorSpec(deps, input)
    const stored = storedVersion(db)
    // The whole surface — a builder never replays history.
    expect(stored.screens[0].panels.map((p) => p.id)).toEqual(['eating_out'])
    // And the ops, so the card and the mockup know what changed.
    expect(stored.ops).toEqual([{ op: 'remove_panel', id: 'walks' }])
  })

  it('retries once on a patch that does not apply, then records patch_failed', async () => {
    confirmCurrentSpec(db, accountId, BASE)
    clientAlwaysReturns({ change_summary: 'c', data_requirements: [], open_questions: [],
                          ops: [{ op: 'remove_panel', id: 'ghost' }] })
    const result = await authorSpec(deps, input)
    expect(result).toBeUndefined()
    expect(client.propose).toHaveBeenCalledTimes(2)
    const errors = metrics(db, 'spec_error')
    expect(errors.map((e) => e.attempt)).toEqual([1, 2])
    expect(errors[0].kind).toBe('patch_failed')
  })

  it('redacts the quoted id out of the patch_failed metric message', async () => {
    confirmCurrentSpec(db, accountId, BASE)
    clientAlwaysReturns({ change_summary: 'c', data_requirements: [], open_questions: [],
                          ops: [{ op: 'remove_panel', id: 'divorce_lawyer_fund' }] })
    await authorSpec(deps, input)
    const message = metrics(db, 'spec_error')[0].message as string
    expect(message).not.toContain('divorce_lawyer_fund')
    expect(message).toContain('"…"')
  })

  it('feeds the FULL patch error back to the model on the retry', async () => {
    confirmCurrentSpec(db, accountId, BASE)
    clientAlwaysReturns({ change_summary: 'c', data_requirements: [], open_questions: [],
                          ops: [{ op: 'remove_panel', id: 'ghost' }] })
    await authorSpec(deps, input)
    const retryMessages = client.propose.mock.calls[1][0].messages
    expect(JSON.stringify(retryMessages)).toContain('ghost')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/author.test.ts`
Expected: FAIL — `authoring_mode` is undefined.

- [ ] **Step 3: Implement**

In `lib/spec/author.ts`, immediately after `const current = currentSpec(db, input.accountId)`:

```ts
    /**
     * WHICH SHAPE THE WRITER IS ASKED FOR — and it is decided in the same place
     * that already decides what the writer is SHOWN (currentVersionBlock's three
     * arms), so the two can never disagree about which era this account is in.
     *
     * `patch` only when there is a confirmed row AND it is in the current shape.
     * Both other arms author the whole surface:
     *
     *   - v1 has no base to patch, and the first-ever conversation is the one
     *     thing this may not change (unified-loop §7 R3). Same prompt, same
     *     schema, same code as before this existed.
     *   - a LEGACY row carries no ids, so there is nothing for an op to name.
     *     `specs` rejects UPDATE, so it can never gain any. That account authors
     *     whole-surface exactly once and is on the patch path from its next
     *     version.
     */
    const storedCurrent = current === undefined ? undefined : readStoredSpec(current.payload)
    const base =
      storedCurrent !== undefined && storedCurrent.kind === 'version'
        ? storedCurrent.version
        : undefined
    const mode: 'patch' | 'whole' = base === undefined ? 'whole' : 'patch'

    const loaded = loadPrompt(mode === 'patch' ? SPEC_PATCH_PROMPT : SPEC_PROMPT)
    promptSha = loaded.sha
    const system = loaded.text
    const schema = mode === 'patch' ? PATCH_JSON_SCHEMA : SPEC_JSON_SCHEMA
```

> Move the existing `loadPrompt(SPEC_PROMPT)` block down to here — it currently
> runs before `currentSpec` is read, and the prompt now depends on it. `base`
> keeps `promptSha` populated for the outer catch exactly as before.

Replace the `client.propose({ … schema: SPEC_JSON_SCHEMA })` argument with `schema`.

Replace the `draft = parseSpecDraft(proposed.input); break` block with:

```ts
      // WHICH PHASE FAILED IS THE CLASSIFICATION — not which error class was
      // thrown. Ruled at Task 9's re-review, and it is the whole reason the
      // metrics kinds can be trusted.
      //
      // The tempting version discriminates on `error instanceof SpecPatchError`.
      // That silently misclassifies, because the shape checks inside a patch are
      // shared with the whole-surface path: a malformed `order` in an
      // update_screen op, a non-string in `open_questions`, and any bad nested
      // panel all reach `fields.ts` helpers that throw the BASE class. Those
      // rows would land in an append-only log as `malformed_spec` forever, and
      // `metrics` rejects UPDATE.
      //
      // Phase cannot be got wrong, because it is not inferred: parsing failed,
      // or applying failed, and the code knows which one it was standing in.
      // The meanings come out clean too — `malformed_spec` is "the model
      // returned the wrong shape", `patch_failed` is "the shape was right and
      // it would not apply to this base", which is the genuinely new failure
      // mode worth watching.
      let phase: 'malformed_spec' | 'patch_failed' = 'malformed_spec'
      try {
        if (mode === 'patch' && base !== undefined) {
          patch = parsePatch(proposed.input)
          phase = 'patch_failed'
          draft = applyPatch(base, patch)
        } else {
          draft = parseSpecDraft(proposed.input)
        }
        break
      } catch (error) {
```

and inside that catch, replace the hard-coded `kind: 'malformed_spec'` with the
phase the failure actually happened in:

```ts
            // Set above, before the call that can fail. See the phase comment.
            kind: phase,
```

`SpecPatchError` keeps extending `SpecShapeError` regardless — that is what makes
the retry loop treat it as its one retryable failure and what makes
`metricMessage()` redact its quoted ids before they reach the metrics log. It is
just no longer what decides the metric's `kind`.

Declare `let patch: SpecPatch | undefined` beside `let draft`.

At the seal, pass the ops:

```ts
    const sealed = sealVersion(
      draft,
      currentSpec(db, input.accountId)?.version ?? null,
      // The ops as PARSED, never as the model returned them: parsePatch is what
      // turned a reply into a value, and the row must carry the thing the
      // applier actually acted on.
      patch?.ops ?? null,
    )
```

On the `spec_proposed` metric, add:

```ts
        authoring_mode: mode,
        // A COUNT, never the ops themselves. `metrics` is append-only and the
        // standing bound is counts, never content — an op carries panel ids
        // derived from what the friend asked for.
        ops_count: patch?.ops.length ?? null,
```

Add the same two fields to the `spec_error` rows written inside the attempt loop
and in the mockup-failure branch, so a query can group any row by mode.

- [ ] **Step 4: Run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean. Every pre-existing `author.test.ts` case must pass unchanged — the v1 path is the same code.

- [ ] **Step 5: Prove the mode selector is load-bearing**

Change `mode` to a constant `'patch'`. Re-run. Expected: the v1 and legacy tests go red. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/spec/author.ts tests/spec/author.test.ts
git commit -m "Author a patch against a current base; whole-surface for v1 and legacy"
```

---

### Task 14: Document Part B

**Files:**
- Modify: `CLAUDE.md`, `architecture-overview.md`, `docs/dashboard-build-rules.md`

- [ ] **Step 1: CLAUDE.md — the whole-surface bullet**

Amend the existing "A confirmed spec **version** is whole-surface" bullet, keeping every sentence that is still true and adding:

```markdown
  The MODEL is asked only for the change: against a current-shape base it emits
  a PATCH (`lib/spec/patch.ts`, eight panel-granular ops) and the server applies
  it, so an untouched panel is COPIED rather than regenerated. The stored row is
  still the whole surface — `applyPatch` produces it and `parseSpecDraft`
  validates it, the same validator as ever — and the ops ride flat inside
  `payload` beside it, `null` when a version was authored whole-surface. A
  first version and a LEGACY base still author the whole surface: v1 has no base
  to patch, and a legacy row has no ids for an op to name and can never gain any.
```

- [ ] **Step 2: CLAUDE.md — the metrics bound**

Extend the spec-version-diffs sentence:

```markdown
  A `spec_proposed` row carries `authoring_mode` and `ops_count` — a mode name
  and a count. Never an op, never a panel id.
```

- [ ] **Step 3: architecture-overview.md**

In the proposal-loop section, state that the writer emits a patch against a
current base and the server applies it; in the metrics section, add
`authoring_mode` / `ops_count` to the list of first-class artifacts, noting they
are what makes the cost claim checkable after the fact.

- [ ] **Step 4: dashboard-build-rules.md**

```markdown
- The spec-writer emits a PATCH against a current base; the stored row is still
  the whole surface, so the build contract is unchanged.
  — CLAUDE.md > Dashboard folder conventions
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md architecture-overview.md docs/dashboard-build-rules.md
git commit -m "Document patch authoring and the invariants it preserves"
```

---

# PART C — PROPORTIONAL PREVIEW

> **Read before starting.** This part changes the mockup's output contract: the
> model stops emitting a whole HTML document and starts emitting one `<section>`
> per screen, with the document frame moving into `lib/spec/mockupCompose.ts`.
> `lib/spec/banner.ts` still injects the banner into the composed document and
> is unaffected.
>
> **The frame is platform-wide and plain; the screens inside it stay fully
> bespoke — Nico's direction, 2026-08-17.** The frame owns only what has to be
> shared: doctype, reset, the `body` background and type that match the app
> chrome, and a container. It does NOT own how a screen looks. The default
> classes ship inside the frame and the prompt offers them **as a nudge** — a
> styled starting point a model may use or ignore — never as a vocabulary it is
> confined to. Each friend's dashboard is a bespoke personal app; a fixed class
> list would have made every one of them look the same, which is the opposite of
> the product.
>
> **A fragment may therefore bring its own `<style>`, and `composeMockup` scopes
> it automatically** by prefixing every selector with that screen's container
> id. Fragments drawn weeks apart are composed into one document, so an unscoped
> `.panel { }` in a screen edited today would silently restyle a screen nobody
> touched. Scoping at compose time rather than asking the model to scope its own
> selectors is the same call `lib/spec/banner.ts` made (ledger D19): a guarantee
> the model cannot forget beats a rule it is asked to remember.

### Task 15: The fragment table

**Files:**
- Modify: `platform/schema.sql`
- Create: `lib/db/screenMockups.ts`
- Test: `tests/db/screenMockups.test.ts`

**Interfaces:**
- Produces: `insertScreenMockups(db, specId, fragments)`, `readScreenMockups(db, specId): Map<string, string>`.

- [ ] **Step 1: Add the table**

Append to `platform/schema.sql`:

```sql
-- Per-screen mockup fragments. Sacred like its neighbours: append-only, never
-- migrated. A row is one screen's HTML as drawn for one spec version.
--
-- A TABLE rather than more JSON inside specs.payload, and the difference is
-- load-bearing: payload is read on EVERY proposal to build the writer's
-- current-version block, so HTML in there would be fed back into the model's
-- own input. CREATE TABLE IF NOT EXISTS needs no migration mechanism — the
-- precedent is account_keys, added the same way for the same reason.
--
-- specs.mockup_html keeps holding the COMPOSED document, so pull-spec.sh,
-- users/<slug>/mockup.html, the admin Mockup tab and the build contract are
-- all untouched by this table's existence.
CREATE TABLE IF NOT EXISTS spec_screen_mockups (
  id        INTEGER PRIMARY KEY,
  spec_id   INTEGER NOT NULL,
  screen_id TEXT    NOT NULL,
  html      TEXT    NOT NULL,
  at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS spec_screen_mockups_unique
  ON spec_screen_mockups(spec_id, screen_id);

CREATE TRIGGER IF NOT EXISTS spec_screen_mockups_no_update
BEFORE UPDATE ON spec_screen_mockups
BEGIN
  SELECT RAISE(ABORT, 'spec_screen_mockups is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_screen_mockups_no_delete
BEFORE DELETE ON spec_screen_mockups
BEGIN
  SELECT RAISE(ABORT, 'spec_screen_mockups is append-only');
END;
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/db/screenMockups.test.ts
describe('spec_screen_mockups', () => {
  it('round-trips fragments for one spec', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: '<section>a</section>' }], 100)
    expect(readScreenMockups(db, 7).get('morning')).toBe('<section>a</section>')
  })

  it('keeps versions apart', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    insertScreenMockups(db, 8, [{ screenId: 'morning', html: 'b' }], 200)
    expect(readScreenMockups(db, 7).get('morning')).toBe('a')
    expect(readScreenMockups(db, 8).get('morning')).toBe('b')
  })

  it('rejects UPDATE and DELETE at the database', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    expect(() => db.prepare('UPDATE spec_screen_mockups SET html = ?').run('x')).toThrow(
      /append-only/,
    )
    expect(() => db.prepare('DELETE FROM spec_screen_mockups').run()).toThrow(/append-only/)
  })

  it('rejects a duplicate screen on one spec', () => {
    insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'a' }], 100)
    expect(() => insertScreenMockups(db, 7, [{ screenId: 'morning', html: 'b' }], 100)).toThrow()
  })

  it('returns an empty map for a spec with no fragments', () => {
    expect(readScreenMockups(db, 99).size).toBe(0)
  })
})
```

- [ ] **Step 3: Implement**

```ts
// lib/db/screenMockups.ts
//
// Appends and reads, nothing else — matching lib/db/specs.ts and
// lib/db/appendOnly.ts. No composition here; that is lib/spec/mockupCompose.ts.
import type { PlatformDb } from './platform'

export type ScreenFragment = { screenId: string; html: string }

/** All of a version's fragments, or none: a half-written set would compose
 * into a document with a screen silently missing. */
export function insertScreenMockups(
  db: PlatformDb,
  specId: number,
  fragments: ScreenFragment[],
  at: number,
): void {
  const stmt = db.prepare(
    'INSERT INTO spec_screen_mockups (spec_id, screen_id, html, at) VALUES (?, ?, ?, ?)',
  )
  db.transaction(() => {
    for (const f of fragments) stmt.run(specId, f.screenId, f.html, at)
  })()
}

export function readScreenMockups(db: PlatformDb, specId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT screen_id, html FROM spec_screen_mockups WHERE spec_id = ?')
    .all(specId) as { screen_id: string; html: string }[]
  return new Map(rows.map((r) => [r.screen_id, r.html]))
}
```

- [ ] **Step 4: Regenerate and run**

```bash
npm run synthetic
npx vitest run tests/db && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add platform/schema.sql lib/db/screenMockups.ts tests/db/screenMockups.test.ts
git commit -m "Add spec_screen_mockups: per-screen fragments, append-only"
```

---

### Task 16: Affected screens, the document shell, and composition

**Files:**
- Create: `lib/spec/mockupCompose.ts`
- Test: `tests/spec/mockupCompose.test.ts`

**Interfaces:**
- Consumes: `SpecPatchOp`, `Screen`.
- Produces: `affectedScreens(base: Screen[] | null, next: Screen[], ops: SpecPatchOp[] | null): string[]`, `composeMockup(screens: Screen[], fragments: Map<string, string>, only?: string[]): string`, `MOCKUP_SHELL_CLASSES`.

> **Two corrections ruled at pre-flight — read before writing the tests.**
>
> **The source screen of a removed or moved panel cannot be found in the
> result.** A removed panel is gone from `next`, and a moved panel is already at
> its destination — so resolving against `next` alone names no screen for
> `remove_panel` and only the destination for `move_panel`. The screen the panel
> LEFT would keep a stale fragment showing a panel that is no longer there, in
> the friend's preview *and* in the stored build contract. Hence the `base`
> parameter: sources resolve against `base`, destinations against `next` and the
> op.
>
> **`set_meta` affects NO screens.** The composed shell renders no title, summary
> or background, so a meta-only change alters no pixel. Returning every screen
> for it would redraw the whole dashboard — the exact cost this branch exists to
> avoid. An empty result is legitimate and Task 18 handles it by skipping the
> mockup call entirely.

- [ ] **Step 1: Write the failing tests**

```ts
describe('affectedScreens', () => {
  it('returns every screen id when ops is null — a whole-surface version', () => {
    expect(affectedScreens(null, SCREENS, null)).toEqual(['morning', 'money'])
  })

  it('names the screen a replaced panel lives on', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'replace_panel', panel: panel('eating_out') }]))
      .toEqual(['morning'])
  })

  // BOTH ends. The destination is where it now is; the source is where it was,
  // and that screen has to be redrawn without it.
  it('names both ends of a move', () => {
    const next = movePanel(SCREENS, 'eating_out', 'money')
    expect(affectedScreens(SCREENS, next, [
      { op: 'move_panel', panel_id: 'eating_out', screen_id: 'money' },
    ])).toEqual(['morning', 'money'])
  })

  // The panel is gone from `next`, so only `base` knows which screen lost it.
  it('names the screen a removed panel used to live on', () => {
    const next = removePanel(SCREENS, 'eating_out')
    expect(affectedScreens(SCREENS, next, [{ op: 'remove_panel', id: 'eating_out' }]))
      .toEqual(['morning'])
  })

  it('names an added screen', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'add_screen', screen: SCREENS[1]! }]))
      .toContain('money')
  })

  it('never names a screen that no longer exists', () => {
    expect(affectedScreens(SCREENS, SCREENS, [{ op: 'remove_screen', id: 'gone' }])).toEqual([])
  })

  // The shell renders no meta, so nothing is redrawn. Task 18 skips the call.
  it('names no screen for set_meta', () => {
    expect(affectedScreens(SCREENS, SCREENS, [
      { op: 'set_meta', title: 'X', summary: null, background: null },
    ])).toEqual([])
  })

  it('deduplicates and returns screens in document order', () => {
    const ops = [
      { op: 'replace_panel' as const, panel: panel('walks') },
      { op: 'replace_panel' as const, panel: panel('eating_out') },
    ]
    expect(affectedScreens(SCREENS, SCREENS, ops)).toEqual(['morning'])
  })
})

describe('composeMockup', () => {
  it('emits one document in screen order', () => {
    const html = composeMockup(SCREENS, new Map([['morning', '<section>M</section>'], ['money', '<section>£</section>']]))
    expect(html).toMatch(/^<!doctype html>/i)
    expect(html.indexOf('<section>M')).toBeLessThan(html.indexOf('<section>£'))
  })

  it('orders by screen.order, not by array position', () => {
    const reordered = [{ ...SCREENS[1]!, order: 1 }, { ...SCREENS[0]!, order: 2 }]
    const html = composeMockup(reordered, FRAGMENTS)
    expect(html.indexOf('<section>£')).toBeLessThan(html.indexOf('<section>M'))
  })

  it('composes only the named screens when `only` is given', () => {
    const html = composeMockup(SCREENS, FRAGMENTS, ['morning'])
    expect(html).toContain('<section>M')
    expect(html).not.toContain('<section>£')
  })

  // The case a friend hits when one request touches two screens at once — a
  // panel moved between them, or two panels edited on different screens. Both
  // must appear, in order, and an untouched third must not.
  it('composes EVERY named screen when several are affected, in order', () => {
    const three = [...SCREENS, { ...SCREENS[0]!, id: 'gym', title: 'Gym', order: 3 }]
    const fragments = new Map([...FRAGMENTS, ['gym', '<section>G</section>']])
    const html = composeMockup(three, fragments, ['morning', 'money'])
    expect(html).toContain('<section>M')
    expect(html).toContain('<section>£')
    expect(html).not.toContain('<section>G')
    expect(html.indexOf('<section>M')).toBeLessThan(html.indexOf('<section>£'))
  })

  it('scopes a fragment\'s own <style> to its screen, so it cannot reach a neighbour', () => {
    const fragments = new Map([
      ['morning', '<section><style>.tile { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    // Prefixed, not passed through: an unscoped .tile would restyle `money`
    // too — and `money` may have been drawn weeks earlier by another call.
    expect(html).not.toMatch(/(^|\})\s*\.tile\s*\{/)
    expect(html).toMatch(/#screen-morning[^{]*\.tile\s*\{/)
  })

  it('scopes every selector in a comma-separated group, not just the first', () => {
    const fragments = new Map([
      ['morning', '<section><style>.a, .b { color: red }</style>M</section>'],
      ['money', '<section>£</section>'],
    ])
    const html = composeMockup(SCREENS, fragments)
    expect(html).toMatch(/#screen-morning[^{]*\.a/)
    expect(html).toMatch(/#screen-morning[^{]*\.b/)
  })

  it('throws when a screen has no fragment rather than composing a gap', () => {
    expect(() => composeMockup(SCREENS, new Map([['morning', 'x']]))).toThrow(/money/)
  })

  it('carries the stylesheet, so fragments drawn in different versions match', () => {
    expect(composeMockup(SCREENS, FRAGMENTS)).toContain('.panel')
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/mockupCompose.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/spec/mockupCompose.ts
//
// The document half of the mockup. The MODEL draws one <section> per screen;
// this file owns everything around them.
//
// THE STYLESHEET LIVES HERE, NOT IN THE MODEL'S OUTPUT, and that is what makes
// fragment reuse possible at all: a document composed from sections drawn
// weeks apart, by separate calls, would otherwise carry two stylesheets that
// disagree, and the unchanged screens would visibly shift every time a
// neighbour was edited.
//
// lib/spec/banner.ts still injects the SYNTHETIC banner into the composed
// document at serve time and is untouched by any of this.
import type { Screen } from './schema'
import type { SpecPatchOp } from './patch'

/**
 * The classes the frame styles for you. A NUDGE, not a vocabulary — a model may
 * use them, extend them, or ignore them entirely and bring its own `<style>`.
 * Kept beside the stylesheet that defines them so the prompt and the CSS cannot
 * drift. Each friend's dashboard is a bespoke personal app; confining every one
 * of them to six class names would make them all look the same.
 */
export const MOCKUP_SHELL_CLASSES = ['screen', 'screen-title', 'panel', 'panel-title', 'figure', 'note'] as const

/**
 * Which screens a patch changed, in the NEXT version's document order.
 *
 * `ops === null` means the version was authored whole-surface, so everything is
 * affected — v1, and the one-time legacy fallback. `base` is null there too.
 *
 * TWO SIDES, TWO SOURCES OF TRUTH, and this is the whole subtlety. A panel that
 * was removed is gone from `next`, and a panel that was moved is already at its
 * destination — so `next` cannot say which screen either one LEFT. That screen
 * has to be redrawn without it, or it keeps a carried-forward fragment showing a
 * panel that is no longer there, both on the friend's card and in the stored
 * build contract. Sources therefore resolve against `base`; destinations
 * against `next` and the op itself.
 *
 * A screen named by an op but absent from `next` is DROPPED rather than
 * returned: a removed screen has no fragment to draw and nothing to preview.
 */
export function affectedScreens(
  base: Screen[] | null,
  next: Screen[],
  ops: SpecPatchOp[] | null,
): string[] {
  const order = next.map((s) => s.id)
  if (ops === null) return order

  const touched = new Set<string>()
  const screenIn = (screens: Screen[], panelId: string): string | undefined =>
    screens.find((s) => s.panels.some((p) => p.id === panelId))?.id
  const was = (panelId: string) => (base ? screenIn(base, panelId) : undefined)

  for (const op of ops) {
    switch (op.op) {
      // NOTHING. The composed shell renders no title, summary or background, so
      // a meta-only change alters no pixel — and redrawing every screen for it
      // would be the whole cost this branch exists to avoid. An empty result is
      // legitimate; lib/spec/author.ts skips the mockup call on it.
      case 'set_meta':
        break
      case 'add_screen':
        touched.add(op.screen.id)
        break
      case 'update_screen':
        touched.add(op.id)
        break
      case 'remove_screen':
        break // nothing left to draw
      case 'add_panel':
        touched.add(op.screen_id)
        break
      case 'replace_panel': {
        // Still present in `next`, and it cannot have moved — replace keeps a
        // panel's position — so either side answers. `next` is the honest one.
        const id = screenIn(next, op.panel.id)
        if (id) touched.add(id)
        break
      }
      case 'remove_panel': {
        // Only `base` remembers where it was.
        const from = was(op.id)
        if (from) touched.add(from)
        break
      }
      case 'move_panel': {
        touched.add(op.screen_id)
        const from = was(op.panel_id)
        if (from) touched.add(from)
        break
      }
    }
  }
  return order.filter((id) => touched.has(id))
}

/**
 * The frame, in two halves, and the split is the design.
 *
 * FRAME owns only what must be shared for fragments drawn at different times to
 * sit in one document without fighting: the reset, the page background and type
 * that match the app chrome, and the container width. Nothing here decides how
 * a panel looks.
 *
 * NUDGE is the published default styling for MOCKUP_SHELL_CLASSES. It is a
 * starting point, deliberately plain, and a fragment is free to override any of
 * it or ignore it entirely — which is why it is defined BEFORE any fragment's
 * own scoped rules are appended, so a fragment always wins on specificity.
 */
const FRAME = `
  *, *::before, *::after { box-sizing: border-box; }
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: Canvas; color: CanvasText; }
  .frame { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem; }
`

const NUDGE = `
  .screen-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 1rem; opacity: 0.7; }
  .panel { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
           border-radius: 0.75rem; padding: 1rem; margin: 0 0 1rem; }
  .panel-title { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; }
  .figure { font-size: 2rem; font-weight: 700; letter-spacing: -0.02em; }
  .note { font-size: 0.85rem; opacity: 0.65; }
`

/**
 * Lift a fragment's own `<style>` out and rewrite every selector under
 * `#screen-<id>`, so bespoke styling cannot escape the screen that authored it.
 *
 * Done HERE rather than asked of the model, for the reason lib/spec/banner.ts
 * gives (ledger D19): a composed document holds fragments drawn weeks apart by
 * separate calls, and one unscoped `.panel { }` would restyle a screen nobody
 * touched. A rule the model must remember is a rule that eventually is not.
 *
 * Bounded on purpose. It handles the shapes a preview actually uses — plain
 * selectors, comma-separated groups, and `@media` blocks — and DROPS anything
 * it cannot scope safely (`@import`, and bare `html`/`body`/`:root` selectors,
 * which are the frame's to own). Dropping beats passing through: an unscopable
 * rule is exactly the one that would leak.
 */
function scopeFragmentStyles(html: string, screenId: string): string { /* … */ }

/**
 * One document from per-screen fragments.
 *
 * `only` scopes it to the screens a patch touched — the friend's preview card.
 * Omitted, it composes the whole dashboard, which is what `specs.mockup_html`
 * stores and what the builder builds toward.
 *
 * A MISSING FRAGMENT THROWS. Composing around a gap would produce a document
 * that looks complete and is silently missing a screen — and for
 * `specs.mockup_html` that document is the build contract.
 */
export function composeMockup(
  screens: Screen[],
  fragments: Map<string, string>,
  only?: string[],
): string {
  const wanted = only ? screens.filter((s) => only.includes(s.id)) : screens
  const ordered = [...wanted].sort((a, b) => a.order - b.order)

  // Each fragment goes inside its own #screen-<id> wrapper, which is both the
  // scoping anchor for its styles and the boundary that keeps two screens'
  // markup from running together.
  const body = ordered
    .map((screen) => {
      const html = fragments.get(screen.id)
      if (html === undefined) {
        throw new Error(`composeMockup: no fragment for screen "${screen.id}"`)
      }
      return `<div id="screen-${screen.id}">${scopeFragmentStyles(html, screen.id)}</div>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${FRAME}${NUDGE}</style>
</head>
<body>
<div class="frame">
${body}
</div>
</body>
</html>`
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run tests/spec/mockupCompose.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add lib/spec/mockupCompose.ts tests/spec/mockupCompose.test.ts
git commit -m "Compose a mockup from per-screen fragments; resolve affected screens from ops"
```

---

### Task 17: The per-screen mockup prompt

**Files:**
- Create: `platform/prompts/mockup-v4.md`
- Modify: `lib/chat/prompt.ts`, `lib/spec/schema.ts` (`SCREEN_MOCKUP_JSON_SCHEMA`)
- Test: `tests/chat/prompt.test.ts`, `tests/spec/schema.test.ts`

**Interfaces:**
- Produces: `MOCKUP_SCREENS_PROMPT = 'mockup-v4.md'`, `SCREEN_MOCKUP_JSON_SCHEMA`, `parseScreenMockups(raw: unknown): ScreenFragment[]`.

- [ ] **Step 1: Write `mockup-v4.md`**

Carry over mockup-v3's restraint section, its plausible-numbers rule, its
"metadata decides how to render, never rendered as caption" rule, and its "do
not add a banner" rule verbatim. Replace the output section with:

```markdown
## What you emit

One entry per screen you are given: its `id`, and `html` — a single
`<section class="screen">` element and nothing outside it.

No `<!doctype>`, no `<html>`, no `<head>`, no `<style>`, no `<script>`. The
document and its stylesheet are added around your sections afterwards, and a
second stylesheet inside one of them would make that screen disagree with the
ones drawn beside it.

## The frame around you

Your section is placed inside a plain page frame that is the same for
everybody: a reset, the page background and type, and a centred column. It
matches the app this person actually uses, so what you draw sits in the right
context without you having to build one.

The frame does not decide how your screen looks. That is yours.

## A starting point, not a vocabulary

These classes are already styled for you, so a plain panel needs no CSS at all:

- `screen` — on your one outer `<section>`.
- `screen-title` — the screen's own heading.
- `panel` — one per panel.
- `panel-title` — a panel's name.
- `figure` — a large number, the thing the eye lands on.
- `note` — small secondary text under a figure.

**Use them, extend them, or ignore them.** This is one person's own app, not a
template — if their screen wants a table, a two-column split, a progress bar, a
colour that means something to them, draw that. A dashboard that looks like
everyone else's has missed the point.

To style your own way, include ONE `<style>` block inside your section and
write ordinary CSS. Your rules are automatically confined to your own screen
before the page is assembled, so you cannot affect anybody else's and nobody
else can affect yours — write selectors as if your screen were the whole
document.

Two things to avoid, because they cannot be confined and will be dropped:
`@import`, and rules targeting `html`, `body` or `:root` — the frame owns
those. Everything else is yours.

Still no `<!doctype>`, no `<html>`, no `<head>`: you are writing one section,
not a page.
```

- [ ] **Step 2: Add the schema and parser**

In `lib/spec/schema.ts`:

```ts
/**
 * The per-screen mockup call's contract. An ARRAY, so one call draws every
 * affected screen — a call per screen would multiply latency by the number of
 * screens for no gain, since they are drawn from one prompt anyway.
 */
export const SCREEN_MOCKUP_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    screens: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' }, html: { type: 'string' } },
        required: ['id', 'html'],
      },
    },
  },
  required: ['screens'],
} as const
```

In `lib/spec/validate.ts`:

```ts
/**
 * Validate the per-screen mockup reply.
 *
 * Every requested screen must come back, and nothing else may. A silently
 * missing screen would compose into a document with a hole in it, and an extra
 * one would be a screen the spec does not contain — the same "a promise made
 * on the friend's behalf" that ledger D7 split the mockup call to prevent.
 */
export function parseScreenMockups(raw: unknown, requested: string[]): ScreenFragment[] {
  const src = record(raw, 'mockup')
  const screens = arrayField(src, 'screens', 'mockup')
  const out = screens.map((s, i) => {
    const entry = record(s, `mockup.screens[${i}]`)
    return {
      screenId: text(entry, 'id', `mockup.screens[${i}]`),
      html: text(entry, 'html', `mockup.screens[${i}]`),
    }
  })

  const got = new Set(out.map((f) => f.screenId))
  for (const id of requested) {
    if (!got.has(id)) throw new SpecShapeError(`mockup is missing screen "${id}"`)
  }
  for (const f of out) {
    if (!requested.includes(f.screenId)) {
      throw new SpecShapeError(`mockup returned screen "${f.screenId}", which was not requested`)
    }
  }
  return out
}
```

- [ ] **Step 3: Test both**

```ts
  it('accepts exactly the requested screens', () => {
    expect(parseScreenMockups({ screens: [{ id: 'a', html: '<section/>' }] }, ['a'])).toHaveLength(1)
  })
  it('throws on a missing screen', () => {
    expect(() => parseScreenMockups({ screens: [] }, ['a'])).toThrow(/missing screen "a"/)
  })
  it('throws on an unrequested screen', () => {
    expect(() => parseScreenMockups({ screens: [{ id: 'b', html: 'x' }] }, ['a'])).toThrow(/not requested/)
  })
```

- [ ] **Step 4: Run and commit**

```bash
npx vitest run tests/spec tests/chat/prompt.test.ts && npx tsc --noEmit
git add platform/prompts/mockup-v4.md lib/chat/prompt.ts lib/spec/schema.ts lib/spec/validate.ts tests
git commit -m "Add mockup-v4.md: per-screen fragments against a fixed class list"
```

---

### Task 18: Draw only what changed, carry the rest forward

**Files:**
- Modify: `lib/spec/author.ts`
- Test: `tests/spec/author.test.ts`

**Interfaces:**
- Consumes: Tasks 15–17.
- Produces: `Proposal.preview_html`, fragments written per version.

- [ ] **Step 1: Write the failing tests**

```ts
describe('scoped mockup', () => {
  it('asks the model only for the affected screens', async () => {
    confirmCurrentSpec(db, accountId, TWO_SCREEN_BASE)
    clientReturnsPatch([{ op: 'replace_panel', panel: panel('eating_out') }])
    await authorSpec(deps, input)
    const mockupCall = client.propose.mock.calls[1][0]
    expect(JSON.stringify(mockupCall.messages)).toContain('morning')
    expect(JSON.stringify(mockupCall.messages)).not.toContain('money')
  })

  it('carries the unchanged screen\'s fragment forward from the base version', async () => {
    confirmCurrentSpec(db, accountId, TWO_SCREEN_BASE)   // fragments already stored
    clientReturnsPatch([{ op: 'replace_panel', panel: panel('eating_out') }])
    const proposal = await authorSpec(deps, input)
    const fragments = readScreenMockups(db, proposal!.id)
    expect(fragments.get('money')).toBe(baseFragment('money'))
    expect(fragments.get('morning')).not.toBe(baseFragment('morning'))
  })

  it('stores the WHOLE composed document as mockup_html — the build contract', async () => {
    confirmCurrentSpec(db, accountId, TWO_SCREEN_BASE)
    clientReturnsPatch([{ op: 'replace_panel', panel: panel('eating_out') }])
    const proposal = await authorSpec(deps, input)
    const stored = specById(db, proposal!.id).mockup_html
    expect(stored).toContain('morning')
    expect(stored).toContain('money')
  })

  it('previews ONLY the affected screen', async () => {
    confirmCurrentSpec(db, accountId, TWO_SCREEN_BASE)
    clientReturnsPatch([{ op: 'replace_panel', panel: panel('eating_out') }])
    const proposal = await authorSpec(deps, input)
    expect(proposal!.preview_html).toContain('morning')
    expect(proposal!.preview_html).not.toContain('money')
  })

  it('previews the whole dashboard for a first version', async () => {
    clientReturnsWholeSurface(TWO_SCREEN_DRAFT)
    const proposal = await authorSpec(deps, input)
    expect(proposal!.preview_html).toContain('money')
  })

  it('writes no spec row when a fragment is missing for an unchanged screen', async () => {
    confirmCurrentSpecWithoutFragments(db, accountId, TWO_SCREEN_BASE)
    clientReturnsPatch([{ op: 'replace_panel', panel: panel('eating_out') }])
    expect(await authorSpec(deps, input)).toBeUndefined()
    expect(lastMetric(db, 'spec_error').kind).toBe('mockup_failed')
  })
})
```

> The last case is the one that matters: a version confirmed **before** Part C
> shipped has no fragments at all. Its next patch cannot carry anything forward.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/spec/author.test.ts`
Expected: FAIL — `preview_html` does not exist.

- [ ] **Step 3: Implement**

Replace the mockup block in `authorSpec` with:

```ts
      input.onStage?.('mockup')

      // base is the version the patch was applied to — null on the
      // whole-surface paths, where ops is null and everything is affected.
      const affected = affectedScreens(base ?? null, draft.screens, patch?.ops ?? null)

      // Fragments this version keeps unchanged, taken from the version the
      // patch was applied to. A version confirmed BEFORE this existed has
      // none, which is why the composition below can fail — and it fails as a
      // mockup_failed with no row written, exactly like any other mockup
      // failure, rather than composing a document with holes in it.
      const carried = current === undefined ? new Map() : readScreenMockups(db, current.id)
      fragments = new Map(carried)

      // NO AFFECTED SCREENS MEANS NO CALL. A meta-only patch changes the spec
      // and no pixel, so there is nothing to draw and every fragment carries
      // forward untouched. Skipping is not an optimisation here — asking for a
      // mockup of zero screens would send an empty list and get back something
      // that could only be wrong. mockupResult stays undefined, and the metrics
      // helper already reports null for a call that never happened.
      if (affected.length > 0) {
        const mockupPrompt = loadPrompt(MOCKUP_SCREENS_PROMPT)
        mockupPromptSha = mockupPrompt.sha
        mockupResult = await client.propose({
          system: mockupPrompt.text,
          // Only the affected screens, from the VALIDATED draft (ledger D7).
          messages: [
            {
              role: 'user',
              content: JSON.stringify({
                title: draft.title,
                screens: draft.screens.filter((s) => affected.includes(s.id)),
              }),
            },
          ],
          signal: input.signal,
          schema: SCREEN_MOCKUP_JSON_SCHEMA,
        })

        for (const f of parseScreenMockups(mockupResult.input, affected)) {
          fragments.set(f.screenId, f.html)
        }
      }

      // The WHOLE document: this is specs.mockup_html, which is the build
      // contract on disk and what the admin pane renders. Throws if any screen
      // has no fragment.
      mockupHtml = composeMockup(draft.screens, fragments)
      // The friend's card: only what changed. For v1, affected IS every
      // screen, so this degenerates to the whole dashboard — which is correct,
      // because on a first version everything is new. An EMPTY affected list
      // falls back to the whole dashboard too: a meta-only change has no screen
      // to point at, and a blank card is worse than a redundant one at the
      // moment someone is deciding whether to confirm.
      previewHtml =
        affected.length > 0
          ? composeMockup(draft.screens, fragments, affected)
          : mockupHtml
```

After `insertSpec`, inside the same flow:

```ts
    // The fragments belong to THIS version. They are written after the spec row
    // exists because they key on its id, and before the proposal is returned so
    // the next patch can carry them forward.
    insertScreenMockups(
      db,
      id,
      draft.screens.map((s) => ({ screenId: s.id, html: fragments.get(s.id)! })),
      at,
    )
```

Add `preview_html: string` to the `Proposal` type with a comment explaining it
is the scoped card and `mockup_html` is the whole build contract, and return it.

- [ ] **Step 4: Run**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add lib/spec/author.ts tests/spec/author.test.ts
git commit -m "Draw only the screens a patch touched; carry the rest forward"
```

---

### Task 19: The card shows the affected surface

**Files:**
- Modify: `app/api/chat/route.ts` (the `proposal` NDJSON line), `app/[user]/ChatPanel.tsx`, `app/[user]/page.tsx`
- Test: `tests/chat/panel.test.ts`

**Interfaces:**
- Consumes: `Proposal.preview_html` (Task 18), `readScreenMockups`, `composeMockup`, `affectedScreens`.

- [ ] **Step 1: Write the failing tests**

```ts
  it('renders the scoped preview, not the whole dashboard', async () => {
    const card = renderCard({ ...PROPOSAL, preview_html: '<section>morning</section>',
                              mockup_html: '<section>morning</section><section>money</section>' })
    expect(card).toContain('morning')
    expect(card).not.toContain('money')
  })

  // The same defect shape as ledger D9's: a value computed once per page load
  // and applied to cards that stream in later.
  it('uses each card\'s own preview when one streams in mid-conversation', async () => {
    const state = applyTurn(initial, { proposal: { ...PROPOSAL, preview_html: '<section>B</section>' } })
    expect(renderState(state)).toContain('<section>B</section>')
  })

  it('falls back to the whole mockup for a card with no scoped preview', () => {
    const { preview_html, ...legacy } = PROPOSAL
    expect(renderCard(legacy)).toContain('money')
  })
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run tests/chat/panel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Add `preview_html` to the `proposal` NDJSON payload in `app/api/chat/route.ts`.
- In `ChatPanel.tsx`, make the iframe `srcDoc` read `proposal.preview_html ?? proposal.mockup_html`. Comment it exactly as the `first` fallback is commented — **held by tests, not by the compiler**, and name `tests/chat/panel.test.ts` as what catches its removal.
- In `app/[user]/page.tsx`, build `preview_html` for the page-load card by reading the spec's fragments and composing with `affectedScreens(version.screens, version.ops)`. A row with no fragments composes nothing — fall back to `mockup_html` there rather than throwing, because a page render must not fail over a preview.

- [ ] **Step 4: Look at it**

```bash
npm run shots -- --task=19
```

Add a screen to `screenshots/screens.ts` for a scoped proposal card at 375 and 1440. **This is a review gate, not a test** — check that a one-panel change reads as a change and not as a broken, half-drawn dashboard. Note on the screen entry, as `mockup-document` already does, that a fixture proves nothing about generated output.

- [ ] **Step 5: Run and commit**

```bash
npx vitest run && npx tsc --noEmit
git add app tests/chat/panel.test.ts screenshots/screens.ts
git commit -m "Show the affected surface on the proposal card"
```

---

### Task 20: Document Part C, and open the ledger

**Files:**
- Create: `docs/superpowers/ledgers/scoped-specs.md`
- Modify: `CLAUDE.md`, `architecture-overview.md`

- [ ] **Step 1: CLAUDE.md — sacred data**

Add `spec_screen_mockups` to the append-only list, with the reason it is a
table rather than more JSON in `payload`.

- [ ] **Step 2: CLAUDE.md — the proposal loop**

Record that the card shows the affected surface, that `specs.mockup_html` is
still the whole composed document and still the build contract, and that the
stylesheet lives in `lib/spec/mockupCompose.ts` **because fragments drawn weeks
apart must match**.

- [ ] **Step 3: Open the ledger**

Write `docs/superpowers/ledgers/scoped-specs.md` with the spec and plan paths,
the branch name, and a **Rulings** section carrying, at minimum:

- **D1.** Patch authored, whole surface stored — and *why* delta-only storage
  was rejected: `specs` rejects UPDATE, so one bad delta corrupts every version
  after it with no repair path, and `diff.ts` computing whole-vs-whole is what
  lets the ops be checked against what actually changed.
- **D2.** `ops` is `null`, never `[]`, for a whole-surface version.
- **D3.** v1 and a legacy base author whole-surface. R3's behaviour-preserving
  requirement is met by running the same code, not by testing around it.
- **D4.** The announcement is an update, never a disclosure (Nico, 2026-08-17).
  `## Open` is builder-only and routes back to the chat.
- **D5.** The mockup stylesheet moved out of model output into
  `mockupCompose.ts`, because fragment reuse requires it.
- **D6.** Panel granularity for ops, and why finer ops were rejected.

Leave **Built** and **Residual risks** empty until the branch lands.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ledgers/scoped-specs.md CLAUDE.md architecture-overview.md
git commit -m "Document the scoped preview and open the scoped-specs ledger"
```

---

### Task 21: The live checkpoint

**Files:**
- Modify: `docs/superpowers/ledgers/scoped-specs.md`

**Interfaces:** none — this is a production run, not code.

> **Why this is a task and not a nicety.** The suite drives a fake client, so
> nothing local can tell you that the API accepts `PATCH_JSON_SCHEMA`, that
> `spec-v3.md` produces output `parsePatch` accepts, or that `mockup-v4.md`
> respects the class list. The unified-loop ledger records that these are the
> exact properties only a production run ever settled.

- [ ] **Step 1: Ship the branch**

Merge to `main` with `--no-ff`, push (Gate E then Gate D), then
`ssh "$DROPLET" '/home/deploy/stairwell/deploy/deploy.sh'`. Twice, if the pull
changed `deploy.sh` or `smoke.sh`.

- [ ] **Step 2: Run three cases on a throwaway slug**

1. **A first version.** New invite, new account, interview, confirm. Expect
   `authoring_mode: 'whole'`, `ops` null, the card showing the whole dashboard,
   and the delivery line reading "tomorrow morning".
2. **A patch against it.** Ask for one panel to be relabelled. Expect
   `authoring_mode: 'patch'`, a small `ops_count`, a card showing **only** that
   screen, and "a few hours".
3. **A legacy base.** Same against `devtwo`, whose confirmed v1 is legacy.
   Expect `authoring_mode: 'whole'` and a working proposal.

- [ ] **Step 3: Run the announce flow end to end**

Write `users/<slug>/notes/v2.md`, run the announcer **without** `--send`, read
the draft, then send it. Confirm the transcript row carries `announce-v1.md`'s
sha and `session_id = 'operator'`.

- [ ] **Step 4: Read the cost, which is the whole claim**

```sql
SELECT json_extract(data,'$.authoring_mode') AS mode,
       COUNT(*) AS n,
       AVG(json_extract(data,'$.output')) AS avg_spec_out,
       AVG(json_extract(data,'$.mockup_output')) AS avg_mockup_out
FROM metrics WHERE event='spec_proposed' GROUP BY mode;
```

Run it on the droplet. Record the numbers in the ledger against §6 of the
design doc's estimates. **If patch-mode output is not materially below
whole-mode output, say so in the ledger** — the design's central claim is a
cost claim, and an unverified one is worth less than a disproved one.

- [ ] **Step 5: Write up the checkpoint**

Fill in **Built** and **Residual risks** in `docs/superpowers/ledgers/scoped-specs.md`.
Name anything not verified, as the unified-loop ledger's own checkpoint section does.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/ledgers/scoped-specs.md
git commit -m "Record the scoped-specs live checkpoint"
```

---

## Self-Review

**Spec coverage.** Design §3.1 → Tasks 1, 3. §3.2 (no-data rule) → Task 8. §3.3 (two gates) → Tasks 3, 7. §3.4 (drafted announcement, parser bound, prompt_sha, dry run, `--plain`, required-env) → Tasks 4–7. §3.5 (routing) → Task 7 warning + Task 8 docs. §4.1 (ops) → Task 9. §4.2 (applier) → Task 10. §4.3 (storage, `ops` null vs `[]`, `parseSpecVersion` preserving) → Task 11. §4.4 (three paths) → Task 13. §4.5 (metrics) → Task 13. §5 (affected screens, scoped drawing, scoped card, fragment table, stylesheet move) → Tasks 15–19. §7 failure modes → the tests named in Tasks 7, 10, 17, 18. §8 file list → all tasks. Live checkpoint → Task 21.

**Two gaps found and closed while reviewing:** Task 18's "a version confirmed before Part C has no fragments" case, which the spec implies but never states, and Task 19's page-load fallback for the same reason.

**Type consistency.** `sealVersion(draft, basedOnVersion, ops)` is three-argument from Task 11 onward and every call site is fixed there. `parseScreenMockups(raw, requested)` takes two arguments in both Task 17 and Task 18. `friendFacing` returns `FriendFacingNotes` in Tasks 1, 5, 7. `announceTarget` returns the `ok` discriminated union in Tasks 6 and 7. `composeMockup(screens, fragments, only?)` matches between Tasks 16, 18, 19.

**Known deviation from the plan-writing default:** Tasks 8, 14, 20 are documentation-only and carry no test cycle. Docs are exempt from Gate B by path, and folding them into their neighbouring code tasks would have made three already-large tasks larger without adding a reviewable boundary.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-17-scoped-specs-and-build-notes.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
