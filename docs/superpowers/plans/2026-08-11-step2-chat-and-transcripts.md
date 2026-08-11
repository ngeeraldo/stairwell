# Step 2 — Chat Surface, Agent, and Transcripts: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev user chats with a Claude-backed agent on their own page, the exchange is persisted to the append-only transcript with conversation grouping and prompt provenance, and Nico reads it in the admin portal.

**Architecture:** A route handler owns the stream: it appends the user turn, calls Anthropic with streaming, and appends the assistant turn *only* when the stream completes server-side. Decision logic lives in `lib/chat/*` with the model client injected as a parameter, so the suite drives every path — completion, abort, API error — without a network call. Two sacred tables gain columns; because neither has ever had a production writer, a pre-schema reshape step drops-and-recreates them when empty and throws loudly when not.

**Tech Stack:** Next.js App Router, TypeScript, `@anthropic-ai/sdk`, better-sqlite3-multiple-ciphers, vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-step2-chat-and-transcripts-design.md`. Section references below (§2.3, §3.4, …) point at it.

**Branch:** `step2-chat-design` (already created, spec already committed).

## Global Constraints

- Sacred data: `transcripts` and `metrics` are append-only. Never write `UPDATE` or `DELETE` against them. `lib/db/reshape.ts` is the single deliberate exception and only via `DROP TABLE` on a verified-empty table.
- All development and testing runs against synthetic databases only. Never open any `*.db` other than `synthetic.db` (and never `fake-real.db`).
- **No test may call the live Anthropic API.** `runTurn` takes its client as a parameter; tests pass a fake.
- Never log, commit, or write an API key to code, fixtures, tests, or debug output.
- `schema.sql` changes must be accompanied in the same commit by a `tests/` change (Gate A).
- Any commit staging `app/`, `lib/`, `platform/`, or `middleware.ts` needs a test under `tests/` (Gate B). `.githooks/` or `.claude/hooks/` changes need `.claude/hooks/test-hooks.sh`.
- Any commit staging a `.ts`/`.tsx` runs `npx tsc --noEmit` and blocks on a compiler error.
- `git push` runs `npx vitest run` then `npx next build`, unconditionally.
- Model id: `claude-opus-5`, from `CHAT_MODEL`. Effort: `medium`. `max_tokens`: 8192.
- Conversation gap: 30 minutes. Prompt sha: first 12 hex chars of sha-256 of the file bytes.
- `context` value in step 2 is always the literal string `interview`.

## Deviation from the spec, deliberate

§3.1 says `loadPrompt` reads "once per process". This plan reads the file on every turn instead. It is a few KB next to a multi-second API call, and a module-level cache would either need a test-only reset hook or make `tests/chat/prompt.test.ts` order-dependent. Nothing else in the spec depends on the caching.

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `lib/db/reshape.ts` | Drop empty sacred tables whose shape is stale; throw if non-empty |
| `lib/chat/conversation.ts` | The 30-minute boundary rule |
| `lib/chat/prompt.ts` | Load prompt text + compute its sha |
| `lib/chat/history.ts` | Transcript rows → API messages |
| `lib/chat/client.ts` | Anthropic SDK behind a narrow `ChatClient` interface |
| `lib/chat/turn.ts` | The append rule, end to end |
| `app/api/chat/route.ts` | HTTP adapter + NDJSON stream |
| `app/[user]/ChatPanel.tsx` | Client component: messages, input, interrupted marker |
| `app/admin/[user]/page.tsx` | Read-only transcript pane grouped by conversation |
| `platform/prompts/agent-v1.md` | The prompt text (prose, no logic) |
| `tests/db/reshape.test.ts`, `tests/chat/*.test.ts`, `tests/admin/transcriptPane.test.ts` | Coverage |

**Modify**

| File | Change |
|---|---|
| `platform/schema.sql` | New columns on both sacred tables + conversation index |
| `lib/db/platform.ts` | Call `reshapeSacredTables` before the schema exec |
| `lib/db/appendOnly.ts` | New required fields; `lastTranscriptRow`; `readConversations` |
| `lib/session/resolve.ts` | Locked sessions may reach a user-space path |
| `app/[user]/page.tsx` | Render `ChatPanel` + a locked placeholder |
| `app/admin/page.tsx` | User list becomes links |
| `tests/db/appendOnly.test.ts` | New columns; extend the mutation-scan to `DROP` |
| `tests/routing/userSpace.test.ts`, `tests/routing/middleware.test.ts` | Rewrite the assertions the §4 fix inverts (Task 7) |
| `.githooks/pre-commit`, `.claude/hooks/test-hooks.sh` | Explicit `platform/prompts/*` arm |
| `CLAUDE.md`, `deploy/PROVISION.md`, `docs/local-dev.md` | Documentation |
| `docs/superpowers/ledgers/step2.md` | Create; known-unhandled items |

## Two hazards found while reading the existing tests

Both are handled in Task 7. Flagged here because they are easy to "fix" by deletion, which would be wrong.

1. **`tests/routing/middleware.test.ts:105` is a regression guard that the §4 fix silently defangs.** It asserts `routeFor('authenticated', '/adminbob')` is `/unlock`, guarding against `/adminbob` being mistaken for an admin path. After the fix, *both* admin paths and user-space paths return `null` for a locked session, so the assertion stops distinguishing anything even though it still passes-by-change. Task 7 replaces it with a pair that still distinguishes: `/admin/settings` → `null` (admin subpath) versus `/adminbob/settings` → `/unlock` (two segments, not a user space, not admin).

2. **`tests/routing/userSpace.test.ts:270` asserts the exact behaviour §4 reverses.** "Sends a locked owner to /unlock too" is correct today and wrong after the fix. It gets rewritten to assert the new property, not deleted.

---

### Task 1: Sacred-table reshape and new columns

**Files:**
- Modify: `platform/schema.sql`
- Create: `lib/db/reshape.ts`
- Modify: `lib/db/platform.ts:16-22`
- Create: `tests/db/reshape.test.ts`

**Interfaces:**
- Consumes: `PlatformDb` from `lib/db/platform.ts`
- Produces: `reshapeSacredTables(db: PlatformDb): void`

- [ ] **Step 1: Write the failing test**

Create `tests/db/reshape.test.ts`:

```ts
// tests/db/reshape.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reshapeSacredTables } from '@/lib/db/reshape'
import { openPlatformDb } from '@/lib/db/platform'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-reshape-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A database carrying the pre-step-2 shape of both sacred tables. */
function legacyDb(path: string) {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL,
      role TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE metrics (
      id INTEGER PRIMARY KEY, account_id INTEGER,
      event TEXT NOT NULL, at INTEGER NOT NULL
    );
  `)
  return db
}

describe('reshapeSacredTables', () => {
  it('drops an empty table whose shape is stale', () => {
    const db = legacyDb(join(dir, 'synthetic.db'))
    reshapeSacredTables(db)
    const info = db.pragma('table_info(transcripts)') as { name: string }[]
    expect(info).toHaveLength(0)
    db.close()
  })

  it('leaves an already-current table alone', () => {
    const db = openPlatformDb(join(dir, 'synthetic.db'))
    reshapeSacredTables(db)
    const names = (db.pragma('table_info(transcripts)') as { name: string }[])
      .map((c) => c.name)
    expect(names).toContain('conversation_id')
    db.close()
  })

  it('refuses to drop a stale table that holds rows, naming table and count', () => {
    const db = legacyDb(join(dir, 'synthetic.db'))
    db.prepare(
      "INSERT INTO transcripts (account_id, role, body, at) VALUES (1, 'user', 'hi', 100)",
    ).run()
    expect(() => reshapeSacredTables(db)).toThrow(/transcripts.*1 row/s)
    // And the row is still there — a refusal must not be destructive.
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as {
      n: number
    }
    expect(n).toBe(1)
    db.close()
  })

  it('is a no-op on a database where the tables do not exist yet', () => {
    const db = new Database(join(dir, 'synthetic.db'))
    expect(() => reshapeSacredTables(db)).not.toThrow()
    db.close()
  })

  it('leaves the append-only triggers in place after openPlatformDb reshapes', () => {
    // The whole point of reshaping BEFORE the schema exec: dropping a table
    // drops its triggers, and schema.sql must be the thing that puts them
    // back. If the order were reversed the table would come back unguarded.
    const path = join(dir, 'synthetic.db')
    legacyDb(path).close()
    const db = openPlatformDb(path)
    db.prepare(
      `INSERT INTO transcripts
       (account_id, session_id, conversation_id, prompt_sha, role, body, at)
       VALUES (1, 's', 'c', 'p', 'user', 'hi', 100)`,
    ).run()
    expect(() => db.prepare("UPDATE transcripts SET body = 'x'").run()).toThrow(
      /append-only/,
    )
    db.close()
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/reshape.test.ts`
Expected: FAIL — cannot resolve `@/lib/db/reshape`.

- [ ] **Step 3: Add the columns to `platform/schema.sql`**

Replace the `transcripts` table and its index (currently lines 28-36):

```sql
CREATE TABLE IF NOT EXISTS transcripts (
  id              INTEGER PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  session_id      TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  prompt_sha      TEXT    NOT NULL,
  role            TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS transcripts_account ON transcripts(account_id, at);
CREATE INDEX IF NOT EXISTS transcripts_conversation
  ON transcripts(conversation_id, at);
```

Replace the `metrics` table (currently lines 38-43):

```sql
CREATE TABLE IF NOT EXISTS metrics (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER,
  event      TEXT    NOT NULL,
  data       TEXT,
  at         INTEGER NOT NULL
);
```

- [ ] **Step 4: Write `lib/db/reshape.ts`**

```ts
// lib/db/reshape.ts
import type { PlatformDb } from './platform'

/**
 * The column set each sacred table must have. Keys are hardcoded literals —
 * nothing here is caller-supplied, which is what makes the interpolation into
 * the statements below safe.
 */
const EXPECTED: Record<string, readonly string[]> = {
  transcripts: [
    'id',
    'account_id',
    'session_id',
    'conversation_id',
    'prompt_sha',
    'role',
    'body',
    'at',
  ],
  metrics: ['id', 'account_id', 'event', 'data', 'at'],
}

/**
 * Bring the sacred tables up to the current shape, before schema.sql runs.
 *
 * CLAUDE.md > Sacred data forbids migrating transcripts and metrics. This is
 * not a migration: neither table has ever had a production writer, so a stale
 * shape means an empty table that was created but never used. Dropping it lets
 * schema.sql recreate it — with its triggers and indexes, which is why this
 * must run BEFORE the schema exec, not after.
 *
 * If a stale table is NOT empty, the assumption above is wrong. Throw rather
 * than destroy: the process fails at boot, deploy/smoke.sh fails the deploy,
 * and the previous version keeps serving with history intact.
 */
export function reshapeSacredTables(db: PlatformDb): void {
  for (const [table, expected] of Object.entries(EXPECTED)) {
    const info = db.pragma(`table_info(${table})`) as { name: string }[]
    if (info.length === 0) continue // Does not exist yet; schema.sql creates it.

    const present = new Set(info.map((c) => c.name))
    const missing = expected.filter((c) => !present.has(c))
    if (missing.length === 0) continue

    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number
    }
    if (n > 0) {
      throw new Error(
        `${table} is missing column(s) ${missing.join(', ')} but holds ${n} row(s). ` +
          'CLAUDE.md > Sacred data: append-only tables are never migrated. ' +
          'Resolve this by hand before deploying.',
      )
    }

    db.exec(`DROP TABLE ${table}`)
  }
}
```

- [ ] **Step 5: Wire it into `lib/db/platform.ts`**

Add the import and one call, so the function body becomes:

```ts
export function openPlatformDb(path: string): PlatformDb {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // Before the schema exec, never after: dropping a table drops its triggers,
  // and the exec below is what puts them back. See lib/db/reshape.ts.
  reshapeSacredTables(db)
  db.exec(readFileSync(SCHEMA, 'utf8'))
  return db
}
```

with `import { reshapeSacredTables } from './reshape'` at the top.

- [ ] **Step 6: Run the reshape tests**

Run: `npx vitest run tests/db/reshape.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Run the whole suite to see what the column change broke**

Run: `npx vitest run`
Expected: FAIL in `tests/db/appendOnly.test.ts` — inserts now violate `NOT NULL`. That is Task 2. Note which tests failed; do not fix them here.

- [ ] **Step 8: Commit**

```bash
git add platform/schema.sql lib/db/reshape.ts lib/db/platform.ts tests/db/reshape.test.ts
git commit -m "Add sacred-table columns and the reshape that lands them

transcripts gains session_id, conversation_id, and prompt_sha; metrics gains
a nullable JSON data column. Neither table has ever had a production writer,
so this finishes a table definition rather than migrating data — and
reshape.ts verifies that at runtime instead of assuming it, throwing on a
non-empty stale table so a wrong assumption fails the deploy."
```

Gate A is satisfied by `tests/` in the same commit; Gate B by `tests/db/reshape.test.ts`.

---

### Task 2: Append-only writers take the new fields

**Files:**
- Modify: `lib/db/appendOnly.ts`
- Modify: `tests/db/appendOnly.test.ts`

**Interfaces:**
- Consumes: `reshapeSacredTables` (Task 1) via `openPlatformDb`
- Produces:
  - `type TranscriptRow = { id, account_id, session_id, conversation_id, prompt_sha, role, body, at }`
  - `appendTranscript(db, { accountId: number, sessionId: string, conversationId: string, promptSha: string, role: string, body: string, at: number }): void`
  - `readTranscript(db, accountId: number): TranscriptRow[]`
  - `lastTranscriptRow(db, accountId: number): TranscriptRow | undefined`
  - `appendMetric(db, { accountId: number | null, event: string, data?: unknown, at: number }): void`

- [ ] **Step 1: Update the existing tests to the new shape and add new ones**

In `tests/db/appendOnly.test.ts`, replace every `appendTranscript(db, {...})` call with the full shape, and extend the mutation scan. The four call sites at lines 25, 30, 37 become:

```ts
appendTranscript(db, {
  accountId: 1,
  sessionId: 'sess-1',
  conversationId: 'conv-1',
  promptSha: 'abc123def456',
  role: 'user',
  body: 'hello',
  at: 100,
})
```

Add these tests inside the same `describe`:

```ts
  it('round-trips every transcript column', () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-1',
      promptSha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
    const [row] = readTranscript(db, 1)
    expect(row).toMatchObject({
      account_id: 1,
      session_id: 'sess-1',
      conversation_id: 'conv-1',
      prompt_sha: 'abc123def456',
      role: 'user',
      body: 'hello',
      at: 100,
    })
  })

  it('lastTranscriptRow returns the newest row for the account, and only that account', () => {
    const base = { sessionId: 's', conversationId: 'c', promptSha: 'p', role: 'user' }
    appendTranscript(db, { ...base, accountId: 1, body: 'older', at: 100 })
    appendTranscript(db, { ...base, accountId: 1, body: 'newer', at: 200 })
    appendTranscript(db, { ...base, accountId: 2, body: 'other account', at: 300 })
    expect(lastTranscriptRow(db, 1)?.body).toBe('newer')
    expect(lastTranscriptRow(db, 99)).toBeUndefined()
  })

  it('appendMetric stores data as JSON and reads back as null when omitted', () => {
    appendMetric(db, {
      accountId: 7,
      event: 'chat_turn',
      at: 1,
      data: { input: 10, output: 20 },
    })
    appendMetric(db, { accountId: 7, event: 'session_open', at: 2 })
    const rows = db
      .prepare('SELECT event, data FROM metrics ORDER BY at')
      .all() as { event: string; data: string | null }[]
    expect(JSON.parse(rows[0].data!)).toEqual({ input: 10, output: 20 })
    expect(rows[1].data).toBeNull()
  })
