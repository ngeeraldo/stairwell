# Step 4 — Interview → Structured Spec Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent proposes a spec and a rendered HTML mockup inline in chat, the friend confirms it with a button, and the confirmed artifact lands in the admin portal and reaches the repo through one command.

**Architecture:** The chat call gains a zero-payload `propose_spec` tool — the agent raising its hand. A second, non-streaming call with structured outputs (`output_config.format`) authors the spec and mockup under its own prompt file. Both are persisted to two new append-only tables in the platform database; confirmation is a second append, and a `scripts/pull-spec.sh` run from the laptop projects the record into `users/<name>/spec.md` + `mockup.html`.

**Tech Stack:** Next.js App Router (server components + route handlers), `@anthropic-ai/sdk` 0.116, `better-sqlite3-multiple-ciphers`, Vitest, `tsx` for scripts. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-12-step4-spec-flow-design.md`

## Global Constraints

- **Node `>=22 <23`.** No new npm dependencies — there is no schema library; validators are hand-written.
- **All dev and testing runs on synthetic data only.** Never open, read, or query any `*.db` other than `synthetic.db` (CLAUDE.md > Data safety). Tests build their own database in a `mkdtempSync` directory.
- **No test makes a network call.** `runTurn` and the authoring path take their client as a parameter; the suite supplies a fake (CLAUDE.md > Testing).
- **`schema.sql` + seed + `tests/` update in the same commit.** No drift.
- **`transcripts`, `metrics`, `specs`, `spec_confirmations` are append-only.** Never migrate, rewrite, or clean up. `lib/db/reshape.ts` is NOT widened to cover the two new tables (spec §2.4).
- **Run tests with `npx vitest run`.** Scope with a path: `npx vitest run tests/spec`.
- **Gate B (pre-commit):** a change under `app/`, `lib/`, `platform/`, `scripts/`, or `middleware.ts` must stage a test under `tests/`. `platform/prompts/*` is exempt by an explicit arm. `users/*/spec.md` and `mockup.html` are exempt.
- **Gate C (pre-commit typecheck):** any staged `.ts`/`.tsx` runs `npx tsc --noEmit`.
- **`tsconfig` has `noUncheckedIndexedAccess`.** Indexing an array yields `T | undefined`; guard or use `!` with a comment saying why it holds.
- **Exact copy, verbatim** — the proposal card's buttons and delivery line:
  - `Build this`
  - `Not quite yet`
  - `Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.`
- **Mockup containment, everywhere it renders:** `<iframe srcDoc={html} sandbox="" />`. Never `allow-scripts`. Never `allow-same-origin`.
- **The six spec fields are frozen:** `title`, `summary`, `background`, `panels`, `manual_logging`, `open_questions`.

---

### Task 1: The `specs` and `spec_confirmations` tables

**Files:**
- Modify: `platform/schema.sql` (append after the `requests` table and its triggers)
- Create: `lib/db/specs.ts`
- Test: `tests/db/specs.test.ts`

**Interfaces:**
- Consumes: `PlatformDb` from `@/lib/db/platform`.
- Produces:
  - `type SpecRecord = { id: number; account_id: number; conversation_id: string; prompt_sha: string; payload: string; mockup_html: string; at: number; confirmed_at: number | null; version: number }`
  - `insertSpec(db, {accountId, conversationId, promptSha, payload, mockupHtml, at}): number` — `payload` is an object, JSON-stringified here.
  - `readSpecs(db, accountId): SpecRecord[]` — newest first.
  - `newestSpec(db, accountId): SpecRecord | undefined`
  - `currentSpec(db, accountId): SpecRecord | undefined` — newest confirmed.
  - `hasConfirmedSpec(db, accountId): boolean`
  - `confirmSpec(db, {specId, accountId, at}): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db/specs.test.ts`:

```ts
// tests/db/specs.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import {
  confirmSpec,
  currentSpec,
  hasConfirmedSpec,
  insertSpec,
  newestSpec,
  readSpecs,
} from '@/lib/db/specs'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-specs-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(accountId: number, title: string, at: number): number {
  return insertSpec(db, {
    accountId,
    conversationId: 'conv-1',
    promptSha: 'sha123456789',
    payload: { title },
    mockupHtml: `<!doctype html><p>${title}</p>`,
    at,
  })
}

describe('insertSpec / readSpecs', () => {
  it('round-trips the payload and the mockup', () => {
    write(1, 'FIRST TEST DASHBOARD', 1_000)
    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.payload)).toEqual({ title: 'FIRST TEST DASHBOARD' })
    expect(rows[0]!.mockup_html).toContain('FIRST TEST DASHBOARD')
  })

  it('returns newest first and numbers versions oldest-to-newest', () => {
    write(1, 'one', 1_000)
    write(1, 'two', 2_000)
    write(1, 'three', 3_000)
    const rows = readSpecs(db, 1)
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1])
    expect(JSON.parse(rows[0]!.payload).title).toBe('three')
  })

  it('scopes to one account', () => {
    write(1, 'mine', 1_000)
    write(2, 'theirs', 2_000)
    expect(readSpecs(db, 1)).toHaveLength(1)
    expect(readSpecs(db, 99)).toEqual([])
  })
})

describe('confirmation', () => {
  it('is null until confirmed, then carries the timestamp', () => {
    const id = write(1, 'one', 1_000)
    expect(newestSpec(db, 1)!.confirmed_at).toBeNull()
    expect(hasConfirmedSpec(db, 1)).toBe(false)

    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    expect(newestSpec(db, 1)!.confirmed_at).toBe(5_000)
    expect(hasConfirmedSpec(db, 1)).toBe(true)
  })

  it('reports the EARLIEST confirmation and never duplicates the row', () => {
    // Two confirmations for one spec is the documented concurrent-confirm
    // race (spec section 12). It must not double the spec in readSpecs, and
    // the reported moment must be the first one — that is when the friend
    // actually decided.
    const id = write(1, 'one', 1_000)
    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    confirmSpec(db, { specId: id, accountId: 1, at: 9_000 })
    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.confirmed_at).toBe(5_000)
  })

  it('currentSpec is the newest CONFIRMED spec, not the newest spec', () => {
    const first = write(1, 'confirmed one', 1_000)
    confirmSpec(db, { specId: first, accountId: 1, at: 1_500 })
    write(1, 'later draft', 2_000)

    expect(JSON.parse(newestSpec(db, 1)!.payload).title).toBe('later draft')
    expect(JSON.parse(currentSpec(db, 1)!.payload).title).toBe('confirmed one')
  })

  it('has no current spec before anything is confirmed', () => {
    write(1, 'draft', 1_000)
    expect(currentSpec(db, 1)).toBeUndefined()
  })
})