```

Update the import on line 8 to include `lastTranscriptRow`.

Then strengthen the mutation scan at line 80. `DROP TABLE` is the most destructive statement there is, and `lib/db/reshape.ts` deliberately contains one — so the scan must cover `DROP` and carve that file out by name, rather than leaving a gap the regex never looked at:

```ts
  it('has no UPDATE, DELETE, or DROP against those tables anywhere in lib/db', () => {
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts')) files.push(p)
      }
    }
    walk('lib/db')
    expect(files.length).toBeGreaterThan(0)

    // reshape.ts is the ONE deliberate exception: it drops a sacred table,
    // but only after proving it holds zero rows, and tests/db/reshape.test.ts
    // pins that it throws rather than drops when rows exist. Carved out by
    // name so the exception is visible here rather than being a hole in the
    // pattern nobody notices.
    const exempt = join('lib', 'db', 'reshape.ts')
    const offending =
      /(UPDATE|DELETE\s+FROM|DROP\s+TABLE)\s+(transcripts|metrics)\b/i
    for (const f of files) {
      if (f === exempt) continue
      expect(readFileSync(f, 'utf8'), `${f} mutates a sacred table`).not.toMatch(
        offending,
      )
    }
    // And the carve-out must not be silently unreachable: if reshape.ts is
    // renamed or removed, this fails rather than quietly exempting nothing.
    expect(files).toContain(exempt)
  })
```

Note: `reshape.ts` interpolates the table name (`DROP TABLE ${table}`), so the literal regex would not have matched it anyway. The carve-out is documentation of intent, and the final assertion is what keeps it honest.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/db/appendOnly.test.ts`
Expected: FAIL — `lastTranscriptRow` is not exported.

- [ ] **Step 3: Rewrite `lib/db/appendOnly.ts`**

```ts
import type { PlatformDb } from './platform'

export type TranscriptRow = {
  id: number
  account_id: number
  session_id: string
  conversation_id: string
  prompt_sha: string
  role: string
  body: string
  at: number
}

/**
 * transcripts and metrics are append-only (CLAUDE.md > Sacred data). This
 * module exposes appends and reads and nothing else. The database enforces
 * the same rule with triggers, so a mistake here fails loudly rather than
 * silently rewriting history.
 */
export function appendTranscript(
  db: PlatformDb,
  row: {
    accountId: number
    sessionId: string
    conversationId: string
    promptSha: string
    role: string
    body: string
    at: number
  },
): void {
  db.prepare(
    `INSERT INTO transcripts
     (account_id, session_id, conversation_id, prompt_sha, role, body, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.accountId,
    row.sessionId,
    row.conversationId,
    row.promptSha,
    row.role,
    row.body,
    row.at,
  )
}

export function readTranscript(
  db: PlatformDb,
  accountId: number,
): TranscriptRow[] {
  return db
    .prepare('SELECT * FROM transcripts WHERE account_id = ? ORDER BY at, id')
    .all(accountId) as TranscriptRow[]
}

/** The newest row for one account, or undefined if they have never written. */
export function lastTranscriptRow(
  db: PlatformDb,
  accountId: number,
): TranscriptRow | undefined {
  return db
    .prepare(
      'SELECT * FROM transcripts WHERE account_id = ? ORDER BY at DESC, id DESC LIMIT 1',
    )
    .get(accountId) as TranscriptRow | undefined
}

export function appendMetric(
  db: PlatformDb,
  row: {
    accountId: number | null
    event: string
    data?: unknown
    at: number
  },
): void {
  db.prepare(
    'INSERT INTO metrics (account_id, event, data, at) VALUES (?, ?, ?, ?)',
  ).run(
    row.accountId,
    row.event,
    row.data === undefined ? null : JSON.stringify(row.data),
    row.at,
  )
}
```

`ORDER BY at, id` rather than bare `at`: two rows in the same millisecond otherwise come back in arbitrary order, and a user turn and its reply can land in the same millisecond with a fake client.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/db/appendOnly.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. Nothing outside `lib/db` called these writers.

- [ ] **Step 6: Commit**

```bash
git add lib/db/appendOnly.ts tests/db/appendOnly.test.ts
git commit -m "Require the new transcript columns at the write boundary

appendTranscript now takes session_id, conversation_id, and prompt_sha as
required arguments, and appendMetric takes an optional data object stored as
JSON. Adds lastTranscriptRow for the conversation boundary rule.

Extends the lib/db mutation scan to cover DROP TABLE, with lib/db/reshape.ts
carved out by name and an assertion that the carve-out still points at a
file that exists."
```

---

### Task 3: The conversation boundary rule

**Files:**
- Create: `lib/chat/conversation.ts`
- Create: `tests/chat/conversation.test.ts`

**Interfaces:**
- Consumes: `lastTranscriptRow` (Task 2)
- Produces: `CONVERSATION_GAP_MS: number`, `conversationIdFor(db: PlatformDb, accountId: number, now: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/conversation.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript } from '@/lib/db/appendOnly'
import { CONVERSATION_GAP_MS, conversationIdFor } from '@/lib/chat/conversation'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-conv-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function write(accountId: number, conversationId: string, at: number) {
  appendTranscript(db, {
    accountId,
    sessionId: 'sess',
    conversationId,
    promptSha: 'sha',
    role: 'user',
    body: 'hi',
    at,
  })
}

describe('conversationIdFor', () => {
  it('mints a fresh id for an account with no history', () => {
    const id = conversationIdFor(db, 1, 1_000)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('reuses the last id inside the gap', () => {
    write(1, 'conv-a', 1_000)
    expect(conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS)).toBe('conv-a')
  })

  it('mints a fresh id past the gap', () => {
    write(1, 'conv-a', 1_000)
    const id = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS + 1)
    expect(id).not.toBe('conv-a')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('treats exactly the gap as still the same conversation', () => {
    // The boundary is "> 30 minutes", so 30:00.000 exactly stays. Pinned
    // because an off-by-one here silently re-cuts every conversation in the
    // retention analysis, and the rows are not rewritable afterwards.
    write(1, 'conv-a', 0)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS)).toBe('conv-a')
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS + 1)).not.toBe('conv-a')
  })

  it('does not borrow another account\'s conversation', () => {
    write(2, 'conv-other', 1_000)
    expect(conversationIdFor(db, 1, 1_100)).not.toBe('conv-other')
  })

  it('is 30 minutes, matching the step-3 alert boundary', () => {
    expect(CONVERSATION_GAP_MS).toBe(30 * 60 * 1000)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/chat/conversation.test.ts`
Expected: FAIL — cannot resolve `@/lib/chat/conversation`.

- [ ] **Step 3: Write `lib/chat/conversation.ts`**

```ts
// lib/chat/conversation.ts
import { randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { lastTranscriptRow } from '@/lib/db/appendOnly'

/**
 * The conversation boundary: a new conversation starts on the first message
 * after this much silence.
 *
 * Not invented here — architecture-overview.md line 126 already defines it
 * for the step-3 ntfy alerts ("first message after 30+ min silence"). One
 * primitive serves both, so step 3's alert reduces to "conversation_id is
 * new" rather than a second rule that can drift from this one.
 */
export const CONVERSATION_GAP_MS = 30 * 60 * 1000

/**
 * The conversation a message written at `now` belongs to.
 *
 * Called ONCE per exchange, when the user turn is appended. The assistant turn
 * reuses the returned value verbatim rather than recomputing — see the design
 * spec section 2.3.
 */
export function conversationIdFor(
  db: PlatformDb,
  accountId: number,
  now: number,
): string {
  const last = lastTranscriptRow(db, accountId)
  if (!last) return randomBytes(16).toString('hex')
  if (now - last.at > CONVERSATION_GAP_MS) return randomBytes(16).toString('hex')
  return last.conversation_id
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat/conversation.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/conversation.ts tests/chat/conversation.test.ts
git commit -m "Add the 30-minute conversation boundary rule

Reuses the boundary architecture-overview.md line 126 already defines for
the step-3 alerts, so both read from one constant. The exactly-at-the-gap
case is pinned: an off-by-one re-cuts every conversation in the retention
analysis, against rows that cannot be rewritten afterwards."
```

---

### Task 4: Prompt v1 and its loader

**Files:**
- Create: `platform/prompts/agent-v1.md`
- Create: `lib/chat/prompt.ts`
- Create: `tests/chat/prompt.test.ts`

**Interfaces:**
- Produces: `PROMPT_PATH: string`, `type LoadedPrompt = { text: string; sha: string }`, `loadPrompt(path?: string): LoadedPrompt`

**Prompt content constraint (spec §5):** the capabilities section is written strictly from the enabled Plaid products in `architecture-overview.md` §3 — Transactions (24 months of history), Balance, Transactions Refresh, Recurring Transactions. Investments and Liabilities are **not** enabled; the prompt must route those to Nico rather than promise a panel. No invented Plaid abilities.

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/prompt.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROMPT_PATH, loadPrompt } from '@/lib/chat/prompt'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-prompt-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadPrompt', () => {
  it('returns the file text and a 12-hex-char sha', () => {
    const p = join(dir, 'p.md')
    writeFileSync(p, 'hello prompt')
    const { text, sha } = loadPrompt(p)
    expect(text).toBe('hello prompt')
    expect(sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('gives the same sha for the same bytes', () => {
    const a = join(dir, 'a.md')
    const b = join(dir, 'b.md')
    writeFileSync(a, 'identical')
    writeFileSync(b, 'identical')
    expect(loadPrompt(a).sha).toBe(loadPrompt(b).sha)
  })

  it('changes the sha when a single byte changes', () => {
    // The point of a content hash over a version label: a quiet edit cannot
    // pass itself off as the version that came before it.
    const p = join(dir, 'p.md')
    writeFileSync(p, 'version one')
    const before = loadPrompt(p).sha
    writeFileSync(p, 'version onE')
    expect(loadPrompt(p).sha).not.toBe(before)
  })

  it('loads the real shipped prompt and it is not empty', () => {
    const { text, sha } = loadPrompt(PROMPT_PATH)
    expect(text.trim().length).toBeGreaterThan(0)
    expect(sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('does not promise Plaid products that are not enabled', () => {
    // architecture-overview.md section 3: Investments and Liabilities are NOT
    // enabled, and line 98 requires checking before promising a panel. A
    // prompt that mentions them will make promises the product cannot keep,
    // to a real friend, in the first conversation.
    const { text } = loadPrompt(PROMPT_PATH)
    expect(text).not.toMatch(/\binvestments?\b/i)
    expect(text).not.toMatch(/\bliabilit(y|ies)\b/i)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/chat/prompt.test.ts`
Expected: FAIL — cannot resolve `@/lib/chat/prompt`.

- [ ] **Step 3: Write `lib/chat/prompt.ts`**

```ts
// lib/chat/prompt.ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PROMPT_PATH = resolve(process.cwd(), 'platform/prompts/agent-v1.md')

export type LoadedPrompt = { text: string; sha: string }

/**
 * Read the system prompt and hash its bytes.
 *
 * The sha is stamped on every transcript row so a row is tied to the exact
 * prompt text that produced it — a content hash rather than a human label,
 * because a label can be reused across a quiet edit and a hash cannot.
 *
 * Read per call rather than memoized: the file is a few KB next to a
 * multi-second API call, and a module-level cache would need a test-only
 * reset hook to stay testable.
 */
export function loadPrompt(path: string = PROMPT_PATH): LoadedPrompt {
  const text = readFileSync(path, 'utf8')
  const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return { text, sha }
}
```

- [ ] **Step 4: Write `platform/prompts/agent-v1.md`**

Structural first pass against `architecture-overview.md` §8. Nico rewrites the interview opening and the monitoring-first moves substantively — write this to be replaced, not defended.

```markdown
You are the agent behind a personal dashboard that a small group of friends
are trying out. Nico builds each dashboard by hand from what you learn in
this conversation.

## Who you are talking to

Someone who agreed to try this as a favour, who has probably never described
what they want from software before, and who may not think of themselves as
someone with goals. Treat that as normal, not as something to fix.

## Your job

Find out what this person would want to keep an eye on every morning.

Good ways in: what they already check, and how often. What they wish they
checked. What they worry about between checks. What they would glance at over
coffee without being asked to.

Do not ask what their goals are. For most people that question is a request
for self-knowledge they do not have, and it is the exact thing this product
exists to not require. If goals surface on their own, follow them. They often
surface weeks later, and that is fine.

Ask about accounts they have, and about anything they would realistically log
by hand — realistically being the operative word. Something they will do twice
and abandon is worse than nothing, and it is better to find that out now.

One question at a time. Follow what they actually said rather than working
through a list.

## What the dashboard can be built from

Bank and card data, if they connect an account: balances, transactions going
back two years, and recurring items like subscriptions and paychecks detected
automatically. Transactions refresh when they log in.

Anything they choose to log by hand.

That is the whole list today. If someone wants something outside it — anything
involving other kinds of accounts, or data from a service not mentioned here —
do not guess whether it is possible. Say it is worth asking Nico about, and
that you will find out. Being wrong about this costs a promise to a friend.

## What to promise

Dashboards arrive the next morning. Tweaks usually land within a few hours.
Never promise anything instant, and never promise a specific feature you have
not confirmed is possible.

Invite requests explicitly, more than once: anything they want changed, at any
time, is useful information rather than an imposition.

## Tone

Warm and direct. Curious about them specifically, not about users in general.
Short messages. No enthusiasm they have not earned, no checklists, no
summarising back what they just told you unless you are checking you got it
right.
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/chat/prompt.test.ts`
Expected: PASS, 5 tests — including the enabled-products check.

- [ ] **Step 6: Commit**

```bash
git add platform/prompts/agent-v1.md lib/chat/prompt.ts tests/chat/prompt.test.ts
git commit -m "Add system prompt v1 and the loader that hashes it

Structural first pass against architecture-overview.md section 8; the
interview opening and the monitoring-first moves are Nico's to rewrite.

The capabilities section names only the enabled Plaid products, and a test
asserts the prompt never mentions Investments or Liabilities — line 98
requires checking with Nico before promising those, and the failure mode is
a promise made to a friend in their first conversation."
```

---

### Task 5: History mapping and the model client

**Files:**
- Create: `lib/chat/history.ts`
- Create: `lib/chat/client.ts`
- Create: `tests/chat/history.test.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk`)

**Interfaces:**
- Consumes: `TranscriptRow` (Task 2)
- Produces:
  - `type ChatMessage = { role: 'user' | 'assistant'; content: string }`
  - `toMessages(rows: TranscriptRow[]): ChatMessage[]`
  - `type Usage = { input: number; output: number; cache_read: number; cache_creation: number }`
  - `type ChatClient = { stream(args: { system: string; messages: ChatMessage[]; signal: AbortSignal; onText: (t: string) => void; onUsage: (u: Partial<Usage>) => void }): Promise<Usage> }`
  - `CHAT_MODEL: string`, `CHAT_EFFORT: 'medium'`, `MAX_TOKENS: number`, `anthropicClient(): ChatClient`

- [ ] **Step 1: Install the SDK**

Run: `npm install @anthropic-ai/sdk`

- [ ] **Step 2: Write the failing history test**

```ts
// tests/chat/history.test.ts
import { describe, expect, it } from 'vitest'
import type { TranscriptRow } from '@/lib/db/appendOnly'
import { toMessages } from '@/lib/chat/history'

function row(over: Partial<TranscriptRow>): TranscriptRow {
  return {
    id: 1,
    account_id: 1,
    session_id: 's',
    conversation_id: 'c',
    prompt_sha: 'p',
    role: 'user',
    body: 'hi',
    at: 0,
    ...over,
  }
}

describe('toMessages', () => {
  it('maps rows to role/content pairs in order', () => {
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'one' }),
        row({ id: 2, role: 'assistant', body: 'two' }),
      ]),
    ).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
  })

  it('drops rows with a role the API does not accept', () => {
    expect(toMessages([row({ role: 'system', body: 'nope' })])).toEqual([])
  })

  it('drops leading assistant rows', () => {
    // The API rejects a conversation whose first message is from the
    // assistant. Our own write path cannot produce that today (the user turn
    // is always appended first), but history is read from a table that keeps
    // rows forever, so this stays defensive rather than trusting the invariant.
    expect(
      toMessages([
        row({ id: 1, role: 'assistant', body: 'orphan' }),
        row({ id: 2, role: 'user', body: 'real start' }),
      ]),
    ).toEqual([{ role: 'user', content: 'real start' }])
  })

  it('keeps consecutive same-role turns rather than merging them', () => {
    // A retry appends a second user row with the same text (design spec
    // section 6.1). The API accepts consecutive same-role messages, and the
    // transcript is a record of what happened — merging would edit history.
    expect(
      toMessages([
        row({ id: 1, role: 'user', body: 'again' }),
        row({ id: 2, role: 'user', body: 'again' }),
      ]),
    ).toHaveLength(2)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run tests/chat/history.test.ts`
Expected: FAIL — cannot resolve `@/lib/chat/history`.

- [ ] **Step 4: Write `lib/chat/history.ts`**

```ts
// lib/chat/history.ts
import type { TranscriptRow } from '@/lib/db/appendOnly'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/**
 * Transcript rows to API messages.
 *
 * History is the account's whole transcript, not just the current
 * conversation: goals surface over weeks (architecture-overview.md section 5),
 * so the agent has to remember earlier conversations.
 */
export function toMessages(rows: TranscriptRow[]): ChatMessage[] {
  const mapped = rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.body }))

  const firstUser = mapped.findIndex((m) => m.role === 'user')
  return firstUser === -1 ? [] : mapped.slice(firstUser)
}
```

- [ ] **Step 5: Run the history tests**

Run: `npx vitest run tests/chat/history.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write `lib/chat/client.ts`**

No unit test of its own — it is a thin SDK adapter whose only untestable-without-network part is the SDK call itself. Task 6 tests everything around it through a fake.

```ts
// lib/chat/client.ts
import Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from './history'

export type Usage = {
  input: number
  output: number
  cache_read: number
  cache_creation: number
}

export type ChatClient = {
  stream(args: {
    system: string
    messages: ChatMessage[]
    signal: AbortSignal
    onText: (text: string) => void
    onUsage: (usage: Partial<Usage>) => void
  }): Promise<Usage>
}

/** Configuration, not architecture — and stamped into every metrics row. */
export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'claude-opus-5'
export const CHAT_EFFORT = 'medium' as const
/**
 * Far above any conversational turn, so this bounds a runaway without risking
 * a truncated reply.
 */
export const MAX_TOKENS = 8192

/**
 * The Anthropic SDK behind the narrow interface above.
 *
 * Adaptive thinking is left at the model default rather than disabled: on this
 * model disabling it risks internal tags leaking into visible output, and the
 * reply goes straight to a friend.
 */
export function anthropicClient(sdk: Anthropic = new Anthropic()): ChatClient {
  return {
    async stream({ system, messages, signal, onText, onUsage }) {
      const stream = sdk.messages.stream(
        {
          model: CHAT_MODEL,
          max_tokens: MAX_TOKENS,
          output_config: { effort: CHAT_EFFORT },
          system: [
            {
              type: 'text',
              text: system,
              // The page-length prompt is resent on every turn. This is why
              // the metrics rows carry cache counters as well as input/output.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages,
        },
        { signal },
      )

      // Usage arrives in two places: input and cache counts at message_start,
      // cumulative output at each message_delta. Reported as they arrive so an
      // aborted turn can still record real numbers instead of zeros.
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_start') {
          const u = event.message.usage
          onUsage({
            input: u.input_tokens,
            cache_read: u.cache_read_input_tokens ?? 0,
            cache_creation: u.cache_creation_input_tokens ?? 0,
          })
        } else if (event.type === 'message_delta') {
          onUsage({ output: event.usage.output_tokens })
        }
      })
      stream.on('text', onText)

      const final = await stream.finalMessage()
      return {
        input: final.usage.input_tokens,
        output: final.usage.output_tokens,
        cache_read: final.usage.cache_read_input_tokens ?? 0,
        cache_creation: final.usage.cache_creation_input_tokens ?? 0,
      }
    },
  }
}
```

If `output_config` is not yet in the installed SDK's types, the typecheck gate will say so. Do not cast it away — upgrade the SDK (`npm install @anthropic-ai/sdk@latest`) and re-run, since a silenced type error here means the effort setting is not reaching the API.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/chat/history.ts lib/chat/client.ts tests/chat/history.test.ts
git commit -m "Add history mapping and the Anthropic client behind a narrow interface

ChatClient is an interface with one method so lib/chat/turn.ts can be driven
by a fake in tests — no test calls the live API.

Usage is reported as it arrives (input and cache at message_start, output at
each message_delta) rather than only at the end, so an aborted turn records
real token counts instead of zeros."
```

---

### Task 6: The append rule

**Files:**
- Create: `lib/chat/turn.ts`
- Create: `tests/chat/turn.test.ts`

**Interfaces:**
- Consumes: `conversationIdFor` (T3), `loadPrompt` (T4), `toMessages` / `ChatClient` / `Usage` / `CHAT_MODEL` / `CHAT_EFFORT` (T5), `appendTranscript` / `appendMetric` / `readTranscript` (T2)
- Produces:
  - `CHAT_CONTEXT: 'interview'`
  - `type TurnDeps = { db: PlatformDb; client: ChatClient; now: () => number }`
  - `type TurnInput = { accountId: number; sessionId: string; body: string; signal: AbortSignal; onText: (t: string) => void }`
  - `type TurnOutcome = { kind: 'completed' | 'aborted' | 'error' }`
  - `runTurn(deps: TurnDeps, input: TurnInput): Promise<TurnOutcome>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/turn.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { readTranscript } from '@/lib/db/appendOnly'
import type { ChatClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-turn-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A client that replies with fixed chunks and reports usage as it goes. */
function fakeClient(chunks: string[]): ChatClient {
  return {
    async stream({ onText, onUsage }) {
      onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
      for (const c of chunks) {
        onText(c)
        onUsage({ output: 7 })
      }
      return { input: 100, output: 7, cache_read: 40, cache_creation: 0 }
    },
  }
}

/** A client that streams one chunk, then the caller aborts. */
function abortingClient(controller: AbortController): ChatClient {
  return {
    async stream({ onText, onUsage, signal }) {
      onUsage({ input: 100, cache_read: 0, cache_creation: 0 })
      onText('half a rep')
      onUsage({ output: 3 })
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      // `signal` is deliberately unused here; runTurn reads signal.aborted.
      void signal
    },
  }
}

function failingClient(): ChatClient {
  return {
    async stream() {
      throw new Error('rate limited')
    },
  }
}

function metrics() {
  return (
    db.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
      event: string
      data: string | null
    }[]
  ).map((r) => ({ event: r.event, data: JSON.parse(r.data ?? 'null') }))
}

const input = (over: Partial<Parameters<typeof runTurn>[1]> = {}) => ({
  accountId: 1,
  sessionId: 'sess-1',
  body: 'what should I watch?',
  signal: new AbortController().signal,
  onText: () => {},
  ...over,
})

describe('runTurn — completion', () => {
  it('appends the user turn and then the assistant turn', async () => {
    const deps = { db, client: fakeClient(['Keep an ', 'eye on rent.']), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('completed')
    const rows = readTranscript(db, 1)
    expect(rows.map((r) => [r.role, r.body])).toEqual([
      ['user', 'what should I watch?'],
      ['assistant', 'Keep an eye on rent.'],
    ])
  })

  it('stamps both rows with the same conversation_id and the prompt sha', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
    await runTurn(deps, input())

    const rows = readTranscript(db, 1)
    expect(rows[0].conversation_id).toBe(rows[1].conversation_id)
    expect(rows[0].session_id).toBe('sess-1')
    expect(rows[0].prompt_sha).toMatch(/^[0-9a-f]{12}$/)
    expect(rows[1].prompt_sha).toBe(rows[0].prompt_sha)
  })

  it('logs one chat_turn metric carrying all four counters', async () => {
    const deps = { db, client: fakeClient(['ok']), now: () => 1_000 }
    await runTurn(deps, input())

    expect(metrics()).toHaveLength(1)
    const [m] = metrics()
    expect(m.event).toBe('chat_turn')
    expect(m.data).toMatchObject({
      input: 100,
      output: 7,
      cache_read: 40,
      cache_creation: 0,
      model: 'claude-opus-5',
      effort: 'medium',
      context: 'interview',
    })
    expect(m.data.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })

  it('streams text to the caller as it arrives', async () => {
    const seen: string[] = []
    const deps = { db, client: fakeClient(['a', 'b']), now: () => 1_000 }
    await runTurn(deps, input({ onText: (t: string) => seen.push(t) }))
    expect(seen).toEqual(['a', 'b'])
  })

  it('starts a new conversation after the gap and keeps one inside it', async () => {
    const client = fakeClient(['ok'])
    await runTurn({ db, client, now: () => 0 }, input())
    await runTurn({ db, client, now: () => 60_000 }, input())
    await runTurn({ db, client, now: () => 60_000 + 31 * 60 * 1000 }, input())

    const ids = readTranscript(db, 1).map((r) => r.conversation_id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(ids[3]) // first exchange and second exchange
    expect(ids[4]).not.toBe(ids[0]) // third, past the gap
  })
})

describe('runTurn — abort', () => {
  it('appends NO assistant row', async () => {
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
    const outcome = await runTurn(deps, input({ signal: controller.signal }))

    expect(outcome.kind).toBe('aborted')
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('user')
  })

  it('logs stream_aborted with the counters known so far, not zeros', async () => {
    // The whole reason usage is reported during the stream rather than only at
    // the end: an aborted turn still cost input tokens, and a cost log that
    // records zero for it is fiction.
    const controller = new AbortController()
    const deps = { db, client: abortingClient(controller), now: () => 1_000 }
    await runTurn(deps, input({ signal: controller.signal }))

    const [m] = metrics()
    expect(m.event).toBe('stream_aborted')
    expect(m.data).toMatchObject({ input: 100, output: 3, context: 'interview' })
    expect(m.data.delivered_chars).toBe('half a rep'.length)
  })
})

describe('runTurn — API error', () => {
  it('appends no assistant row and logs chat_error, not stream_aborted', async () => {
    const deps = { db, client: failingClient(), now: () => 1_000 }
    const outcome = await runTurn(deps, input())

    expect(outcome.kind).toBe('error')
    expect(readTranscript(db, 1)).toHaveLength(1)
    const [m] = metrics()
    expect(m.event).toBe('chat_error')
    expect(m.data).toMatchObject({ kind: 'Error', context: 'interview' })
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/chat/turn.test.ts`
Expected: FAIL — cannot resolve `@/lib/chat/turn`.

- [ ] **Step 3: Write `lib/chat/turn.ts`**

```ts
// lib/chat/turn.ts
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric, appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import { conversationIdFor } from './conversation'
import { toMessages } from './history'
import { loadPrompt } from './prompt'
import { CHAT_EFFORT, CHAT_MODEL, type ChatClient, type Usage } from './client'

/**
 * The run kind recorded on every metrics row (architecture-overview.md line
 * 136: "interview, planning, tweak runs"). No spec exists until step 4, so
 * every turn in step 2 is an interview turn.
 */
export const CHAT_CONTEXT = 'interview' as const

export type TurnDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
}

export type TurnInput = {
  accountId: number
  sessionId: string
  body: string
  signal: AbortSignal
  onText: (text: string) => void
}

export type TurnOutcome = { kind: 'completed' | 'aborted' | 'error' }

/**
 * One chat exchange, and the rule for what gets written.
 *
 * The user turn is appended immediately; the assistant turn is appended ONLY
 * when the stream completes server-side. An aborted or failed exchange
 * therefore leaves a user row with no reply — which is what actually happened.
 * transcripts is append-only, so this rule cannot be corrected after the fact;
 * see the design spec section 3.4.
 */
export async function runTurn(
  deps: TurnDeps,
  input: TurnInput,
): Promise<TurnOutcome> {
  const { db, client, now } = deps
  const at = now()
  const { text: system, sha: promptSha } = loadPrompt()

  // Computed once, here. The assistant row reuses it rather than recomputing
  // the gap against a clock that has moved.
  const conversationId = conversationIdFor(db, input.accountId, at)

  const stamp = {
    accountId: input.accountId,
    sessionId: input.sessionId,
    conversationId,
    promptSha,
  }

  appendTranscript(db, { ...stamp, role: 'user', body: input.body, at })

  const messages = toMessages(readTranscript(db, input.accountId))

  let delivered = ''
  let usage: Usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0 }
  const base = {
    model: CHAT_MODEL,
    effort: CHAT_EFFORT,
    prompt_sha: promptSha,
    context: CHAT_CONTEXT,
  }

  try {
    const final = await client.stream({
      system,
      messages,
      signal: input.signal,
      onText: (text) => {
        delivered += text
        input.onText(text)
      },
      onUsage: (partial) => {
        usage = { ...usage, ...partial }
      },
    })

    appendTranscript(db, {
      ...stamp,
      role: 'assistant',
      body: delivered,
      at: now(),
    })
    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_turn',
      at: now(),
      data: { ...final, ...base },
    })
    return { kind: 'completed' }
  } catch (error) {
    // No assistant row on either branch. The two events are kept apart because
    // they are different facts: an abort has real token counts to record, an
    // error before first output has none.
    if (input.signal.aborted) {
      appendMetric(db, {
        accountId: input.accountId,
        event: 'stream_aborted',
        at: now(),
        data: { ...usage, ...base, delivered_chars: delivered.length },
      })
      return { kind: 'aborted' }
    }

    appendMetric(db, {
      accountId: input.accountId,
      event: 'chat_error',
      at: now(),
      data: {
        ...base,
        kind: error instanceof Error ? error.name : 'unknown',
        delivered_chars: delivered.length,
      },
    })
    return { kind: 'error' }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat/turn.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add lib/chat/turn.ts tests/chat/turn.test.ts
git commit -m "Add the chat turn append rule

The user turn appends immediately; the assistant turn appends only on stream
completion. Abort and API error both append no assistant row and are logged
as separate events, because an abort has real token counts to record and an
error before first output has none.

transcripts is append-only, so this rule cannot be corrected later. Tested
against a fake client on all three paths — no test touches the live API."
```

---

### Task 7: Locked sessions reach their own space

This is the auth-tier change from spec §4. It **inverts two existing assertions and defangs a third**; all three are rewritten deliberately below rather than deleted.

**Files:**
- Modify: `lib/session/resolve.ts`
- Modify: `tests/routing/middleware.test.ts:81-110, 167`
- Modify: `tests/routing/userSpace.test.ts:243-294`

**Interfaces:**
- Produces: `isUserSpacePath(pathname: string): boolean` (exported for direct test)

- [ ] **Step 1: Write the new assertions first**

In `tests/routing/middleware.test.ts`, replace the `sends authenticated users to unlock` test (line 81) and the `/adminbob` test (around line 102) with:

```ts
  it('lets a locked session reach a user space, but not a deeper path', () => {
    // architecture-overview.md line 59: the chat surface keeps working across
    // the tweak loop while data panels ask for the password again. The lock
    // moved down to the panel layer, so the page itself is reachable.
    expect(routeFor('authenticated', '/nico')).toBeNull()
    expect(routeFor('authenticated', '/nico/settings')).toBe('/unlock')
  })

  it('still distinguishes an admin path from a same-named user slug', () => {
    // Regression guard for the '/adminbob' bug. It used to be expressible as
    // "/adminbob -> /unlock", but now that locked sessions may reach a user
    // space BOTH return null at one segment, so that assertion would pass
    // without distinguishing anything. Two segments still separates them:
    // '/admin/settings' is an admin subpath, '/adminbob/settings' is neither
    // admin nor a user space.
    expect(routeFor('authenticated', '/admin/settings')).toBeNull()
    expect(routeFor('authenticated', '/adminbob/settings')).toBe('/unlock')
    expect(routeFor('anonymous', '/adminbob')).toBe('/login')
  })

  it('does not treat reserved paths as user spaces', () => {
    expect(isUserSpacePath('/login')).toBe(false)
    expect(isUserSpacePath('/unlock')).toBe(false)
    expect(isUserSpacePath('/admin')).toBe(false)
    expect(isUserSpacePath('/api')).toBe(false)
    expect(isUserSpacePath('/')).toBe(false)
    expect(isUserSpacePath('/devone')).toBe(true)
  })
```

Add `isUserSpacePath` to the import on line 10.

Then find the test at line 167 (`sends a locked ... session asking for a user space to /unlock`) and rewrite its expectation to `toBeNull()`, updating its name to `lets a locked session through to its own user space` and its comment to cite line 59.

- [ ] **Step 2: Rewrite the two userSpace page tests**

In `tests/routing/userSpace.test.ts`, replace the test at line 243 (`sends a locked non-owner to /unlock before ever checking ownership`) with:

```ts
  it('404s a locked non-owner, the same as an unlocked one', async () => {
    // The lock no longer intercepts upstream of the ownership check, so a
    // locked session asking for someone else's space now falls through to
    // canSeeUserSpace and 404s. No new information leaks: an unlocked
    // non-owner already got exactly this 404.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const oneId = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    await createAcct(handle, { slug: 'devtwo', role: 'user', password: 'pw' })
    const sid = createSess(handle, oneId) // no putKey: locked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    await expect(
      UserSpace({ params: Promise.resolve({ user: 'devtwo' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFoundMock).toHaveBeenCalledTimes(1)
    expect(redirectMock).not.toHaveBeenCalled()
  })
```

Replace the test at line 270 (`sends a locked owner to /unlock too`) with:

```ts
  it('renders a locked owner\'s own space, with the data region locked', async () => {
    // This inverts the pre-step-2 behaviour deliberately. architecture-
    // overview.md line 59 is the spec: the chat surface keeps working across
    // the tweak loop, and data panels ask for the password again. Both halves
    // are asserted — reaching the page is only correct if the data region is
    // still withheld.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id) // no putKey: locked
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    const element = await UserSpace({ params: Promise.resolve({ user: 'devone' }) })

    expect(redirectMock).not.toHaveBeenCalled()
    expect(notFoundMock).not.toHaveBeenCalled()
    const json = JSON.stringify(element)
    expect(json).toContain('devone')
    expect(json).toContain('Locked')
  })

  it('does not render the data region locked for an unlocked owner', async () => {
    // Without this, the test above passes for a page that shows "Locked" to
    // everybody — which would satisfy the letter of "data panels ask for the
    // password" while breaking the product.
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount: createAcct } = await import('@/lib/auth/accounts')
    const { createSession: createSess, SESSION_COOKIE } = await import(
      '@/lib/session/store'
    )
    const { putKey: putK } = await import('@/lib/session/keymap')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const id = await createAcct(handle, { slug: 'devone', role: 'user', password: 'pw' })
    const sid = createSess(handle, id)
    putK(sid, Buffer.alloc(32, 1))
    cookieSlot.value = { value: sid }

    const { default: UserSpace } = await import('@/app/[user]/page')
    const element = await UserSpace({ params: Promise.resolve({ user: 'devone' }) })
    expect(JSON.stringify(element)).not.toContain('Locked')
  })
```

- [ ] **Step 3: Run to confirm failure**

Run: `npx vitest run tests/routing`
Expected: FAIL — `isUserSpacePath` not exported, and the locked-owner tests still redirect.

- [ ] **Step 4: Change `lib/session/resolve.ts`**

Add the helper and extend the `authenticated` branch:

```ts
/**
 * Paths that are never a user slug. `createAccount` validates slugs against
 * SLUG_PATTERN, so a real account can never be named one of these — this set
 * is about classifying the URL, not about trusting it.
 */
const RESERVED_SEGMENTS = new Set(['login', 'unlock', 'admin', 'api'])

/**
 * A single non-reserved segment: '/devone', not '/devone/settings' and not
 * '/admin'. Exactly one segment, because a locked session is allowed the
 * user-space page itself (which carries the chat surface) and nothing deeper.
 */
export function isUserSpacePath(pathname: string): boolean {
  const segments = pathname.split('/').filter(Boolean)
  return segments.length === 1 && !RESERVED_SEGMENTS.has(segments[0])
}
```

and replace the `authenticated` branch inside `routeFor`:

```ts
  if (state === 'authenticated') {
    // architecture-overview.md line 59: a deploy leaves users logged in but
    // locked, and "the chat surface keeps working across the tweak loop,
    // and data panels ask for the password again". The user-space page
    // carries that chat surface, so the lock is enforced at the panel layer
    // inside the page rather than by bouncing the whole route.
    return LOCKED_OK.has(pathname) ||
      isAdminPath(pathname) ||
      isUserSpacePath(pathname)
      ? null
      : '/unlock'
  }
```

- [ ] **Step 5: Update `app/[user]/page.tsx` to render the locked placeholder**

```tsx
// app/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'
import { resolveState } from '@/lib/session/resolve'

export default async function UserSpace({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params

  // Still enforced: anonymous goes to /login. A locked session now passes
  // through to the page — the lock is applied to the data region below.
  await requireState(`/${user}`)

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404, never 403: a 403 would confirm that the other dev user exists.
  if (!canSeeUserSpace(getDb(), sessionId, user)) notFound()

  const unlocked = resolveState(getDb(), sessionId) === 'unlocked'

  return (
    <main>
      <h1>{user}</h1>
      {unlocked ? (
        <p>Nothing here yet. Your dashboard gets built from your interview.</p>
      ) : (
        <p>Locked. Unlock to see your data.</p>
      )}
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
```

The chat panel is added to this file in Task 9.

- [ ] **Step 6: Run the routing tests**

Run: `npx vitest run tests/routing`
Expected: PASS.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean. If `tests/auth/unlockPage.test.ts` fails, read it before changing it — `/unlock` behaviour is unchanged by this task and a failure there means the helper is matching too broadly.

- [ ] **Step 8: Commit**

```bash
git add lib/session/resolve.ts app/[user]/page.tsx tests/routing/middleware.test.ts tests/routing/userSpace.test.ts
git commit -m "Let a locked session reach its own space; lock the data region instead

architecture-overview.md line 59 says the chat surface keeps working across
the tweak loop while data panels ask for the password again. routeFor was
bouncing the whole user-space route to /unlock, so there was nowhere for a
chat surface to keep working. The lock moves down to the panel layer.

Three existing assertions were rewritten rather than deleted. Two inverted
by design. The third, the '/adminbob' regression guard, would have kept
passing while distinguishing nothing — both admin paths and user spaces now
return null at one segment — so it is re-expressed at two segments, where
'/admin/settings' and '/adminbob/settings' still diverge."
```

---

### Task 8: The chat endpoint

**Files:**
- Create: `app/api/chat/route.ts`
- Create: `tests/chat/route.test.ts`

**Interfaces:**
- Consumes: `runTurn` (T6), `anthropicClient` (T5), `resolveState` (T7), `readSession`
- Produces: `POST(request: Request): Promise<Response>` at `/api/chat`

- [ ] **Step 1: Write the failing test**

```ts
// tests/chat/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

// The route builds a real Anthropic client. Replace the module so no test can
// construct one (which would also throw without an API key).
vi.mock('@/lib/chat/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/client')>()
  return {
    ...actual,
    anthropicClient: () => ({
      async stream({ onText, onUsage }: any) {
        onUsage({ input: 5, cache_read: 0, cache_creation: 0 })
        onText('hello ')
        onText('friend')
        onUsage({ output: 2 })
        return { input: 5, output: 2, cache_read: 0, cache_creation: 0 }
      },
    }),
  }
})

let dir: string
let handle: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-chatroute-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  cookieGet.mockClear()
  cookieSlot.value = undefined
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

async function post(body: unknown) {
  const { POST } = await import('@/app/api/chat/route')
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  )
}

async function lines(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Create an account and a session; `unlocked` controls whether a key exists. */
async function signIn(unlocked: boolean) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  const id = await createAccount(handle, {
    slug: 'devone',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, id)
  if (unlocked) putKey(sid, Buffer.alloc(32, 1))
  cookieSlot.value = { value: sid }
  return { accountId: id, sid }
}

describe('POST /api/chat', () => {
  it('401s with no session', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { SESSION_COOKIE } = await import('@/lib/session/store')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    cookieSlot.value = undefined

    const res = await post({ body: 'hi' })
    expect(res.status).toBe(401)
  })

  it('answers a LOCKED session — the chat surface survives the lock', async () => {
    // architecture-overview.md line 59. This is the property that makes the
    // two-tier session worth having, so it is pinned at the endpoint and not
    // only at the page.
    await signIn(false)
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)
    expect(await lines(res)).toEqual([
      { t: 'hello ' },
      { t: 'friend' },
      { done: true },
    ])
  })

  it('answers an unlocked session too', async () => {
    await signIn(true)
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)
  })

  it('persists the exchange against the session that sent it', async () => {
    const { accountId, sid } = await signIn(false)
    const res = await post({ body: 'what should I watch?' })
    await res.text()

    const { readTranscript } = await import('@/lib/db/appendOnly')
    const rows = readTranscript(handle!, accountId)
    expect(rows.map((r) => [r.role, r.body])).toEqual([
      ['user', 'what should I watch?'],
      ['assistant', 'hello friend'],
    ])
    expect(rows[0].session_id).toBe(sid)
  })

  it('400s on an empty or missing body rather than writing a row', async () => {
    const { accountId } = await signIn(false)
    expect((await post({ body: '   ' })).status).toBe(400)
    expect((await post({})).status).toBe(400)

    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)
  })

  it('sends NDJSON, not JSON', async () => {
    await signIn(false)
    const res = await post({ body: 'hi' })
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/chat/route.test.ts`
Expected: FAIL — cannot resolve `@/app/api/chat/route`.

- [ ] **Step 3: Write `app/api/chat/route.ts`**

```ts
// app/api/chat/route.ts
import { cookies } from 'next/headers'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE, readSession } from '@/lib/session/store'
import { resolveState } from '@/lib/session/resolve'
import { anthropicClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

const encoder = new TextEncoder()
const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`)

/**
 * The chat endpoint.
 *
 * Deliberately does NOT use requireState: that returns redirect targets, which
 * would hand a JSON caller a 307 to a page. And deliberately accepts a locked
 * session — architecture-overview.md line 59 makes the chat surface the thing
 * that keeps working when the key is gone.
 */
export async function POST(request: Request) {
  const db = getDb()
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  if (resolveState(db, sessionId) === 'anonymous') {
    return new Response(null, { status: 401 })
  }
  const session = readSession(db, sessionId!)
  if (!session) return new Response(null, { status: 401 })

  let payload: { body?: unknown }
  try {
    payload = (await request.json()) as { body?: unknown }
  } catch {
    return new Response(null, { status: 400 })
  }
  const body = typeof payload.body === 'string' ? payload.body.trim() : ''
  if (!body) return new Response(null, { status: 400 })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const outcome = await runTurn(
        { db, client: anthropicClient(), now: Date.now },
        {
          accountId: session.account_id,
          sessionId: sessionId!,
          body,
          signal: request.signal,
          onText: (text) => {
            // A client that has gone away makes enqueue throw. The turn's own
            // abort path has already decided what to persist; this just keeps
            // the rejection from surfacing as an unhandled error.
            if (!request.signal.aborted) controller.enqueue(line({ t: text }))
          },
        },
      )

      // The terminal line is what tells the browser the reply is complete and
      // therefore saved. Its ABSENCE is the interrupted case — see the panel.
      if (outcome.kind === 'completed' && !request.signal.aborted) {
        controller.enqueue(line({ done: true }))
      }
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat/route.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/route.ts tests/chat/route.test.ts
git commit -m "Add POST /api/chat streaming NDJSON

Resolves session state directly rather than through requireState, which
returns redirect targets and would hand a JSON caller a 307. A locked
session is answered on purpose: architecture-overview.md line 59 makes the
chat surface the thing that survives losing the key, and a test pins it.

The terminal {done:true} line is what tells the browser the reply completed
and was saved; its absence is the interrupted case."
```

---

### Task 9: The chat panel

**Files:**
- Create: `app/[user]/ChatPanel.tsx`
- Modify: `app/[user]/page.tsx`
- Create: `tests/chat/panel.test.ts`

**Interfaces:**
- Consumes: `POST /api/chat` NDJSON (T8)
- Produces: `parseNdjson(chunk: string): { lines: unknown[]; rest: string }` (exported from the panel module for direct test), default export `ChatPanel`

- [ ] **Step 1: Write the failing test**

The React rendering itself is out of reach of this node-environment suite (no jsdom is configured, and adding one is out of scope). What *is* worth pinning is the stream parser, because that is where the interrupted rule is actually decided.

```ts
// tests/chat/panel.test.ts
import { describe, expect, it } from 'vitest'
import { parseNdjson } from '@/app/[user]/ChatPanel'

describe('parseNdjson', () => {
  it('parses whole lines and keeps the trailing partial', () => {
    const { lines, rest } = parseNdjson('{"t":"a"}\n{"t":"b"}\n{"t":"par')
    expect(lines).toEqual([{ t: 'a' }, { t: 'b' }])
    expect(rest).toBe('{"t":"par')
  })

  it('returns nothing when no line is complete yet', () => {
    const { lines, rest } = parseNdjson('{"t":"incomp')
    expect(lines).toEqual([])
    expect(rest).toBe('{"t":"incomp')
  })

  it('recognises the terminal done line', () => {
    const { lines } = parseNdjson('{"t":"x"}\n{"done":true}\n')
    expect(lines).toEqual([{ t: 'x' }, { done: true }])
  })

  it('ignores a blank line rather than throwing', () => {
    // A stream that ends with "\n\n" must not crash the reader mid-reply.
    const { lines } = parseNdjson('{"t":"x"}\n\n')
    expect(lines).toEqual([{ t: 'x' }])
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/chat/panel.test.ts`
Expected: FAIL — cannot resolve `@/app/[user]/ChatPanel`.

- [ ] **Step 3: Write `app/[user]/ChatPanel.tsx`**

```tsx
// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'

const TOGGLE_KEY = 'stairwell:chat-open'

type Turn = {
  role: 'user' | 'assistant'
  body: string
  /** True when the stream ended without a {done:true} line — nothing saved. */
  interrupted?: boolean
}

/**
 * Split a buffer into complete NDJSON values plus whatever trailing partial
 * line is left. Exported because this is where the interrupted rule is
 * decided: the reply is only saved if a {done:true} line arrives.
 */
export function parseNdjson(buffer: string): { lines: unknown[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const lines: unknown[] = []
  for (const part of parts) {
    if (part.trim() === '') continue
    lines.push(JSON.parse(part))
  }
  return { lines, rest }
}

export default function ChatPanel({ initial }: { initial: Turn[] }) {
  const [open, setOpen] = useState(true)
  const [turns, setTurns] = useState<Turn[]>(initial)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const lastSent = useRef('')

  useEffect(() => {
    setOpen(window.localStorage.getItem(TOGGLE_KEY) !== 'closed')
  }, [])

  function toggle() {
    setOpen((wasOpen) => {
      window.localStorage.setItem(TOGGLE_KEY, wasOpen ? 'closed' : 'open')
      return !wasOpen
    })
  }

  async function send(text: string) {
    if (!text.trim() || busy) return
    lastSent.current = text
    setBusy(true)
    setTurns((t) => [...t, { role: 'user', body: text }, { role: 'assistant', body: '' }])
    setDraft('')

    let done = false
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const reader = response.body?.getReader()
      if (!reader) throw new Error('no body')

      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        const { lines, rest } = parseNdjson(buffer)
        buffer = rest
        for (const raw of lines) {
          const message = raw as { t?: string; done?: boolean }
          if (message.done) done = true
          else if (typeof message.t === 'string') {
            const chunk = message.t
            setTurns((t) => {
              const next = [...t]
              next[next.length - 1] = {
                ...next[next.length - 1],
                body: next[next.length - 1].body + chunk,
              }
              return next
            })
          }
        }
      }
    } catch {
      // Fall through: no done line means interrupted, which is handled below.
    }

    if (!done) {
      // Design spec section 6.1. The partial stays visible and is labelled,
      // so the screen agrees with the transcript instead of quietly showing
      // text that was never saved.
      setTurns((t) => {
        const next = [...t]
        next[next.length - 1] = { ...next[next.length - 1], interrupted: true }
        return next
      })
    }
    setBusy(false)
  }

  if (!open) {
    return (
      <button type="button" onClick={toggle}>
        Show chat
      </button>
    )
  }

  return (
    <section aria-label="Chat">
      <ol>
        {turns.map((turn, i) => (
          <li key={i} data-role={turn.role} data-interrupted={turn.interrupted}>
            <p style={turn.interrupted ? { opacity: 0.5 } : undefined}>{turn.body}</p>
            {turn.interrupted && (
              <p>
                <em>interrupted — not saved</em>{' '}
                {/* A retry is an ordinary new turn: the user row from the
                    interrupted exchange was already written and cannot be
                    amended, so the transcript honestly shows the message
                    twice. Design spec section 6.1. */}
                <button type="button" onClick={() => send(lastSent.current)}>
                  retry
                </button>
              </p>
            )}
          </li>
        ))}
      </ol>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say anything — every request is data I need."
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>

      <button type="button" onClick={toggle}>
        Hide chat
      </button>
    </section>
  )
}
```

- [ ] **Step 4: Render the panel from `app/[user]/page.tsx`**

Add the import and the read, and place the panel above the data region:

```tsx
import { readTranscript } from '@/lib/db/appendOnly'
import ChatPanel from './ChatPanel'
```

and inside the returned `<main>`, immediately after the `<h1>`:

```tsx
      <ChatPanel
        initial={readTranscript(getDb(), accountIdFor(getDb(), sessionId)).map(
          (row) => ({
            role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            body: row.body,
          }),
        )}
      />
```

This needs the account id. Add to `lib/auth/authorize.ts`:

```ts
/** The account id a session belongs to, or undefined if none. */
export function accountIdFor(
  db: PlatformDb,
  sessionId: string | undefined,
): number | undefined {
  if (!sessionId) return undefined
  return readSession(db, sessionId)?.account_id
}
```

and guard the call in the page, since `canSeeUserSpace` has already proven a session exists by this point:

```tsx
  const accountId = accountIdFor(getDb(), sessionId)
  if (accountId === undefined) notFound()
```

placed immediately after the `canSeeUserSpace` check, with the `<ChatPanel initial={...}>` using `readTranscript(getDb(), accountId)`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: both clean. `tests/routing/userSpace.test.ts` still passes — the panel is a client component but rendering it to an element tree does not execute its hooks.

- [ ] **Step 6: Verify the build, since this is the first client component**

Run: `npx next build`
Expected: success. A `'use client'` boundary is the kind of change that passes `tsc` and the suite and still breaks the build — which is exactly why Gate D exists.

- [ ] **Step 7: Commit**

```bash
git add app/[user]/ChatPanel.tsx app/[user]/page.tsx lib/auth/authorize.ts tests/chat/panel.test.ts
git commit -m "Add the chat panel with an explicit interrupted marker

The reply is only treated as saved when the terminal {done:true} line
arrives. Without it the partial stays on screen, greyed and labelled
'interrupted — not saved', so the screen agrees with the append-only
transcript rather than showing text that was never written.

Retry is an ordinary new turn: the earlier user row cannot be amended, so
the transcript honestly records the message twice.

parseNdjson is exported and tested directly — it is where the saved-or-not
decision is made, and the suite has no DOM environment."
```

---

### Task 10: The admin transcript pane

**Files:**
- Create: `app/admin/[user]/page.tsx`
- Modify: `app/admin/page.tsx`
- Modify: `lib/db/appendOnly.ts` (add `readConversations`)
- Create: `tests/admin/transcriptPane.test.ts`

**Interfaces:**
- Consumes: `readTranscript`, `isAdmin`
- Produces: `readConversations(db, accountId): { id: string; rows: TranscriptRow[] }[]` — newest conversation first

- [ ] **Step 1: Write the failing test**

```ts
// tests/admin/transcriptPane.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import type { PlatformDb } from '@/lib/db/platform'
import { openPlatformDb } from '@/lib/db/platform'
import { appendTranscript, readConversations } from '@/lib/db/appendOnly'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
  redirect: (p: string) => {
    throw new Error(`NEXT_REDIRECT:${p}`)
  },
}))

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

describe('readConversations', () => {
  let dir: string
  let db: ReturnType<typeof openPlatformDb>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stairwell-conv-read-'))
    db = openPlatformDb(join(dir, 'synthetic.db'))
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function write(conversationId: string, body: string, at: number) {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's',
      conversationId,
      promptSha: 'sha123456789',
      role: 'user',
      body,
      at,
    })
  }

  it('groups rows by conversation, newest conversation first', () => {
    write('old', 'first ever', 1_000)
    write('old', 'still first', 2_000)
    write('new', 'later chat', 9_000)

    const groups = readConversations(db, 1)
    expect(groups.map((g) => g.id)).toEqual(['new', 'old'])
    expect(groups[1].rows.map((r) => r.body)).toEqual(['first ever', 'still first'])
  })

  it('orders rows inside a conversation oldest-first', () => {
    write('c', 'earlier', 1_000)
    write('c', 'later', 2_000)
    expect(readConversations(db, 1)[0].rows.map((r) => r.body)).toEqual([
      'earlier',
      'later',
    ])
  })

  it('returns nothing for an account with no transcript', () => {
    expect(readConversations(db, 99)).toEqual([])
  })
})