describe('append-only enforcement', () => {
  it('rejects UPDATE and DELETE on specs', () => {
    write(1, 'one', 1_000)
    expect(() => db.prepare('UPDATE specs SET at = 2').run()).toThrow(
      /append-only/,
    )
    expect(() => db.prepare('DELETE FROM specs').run()).toThrow(/append-only/)
  })

  it('rejects UPDATE and DELETE on spec_confirmations', () => {
    const id = write(1, 'one', 1_000)
    confirmSpec(db, { specId: id, accountId: 1, at: 5_000 })
    expect(() =>
      db.prepare('UPDATE spec_confirmations SET at = 2').run(),
    ).toThrow(/append-only/)
    expect(() => db.prepare('DELETE FROM spec_confirmations').run()).toThrow(
      /append-only/,
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/specs.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/db/specs"`.

- [ ] **Step 3: Add the tables to `platform/schema.sql`**

Append to the end of `platform/schema.sql`:

```sql
-- Step 4. Sacred like transcripts and metrics: append-only, never migrated.
-- Deliberately NOT covered by lib/db/reshape.ts — CLAUDE.md forbids widening
-- that exception, so these columns are right the first time or they are fixed
-- by hand (design spec section 2.4).
CREATE TABLE IF NOT EXISTS specs (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  conversation_id TEXT    NOT NULL,
  prompt_sha      TEXT    NOT NULL,
  payload         TEXT    NOT NULL,
  mockup_html     TEXT    NOT NULL,
  at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS specs_account ON specs(account_id, at);

-- A confirmation is a second append, not a status column: a status column
-- would need an UPDATE, which the triggers below reject.
CREATE TABLE IF NOT EXISTS spec_confirmations (
  id         INTEGER PRIMARY KEY,
  spec_id    INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS spec_confirmations_spec
  ON spec_confirmations(spec_id);

CREATE TRIGGER IF NOT EXISTS specs_no_update
BEFORE UPDATE ON specs
BEGIN
  SELECT RAISE(ABORT, 'specs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS specs_no_delete
BEFORE DELETE ON specs
BEGIN
  SELECT RAISE(ABORT, 'specs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_confirmations_no_update
BEFORE UPDATE ON spec_confirmations
BEGIN
  SELECT RAISE(ABORT, 'spec_confirmations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS spec_confirmations_no_delete
BEFORE DELETE ON spec_confirmations
BEGIN
  SELECT RAISE(ABORT, 'spec_confirmations is append-only');
END;
```

`platform/seed.ts` needs no change: it seeds accounts only, and `openPlatformDb` exec's `schema.sql` on every open, so the new tables exist in a freshly seeded database.

- [ ] **Step 4: Write `lib/db/specs.ts`**

```ts
// lib/db/specs.ts
import type { PlatformDb } from './platform'

/**
 * One proposal, with its derived version and confirmation state.
 *
 * `payload` is the raw JSON string as stored. Callers parse it with
 * parseSpecPayload (lib/spec/schema.ts) — this module does appends and reads
 * and nothing else, matching lib/db/appendOnly.ts.
 */
export type SpecRecord = {
  id: number
  account_id: number
  conversation_id: string
  prompt_sha: string
  payload: string
  mockup_html: string
  at: number
  /** The FIRST confirmation's timestamp, or null if never confirmed. */
  confirmed_at: number | null
  /** Position in the account's proposal list, oldest = 1. Derived, never stored. */
  version: number
}

export function insertSpec(
  db: PlatformDb,
  row: {
    accountId: number
    conversationId: string
    promptSha: string
    payload: unknown
    mockupHtml: string
    at: number
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO specs
       (account_id, conversation_id, prompt_sha, payload, mockup_html, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.accountId,
      row.conversationId,
      row.promptSha,
      JSON.stringify(row.payload),
      row.mockupHtml,
      row.at,
    )
  return Number(info.lastInsertRowid)
}

/**
 * One account's proposals, newest first.
 *
 * confirmed_at comes from a scalar subquery taking MIN(at), not a LEFT JOIN:
 * a JOIN would duplicate a spec row for every confirmation, and the
 * concurrent-confirm race (design spec section 12) can produce two. MIN is
 * also the honest value — the first confirmation is when the friend decided.
 *
 * `version` is derived from position so it can neither drift nor race.
 */
export function readSpecs(db: PlatformDb, accountId: number): SpecRecord[] {
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT MIN(c.at) FROM spec_confirmations c WHERE c.spec_id = s.id)
                AS confirmed_at
       FROM specs s
       WHERE s.account_id = ?
       ORDER BY s.at DESC, s.id DESC`,
    )
    .all(accountId) as Omit<SpecRecord, 'version'>[]

  // Newest first, so the first row is the highest version.
  return rows.map((row, index) => ({ ...row, version: rows.length - index }))
}

export function newestSpec(
  db: PlatformDb,
  accountId: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId)[0]
}

/** The newest proposal that has a confirmation. The build contract. */
export function currentSpec(
  db: PlatformDb,
  accountId: number,
): SpecRecord | undefined {
  return readSpecs(db, accountId).find((s) => s.confirmed_at !== null)
}

export function hasConfirmedSpec(db: PlatformDb, accountId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM spec_confirmations c
       JOIN specs s ON s.id = c.spec_id
       WHERE c.account_id = ? AND s.account_id = ?
       LIMIT 1`,
    )
    .get(accountId, accountId)
  return row !== undefined
}

export function confirmSpec(
  db: PlatformDb,
  row: { specId: number; accountId: number; at: number },
): void {
  db.prepare(
    'INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)',
  ).run(row.specId, row.accountId, row.at)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/specs.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. The new tables are additive, so nothing existing changes.

- [ ] **Step 7: Commit**

```bash
git add platform/schema.sql lib/db/specs.ts tests/db/specs.test.ts
git commit -m "Add the append-only specs and spec_confirmations tables

Confirmation is a second append rather than a status column, because a
status column needs an UPDATE and the triggers reject it. version is
derived from position so it cannot race the way conversation_id minting
can, and confirmed_at is a MIN() subquery so a duplicate confirmation
cannot duplicate the spec row.

Deliberately outside lib/db/reshape.ts: CLAUDE.md forbids widening that
exception, so these columns are right the first time."
```

---

### Task 2: Prompts by name, and the two new prompt files

**Files:**
- Modify: `lib/chat/prompt.ts`
- Create: `platform/prompts/agent-v2.md`
- Create: `platform/prompts/spec-v1.md`
- Test: `tests/chat/prompt.test.ts` (modify)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `AGENT_PROMPT = 'agent-v1.md'` (flipped to `'agent-v2.md'` in Task 7)
  - `SPEC_PROMPT = 'spec-v1.md'`
  - `promptPath(name: string): string`
  - `loadPrompt(name?: string): { text: string; sha: string }` — `name` is a bare filename under `platform/prompts/`, defaulting to `AGENT_PROMPT`.

**Note for the implementer:** `agent-v2.md` describes a tool that does not exist until Task 7. That is why `AGENT_PROMPT` still points at `agent-v1.md` here — the file ships in this task, the switch happens in the task that ships the tool.

- [ ] **Step 1: Write the failing test**

Replace the last two `describe`-level tests in `tests/chat/prompt.test.ts` and add these. Keep `FORBIDDEN_TERMS` and the first three `loadPrompt` tests exactly as they are; change only the import line and the shipped-prompt tests:

```ts
// Change the import at the top of tests/chat/prompt.test.ts to:
import {
  AGENT_PROMPT,
  SPEC_PROMPT,
  loadPrompt,
  promptPath,
} from '@/lib/chat/prompt'
```

Then replace the `'loads the real shipped prompt and it is not empty'` and
`'does not promise Plaid products that are not enabled'` tests with:

```ts
  it('loads a shipped prompt by bare name and it is not empty', () => {
    for (const name of [AGENT_PROMPT, SPEC_PROMPT, 'agent-v2.md']) {
      const { text, sha } = loadPrompt(name)
      expect(text.trim().length, name).toBeGreaterThan(0)
      expect(sha, name).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  it('defaults to the agent prompt when given no name', () => {
    expect(loadPrompt().sha).toBe(loadPrompt(AGENT_PROMPT).sha)
  })

  it('gives every shipped prompt a distinct sha', () => {
    // The whole point of a per-file content hash: two prompts that share a
    // sha would be indistinguishable in the transcript and metrics rows.
    const shas = [AGENT_PROMPT, 'agent-v2.md', SPEC_PROMPT].map(
      (n) => loadPrompt(n).sha,
    )
    expect(new Set(shas).size).toBe(3)
  })

  it('does not promise Plaid products that are not enabled, in ANY prompt', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. This
    // now covers spec-v1.md too, which is the call that actually writes the
    // panels — a panel naming an un-enabled product is a promise to a friend
    // that step 6 cannot keep.
    for (const name of [AGENT_PROMPT, 'agent-v2.md', SPEC_PROMPT]) {
      const { text } = loadPrompt(name)
      for (const forbidden of FORBIDDEN_TERMS) {
        expect(text, `${name} matched ${forbidden}`).not.toMatch(forbidden)
      }
    }
  })

  it('resolves a bare name under platform/prompts', () => {
    expect(promptPath('agent-v1.md')).toMatch(
      /platform[/\\]prompts[/\\]agent-v1\.md$/,
    )
  })
```

The three existing tmp-file tests (`returns the file text and a 12-hex-char sha`, `gives the same sha for the same bytes`, `changes the sha when a single byte changes`) pass absolute paths. Keep them working by making `loadPrompt` treat an absolute path as-is — see Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chat/prompt.test.ts`
Expected: FAIL — `AGENT_PROMPT` is not exported.

- [ ] **Step 3: Rewrite `lib/chat/prompt.ts`**

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const PROMPT_DIR = resolve(process.cwd(), 'platform/prompts')

/** The interview prompt. New versions are new FILES, never edits. */
export const AGENT_PROMPT = 'agent-v1.md'

/**
 * The spec-authoring prompt. Separate from the interview prompt so the output
 * contract and the mockup conventions can be iterated without touching
 * interview wording, and so the two eras stay separable in the record.
 */
export const SPEC_PROMPT = 'spec-v1.md'

export type LoadedPrompt = { text: string; sha: string }

/** A bare filename resolved under platform/prompts. */
export function promptPath(name: string): string {
  return resolve(PROMPT_DIR, name)
}

/**
 * Read a prompt and hash its bytes.
 *
 * The sha is stamped on every transcript row and every spec row so a row is
 * tied to the exact prompt text that produced it — a content hash rather than
 * a human label, because a label can be reused across a quiet edit and a hash
 * cannot.
 *
 * Absolute paths are used as-is, which is what lets the suite hash temp files
 * without a second entry point.
 *
 * Read per call rather than memoized: the files are a few KB next to a
 * multi-second API call, and a module-level cache would need a test-only reset
 * hook to stay testable.
 */
export function loadPrompt(name: string = AGENT_PROMPT): LoadedPrompt {
  const path = isAbsolute(name) ? name : promptPath(name)
  const text = readFileSync(path, 'utf8')
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text, sha }
}
```

`PROMPT_PATH` is gone. Update its one other consumer if `npx tsc --noEmit` reports one.

- [ ] **Step 4: Write `platform/prompts/agent-v2.md`**

Copy `platform/prompts/agent-v1.md` byte-for-byte, then append this section at the end. Change nothing else — the substantive interview rewrite is explicitly out of scope (spec §10).

```markdown

## When you have enough

At some point you will know enough to describe a dashboard worth building.
There is no checklist and no minimum number of questions — it is when you could
explain, to someone who was not here, what this person wants to see each
morning and where those numbers come from.

When you reach that point, call the `propose_spec` tool. It takes no arguments.

Say one short sentence first, so they know something is coming. Calling the
tool ends your turn — a preview is then written and shown to them in the chat
as a card: the dashboard described in plain language, a rendered mockup with
made-up numbers, and two buttons.

They press **Build this** to accept, or **Not quite yet** to keep talking. If
they push back, listen, then call `propose_spec` again when you have understood
what was wrong. The new preview replaces the old one. There is no limit on how
many times this can happen, and more than one round is normal.

Do not describe the dashboard in detail yourself before calling the tool — the
preview does that, and saying it twice makes the card read as a repeat.
```

- [ ] **Step 5: Write `platform/prompts/spec-v1.md`**

```markdown
You are writing the build specification for one person's dashboard, from the
conversation they just had with the agent.

You are not talking to them. Nobody reads your output as prose — it becomes a
structured record, shown back to them as a preview and used by the person who
builds the dashboard by hand.

## What you are given

The whole conversation for this account, oldest first.

## The fields

**title** — a short name for this dashboard. Theirs, not generic. "Eating out
and the car fund", not "Personal Finance Dashboard".

**summary** — a paragraph on what this dashboard is for, in their framing and
their vocabulary. If they said "I want to stop being surprised", the summary
says that, not "provides spending visibility".

**background** — what you learned about *the person* that did not become a
panel. What they already check and how often, what they worry about between
checks, what they turned down, constraints they mentioned, anything they said
that a builder would want to know and would otherwise have to read the whole
transcript to find. This is the residue, not a recap: if a sentence here would
also fit in `summary` or a panel, it belongs there instead.

**panels** — one entry per thing they want to see. Each carries:
- `name` — what to call it on screen
- `shows` — concretely, what is on it. A number, a list, a chart of what.
- `why` — why they wanted it, traceable to something they actually said
- `source` — `plaid` for bank and card data, `manual` for something they log by
  hand, `derived` for anything computed from the other two

Only panels the conversation supports. Do not round out the dashboard with
sensible additions nobody asked for — an unasked-for panel is a promise made on
their behalf.

**manual_logging** — what they agreed to track by hand, and how often. Only
what they actually agreed to. If they were lukewarm, that belongs in
`background`, not here.

**open_questions** — anything the agent could not promise, anything that needs
a decision from Nico, anything you are unsure is possible. This is read first
and treated as a to-do list. An empty list is a real answer; do not invent
items to fill it.

## What the dashboard can be built from

Bank and card data, if they connect an account: balances, transactions going
back two years, and recurring items like subscriptions and paychecks detected
automatically. Transactions refresh when they log in.

Anything they choose to log by hand.

Anything computed from those two.

That is the whole list. A panel that needs anything else is not a panel — it is
an entry in `open_questions`. Being wrong about this costs a promise to a
friend.

## The mockup

One self-contained HTML document: `<!doctype html>`, `<html>`, `<head>` with an
inline `<style>`, `<body>`.

- No `<script>`. None. It renders sealed off and scripts will not run.
- No external anything — no stylesheet links, no web fonts, no images by URL.
- Inline CSS only, in the one `<style>` block.
- It must read as the dashboard they described, at a glance, on a phone-width
  screen. Layout and hierarchy are the promise; polish is not.

**Every number, merchant, and date in it is loudly, obviously fake.**
"COFFEE PALACE TEST", "MEGA MART TEST", "£000.00". Someone glancing at this
must never wonder whether they are looking at their own money. This is not a
style note — it is the rule that keeps real and fake data distinguishable
everywhere in this system.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/chat/prompt.test.ts`
Expected: PASS. If the forbidden-terms test fails on `spec-v1.md`, a Plaid
product that is not enabled has been named — fix the prompt, not the test.

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean. `tsc` will name any remaining `PROMPT_PATH` importer.

- [ ] **Step 8: Commit**

```bash
git add lib/chat/prompt.ts platform/prompts/agent-v2.md platform/prompts/spec-v1.md tests/chat/prompt.test.ts
git commit -m "Load prompts by name, and add agent-v2 and spec-v1

agent-v2.md is agent-v1 plus a structural section on propose_spec, byte
identical otherwise: the substantive interview rewrite is a separate piece
of work, and keeping them apart is what lets prompt_sha tell the two eras
apart when it lands.

spec-v1.md is the authoring contract, with its own sha so mockup
conventions can change without touching interview wording. The
forbidden-Plaid-products test now covers every shipped prompt, not just
the interview one — spec-v1 is the call that actually writes the panels.

AGENT_PROMPT still points at v1; Task 7 flips it, in the commit that
ships the tool the v2 text describes."
```

---

### Task 3: The spec payload schema and validator

**Files:**
- Create: `lib/spec/schema.ts`
- Test: `tests/spec/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type PanelSource = 'plaid' | 'manual' | 'derived'`
  - `type Panel = { name: string; shows: string; why: string; source: PanelSource }`
  - `type SpecPayload = { title: string; summary: string; background: string; panels: Panel[]; manual_logging: string[]; open_questions: string[] }`
  - `type SpecInput = { payload: SpecPayload; mockupHtml: string }`
  - `SPEC_JSON_SCHEMA` — the JSON Schema sent as `output_config.format`.
  - `class SpecShapeError extends Error`
  - `parseSpecInput(raw: unknown): SpecInput` — throws `SpecShapeError`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/spec/schema.test.ts
import { describe, expect, it } from 'vitest'
import {
  SPEC_JSON_SCHEMA,
  SpecShapeError,
  parseSpecInput,
} from '@/lib/spec/schema'

function good(over: Record<string, unknown> = {}) {
  return {
    title: 'Eating out and the car fund',
    summary: 'So mornings stop being a surprise.',
    background: 'Checks the banking app most days, does not trust it.',
    panels: [
      {
        name: 'Eating out',
        shows: 'This month against last month',
        why: 'Said it is where the money goes',
        source: 'plaid',
      },
    ],
    manual_logging: ['Weight, most mornings'],
    open_questions: [],
    mockup_html: '<!doctype html><html><body><p>COFFEE PALACE TEST</p></body></html>',
    ...over,
  }
}

describe('parseSpecInput', () => {
  it('accepts a well-formed payload and splits the mockup out', () => {
    const { payload, mockupHtml } = parseSpecInput(good())
    expect(payload.title).toBe('Eating out and the car fund')
    expect(payload.panels[0]!.source).toBe('plaid')
    expect(mockupHtml).toContain('COFFEE PALACE TEST')
    // mockup_html is a separate column, never part of the payload.
    expect(payload).not.toHaveProperty('mockup_html')
  })

  it('trims whitespace and drops blank list entries', () => {
    const { payload } = parseSpecInput(
      good({ title: '  Spaced  ', manual_logging: ['a', '   ', 'b'] }),
    )
    expect(payload.title).toBe('Spaced')
    expect(payload.manual_logging).toEqual(['a', 'b'])
  })

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['a missing field', (() => { const g = good(); delete (g as Record<string, unknown>).summary; return g })()],
    ['an empty title', good({ title: '   ' })],
    ['an empty mockup', good({ mockup_html: '' })],
    ['a non-string title', good({ title: 7 })],
    ['panels that are not an array', good({ panels: {} })],
    ['zero panels', good({ panels: [] })],
    ['a panel missing a field', good({ panels: [{ name: 'a', shows: 'b', why: 'c' }] })],
    ['a bad panel source', good({ panels: [{ name: 'a', shows: 'b', why: 'c', source: 'sql' }] })],
    ['a non-string list item', good({ open_questions: [3] })],
    ['manual_logging that is not an array', good({ manual_logging: 'weight' })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSpecInput(raw)).toThrow(SpecShapeError)
  })

  it('allows empty manual_logging and open_questions', () => {
    const { payload } = parseSpecInput(
      good({ manual_logging: [], open_questions: [] }),
    )
    expect(payload.manual_logging).toEqual([])
    expect(payload.open_questions).toEqual([])
  })
})

describe('SPEC_JSON_SCHEMA', () => {
  it('requires exactly the fields the validator requires', () => {
    // The schema constrains the model and the validator guards the database.
    // If they drift, the model is told to produce one shape and we accept
    // another, and the mismatch only shows up as a spec_error in production.
    expect([...SPEC_JSON_SCHEMA.required].sort()).toEqual([
      'background',
      'manual_logging',
      'mockup_html',
      'open_questions',
      'panels',
      'summary',
      'title',
    ])
    expect(Object.keys(SPEC_JSON_SCHEMA.properties).sort()).toEqual(
      [...SPEC_JSON_SCHEMA.required].sort(),
    )
  })

  it('pins the panel source enum to the three real sources', () => {
    expect(
      SPEC_JSON_SCHEMA.properties.panels.items.properties.source.enum,
    ).toEqual(['plaid', 'manual', 'derived'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spec/schema.test.ts`
Expected: FAIL — cannot resolve `@/lib/spec/schema`.

- [ ] **Step 3: Write `lib/spec/schema.ts`**

```ts
// lib/spec/schema.ts
//
// The six fields are FROZEN. specs is append-only and is deliberately outside
// lib/db/reshape.ts, so a field added later is missing from every spec written
// before it — permanently. Design spec sections 2.4 and 3.

export const PANEL_SOURCES = ['plaid', 'manual', 'derived'] as const
export type PanelSource = (typeof PANEL_SOURCES)[number]

export type Panel = {
  name: string
  shows: string
  why: string
  source: PanelSource
}

export type SpecPayload = {
  title: string
  summary: string
  background: string
  panels: Panel[]
  manual_logging: string[]
  open_questions: string[]
}

/** What the record stores: the payload, and the mockup in its own column. */
export type SpecInput = { payload: SpecPayload; mockupHtml: string }

export class SpecShapeError extends Error {
  constructor(message: string) {
    super(`spec payload: ${message}`)
    this.name = 'SpecShapeError'
  }
}

/**
 * The shape handed to the API as output_config.format.
 *
 * Constraining the response is what makes a well-formed proposal guaranteed
 * rather than hoped for. It does NOT remove the need for parseSpecInput
 * below: the schema is a request parameter and the validator is what stands
 * between the model and an append-only table.
 */
export const SPEC_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    background: { type: 'string' },
    panels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          shows: { type: 'string' },
          why: { type: 'string' },
          source: { type: 'string', enum: PANEL_SOURCES },
        },
        required: ['name', 'shows', 'why', 'source'],
      },
    },
    manual_logging: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    mockup_html: { type: 'string' },
  },
  required: [
    'title',
    'summary',
    'background',
    'panels',
    'manual_logging',
    'open_questions',
    'mockup_html',
  ],
} as const

function asRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecShapeError(`${what} is not an object`)
  }
  return raw as Record<string, unknown>
}

function text(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw new SpecShapeError(`${key} is not a string`)
  const trimmed = value.trim()
  if (trimmed === '') throw new SpecShapeError(`${key} is empty`)
  return trimmed
}

/** Non-empty entries only. An empty list is legitimate; a blank entry is not. */
function textList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) throw new SpecShapeError(`${key} is not an array`)
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new SpecShapeError(`${key} contains a non-string entry`)
    }
    const trimmed = entry.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

function panels(source: Record<string, unknown>): Panel[] {
  const value = source.panels
  if (!Array.isArray(value)) throw new SpecShapeError('panels is not an array')
  // Zero panels is not a dashboard. Rejecting here means a degenerate
  // proposal fails loudly at authoring time rather than becoming a permanent
  // row that renders as an empty card.
  if (value.length === 0) throw new SpecShapeError('panels is empty')
  return value.map((entry, index) => {
    const panel = asRecord(entry, `panels[${index}]`)
    const source_ = text(panel, 'source')
    if (!(PANEL_SOURCES as readonly string[]).includes(source_)) {
      throw new SpecShapeError(`panels[${index}].source is not one of ${PANEL_SOURCES.join(', ')}`)
    }
    return {
      name: text(panel, 'name'),
      shows: text(panel, 'shows'),
      why: text(panel, 'why'),
      source: source_ as PanelSource,
    }
  })
}

/** Validate a model-authored object, and split the mockup from the payload. */
export function parseSpecInput(raw: unknown): SpecInput {
  const input = asRecord(raw, 'input')
  return {
    payload: {
      title: text(input, 'title'),
      summary: text(input, 'summary'),
      background: text(input, 'background'),
      panels: panels(input),
      manual_logging: textList(input, 'manual_logging'),
      open_questions: textList(input, 'open_questions'),
    },
    mockupHtml: text(input, 'mockup_html'),
  }
}

/** Re-validate a stored payload on the way out of the database. */
export function parseSpecPayload(json: string): SpecPayload {
  return parseSpecInput({ ...JSON.parse(json), mockup_html: 'x' }).payload
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/spec/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, then commit**

```bash
npx tsc --noEmit
git add lib/spec/schema.ts tests/spec/schema.test.ts
git commit -m "Add the spec payload schema and its validator

The JSON Schema constrains the model; the validator guards the table. A
test pins the two together, because drift between them means the model is
told to produce one shape while we accept another — visible only as a
spec_error in production.

Zero panels is rejected: a proposal with no panels is not a dashboard, and
specs is append-only, so a degenerate row renders as an empty card forever."
```

---

### Task 4: Rendering a spec to markdown

**Files:**
- Create: `lib/spec/render.ts`
- Test: `tests/spec/render.test.ts`

**Interfaces:**
- Consumes: `SpecPayload` from `@/lib/spec/schema`.
- Produces: `renderSpecMarkdown(payload: SpecPayload, meta: { slug: string; version: number; confirmedAt: number }): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spec/render.test.ts
import { describe, expect, it } from 'vitest'
import type { SpecPayload } from '@/lib/spec/schema'
import { renderSpecMarkdown } from '@/lib/spec/render'

const PAYLOAD: SpecPayload = {
  title: 'Eating out and the car fund',
  summary: 'So mornings stop being a surprise.',
  background: 'Checks the banking app most days, does not trust it.',
  panels: [
    {
      name: 'Eating out',
      shows: 'This month against last month',
      why: 'Said it is where the money goes',
      source: 'plaid',
    },
    {
      name: 'Car fund',
      shows: 'Saved so far against the target',
      why: 'Wants the number visible',
      source: 'manual',
    },
  ],
  manual_logging: ['Car fund top-ups, when they happen'],
  open_questions: ['Wants a Monzo pot balance — is that reachable?'],
}

describe('renderSpecMarkdown', () => {
  it('renders every field, deterministically', () => {
    const out = renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 2,
      confirmedAt: 1_760_000_000_000,
    })
    expect(out).toBe(renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 2,
      confirmedAt: 1_760_000_000_000,
    }))

    expect(out).toContain('# Eating out and the car fund')
    expect(out).toContain('devtwo')
    expect(out).toContain('v2')
    expect(out).toContain('2025-10-09')
    expect(out).toContain('So mornings stop being a surprise.')
    expect(out).toContain('Checks the banking app most days')
    expect(out).toContain('### 1. Eating out')
    expect(out).toContain('### 2. Car fund')
    expect(out).toContain('plaid')
    expect(out).toContain('Car fund top-ups, when they happen')
    expect(out).toContain('is that reachable?')
  })

  it('warns against hand-editing, because pull-spec.sh overwrites', () => {
    const out = renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 1,
      confirmedAt: 0,
    })
    expect(out).toContain('pull-spec.sh')
  })

  it('says so plainly when a list is empty rather than rendering nothing', () => {
    // A missing heading reads as "the renderer dropped it". "None." reads as
    // "the friend had none", which is the fact.
    const out = renderSpecMarkdown(
      { ...PAYLOAD, manual_logging: [], open_questions: [] },
      { slug: 'devtwo', version: 1, confirmedAt: 0 },
    )
    expect(out).toContain('## Manual logging')
    expect(out).toContain('## Open questions')
    expect(out.match(/_None\._/g)).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spec/render.test.ts`
Expected: FAIL — cannot resolve `@/lib/spec/render`.

- [ ] **Step 3: Write `lib/spec/render.ts`**

```ts
// lib/spec/render.ts
import type { SpecPayload } from './schema'

/**
 * A confirmed spec, as the build contract on disk.
 *
 * Rendered from the stored payload rather than stored as text, so improving
 * how a spec reads lets every past spec be re-exported in the new format
 * (design spec section 2.1). Deterministic: same input, same bytes, so a
 * re-export produces no spurious diff.
 */
export function renderSpecMarkdown(
  payload: SpecPayload,
  meta: { slug: string; version: number; confirmedAt: number },
): string {
  const list = (items: string[]) =>
    items.length === 0 ? '_None._' : items.map((i) => `- ${i}`).join('\n')

  const panels = payload.panels
    .map(
      (panel, index) =>
        `### ${index + 1}. ${panel.name}\n\n` +
        `- **Shows:** ${panel.shows}\n` +
        `- **Why:** ${panel.why}\n` +
        `- **Source:** ${panel.source}`,
    )
    .join('\n\n')

  return `# ${payload.title}

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** ${meta.slug}
- **Spec version:** v${meta.version}
- **Confirmed:** ${new Date(meta.confirmedAt).toISOString()}

## Summary

${payload.summary}

## Background

${payload.background}

## Panels

${panels}

## Manual logging

${list(payload.manual_logging)}

## Open questions

${list(payload.open_questions)}
`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/spec/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, then commit**

```bash
npx tsc --noEmit
git add lib/spec/render.ts tests/spec/render.test.ts
git commit -m "Render a confirmed spec to markdown, deterministically

Rendered from the stored payload rather than stored as text, so improving
the format later re-exports every past spec in the new one. Empty lists
render 'None.' rather than nothing: a missing heading reads as a renderer
bug, where 'None.' reads as the fact."
```

---

### Task 5: `contextFor`, and the `no_api_key` shape

**Files:**
- Create: `lib/chat/context.ts`
- Modify: `lib/chat/turn.ts` (remove `CHAT_CONTEXT`, take `context` from a new dep)
- Modify: `app/api/chat/route.ts` (call `contextFor`, align the `no_api_key` row)
- Test: `tests/chat/context.test.ts`
- Test: `tests/chat/turn.test.ts` (mechanical: supply the new dep)
- Test: `tests/chat/route.test.ts` (assert the aligned shape)

**Interfaces:**
- Consumes: `hasConfirmedSpec` (Task 1), `loadPrompt` / `AGENT_PROMPT` (Task 2).
- Produces:
  - `type ChatContext = 'interview' | 'tweak'`
  - `contextFor(db: PlatformDb, accountId: number): ChatContext`

**Note:** `CHAT_CONTEXT` is deleted. `tsc --noEmit` names every importer.

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/context.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { confirmSpec, insertSpec } from '@/lib/db/specs'
import { contextFor } from '@/lib/chat/context'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-context-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function draft(accountId: number): number {
  return insertSpec(db, {
    accountId,
    conversationId: 'c',
    promptSha: 'sha123456789',
    payload: { title: 'TEST' },
    mockupHtml: '<!doctype html>',
    at: 1_000,
  })
}

describe('contextFor', () => {
  it('is interview for an account with no specs at all', () => {
    expect(contextFor(db, 1)).toBe('interview')
  })

  it('is still interview while a proposal is unconfirmed', () => {
    // A spec that was offered and not accepted has not ended the interview.
    draft(1)
    expect(contextFor(db, 1)).toBe('interview')
  })

  it('is tweak once a spec is confirmed', () => {
    const id = draft(1)
    confirmSpec(db, { specId: id, accountId: 1, at: 2_000 })
    expect(contextFor(db, 1)).toBe('tweak')
  })

  it('does not leak across accounts', () => {
    const id = draft(1)
    confirmSpec(db, { specId: id, accountId: 1, at: 2_000 })
    expect(contextFor(db, 2)).toBe('interview')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chat/context.test.ts`
Expected: FAIL — cannot resolve `@/lib/chat/context`.

- [ ] **Step 3: Write `lib/chat/context.ts`**

```ts
// lib/chat/context.ts
import type { PlatformDb } from '@/lib/db/platform'
import { hasConfirmedSpec } from '@/lib/db/specs'

/**
 * The run kind stamped on every metrics row (architecture-overview.md line
 * 136: "interview, planning, tweak runs").
 */
export type ChatContext = 'interview' | 'tweak'

/**
 * Which kind of run this turn is.
 *
 * Replaces step 2's hardcoded 'interview', which was correct only until spec
 * confirmation existed (step-2 ledger residual 5). This is the field that
 * answers how much cost goes into winning someone over versus keeping them.
 *
 * Going forward only. metrics is append-only and rows already written say
 * 'interview' permanently — which is correct, because every turn written so
 * far genuinely was one.
 *
 * The boundary is CONFIRMATION, not proposal: a spec that was offered and not
 * accepted has not ended the interview.
 */
export function contextFor(db: PlatformDb, accountId: number): ChatContext {
  return hasConfirmedSpec(db, accountId) ? 'tweak' : 'interview'
}
```

- [ ] **Step 4: Thread it through `lib/chat/turn.ts`**

Delete the `CHAT_CONTEXT` export and its comment block. Add `context` to `TurnDeps`:

```ts
import type { ChatContext } from './context'

export type TurnDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  /**
   * Resolved by the caller and passed in, not computed here: turn.ts takes
   * its collaborators as parameters so the suite can drive every path, and
   * this is one of them.
   */
  context: ChatContext
  alert: (accountId: number) => void
}
```

In `runTurn`, destructure `context` alongside the rest, and change `base`:

```ts
  const { db, client, now, context, alert } = deps
  // ...
  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context,
  }
```

- [ ] **Step 5: Fix `app/api/chat/route.ts`**

Replace the `CHAT_CONTEXT` import with `contextFor`, and align the `no_api_key`
metric row to the documented `chat_error` shape (step-2 ledger residual 8):

```ts
import { contextFor } from '@/lib/chat/context'
import { AGENT_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import { runTurn } from '@/lib/chat/turn'
```

```ts
  let turnClient: ChatClient
  try {
    turnClient = chatClient()
  } catch {
    // Aligned to the chat_error shape documented in the step-2 design spec
    // section 2.5 (step-2 ledger residual 8). It used to carry six fields
    // where every other chat_error carries fifteen, so anyone grouping
    // chat_error rows by prompt_sha silently dropped these. metrics is
    // append-only, so this only gets more expensive with every row.
    appendMetric(db, {
      accountId: session.account_id,
      event: 'chat_error',
      at: Date.now(),
      data: {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
        model: CHAT_MODEL,
        effort: CHAT_EFFORT,
        prompt_sha: loadPrompt(AGENT_PROMPT).sha,
        context: contextFor(db, session.account_id),
        model_served: CHAT_MODEL,
        fallback_fired: false,
        kind: 'no_api_key',
        status: null,
        type: null,
        delivered_chars: 0,
      },
    })
    return new Response(null, { status: 503 })
  }
```

And pass `context` into `runTurn`'s deps:

```ts
        {
          db,
          client: turnClient,
          now: Date.now,
          context: contextFor(db, session.account_id),
          alert: conversationAlerter({ /* unchanged */ }),
        },
```

- [ ] **Step 6: Update the existing tests**

In `tests/chat/turn.test.ts`, every `runTurn({ db, client, now, alert })` deps
object gains `context: 'interview'`. In `tests/alerts/leak.test.ts`, the same.

In `tests/chat/route.test.ts`, add a test asserting the aligned shape:

```ts
  it('records a no_api_key chat_error carrying the full documented shape', async () => {
    // Residual 8: this row used to be a second, narrower chat_error shape.
    // Anyone grouping chat_error by prompt_sha silently dropped it.
    const row = db
      .prepare("SELECT data FROM metrics WHERE event = 'chat_error' ORDER BY id DESC LIMIT 1")
      .get() as { data: string }
    const data = JSON.parse(row.data) as Record<string, unknown>
    for (const key of [
      'input', 'output', 'cache_read', 'cache_creation',
      'model', 'effort', 'prompt_sha', 'context',
      'model_served', 'fallback_fired', 'kind', 'status', 'type',
      'delivered_chars',
    ]) {
      expect(data, key).toHaveProperty(key)
    }
    expect(data.kind).toBe('no_api_key')
    expect(data.context).toBe('interview')
  })
```

Wire it into whichever existing `describe` block already drives the 503 path;
if none does, follow that file's existing setup to force `anthropicClient()` to
throw and assert the 503 first.

- [ ] **Step 7: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean. `tsc` names any remaining `CHAT_CONTEXT` importer.

- [ ] **Step 8: Commit**

```bash
git add lib/chat/context.ts lib/chat/turn.ts app/api/chat/route.ts tests/chat/context.test.ts tests/chat/turn.test.ts tests/chat/route.test.ts tests/alerts/leak.test.ts
git commit -m "Derive the metrics context, and close step-2 residual 8

context was the hardcoded literal 'interview', correct only until spec
confirmation existed. It is now derived from whether the account has a
CONFIRMED spec — a proposal that was offered and not accepted has not
ended the interview. Going forward only: metrics is append-only and every
row written so far genuinely was an interview turn.

The no_api_key row was a second, narrower chat_error shape carrying six
of fifteen documented fields, so anyone grouping chat_error rows by
prompt_sha silently dropped them. It is being edited for context anyway,
and leaving a known-wrong shape in a line under the cursor is how it
survives forever."
```

---

### Task 6: `client.propose()` and `tools_called`

**Files:**
- Modify: `lib/chat/client.ts`
- Test: `tests/chat/client.test.ts` (new)

**Interfaces:**
- Consumes: `SPEC_JSON_SCHEMA` (Task 3), `SPEC_PROMPT` (Task 2).
- Produces:
  - `PROPOSE_TOOL_NAME = 'propose_spec'`, `PROPOSE_TOOL` (empty input schema)
  - `SPEC_MAX_TOKENS = 32000`, `SPEC_TIMEOUT_MS = 180_000`
  - `StreamResult` gains `tools_called: string[]`
  - `type ProposeResult = { input: unknown; usage: Usage; stop_reason: string | null; served: Served }`
  - `ChatClient` gains `propose(args: { system: string; messages: ChatMessage[]; signal: AbortSignal }): Promise<ProposeResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/client.test.ts
import { describe, expect, it } from 'vitest'
import {
  PROPOSE_TOOL,
  PROPOSE_TOOL_NAME,
  SPEC_MAX_TOKENS,
  SPEC_TIMEOUT_MS,
  anthropicClient,
} from '@/lib/chat/client'

/** The narrowest fake that satisfies anthropicClient's credential guard. */
function fakeSdk(over: Record<string, unknown> = {}) {
  return {
    apiKey: 'sk-test-FAKE',
    authToken: null,
    beta: { messages: { create: async () => ({}), stream: () => ({}) } },
    ...over,
  }
}

describe('propose()', () => {
  it('asks for structured output and returns the parsed object', async () => {
    let seen: Record<string, unknown> | undefined
    let options: Record<string, unknown> | undefined
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async (body: Record<string, unknown>, opts: Record<string, unknown>) => {
            seen = body
            options = opts
            return {
              content: [{ type: 'text', text: '{"title":"TEST"}' }],
              stop_reason: 'end_turn',
              model: 'claude-opus-5',
              usage: { input_tokens: 10, output_tokens: 4 },
            }
          },
          stream: () => ({}),
        },
      },
    })

    const result = await anthropicClient(sdk as never).propose({
      system: 'author a spec',
      messages: [{ role: 'user', content: 'hi' }],
      signal: new AbortController().signal,
    })

    expect(result.input).toEqual({ title: 'TEST' })
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input).toBe(10)

    // The bounded-wait guarantee. Without both of these a wedged authoring
    // call holds a friend on "putting together a preview" for the better
    // part of an hour, because the SDK scales its own timeout UP for large
    // non-streaming max_tokens.
    expect(seen!.max_tokens).toBe(SPEC_MAX_TOKENS)
    expect(options!.timeout).toBe(SPEC_TIMEOUT_MS)
    expect((seen!.output_config as Record<string, unknown>).format).toBeDefined()
  })

  it('wraps an SDK failure as a ChatStreamError with a usable kind', async () => {
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async () => {
            throw new Error('boom')
          },
          stream: () => ({}),
        },
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ChatStreamError' })
  })

  it('fails rather than returning junk when the reply is not JSON', async () => {
    // A truncated or non-JSON reply must surface as spec_error, not be
    // written to an append-only table as a spec.
    const sdk = fakeSdk({
      beta: {
        messages: {
          create: async () => ({
            content: [{ type: 'text', text: 'sorry, no' }],
            stop_reason: 'max_tokens',
            model: 'claude-opus-5',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          stream: () => ({}),
        },
      },
    })
    await expect(
      anthropicClient(sdk as never).propose({
        system: 's',
        messages: [{ role: 'user', content: 'hi' }],
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: 'ChatStreamError' })
  })
})

describe('PROPOSE_TOOL', () => {
  it('takes no arguments at all', () => {
    // The hand-raise carries no payload on purpose: that is what keeps a 5KB
    // mockup out of the same path that feeds the chat bubble.
    expect(PROPOSE_TOOL.name).toBe(PROPOSE_TOOL_NAME)
    expect(PROPOSE_TOOL.input_schema.properties).toEqual({})
    expect(PROPOSE_TOOL.input_schema.required).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/chat/client.test.ts`
Expected: FAIL — `PROPOSE_TOOL` is not exported.

- [ ] **Step 3: Extend `lib/chat/client.ts`**

Add the imports and constants near the top:

```ts
import { SPEC_JSON_SCHEMA } from '@/lib/spec/schema'
```

```ts
/** The hand-raise. No payload — see PROPOSE_TOOL below. */
export const PROPOSE_TOOL_NAME = 'propose_spec'

/**
 * A tool with an EMPTY input schema.
 *
 * The agent is not delivering a spec here, it is asking for one to be
 * written. Carrying no payload is what keeps stream() from having to
 * accumulate a 5KB mockup out of input_json_delta events alongside the text
 * it is already pushing to a friend's screen.
 */
export const PROPOSE_TOOL = {
  name: PROPOSE_TOOL_NAME,
  description:
    'Signal that the interview has enough to describe a dashboard. Takes no ' +
    'arguments. Calling this ends your turn; a preview is written and shown ' +
    'to the person as a card they can accept or push back on.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [] as string[],
  },
}

/**
 * NOT MAX_TOKENS, and this difference is load-bearing.
 *
 * stream() runs at 64000 because streaming makes a high ceiling free. The
 * authoring call does not stream, and the SDK scales its own timeout UP for
 * large non-streaming max_tokens — so reusing 64000 here could hold a friend
 * on "putting together a preview" for the better part of an hour. This
 * ceiling is still far above a spec plus a mockup plus adaptive thinking.
 */
export const SPEC_MAX_TOKENS = 32000

/** What actually bounds the wait. A timeout is a visible failure; a hang is not. */
export const SPEC_TIMEOUT_MS = 180_000
```

Extend the types:

```ts
export type StreamResult = {
  usage: Usage
  stop_reason: string | null
  served: Served
  /** Names of the tools the resolved message asked to call. */
  tools_called: string[]
}

export type ProposeResult = {
  /** The parsed object, still unvalidated. lib/spec/schema.ts validates it. */
  input: unknown
  usage: Usage
  stop_reason: string | null
  served: Served
}

export type ChatClient = {
  stream(args: { /* unchanged */ }): Promise<StreamResult>
  propose(args: {
    system: string
    messages: ChatMessage[]
    signal: AbortSignal
  }): Promise<ProposeResult>
}
```

In `anthropicClient`'s `stream()`, pass the tool and populate `tools_called`:

```ts
        const stream = sdk.beta.messages.stream(
          {
            // ...everything unchanged...
            messages,
            tools: [PROPOSE_TOOL],
          },
          { signal },
        )
```

```ts
        return {
          usage: { /* unchanged */ },
          stop_reason: final.stop_reason,
          served,
          tools_called: final.content
            .filter((block) => block.type === 'tool_use')
            .map((block) => (block as { name: string }).name),
        }
```

Add `propose()` alongside `stream()`:

```ts
    async propose({ system, messages, signal }) {
      try {
        const message = await sdk.beta.messages.create(
          {
            model: CHAT_MODEL,
            max_tokens: SPEC_MAX_TOKENS,
            output_config: {
              effort: CHAT_EFFORT,
              // Structured outputs rather than a forced tool: it constrains
              // the RESPONSE, so there is no tool_use block to extract and no
              // tool/thinking interaction to reason about. Same guarantee,
              // fewer moving parts (design spec section 4.1).
              format: { type: 'json_schema', schema: SPEC_JSON_SCHEMA },
            },
            betas: [FALLBACK_BETA],
            fallbacks: 'default',
            system: [{ type: 'text', text: system }],
            messages,
          },
          { signal, timeout: SPEC_TIMEOUT_MS },
        )

        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => (block as { text: string }).text)
          .join('')

        let input: unknown
        try {
          input = JSON.parse(text)
        } catch {
          // A truncated or refused reply is NOT a spec. Failing here is what
          // keeps junk out of an append-only table.
          throw new ChatStreamError(
            { kind: 'unparsable_spec', status: null, type: null },
            `authoring call returned unparsable output (stop_reason ${message.stop_reason})`,
          )
        }

        return {
          input,
          usage: {
            input: message.usage.input_tokens,
            output: message.usage.output_tokens,
            cache_read: message.usage.cache_read_input_tokens ?? 0,
            cache_creation: message.usage.cache_creation_input_tokens ?? 0,
          },
          stop_reason: message.stop_reason,
          served: {
            model_served: message.model,
            fallback_fired:
              (message.usage.iterations ?? []).some(
                (entry) => entry.type === 'fallback_message',
              ) || message.content.some((block) => block.type === 'fallback'),
          },
        }
      } catch (error) {
        if (error instanceof ChatStreamError) throw error
        throw new ChatStreamError(
          describeError(error),
          error instanceof Error ? error.message : String(error),
        )
      }
    },
```

The system block here is deliberately **not** `cache_control`-marked: the
authoring prompt is used once per proposal, so a write premium buys nothing.

- [ ] **Step 4: Update every fake `ChatClient` in the suite**

`tools_called: []` on every `StreamResult` a fake returns, and a `propose`
method that throws (`async propose() { throw new Error('unused') }`) on every
fake that does not exercise it. `tsc --noEmit` names all of them.

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/chat/client.ts tests/chat/client.test.ts tests/chat/turn.test.ts tests/alerts/leak.test.ts
git commit -m "Add client.propose(), and report which tools a stream called

The authoring call uses structured outputs rather than a forced tool: it
constrains the response itself, so there is no tool_use block to extract
and no tool/thinking interaction to reason about.

It does NOT reuse MAX_TOKENS. stream() runs at 64000 because streaming
makes a high ceiling free; a non-streaming call at that ceiling is the
opposite, since the SDK scales its own timeout UP for large non-streaming
max_tokens. A wedged authoring call would have held a friend on 'putting
together a preview' for the better part of an hour. 32000 plus an explicit
180s timeout, and a timeout is a visible spec_error rather than a hang.

Closes part of step-2 residual 10: lib/chat/client.ts had no tests at all."
```

---

### Task 7: `authorSpec`, and the restated completion rule

**Files:**
- Create: `lib/spec/author.ts`
- Modify: `lib/chat/turn.ts`
- Modify: `lib/chat/prompt.ts` (flip `AGENT_PROMPT` to `agent-v2.md`)
- Test: `tests/spec/author.test.ts`
- Test: `tests/chat/turn.test.ts` (extend)

**Interfaces:**
- Consumes: `insertSpec` (T1), `SPEC_PROMPT`/`loadPrompt` (T2), `parseSpecInput` (T3), `contextFor` (T5), `propose`/`PROPOSE_TOOL_NAME` (T6).
- Produces:
  - `type Proposal = { id: number; version: number; payload: SpecPayload; mockup_html: string }`
  - `authorSpec(deps, input): Promise<Proposal | undefined>` where
    `deps = { db, client, now, context }` and
    `input = { accountId, conversationId, signal }`
  - `TurnOutcome` gains `proposal?: Proposal`

- [ ] **Step 1: Write the failing test**

```ts
// tests/spec/author.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { readSpecs } from '@/lib/db/specs'
import { CHAT_MODEL, ChatStreamError, type ChatClient } from '@/lib/chat/client'
import { authorSpec } from '@/lib/spec/author'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-author-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const GOOD = {
  title: 'Eating out and the car fund',
  summary: 'So mornings stop being a surprise.',
  background: 'Checks the banking app most days.',
  panels: [{ name: 'Eating out', shows: 'This month', why: 'Said so', source: 'plaid' }],
  manual_logging: [],
  open_questions: [],
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

const USAGE = { input: 50, output: 900, cache_read: 0, cache_creation: 0 }
const SERVED = { model_served: CHAT_MODEL, fallback_fired: false }

function client(over: Partial<ChatClient> = {}): ChatClient {
  return {
    async stream() {
      throw new Error('unused')
    },
    async propose() {
      return { input: GOOD, usage: USAGE, stop_reason: 'end_turn', served: SERVED }
    },
    ...over,
  } as ChatClient
}

const INPUT = {
  accountId: 1,
  conversationId: 'conv-1',
  signal: new AbortController().signal,
}

const deps = (c: ChatClient) => ({
  db,
  client: c,
  now: () => 5_000,
  context: 'interview' as const,
})

function metrics(): { event: string; data: Record<string, unknown> }[] {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data) }))
}

describe('authorSpec', () => {
  it('inserts one spec and records spec_proposed', async () => {
    const proposal = await authorSpec(deps(client()), INPUT)

    expect(proposal!.version).toBe(1)
    expect(proposal!.payload.title).toBe('Eating out and the car fund')
    expect(proposal!.mockup_html).toContain('COFFEE PALACE TEST')

    const rows = readSpecs(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.conversation_id).toBe('conv-1')

    const [row] = metrics()
    expect(row!.event).toBe('spec_proposed')
    expect(row!.data.spec_id).toBe(proposal!.id)
    expect(row!.data.version).toBe(1)
    expect(row!.data.output).toBe(900)
    expect(row!.data.context).toBe('interview')
    // The authoring prompt's sha, NOT the interview prompt's.
    expect(row!.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('writes NO spec and records spec_error when the call fails', async () => {
    const failing = client({
      async propose() {
        throw new ChatStreamError(
          { kind: 'rate_limit', status: 429, type: 'rate_limit_error' },
          'slow down',
        )
      },
    })
    expect(await authorSpec(deps(failing), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])

    const [row] = metrics()
    expect(row!.event).toBe('spec_error')
    expect(row!.data.kind).toBe('rate_limit')
    expect(row!.data.status).toBe(429)
  })

  it('writes NO spec and records spec_error when the payload is malformed', async () => {
    // A schema-valid REQUEST does not guarantee a schema-valid RESPONSE
    // reaching an append-only table. The validator is the last gate.
    const bad = client({
      async propose() {
        return {
          input: { ...GOOD, panels: [] },
          usage: USAGE,
          stop_reason: 'end_turn',
          served: SERVED,
        }
      },
    })
    expect(await authorSpec(deps(bad), INPUT)).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_error')
  })

  it('writes NO spec and records spec_aborted when the friend walks away', async () => {
    const controller = new AbortController()
    const aborting = client({
      async propose() {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    })
    const outcome = await authorSpec(deps(aborting), {
      ...INPUT,
      signal: controller.signal,
    })
    expect(outcome).toBeUndefined()
    expect(readSpecs(db, 1)).toEqual([])
    expect(metrics()[0]!.event).toBe('spec_aborted')
  })

  it('numbers a second proposal v2 and leaves the first in the record', async () => {
    await authorSpec(deps(client()), INPUT)
    const second = await authorSpec(deps(client()), INPUT)
    expect(second!.version).toBe(2)
    expect(readSpecs(db, 1)).toHaveLength(2)
  })

  it('never writes the synthetic authoring message to transcripts', async () => {
    // "Write the spec now." is a call-time construct, not a thing the friend
    // said. Anything reading the transcript must see only what happened.
    await authorSpec(deps(client()), INPUT)
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcripts').get()).toEqual({
      n: 0,
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spec/author.test.ts`
Expected: FAIL — cannot resolve `@/lib/spec/author`.

- [ ] **Step 3: Write `lib/spec/author.ts`**

```ts
// lib/spec/author.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { insertSpec, readSpecs } from '@/lib/db/specs'
import { toMessages } from '@/lib/chat/history'
import { SPEC_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import type { ChatContext } from '@/lib/chat/context'
import {
  CHAT_EFFORT,
  CHAT_MODEL,
  ChatStreamError,
  UNKNOWN_ERROR,
  type ChatClient,
  type Served,
  type Usage,
} from '@/lib/chat/client'
import { parseSpecInput, type SpecPayload } from './schema'

export type Proposal = {
  id: number
  version: number
  payload: SpecPayload
  mockup_html: string
}

export type AuthorDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  context: ChatContext
}

export type AuthorInput = {
  accountId: number
  conversationId: string
  signal: AbortSignal
}

/** Honest defaults for a call that failed before the API reported anything. */
const NO_USAGE: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }

/**
 * Write one proposal, or record why it could not be written.
 *
 * Returns undefined on every failure path rather than throwing: this runs
 * AFTER the chat turn's assistant row is already appended, and a failed
 * preview must not retroactively turn a delivered reply into a failed turn.
 */
export async function authorSpec(
  deps: AuthorDeps,
  input: AuthorInput,
): Promise<Proposal | undefined> {
  const { db, client, now, context } = deps
  const { text: system, sha: promptSha } = loadPrompt(SPEC_PROMPT)

  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context,
  }
  const served: Served = { model_served: CHAT_MODEL, fallback_fired: false }

  const history = toMessages(readTranscript(db, input.accountId))
  const last = history[history.length - 1]
  // Appended ONLY when the last message is an assistant turn. On the usual
  // path the agent said something before calling the tool, so the call needs
  // a user message to answer. On the no-text path the friend's own message is
  // already last and a second user turn buys nothing. Ending on a user
  // message is the only invariant this needs.
  //
  // Never written to transcripts: it is a call-time construct, not a thing
  // the friend said (design spec section 4.4).
  const messages =
    last?.role === 'assistant'
      ? [...history, { role: 'user' as const, content: 'Write the spec now.' }]
      : history

  let result
  try {
    result = await client.propose({ system, messages, signal: input.signal })
  } catch (error) {
    if (input.signal.aborted) {
      appendMetric(db, {
        accountId: input.accountId,
        event: 'spec_aborted',
        at: now(),
        data: { ...NO_USAGE, ...base, ...served },
      })
      return undefined
    }
    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_error',
      at: now(),
      data: {
        ...NO_USAGE,
        ...base,
        ...served,
        ...(error instanceof ChatStreamError ? error.shape : UNKNOWN_ERROR),
      },
    })
    return undefined
  }

  let parsed
  try {
    parsed = parseSpecInput(result.input)
  } catch (error) {
    // A schema-constrained REQUEST is not a guarantee about the row that
    // reaches an append-only table. This validator is the last gate.
    appendMetric(db, {
      accountId: input.accountId,
      event: 'spec_error',
      at: now(),
      data: {
        ...result.usage,
        ...base,
        ...result.served,
        kind: 'malformed_spec',
        status: null,
        type: error instanceof Error ? error.message : null,
      },
    })
    return undefined
  }

  const id = insertSpec(db, {
    accountId: input.accountId,
    conversationId: input.conversationId,
    promptSha,
    payload: parsed.payload,
    mockupHtml: parsed.mockupHtml,
    at: now(),
  })
  // Read back rather than counting: version is derived from position, and
  // this is the one place that must agree with what the admin pane renders.
  const version = readSpecs(db, input.accountId).find((s) => s.id === id)!.version

  appendMetric(db, {
    accountId: input.accountId,
    event: 'spec_proposed',
    at: now(),
    data: { ...result.usage, ...base, ...result.served, spec_id: id, version },
  })

  return { id, version, payload: parsed.payload, mockup_html: parsed.mockupHtml }
}
```

- [ ] **Step 4: Restate the completion rule in `lib/chat/turn.ts`**

Add `proposal` to the outcome and an `authorSpec` dep:

```ts
export type TurnOutcome = {
  kind: 'completed' | 'aborted' | 'error' | 'empty'
  proposal?: Proposal
}
```

Add to `TurnDeps`:

```ts
  /**
   * Injected so the suite can drive the completion rule without a second
   * fake client — the same reason `client` is a parameter.
   */
  authorSpec: (input: AuthorInput) => Promise<Proposal | undefined>
```

Replace the empty-reply block at the end of `runTurn` with:

```ts
  // THE COMPLETION RULE, restated in full because transcripts is append-only
  // and this cannot be corrected later (design spec section 4.3).
  //
  // Step 2's rule — anything other than end_turn is chat_empty_reply — was
  // correct only in a world with no tools. A propose_spec call stops with
  // 'tool_use' and lands squarely on it.
  //
  // Text and proposal are evaluated INDEPENDENTLY. A turn that calls the tool
  // without saying anything first still proposes, and still writes no
  // assistant row: an empty body in an append-only table breaks every later
  // turn for that account, and that hazard does not soften because a tool was
  // also called.
  const proposed = final.tools_called.includes(PROPOSE_TOOL_NAME)
  const usable =
    delivered.trim() !== '' &&
    (final.stop_reason === 'end_turn' || final.stop_reason === 'tool_use')

  if (!usable && !proposed) {
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_empty_reply',
      at: now(),
      data: {
        ...final.usage,
        ...base,
        ...final.served,
        stop_reason: final.stop_reason,
        delivered_chars: delivered.length,
      },
    })
    return { kind: 'empty' }
  }

  if (usable) {
    appendTranscript(db, { ...stamp, role: 'assistant', body: delivered, at: now() })
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_turn',
      at: now(),
      data: { ...final.usage, ...base, ...final.served },
    })
  }

  const proposal = proposed
    ? await deps.authorSpec({
        accountId: input.accountId,
        conversationId,
        signal: input.signal,
      })
    : undefined

  return { kind: usable ? 'completed' : 'empty', proposal }
```

Import `PROPOSE_TOOL_NAME` from `./client` and the `Proposal` / `AuthorInput`
types from `@/lib/spec/author`.

- [ ] **Step 5: Flip `AGENT_PROMPT` to v2**

In `lib/chat/prompt.ts`:

```ts
export const AGENT_PROMPT = 'agent-v2.md'
```

This is the commit that ships the tool the v2 text describes.

- [ ] **Step 6: Extend `tests/chat/turn.test.ts`**

Add `authorSpec: async () => undefined` to every existing deps object, then add:

```ts
describe('the completion rule with propose_spec', () => {
  function toolClient(text: string, tools: string[]): ChatClient {
    return {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        if (text) onText(text)
        return {
          usage: USAGE,
          stop_reason: tools.length > 0 ? 'tool_use' : 'end_turn',
          served: SERVED,
          tools_called: tools,
        }
      },
      async propose() {
        throw new Error('unused')
      },
    }
  }

  const PROPOSAL = {
    id: 7,
    version: 1,
    payload: {
      title: 'T', summary: 's', background: 'b',
      panels: [{ name: 'n', shows: 's', why: 'w', source: 'plaid' as const }],
      manual_logging: [], open_questions: [],
    },
    mockup_html: '<!doctype html>',
  }

  it('appends the assistant row AND proposes when both happened', async () => {
    let called = false
    const outcome = await runTurn(
      {
        db,
        client: toolClient('one moment', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => {
          called = true
          return PROPOSAL
        },
      },
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.kind).toBe('completed')
    expect(outcome.proposal).toEqual(PROPOSAL)
    expect(called).toBe(true)
    expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(1)
  })

  it('proposes with NO assistant row when the tool call carried no text', async () => {
    // An empty body in an append-only table would 400 every later turn for
    // this account. That hazard does not soften because a tool was called.
    const outcome = await runTurn(
      {
        db,
        client: toolClient('', ['propose_spec']),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => PROPOSAL,
      },
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.proposal).toEqual(PROPOSAL)
    expect(readTranscript(db, 1).filter((r) => r.role === 'assistant')).toHaveLength(0)
  })

  it('still records chat_empty_reply when there is neither text nor a tool', async () => {
    const outcome = await runTurn(
      {
        db,
        client: toolClient('', []),
        now: () => 1_000,
        context: 'interview',
        alert: noAlert,
        authorSpec: async () => {
          throw new Error('must not be called')
        },
      },
      { accountId: 1, sessionId: 's', body: 'hi', signal: new AbortController().signal, onText: () => {} },
    )
    expect(outcome.kind).toBe('empty')
    expect(outcome.proposal).toBeUndefined()
  })
})
```

- [ ] **Step 7: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add lib/spec/author.ts lib/chat/turn.ts lib/chat/prompt.ts tests/spec/author.test.ts tests/chat/turn.test.ts
git commit -m "Author a spec when the agent raises its hand

The completion rule is restated in full rather than patched: step 2's
'anything but end_turn is empty' was correct only in a world with no
tools, and a propose_spec call stops with tool_use. Text and proposal are
now evaluated independently, so a tool call with no text still proposes
and still writes no assistant row — an empty body in an append-only table
breaks every later turn for that account.

The synthetic 'Write the spec now.' message is appended only when the
last message is an assistant turn, and never reaches transcripts: it is a
call-time construct, not a thing the friend said.

AGENT_PROMPT moves to agent-v2.md here, in the commit that ships the tool
its new section describes."
```

---

### Task 8: One alerter, two kinds — content-freeness per module

**Files:**
- Modify: `lib/alerts/ntfy.ts`
- Test: `tests/alerts/ntfy.test.ts` (modify)
- Test: `tests/alerts/leak.test.ts` (extend)

**Interfaces:**
- Produces:
  - `ALERT_TEXT = { conversation_started: 'started a conversation', spec_confirmed: 'confirmed a spec' }`
  - `type AlertKind = keyof typeof ALERT_TEXT`
  - `alerter(deps): (kind: AlertKind, accountId: number) => Promise<void>`
  - `conversationAlerter(deps): (accountId: number) => Promise<void>` — a kind-bound binding, so `TurnDeps.alert` is unchanged.

- [ ] **Step 1: Write the failing test**

Extend `tests/alerts/leak.test.ts` with a kind-agnostic sweep:

```ts
import { ALERT_TEXT, alerter, type AlertKind } from '@/lib/alerts/ntfy'

describe('content-freeness holds for EVERY alert kind', () => {
  // Step-3 residual 5: the guarantee used to be the shape of ONE function.
  // Iterating ALERT_TEXT is what makes a third kind covered the moment it is
  // declared, rather than the moment someone remembers to add a test.
  it.each(Object.keys(ALERT_TEXT) as AlertKind[])(
    'sends only "<slug> <fixed phrase>" for %s',
    async (kind) => {
      const seen: { url: string; init: RequestInit | undefined }[] = []
      const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init })
        return new Response('1', { status: 200 })
      }) as unknown as typeof globalThis.fetch

      await alerter({ topic: 'topic-abc', fetch, db, now: () => 1_000 })(
        kind,
        accountId,
      )

      expect(seen).toHaveLength(1)
      expect(seen[0]!.init?.body).toBe(`devtwo ${ALERT_TEXT[kind]}`)
    },
  )

  it('has no exported path through which text could reach ntfy.sh', () => {
    // The guarantee moves from "this function has no parameter for it" to
    // "this module has no path for it". The alerter takes a KIND, and the
    // kind indexes a fixed table.
    expect(alerter({ topic: 't', fetch: globalThis.fetch, db, now: () => 0 }).length).toBe(2)
    for (const phrase of Object.values(ALERT_TEXT)) {
      expect(typeof phrase).toBe('string')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/alerts`
Expected: FAIL — `ALERT_TEXT` is not exported.

- [ ] **Step 3: Reshape `lib/alerts/ntfy.ts`**

Replace `ALERT_KIND` with the table, and take a kind:

```ts
/**
 * Every alert body this module can ever send.
 *
 * Step-3 residual 5: content-freeness used to be guaranteed by the SHAPE OF
 * ONE FUNCTION — conversationAlerter had no parameter through which message
 * text could arrive. Nothing extended that to a second alert type.
 *
 * It is now a property of the FILE. The alerter takes a kind, the kind indexes
 * this table, and there is no exported function on this module through which
 * text could reach ntfy.sh. Adding a third kind cannot weaken it by accident.
 */
export const ALERT_TEXT = {
  conversation_started: 'started a conversation',
  spec_confirmed: 'confirmed a spec',
} as const

export type AlertKind = keyof typeof ALERT_TEXT

export function alerter(
  deps: AlerterDeps,
): (kind: AlertKind, accountId: number) => Promise<void> {
  return async (kind, accountId) => {
    try {
      const account = findAccountById(deps.db, accountId)
      if (!account || account.role === 'admin') return

      const topic = deps.topic?.trim()
      if (!topic) {
        record(deps, account.id, kind, 'alert_failed', {
          reason: 'no_topic',
          status: null,
        })
        return
      }

      await send(deps, account.id, kind, topic, `${account.slug} ${ALERT_TEXT[kind]}`)
    } catch {
      // Backstop. Property 2 at the top of this file is absolute.
    }
  }
}

/**
 * The conversation-start alerter, kind-bound.
 *
 * Kept so lib/chat/turn.ts's `alert: (accountId: number) => void` dependency
 * type is unchanged — that type is what stops a future edit from awaiting a
 * push notification on the critical path of a friend's chat turn.
 */
export function conversationAlerter(
  deps: AlerterDeps,
): (accountId: number) => Promise<void> {
  const send = alerter(deps)
  return (accountId) => send('conversation_started', accountId)
}
```

Thread `kind` through `send()` and `record()` so the metric's `kind` field
comes from the argument rather than a module constant. `record`'s data stays
`{ kind, reason?, status }` — the same shape step 3 shipped, so no metrics
consumer changes.

- [ ] **Step 4: Update `tests/alerts/ntfy.test.ts`**

Replace `ALERT_KIND` references with `'conversation_started'`, and any direct
`conversationAlerter(...)(id)` calls stay as they are — the binding preserves
that signature.

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/alerts`
Expected: PASS.

- [ ] **Step 6: Run the hook tests**

Run: `.claude/hooks/test-hooks.sh`
Expected: all pass. (No hook scope changed, but CLAUDE.md requires reporting
this after any change that touches alerting's guarantees.)

- [ ] **Step 7: Commit**

```bash
git add lib/alerts/ntfy.ts tests/alerts/ntfy.test.ts tests/alerts/leak.test.ts
git commit -m "Make content-freeness a property of the alert module, not one function

Step-3 residual 5: the guarantee was the shape of conversationAlerter,
which has no parameter through which message text could arrive. Nothing
extended that to a second alert type, and step 4 adds one.

The body now comes from a fixed table keyed by alert kind, so no exported
function on this module has a path through which text could reach
ntfy.sh. The leak test iterates every key in that table, which is what
makes a third kind covered the moment it is declared.

turn.ts's alert dependency type is unchanged — it receives a kind-bound
binding — so the type that keeps a push notification off the critical
path of a chat turn stays exactly as it is."
```

---

### Task 9: `POST /api/spec/confirm`

**Files:**
- Create: `app/api/spec/confirm/route.ts`
- Test: `tests/spec/confirm.test.ts`

**Interfaces:**
- Consumes: `resolveState`, `readSession`, `newestSpec`/`confirmSpec` (T1), `alerter` (T8).
- Produces: `POST /api/spec/confirm` taking `{ specId: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/spec/confirm.test.ts
//
// The confirm endpoint is the only thing that turns a proposal into a
// promise. Follow the setup pattern in tests/chat/route.test.ts: stub
// next/headers, set process.env.PLATFORM_DB to a temp path, vi.resetModules(),
// then dynamically import the route.
import { describe, expect, it } from 'vitest'

describe('POST /api/spec/confirm', () => {
  it('401s an anonymous caller', async () => {
    // No session cookie at all.
    expect((await post({ specId: 1 }, { session: 'none' })).status).toBe(401)
  })

  it('400s a body with no numeric specId', async () => {
    expect((await post({ specId: 'seven' })).status).toBe(400)
  })

  it("404s another account's spec, never 403", async () => {
    // 404, matching canSeeUserSpace: a 403 confirms the row exists.
    const other = await seedSpec('devone')
    expect((await post({ specId: other }, { as: 'devtwo' })).status).toBe(404)
  })

  it('404s an id that does not exist', async () => {
    expect((await post({ specId: 9999 })).status).toBe(404)
  })

  it('409s a superseded proposal', async () => {
    // A stale tab is not bound by what the current page rendered.
    const first = await seedSpec('devtwo')
    await seedSpec('devtwo')
    expect((await post({ specId: first })).status).toBe(409)
  })

  it('confirms the newest proposal, records the metric, and fires the alert', async () => {
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id })).status).toBe(200)
    expect(confirmationCount(id)).toBe(1)
    expect(lastMetric().event).toBe('spec_confirmed')
    expect(lastMetric().data.spec_id).toBe(id)
    expect(alertBodies()).toEqual(['devtwo confirmed a spec'])
  })

  it('is a no-op on a repeat confirm, not a second append', async () => {
    // Append-only makes a duplicate harmless but permanent, and "confirmed
    // twice" is not a fact about anything.
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id })).status).toBe(200)
    expect((await post({ specId: id })).status).toBe(200)
    expect(confirmationCount(id)).toBe(1)
  })

  it('works while the session is locked', async () => {
    // The chat surface keeps working when the key is gone
    // (architecture-overview.md line 59), the spec flow lives inside it, and
    // confirming touches no user data.
    const id = await seedSpec('devtwo')
    expect((await post({ specId: id }, { locked: true })).status).toBe(200)
  })
})
```

The implementer writes `post`, `seedSpec`, `confirmationCount`, `lastMetric`,
and `alertBodies` as local helpers following `tests/chat/route.test.ts`'s
existing module-mocking setup. `alertBodies` reads a captured `fetch` the same
way `tests/alerts/leak.test.ts` does.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/spec/confirm.test.ts`
Expected: FAIL — the route does not exist.

- [ ] **Step 3: Write `app/api/spec/confirm/route.ts`**

```ts
// app/api/spec/confirm/route.ts
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { appendMetric } from '@/lib/db/appendOnly'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { confirmSpec, newestSpec, readSpecs } from '@/lib/db/specs'
import { alerter } from '@/lib/alerts/ntfy'

/**
 * The only thing that turns a proposal into a promise.
 *
 * Deliberately accepts a LOCKED session: the chat surface keeps working when
 * the key is gone (architecture-overview.md line 59), the spec flow lives
 * entirely inside that surface, and confirming touches no user data. Same
 * resolveState call, and the same reasoning, as /api/chat.
 */
export async function POST(request: Request) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) === 'anonymous') {
    return new Response(null, { status: 401 })
  }
  const session = readSession(db, sessionId!)
  if (!session) return new Response(null, { status: 401 })

  let payload: { specId?: unknown }
  try {
    payload = (await request.json()) as { specId?: unknown }
  } catch {
    return new Response(null, { status: 400 })
  }
  const specId = payload.specId
  if (typeof specId !== 'number' || !Number.isInteger(specId)) {
    return new Response(null, { status: 400 })
  }

  const mine = readSpecs(db, session.account_id)
  const spec = mine.find((s) => s.id === specId)
  // 404, never 403: a 403 would confirm the row exists. Same rule as
  // canSeeUserSpace, and it covers "not found" and "not yours" identically.
  if (!spec) return new Response(null, { status: 404 })

  // Only the newest proposal is confirmable. The panel renders older cards
  // inert, but a stale tab is not bound by what the current page rendered.
  if (newestSpec(db, session.account_id)?.id !== spec.id) {
    return new Response(null, { status: 409 })
  }

  // Append-only makes a duplicate confirmation harmless but permanent, and
  // "confirmed twice" is not a fact about anything. No-op, not an error:
  // a double-click is not a mistake the friend needs to hear about.
  if (spec.confirmed_at !== null) {
    return Response.json({ ok: true })
  }

  const at = Date.now()
  confirmSpec(db, { specId: spec.id, accountId: session.account_id, at })
  appendMetric(db, {
    accountId: session.account_id,
    event: 'spec_confirmed',
    at,
    // Not a model call: no counters, no model. Giving it zeroed counters
    // would put four rows of fiction in the cost log per confirmation.
    data: { spec_id: spec.id, version: spec.version },
  })

  // Fire-and-forget, exactly like the conversation alert: a friend's
  // confirmation must never fail because a phone did not buzz.
  void alerter({
    topic: process.env.NTFY_TOPIC,
    fetch: globalThis.fetch,
    db,
    now: Date.now,
  })('spec_confirmed', session.account_id)

  return Response.json({ ok: true })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx vitest run tests/spec/confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/spec/confirm/route.ts tests/spec/confirm.test.ts
git commit -m "Add the confirm endpoint

404 rather than 403 on a cross-account id, matching canSeeUserSpace: a
403 confirms the row exists. 409 on a superseded proposal, because the
panel renders older cards inert but a stale tab is not bound by what the
current page rendered. A repeat confirm is a 200 no-op rather than a
second append — append-only makes a duplicate harmless but permanent, and
a double-click is not a mistake the friend needs to hear about.

Accepts a locked session: the spec flow lives entirely inside the chat
surface, which keeps working when the key is gone, and confirming touches
no user data."
```

---

### Task 10: The three new NDJSON lines

**Files:**
- Modify: `app/api/chat/route.ts`
- Test: `tests/chat/route.test.ts` (extend)

**Interfaces:**
- Produces, on the existing NDJSON stream: `{"authoring":true}`, `{"proposal":{id,version,payload,mockup_html}}`, `{"proposal_error":true}`.

- [ ] **Step 1: Write the failing test**

```ts
describe('the proposal lines', () => {
  it('emits authoring, then proposal, then done', async () => {
    const lines = await drain(/* a turn whose fake proposes successfully */)
    expect(lines.map(Object.keys).flat()).toEqual([
      't', 'authoring', 'proposal', 'done',
    ])
    expect((lines.find((l) => 'proposal' in l) as { proposal: { version: number } })
      .proposal.version).toBe(1)
  })

  it('emits proposal_error when authoring fails, and STILL emits done', async () => {
    // A completed chat turn whose preview failed is still a completed chat
    // turn: the assistant row for it exists, and the friend really did
    // receive that reply.
    const lines = await drain(/* a turn whose authorSpec returns undefined */)
    expect(lines.some((l) => 'proposal_error' in l)).toBe(true)
    expect(lines.some((l) => 'done' in l)).toBe(true)
  })

  it('emits neither line on an ordinary turn', async () => {
    const lines = await drain(/* a turn that does not propose */)
    expect(lines.some((l) => 'authoring' in l || 'proposal' in l)).toBe(false)
  })
})
```

`drain` reads the response body and runs it through `parseNdjson`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/chat/route.test.ts`
Expected: FAIL — no `authoring` line is ever emitted.

- [ ] **Step 3: Wire the lines into `app/api/chat/route.ts`**

Add an `onAuthoring` callback to the `runTurn` deps object and emit from the
outcome:

```ts
      const outcome = await runTurn(
        {
          db,
          client: turnClient,
          now: Date.now,
          context: contextFor(db, session.account_id),
          alert: conversationAlerter({ /* unchanged */ }),
          authorSpec: (specInput) => {
            // Emitted here rather than before runTurn so the waiting state
            // appears exactly when the wait starts — after the reply has
            // finished streaming, not before it began.
            if (!request.signal.aborted) {
              controller.enqueue(line({ authoring: true }))
            }
            return authorSpec(
              { db, client: turnClient, now: Date.now, context: contextFor(db, session.account_id) },
              specInput,
            )
          },
        },
        { /* input unchanged */ },
      )

      if (!request.signal.aborted) {
        // Only when a proposal was ATTEMPTED. An ordinary turn emits neither.
        if (outcome.proposal) {
          controller.enqueue(line({ proposal: outcome.proposal }))
        } else if (outcome.attemptedProposal) {
          controller.enqueue(line({ proposal_error: true }))
        }
      }

      if (outcome.kind === 'completed' && !request.signal.aborted) {
        controller.enqueue(line({ done: true }))
      }
      controller.close()
```

`TurnOutcome` gains `attemptedProposal?: boolean`, set to `proposed` in
`runTurn` — the route cannot otherwise tell "did not propose" from
"proposed and failed", and those render differently.

Update `lib/chat/turn.ts` to set it, and extend
`tests/chat/turn.test.ts` with one assertion that `attemptedProposal` is
`true` on the failed-authoring path and absent on an ordinary turn.

- [ ] **Step 4: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/api/chat/route.ts lib/chat/turn.ts tests/chat/route.test.ts tests/chat/turn.test.ts
git commit -m "Emit the authoring, proposal, and proposal_error lines

The done line is unchanged and is NOT suppressed by a failed preview: a
completed chat turn whose authoring failed is still a completed chat turn,
and the assistant row for it exists.

TurnOutcome gains attemptedProposal because the route cannot otherwise
tell 'did not propose' from 'proposed and failed', and those render
differently — one shows nothing, the other owes the friend an explanation."
```

---

### Task 11: The proposal card

**Files:**
- Modify: `app/[user]/ChatPanel.tsx`
- Modify: `app/[user]/page.tsx` (pass the newest proposal)
- Test: `tests/chat/panel.test.ts` (extend)
- Test: `tests/spec/sandbox.test.ts` (new)

**Interfaces:**
- Consumes: `Proposal` (T7), `newestSpec` (T1), `parseSpecPayload` (T3).
- Produces: `SpecCard` (exported from `ChatPanel.tsx` for testing), `ChatPanel` gains a `proposal?: Proposal & { confirmed: boolean }` prop.

- [ ] **Step 1: Write the failing tests**

Add to `tests/chat/panel.test.ts`:

```ts
describe('the proposal card', () => {
  it('renders the spec, the mockup, and the exact copy', () => {
    const json = JSON.stringify(SpecCard({ proposal: PROPOSAL, live: true, busy: false, onConfirm: () => {} }))
    expect(json).toContain('Eating out and the car fund')
    expect(json).toContain('Build this')
    expect(json).toContain('Not quite yet')
    expect(json).toContain(
      "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
    )
  })

  it('renders a superseded card inert — no buttons', () => {
    // Scrolling back should read as a history of what was offered, not a
    // stack of armed buttons.
    const json = JSON.stringify(SpecCard({ proposal: PROPOSAL, live: false, busy: false, onConfirm: () => {} }))
    expect(json).not.toContain('Build this')
  })

  it('posts the id of the card the button sits on', async () => {
    const posted: unknown[] = []
    // ...stub fetch, click confirm on a card whose id is 42...
    expect(posted).toEqual([{ specId: 42 }])
  })

  it('renders a proposal_error line as an honest failure with no card', () => {
    const { lines } = parseNdjson('{"proposal_error":true}\n')
    expect(lines).toEqual([{ proposal_error: true }])
  })
})
```

Create `tests/spec/sandbox.test.ts`:

```ts
// tests/spec/sandbox.test.ts
//
// The one property that must hold at EVERY site rendering model-authored
// HTML, including sites added later. Its own file for that reason: an
// assertion buried in a render test covers the site it was written for and
// nothing else.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Every file under app/ that renders mockup_html into the DOM. */
const SITES = ['app/[user]/ChatPanel.tsx']

/**
 * Files that mention mockup_html without rendering it — they read it, pass it
 * along, or type it. Listed explicitly so the sweep below can tell "does not
 * render" from "renders and nobody checked".
 */
const NON_RENDERING = ['app/[user]/page.tsx']

describe('mockup HTML is rendered sealed off', () => {
  it.each(SITES)('%s uses an empty sandbox and never allow-scripts', (file) => {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8')
    expect(source).toContain('sandbox=""')
    expect(source).not.toContain('allow-scripts')
    expect(source).not.toContain('allow-same-origin')
  })

  it('every file under app/ that touches mockup_html is accounted for', () => {
    // A new render site nobody added to SITES is exactly the gap this file
    // exists to close, and it is invisible to a per-site assertion. Grep the
    // tree rather than trusting the list.
    const found = execFileSync('git', ['grep', '-l', 'mockup_html', '--', 'app'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
      .split('\n')
      .filter((line) => line !== '')
      .sort()

    expect(found).toEqual([...SITES, ...NON_RENDERING].sort())
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/spec/sandbox.test.ts tests/chat/panel.test.ts`
Expected: FAIL — `SpecCard` is not exported.

- [ ] **Step 3: Add `SpecCard` to `app/[user]/ChatPanel.tsx`**

```tsx
export type CardProposal = {
  id: number
  version: number
  payload: SpecPayload
  mockup_html: string
  confirmed?: boolean
}

/**
 * The moment a promise gets made.
 *
 * `live` is false for a superseded card: it stays visible in the scrollback
 * so the conversation reads as a history of what was offered, but it carries
 * no buttons. The server enforces the same rule (409), because a stale tab is
 * not bound by what this rendered.
 */
export function SpecCard({
  proposal,
  live,
  busy,
  onConfirm,
}: {
  proposal: CardProposal
  live: boolean
  busy: boolean
  onConfirm: (specId: number) => void
}) {
  const { payload } = proposal
  return (
    <section aria-label="Proposed dashboard" data-spec-id={proposal.id}>
      <h3>{payload.title}</h3>
      <p>{payload.summary}</p>
      <ul>
        {payload.panels.map((panel) => (
          <li key={panel.name}>
            <strong>{panel.name}</strong> — {panel.shows}
          </li>
        ))}
      </ul>

      {/* Sealed off: an empty sandbox grants nothing — no scripts, no
          same-origin, no forms, no top-level navigation. Model-authored
          markup can therefore never run code in a friend's session, and the
          preview stays a LAYOUT promise rather than a behaviour promise
          somebody then has to build. tests/spec/sandbox.test.ts pins this. */}
      <iframe
        title={`Preview of ${payload.title}`}
        srcDoc={proposal.mockup_html}
        sandbox=""
      />

      {proposal.confirmed ? (
        <p><em>Building this one.</em></p>
      ) : live ? (
        <>
          <p>
            <button type="button" disabled={busy} onClick={() => onConfirm(proposal.id)}>
              Build this
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => { /* just keep talking */ }}>
              Not quite yet
            </button>
          </p>
          {/* Fixed chrome, not agent prose: this is the most load-bearing
              promise in the pilot and it is made at the exact moment the
              friend decides, so it cannot depend on a model remembering to
              say it. Passive, and it names nobody — the agent is not the one
              building, and naming Nico turns the surface into a middleman.
              It promises no notification, because nothing can deliver one
              (architecture-overview.md line 49: delivery nudges stay
              out-of-app). */}
          <p>
            <small>
              Your dashboard gets built as soon as possible — at the latest,
              it&apos;ll be here tomorrow morning.
            </small>
          </p>
        </>
      ) : null}
    </section>
  )
}
```

In `ChatPanel`, hold `proposal` in state, set it from the `proposal` NDJSON
line, render `{authoring && <p>Putting together a preview…</p>}` from the
`authoring` line, render an honest failure from `proposal_error`, and POST
`{specId}` to `/api/spec/confirm` from `onConfirm`. `live` is
`proposal.id === newest.id`.

- [ ] **Step 4: Pass the newest proposal from `app/[user]/page.tsx`**

```tsx
  const newest = newestSpec(getDb(), accountId)
  // Rendered from the record on load, so a friend who closes the tab
  // mid-decision comes back to the same card, still confirmable.
  const proposal = newest
    ? {
        id: newest.id,
        version: newest.version,
        payload: parseSpecPayload(newest.payload),
        mockup_html: newest.mockup_html,
        confirmed: newest.confirmed_at !== null,
      }
    : undefined
```

- [ ] **Step 5: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/[user]/ChatPanel.tsx app/[user]/page.tsx tests/chat/panel.test.ts tests/spec/sandbox.test.ts
git commit -m "Render the proposal card, with the mockup sealed off

The mockup renders in an iframe with an EMPTY sandbox attribute, which
grants nothing. Containment is structural — a capability never granted —
rather than a sanitizer that has to keep winning, and it keeps the preview
a layout promise rather than a behaviour promise somebody then has to
build. tests/spec/sandbox.test.ts is its own file because that property
must hold at every render site, including ones added later.

'Build this' names the consequence; 'This is right' would invite agreement
with a description. The delivery line is fixed chrome rather than agent
prose, promises no notification we cannot deliver, and names nobody.

The card is rendered from the record on page load too, so closing the tab
mid-decision does not lose it."
```

---

### Task 12: The admin spec pane

**Files:**
- Modify: `app/admin/[user]/page.tsx`
- Test: `tests/admin/specPane.test.ts` (new)
- Test: `tests/spec/sandbox.test.ts` (add the admin page to `SITES`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin/specPane.test.ts — follow tests/admin/transcriptPane.test.ts's
// module-mocking setup exactly.
describe('the spec pane', () => {
  it('lists every proposal, newest first, marking the confirmed one', async () => {
    // A friend stuck on round three is visible as a friend stuck on round
    // three, not as silence.
    const json = await render('devone')
    expect(json.indexOf('v3')).toBeLessThan(json.indexOf('v1'))
    expect(json).toContain('Confirmed')
  })

  it('puts open questions ABOVE the spec body', async () => {
    // open_questions is not documentation: it is the agent saying it refused
    // to promise something and handed the question over.
    const json = await render('devone')
    expect(json.indexOf('Is a Monzo pot reachable?')).toBeLessThan(
      json.indexOf('So mornings stop being a surprise.'),
    )
  })

  it('renders the mockup with an empty sandbox', async () => {
    const json = await render('devone')
    expect(json).toContain('"sandbox":""')
    expect(json).not.toContain('allow-scripts')
  })

  it('says so plainly when there are no proposals yet', async () => {
    expect(await render('devtwo')).toContain('No spec yet.')
  })

  it('still 404s a non-admin session', async () => {
    await expect(render('devone', { as: 'user' })).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/admin/specPane.test.ts`
Expected: FAIL — no spec section is rendered.

- [ ] **Step 3: Add the section to `app/admin/[user]/page.tsx`**

Read `readSpecs(getDb(), account.id)`, render a `<section>` above the
transcript with one block per proposal: version, timestamp, confirmed marker,
`open_questions` first as a list, then title/summary/background/panels, then
`<iframe srcDoc={spec.mockup_html} sandbox="" />`. Parse each `payload` with
`parseSpecPayload`. Read-only, admin-only, 404 otherwise — unchanged.

- [ ] **Step 4: Add the admin page to `SITES` in `tests/spec/sandbox.test.ts`**

```ts
const SITES = ['app/[user]/ChatPanel.tsx', 'app/admin/[user]/page.tsx']
```

- [ ] **Step 5: Run the tests, then commit**

```bash
npx tsc --noEmit && npx vitest run
git add app/admin/[user]/page.tsx tests/admin/specPane.test.ts tests/spec/sandbox.test.ts
git commit -m "Add the admin spec pane beside the transcript

Every proposal, newest first, confirmed ones marked — so a friend stuck on
round three is visible as a friend stuck on round three rather than as
silence, and how many rounds an interview took becomes something you can
see rather than reconstruct.

open_questions renders ABOVE the spec body: it is not part of the build
description, it is the agent saying it refused to promise something and
handed the question over. The mockup is sealed the same way it is for the
friend, so the portal is not the softer target."
```

---

### Task 13: `pull-spec.sh`

**Files:**
- Create: `scripts/export-spec.ts`
- Create: `scripts/pull-spec.sh`
- Test: `tests/scripts/exportSpec.test.ts`
- Modify: `docs/local-dev.md` (the command)

**Interfaces:**
- Produces: `exportSpec(db, slug): { spec_md: string; mockup_html: string }` from `scripts/export-spec.ts`, plus a CLI entry point printing that object as JSON.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/exportSpec.test.ts
describe('exportSpec', () => {
  it('renders the confirmed spec and returns the mockup verbatim', () => {
    const out = exportSpec(db, 'devtwo')
    expect(out.spec_md).toContain('# Eating out and the car fund')
    expect(out.spec_md).toContain('v1')
    expect(out.mockup_html).toBe('<!doctype html><html><body>COFFEE PALACE TEST</body></html>')
  })

  it('exports the newest CONFIRMED spec, not the newest proposal', () => {
    // The file is the build contract, and only a confirmed spec is one.
    expect(exportSpec(db, 'devtwo').spec_md).toContain('confirmed one')
  })

  it('refuses an account with no confirmed spec, naming why', () => {
    expect(() => exportSpec(db, 'devone')).toThrow(/no confirmed spec/)
  })

  it('refuses an unknown slug', () => {
    expect(() => exportSpec(db, 'ghost')).toThrow(/no account/)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/scripts/exportSpec.test.ts`
Expected: FAIL — cannot resolve `@/scripts/export-spec`.

- [ ] **Step 3: Write `scripts/export-spec.ts`**

```ts
// scripts/export-spec.ts
//
// Prints one account's confirmed spec as JSON on stdout. Runs ON THE DROPLET,
// invoked by scripts/pull-spec.sh over ssh.
//
// THIS READS A NON-SYNTHETIC DATABASE BY DESIGN, on the server, run by Nico.
// That is consistent with CLAUDE.md: the platform database is not encrypted
// with any user key and holds the records Nico is promised access to at
// onboarding. It is NOT consistent with Claude running it locally against
// anything but the synthetic database — pass --local for that, and nothing
// else.
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { currentSpec } from '@/lib/db/specs'
import { parseSpecPayload } from '@/lib/spec/schema'
import { renderSpecMarkdown } from '@/lib/spec/render'

export function exportSpec(
  db: PlatformDb,
  slug: string,
): { spec_md: string; mockup_html: string } {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)

  const spec = currentSpec(db, account.id)
  // Only a CONFIRMED spec is a build contract. Refusing loudly here is what
  // stops a draft being committed as one.
  if (!spec) throw new Error(`no confirmed spec for '${slug}'`)

  return {
    spec_md: renderSpecMarkdown(parseSpecPayload(spec.payload), {
      slug,
      version: spec.version,
      confirmedAt: spec.confirmed_at!,
    }),
    mockup_html: spec.mockup_html,
  }
}

if (process.argv[1]?.endsWith('export-spec.ts')) {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: tsx scripts/export-spec.ts <slug>')
    process.exit(2)
  }
  const db = openPlatformDb(
    process.env.PLATFORM_DB ?? 'platform/dev/synthetic.db',
  )
  try {
    process.stdout.write(JSON.stringify(exportSpec(db, slug)))
  } finally {
    db.close()
  }
}
```

- [ ] **Step 4: Write `scripts/pull-spec.sh`**

```bash
#!/usr/bin/env bash
# Pull one user's confirmed spec into the repo. Run from the repo root on the
# LAPTOP:
#   ./scripts/pull-spec.sh devtwo
#   ./scripts/pull-spec.sh devtwo --local
#
# The droplet never writes into its own git checkout. deploy/deploy.sh runs
# `git pull --ff-only` in the working tree and CLAUDE.md forbids deploying by
# editing files on the droplet, so an app that wrote users/<name>/spec.md at
# runtime would be putting untracked, un-backed-up files inside the deploy
# unit — invisible to the laptop where the dashboard actually gets built.
set -euo pipefail

main() {
  local user="${1:-}"
  if [ -z "$user" ]; then
    echo "usage: ./scripts/pull-spec.sh <user> [--local]" >&2
    exit 2
  fi

  local json
  if [ "${2:-}" = "--local" ]; then
    json=$(npx tsx scripts/export-spec.ts "$user")
  else
    json=$(ssh deploy@app.stairwell.run \
      'cd /home/deploy/stairwell && npx tsx scripts/export-spec.ts '"$user")
  fi

  mkdir -p "users/$user"
  node -e '
    const fs = require("fs");
    const out = JSON.parse(process.argv[1]);
    const user = process.argv[2];
    fs.writeFileSync(`users/${user}/spec.md`, out.spec_md);
    fs.writeFileSync(`users/${user}/mockup.html`, out.mockup_html);
  ' "$json" "$user"

  echo "Wrote users/$user/spec.md and users/$user/mockup.html"
  echo "Both are Gate B exempt — commit them when you are ready."
}

main "$@"
```

`chmod +x scripts/pull-spec.sh`.

- [ ] **Step 5: Document the command in `docs/local-dev.md`**

Add a short section giving the two commands verbatim, and stating that the
droplet form needs ssh access and that the file is overwritten on every pull.

- [ ] **Step 6: Run the tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add scripts/export-spec.ts scripts/pull-spec.sh tests/scripts/exportSpec.test.ts docs/local-dev.md
git commit -m "Pull a confirmed spec into the repo with one command

The droplet never writes into its own git checkout: deploy.sh runs
git pull --ff-only in the working tree and CLAUDE.md forbids deploying by
editing files there, so a runtime write would put untracked,
un-backed-up files inside the deploy unit, invisible to the laptop where
the dashboard actually gets built.

export-spec.ts refuses an account with no CONFIRMED spec rather than
exporting the newest draft — only a confirmed spec is a build contract.

It reads a non-synthetic database by design, on the server, run by Nico;
the platform DB is not encrypted with any user key and holds the records
the onboarding promise already covers. The header says so, and says that
--local is the only form Claude runs."
```

---

## Closing out

After Task 13:

- [ ] `npx vitest run` — full suite green
- [ ] `npx tsc --noEmit` — clean
- [ ] `npx next build` — succeeds (Gate D runs it on push anyway; running it here means finding a middleware/import break before the push, not during it)
- [ ] `.claude/hooks/test-hooks.sh` — all pass
- [ ] Merge to `main` as a fast-forward, preserving task SHAs, then push
- [ ] `deploy/deploy.sh` on the droplet; confirm the `Deployed <sha>` line matches the sha you pushed (step-2 ledger item 15)
- [ ] **The step-4 checkpoint, as `devtwo`** — spec §11.2:
      log in as `devtwo` → run a real interview to completion → the agent
      proposes → the card renders with a working mockup → press **Build this**
      → the phone buzzes → the spec and mockup render in the admin portal →
      `./scripts/pull-spec.sh devtwo` writes both files into the repo.
      Running this as `nico` looks identical to a broken build: admin accounts
      are alert-suppressed and unlistable in the portal.
- [ ] Open `docs/superpowers/ledgers/step4.md` and record what shipped, what
      was deviated from, and the residual risks