describe('app/admin/[user]/page.tsx', () => {
  let dir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stairwell-adminpane-'))
    process.env.PLATFORM_DB = join(dir, 'synthetic.db')
    vi.resetModules()
    notFoundMock.mockClear()
    cookieSlot.value = undefined
    handle = undefined
  })
  afterEach(() => {
    handle?.close()
    delete process.env.PLATFORM_DB
    rmSync(dir, { recursive: true, force: true })
  })

  async function setup(role: 'user' | 'admin') {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    const { appendTranscript: append } = await import('@/lib/db/appendOnly')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()
    const targetId = await createAccount(handle, {
      slug: 'devone',
      role: 'user',
      password: 'pw',
    })
    append(handle, {
      accountId: targetId,
      sessionId: 's',
      conversationId: 'conv-1',
      promptSha: 'sha123456789',
      role: 'user',
      body: 'MY SECRET WORRY',
      at: 1_000,
    })
    const viewerId =
      role === 'admin'
        ? await createAccount(handle, { slug: 'nico', role: 'admin', password: 'pw' })
        : targetId
    cookieSlot.value = { value: createSession(handle, viewerId) }
  }

  it('renders a user transcript for the admin', async () => {
    await setup('admin')
    const { default: Pane } = await import('@/app/admin/[user]/page')
    const element = await Pane({ params: Promise.resolve({ user: 'devone' }) })

    expect(notFoundMock).not.toHaveBeenCalled()
    const json = JSON.stringify(element)
    expect(json).toContain('MY SECRET WORRY')
    expect(json).toContain('sha123456789')
  })

  it('404s for a non-admin session', async () => {
    await setup('user')
    const { default: Pane } = await import('@/app/admin/[user]/page')
    await expect(
      Pane({ params: Promise.resolve({ user: 'devone' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('404s for an unknown slug', async () => {
    await setup('admin')
    const { default: Pane } = await import('@/app/admin/[user]/page')
    await expect(
      Pane({ params: Promise.resolve({ user: 'ghost' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run tests/admin/transcriptPane.test.ts`
Expected: FAIL — `readConversations` is not exported.

- [ ] **Step 3: Add `readConversations` to `lib/db/appendOnly.ts`**

```ts
export type Conversation = { id: string; rows: TranscriptRow[] }

/**
 * One account's transcript, grouped into conversations.
 *
 * Newest conversation first (the admin pane wants the current one at the top);
 * rows inside a conversation oldest-first, because that is reading order.
 */
export function readConversations(
  db: PlatformDb,
  accountId: number,
): Conversation[] {
  const groups = new Map<string, TranscriptRow[]>()
  for (const row of readTranscript(db, accountId)) {
    const existing = groups.get(row.conversation_id)
    if (existing) existing.push(row)
    else groups.set(row.conversation_id, [row])
  }
  return [...groups.entries()]
    .map(([id, rows]) => ({ id, rows }))
    .sort((a, b) => b.rows[0].at - a.rows[0].at)
}
```

- [ ] **Step 4: Write `app/admin/[user]/page.tsx`**

```tsx
// app/admin/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { readConversations } from '@/lib/db/appendOnly'

/**
 * Read-only transcript pane. The admin portal is not a back door into a
 * dashboard (lib/auth/authorize.ts) — it reads the platform database only,
 * which is the visibility the onboarding promise already covers.
 */
export default async function TranscriptPane({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const account = getDb()
    .prepare("SELECT id FROM accounts WHERE slug = ? AND role = 'user'")
    .get(user) as { id: number } | undefined
  if (!account) notFound()

  const conversations = readConversations(getDb(), account.id)

  return (
    <main>
      <h1>{user}</h1>
      {conversations.length === 0 ? (
        <p>No transcript yet.</p>
      ) : (
        conversations.map((conversation) => (
          <section key={conversation.id}>
            <h2>
              {new Date(conversation.rows[0].at).toISOString()} —{' '}
              {conversation.rows.length} messages
            </h2>
            <ol>
              {conversation.rows.map((row) => (
                <li key={row.id}>
                  <strong>{row.role}</strong>{' '}
                  <time dateTime={new Date(row.at).toISOString()}>
                    {new Date(row.at).toISOString()}
                  </time>{' '}
                  <code>{row.prompt_sha}</code>
                  <p>{row.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </main>
  )
}
```

- [ ] **Step 5: Link the user list in `app/admin/page.tsx`**

Replace the `<li>` at line 25:

```tsx
            <li key={u.slug}>
              <a href={`/admin/${u.slug}`}>{u.slug}</a>
            </li>
```

- [ ] **Step 6: Run the tests, typecheck, and build**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add app/admin/[user]/page.tsx app/admin/page.tsx lib/db/appendOnly.ts tests/admin/transcriptPane.test.ts
git commit -m "Add the admin transcript pane, grouped by conversation

Newest conversation first, rows inside it in reading order, each turn
showing role, timestamp, and prompt_sha so a transcript can be read against
the exact prompt that produced it.

Read-only over the platform database. Tests pin that a non-admin session
and an unknown slug both 404."
```

---

### Task 11: Gate B arm, docs, and the ledger

**Files:**
- Modify: `.githooks/pre-commit:125-128`
- Modify: `.claude/hooks/test-hooks.sh`
- Modify: `CLAUDE.md`
- Modify: `deploy/PROVISION.md`
- Modify: `docs/local-dev.md`
- Create: `docs/superpowers/ledgers/step2.md`

- [ ] **Step 1: Add the explicit arm to `.githooks/pre-commit`**

Insert immediately **before** the "Docs first" case (currently line 125), so intent is recorded ahead of the incidental `*.md` match:

```sh
  # Runtime prose, not documentation and not logic. platform/prompts/*.md is
  # loaded at request time and its sha is stamped on every transcript row.
  # The loader and the hash stamping ARE tested (tests/chat/prompt.test.ts);
  # the prose is not, because a test over wording would pin style rather than
  # behaviour. Listed explicitly rather than relying on the *.md arm below,
  # which exempts it only by accident of file extension.
  case "$p" in
    platform/prompts/*) echo "exempt"; return ;;
  esac
```

- [ ] **Step 2: Add a case to `.claude/hooks/test-hooks.sh`**

Follow the existing assertion style in that file; the case must assert that `_gate_b_class platform/prompts/agent-v1.md` prints `exempt`, and that `platform/chat.ts` still prints `guard:platform` — so a too-broad glob is caught.

- [ ] **Step 3: Run the hook tests and report the output**

Run: `.claude/hooks/test-hooks.sh`
Expected: all pass. CLAUDE.md requires this after any hook change; paste the output into the task report.

- [ ] **Step 4: Update `CLAUDE.md`**

Under **Testing**, add:

```markdown
- `platform/prompts/*` is runtime prose, not documentation and not logic. It
  is exempt from Gate B by an explicit arm in `.githooks/pre-commit`. Test the
  loader and the `prompt_sha` stamping, never the wording.
- Chat tests never call the live Anthropic API. `lib/chat/turn.ts` takes its
  client as a parameter; tests pass a fake. A test that needs a real key is a
  test that is wrong.
```

Under **Data safety**, add:

```markdown
- `transcripts` and `metrics` gained columns in step 2 via `lib/db/reshape.ts`,
  which drops a stale-shaped table only after proving it holds zero rows and
  throws otherwise. It is the one place in `lib/db` allowed to drop a sacred
  table. Never widen that exception.
```

- [ ] **Step 5: Update `deploy/PROVISION.md`**

Document that `ANTHROPIC_API_KEY=sk-ant-...` goes in `/home/deploy/stairwell/.env`, the existing `EnvironmentFile` referenced by `deploy/stairwell.service:11`. Note that the file lives outside the repo, that the deploy contract is unchanged, and that `deploy.sh` remains the only way changes reach the droplet.

- [ ] **Step 6: Update `docs/local-dev.md`**

Document `ANTHROPIC_API_KEY` for local runs, in the same shape as the existing `ADMIN_PASSWORD` guidance: supplied at the command line or in an untracked `.env.local`, never committed. Note the guard hook denies reads of `.env` files by design.

- [ ] **Step 7: Write `docs/superpowers/ledgers/step2.md`**

Record, matching the step1a/step1b ledger style:

- **The `conversationIdFor` race** (spec §8): two concurrent turns from one account can both read the same last row and disagree on the boundary. Ruled known-unhandled. Damage is a mis-grouped row, never a lost one.
- **Partial replies are invisible in the transcript** (spec §3.4): deliberate; the interrupted marker is the mitigation.
- **No rate limiting** (spec §8): `max_tokens` bounds one reply, nothing bounds turns per day.
- **`putKey` overwrite does not zero the replaced buffer** — carried forward from step 1a, noted in `lib/session/keymap.ts:17`, still open.
- **`context` is hardcoded to `interview`** — becomes wrong the moment step 4 ships spec confirmation. Step 4 must set it from whether a confirmed spec exists.

- [ ] **Step 8: Commit**

```bash
git add .githooks/pre-commit .claude/hooks/test-hooks.sh CLAUDE.md deploy/PROVISION.md docs/local-dev.md docs/superpowers/ledgers/step2.md
git commit -m "Make the prompts Gate B exemption explicit; document step 2

platform/prompts/*.md was already exempt via the *.md arm — by accident of
file extension, not intent. A load-bearing runtime input looked like
documentation to the gate, and narrowing the .md rule later would have
silently made it guarded. Named arm, with the reason beside it.

Ledger records the conversationIdFor race as known-unhandled, and flags that
context='interview' is hardcoded and becomes wrong when step 4 ships."
```

---

### Task 12: End-to-end verification

- [ ] **Step 1: Regenerate the synthetic database and create dev users**

```bash
npx tsx scripts/create-dev-users.ts
```

with `ADMIN_PASSWORD` supplied per `docs/local-dev.md`.

- [ ] **Step 2: Run the app with a real key**

```bash
ANTHROPIC_API_KEY='sk-ant-...' npm run dev
```

- [ ] **Step 3: Walk the checkpoint**

Log in as the dev user, send a message, watch the reply stream, hide and show the panel, reload and confirm the transcript persisted. Log in as admin, open the user from the list, confirm the transcript appears grouped with its `prompt_sha`.

- [ ] **Step 4: Confirm the locked path by hand**

Restart the dev server without logging out. The session survives; the key does not. Confirm the user page still loads, the data region says Locked, and chat still answers. That is `architecture-overview.md` line 59 working end to end.

- [ ] **Step 5: Check the metrics rows**

```bash
sqlite3 platform/dev/synthetic.db "SELECT event, data FROM metrics ORDER BY id"
```

Expected: one `chat_turn` per completed reply, with four non-zero-where-expected counters, `model`, `effort`, `prompt_sha`, and `context: "interview"`.

- [ ] **Step 6: Push**

```bash
git push -u origin step2-chat-design
```

Gate E (`npx vitest run`) then Gate D (`npx next build`) run automatically. Do not use `SKIP_TEST_RUN_GATE` or `SKIP_BUILD_GATE`.

- [ ] **Step 7: Deploy**

```bash
deploy/deploy.sh
```

Confirm `deploy/smoke.sh` passes. Remember `ANTHROPIC_API_KEY` must already be in `/home/deploy/stairwell/.env` (Task 11 Step 5) or the first chat request will fail at runtime while the deploy itself still reports success — the smoke check does not exercise the chat endpoint.

---

## Self-review notes

**Spec coverage.** §2.1 → T1/T2. §2.2 → T3 (rationale) . §2.3 → T3. §2.4 → T1. §2.5 → T2 (storage) + T6 (shapes). §2.6 → T2/T10. §3.1 → T4/T5/T6/T8. §3.2 → T5. §3.3 → T8/T9. §3.4 → T6. §3.5 → T8. §4 → T7. §5 → T4. §6.1 → T9. §6.2 → T10. §7.1 → every task. §7.2 → T11. §7.3 → T11. §8 → T11 (ledger). §9 out of scope, untouched.

**Known gap, deliberate.** The chat panel's React rendering has no test — the suite is node-environment with no jsdom, and adding one is a test-infrastructure change beyond this step. The parser that decides saved-versus-interrupted *is* tested directly (T9), and the endpoint behaviour it depends on is tested (T8). Task 12 Step 3 covers the rendering by hand. Flagged rather than silently skipped.

**Task 12 caveat.** `deploy/smoke.sh` asserts the redirect shape, not the chat endpoint. A deploy can therefore succeed with a missing or invalid `ANTHROPIC_API_KEY`. Called out in T12 Step 7; extending the smoke check is out of scope here.
