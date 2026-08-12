# Step 3 — ntfy.sh conversation alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a content-free notification to Nico's phone when a friend starts
a conversation, without ever letting that push affect the chat turn.

**Architecture:** Step 2 already mints a `conversation_id` on exactly the
30-minute boundary the alert is defined on, so the only missing piece is that
the minting is not *reported*. `conversationIdFor` starts returning
`{ id, started }`; `runTurn` calls an injected `alert(accountId)` when `started`
is true, immediately after the user row is appended and before the model
stream opens. The alerter itself lives in `lib/alerts/ntfy.ts`, takes an
account id and nothing else, and fires a POST it never awaits.

**Tech Stack:** TypeScript, Next.js App Router, better-sqlite3, vitest, Node 22
global `fetch` and `AbortSignal.timeout`.

**Spec:** `docs/superpowers/specs/2026-08-12-step3-ntfy-alerts-design.md`
**Ledger:** `docs/superpowers/ledgers/step3.md`

## Global Constraints

- **No test in this plan performs a real HTTP request.** `fetch` is injected
  everywhere it is used, exactly as `lib/chat/turn.ts` already injects its
  Anthropic client (CLAUDE.md > Testing).
- **The alert carries no message text, ever.** The alerter's only parameter is
  an account id. Widening that signature is a spec change (spec §2 item 2).
- **The alert never throws and never rejects.** A friend's chat turn must not
  fail because a push timed out (spec §2 item 3).
- **Posted body is exactly** `` `${slug} started a conversation` ``.
- **`ntfy.sh` origin:** `https://ntfy.sh`. **Timeout:** 5000 ms.
- **Metric events:** `alert_sent` and `alert_failed`, both with
  `data.kind === 'conversation_started'`. `alert_failed.reason` is one of
  `http` | `network` | `timeout` | `no_topic`. `status` is the HTTP status for
  `http`, `null` otherwise.
- **`admin`-role accounts never alert** (spec §3 D2).
- Every commit runs the pre-commit gates. Changes under `lib/` and `app/`
  require a test under `tests/` in the SAME commit (CLAUDE.md > Testing).
- Run tests with `npx vitest run`. Scope with a path while iterating.

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/chat/conversation.ts` (modify) | Owns the 30-minute boundary. Gains a `started` flag on its return — the whole trigger. |
| `lib/auth/accounts.ts` (modify) | Gains `findAccountById`, mirroring the existing `findAccountBySlug`. |
| `lib/alerts/ntfy.ts` (create) | The alerter: suppression rule, the POST, the timeout, both metrics. The only file that knows ntfy.sh exists. |
| `lib/chat/turn.ts` (modify) | Calls the injected alert at the right moment. Knows nothing about ntfy. |
| `app/api/chat/route.ts` (modify) | Builds the real alerter from `process.env.NTFY_TOPIC` and injects it. |
| `deploy/required-env` (modify) | Declares `NTFY_TOPIC REQUIRED`. |
| `docs/local-dev.md` (modify) | Tells a developer to set a separate dev topic. |
| `tests/chat/conversation.test.ts` (modify) | The new return shape. |
| `tests/alerts/ntfy.test.ts` (create) | Every alerter branch, with a fake `fetch`. |
| `tests/chat/turn.test.ts` (modify) | That the alert fires, when, and in what order. |
| `tests/chat/route.test.ts` (modify) | That the route actually wired an alerter. |
| `tests/alerts/leak.test.ts` (create) | That no message text can reach the wire. |
| `tests/env/required.test.ts` (modify) | That `NTFY_TOPIC` is `REQUIRED`. |

Five tasks. Each ends with a green suite and a commit.

---

### Task 1: `conversationIdFor` reports whether it minted

Nothing downstream can currently tell a minted id from a reused one — the
function returns a bare string either way. This task changes only that.

**Files:**
- Modify: `lib/chat/conversation.ts`
- Modify: `lib/chat/turn.ts:63` (destructure only, no behaviour change)
- Test: `tests/chat/conversation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type ConversationRef = { id: string; started: boolean }`
  and `conversationIdFor(db: PlatformDb, accountId: number, now: number): ConversationRef`.
  Task 3 depends on `started`.

- [ ] **Step 1: Write the failing tests**

In `tests/chat/conversation.test.ts`, every existing assertion moves onto
`.id`, and `started` gets pinned. Replace the whole `describe('conversationIdFor')`
block with this — the helpers above it (`write`, the `beforeEach`) stay as they are:

```ts
describe('conversationIdFor', () => {
  it('mints a fresh id for an account with no history', () => {
    const ref = conversationIdFor(db, 1, 1_000)
    expect(ref.id).toMatch(/^[0-9a-f]{32}$/)
    expect(ref.started).toBe(true)
  })

  it('reuses the last id inside the gap', () => {
    write(1, 'conv-a', 1_000)
    const ref = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS)
    expect(ref.id).toBe('conv-a')
    expect(ref.started).toBe(false)
  })

  it('mints a fresh id past the gap', () => {
    write(1, 'conv-a', 1_000)
    const ref = conversationIdFor(db, 1, 1_000 + CONVERSATION_GAP_MS + 1)
    expect(ref.id).not.toBe('conv-a')
    expect(ref.id).toMatch(/^[0-9a-f]{32}$/)
    expect(ref.started).toBe(true)
  })

  it('treats exactly the gap as still the same conversation', () => {
    // The boundary is "> 30 minutes", so 30:00.000 exactly stays. Pinned
    // because an off-by-one here silently re-cuts every conversation in the
    // retention analysis, and the rows are not rewritable afterwards. Now
    // also the boundary the step-3 alert fires on, so an off-by-one is a
    // phone that buzzes at the wrong moment as well.
    write(1, 'conv-a', 0)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS).started).toBe(false)
    expect(conversationIdFor(db, 1, CONVERSATION_GAP_MS + 1).started).toBe(true)
  })

  it('scopes the lookup to one account', () => {
    write(2, 'conv-other', 1_000)
    const ref = conversationIdFor(db, 1, 1_100)
    expect(ref.id).not.toBe('conv-other')
    // Account 1 has never written, so this is a start even though account 2
    // is mid-conversation. Two friends chatting at once must alert twice.
    expect(ref.started).toBe(true)
  })
})
```

Note: the last test replaces the existing `scopes the lookup to one account`
test at line 63. Read the current file and keep any assertion it makes that is
not reproduced above, rewritten onto `.id`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/chat/conversation.test.ts`
Expected: FAIL — `ref.id` is `undefined` because `conversationIdFor` still
returns a string.

- [ ] **Step 3: Change the return shape**

Replace the body of `conversationIdFor` in `lib/chat/conversation.ts`, and
update its doc comment:

```ts
export type ConversationRef = {
  id: string
  /**
   * True when this call MINTED the id rather than reusing one. This is the
   * step-3 alert trigger in its entirety: "a conversation started" and "a
   * conversation_id was minted" are the same event, deliberately, so there is
   * no second rule that can drift from this one (design spec §4.1).
   */
  started: boolean
}

/**
 * The conversation a message written at `now` belongs to, and whether that
 * conversation is new.
 *
 * Called ONCE per exchange, when the user turn is appended. The assistant turn
 * reuses the returned value verbatim rather than recomputing — see the step-2
 * design spec section 2.3.
 */
export function conversationIdFor(
  db: PlatformDb,
  accountId: number,
  now: number,
): ConversationRef {
  const last = lastTranscriptRow(db, accountId)
  const fresh = () => ({ id: randomBytes(16).toString('hex'), started: true })
  if (!last) return fresh()
  if (now - last.at > CONVERSATION_GAP_MS) return fresh()
  return { id: last.conversation_id, started: false }
}
```

- [ ] **Step 4: Update the one caller**

In `lib/chat/turn.ts`, line 63 becomes:

```ts
  // Computed once, here. The assistant row reuses it rather than recomputing
  // the gap against a clock that has moved.
  const { id: conversationId } = conversationIdFor(db, input.accountId, at)
```

`started` is deliberately not used yet — Task 3 wires it. Leaving it unused
here keeps this task a pure refactor with no behaviour change.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: PASS. If anything outside `tests/chat/` fails, a second caller of
`conversationIdFor` exists that this plan did not account for — fix it the same
way and note it in the commit message.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. This is the gate that catches a missed `.id`.

- [ ] **Step 7: Commit**

```bash
git add lib/chat/conversation.ts lib/chat/turn.ts tests/chat/conversation.test.ts
git commit -m "Report whether conversationIdFor minted or reused

The step-3 alert fires on a conversation start, which is already exactly
the moment this function mints an id. Returning { id, started } makes that
observable instead of requiring a second boundary check somewhere else."
```

---

### Task 2: the alerter

Everything that knows ntfy.sh exists, in one file, wired to nothing yet.

**Files:**
- Modify: `lib/auth/accounts.ts`
- Create: `lib/alerts/ntfy.ts`
- Test: `tests/alerts/ntfy.test.ts` (create; `tests/alerts/` is a new directory)

**Interfaces:**
- Consumes: `appendMetric` from `@/lib/db/appendOnly`, `Account` from
  `@/lib/auth/accounts`.
- Produces:
  - `findAccountById(db: PlatformDb, id: number): Account | undefined`
  - `conversationAlerter(deps: AlerterDeps): (accountId: number) => Promise<void>`
    where `AlerterDeps = { topic: string | undefined; fetch: typeof globalThis.fetch; db: PlatformDb; now: () => number }`
  - `NTFY_ORIGIN`, `ALERT_TIMEOUT_MS`, `ALERT_KIND`

  The returned function is `async`, so tests can await it, but Task 3 declares
  the dependency as `(accountId: number) => void` — a promise-returning
  function is assignable to that, and the narrower type is what stops `runTurn`
  from ever awaiting it.

- [ ] **Step 1: Write the failing tests**

Create `tests/alerts/ntfy.test.ts`:

```ts
// tests/alerts/ntfy.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { conversationAlerter, NTFY_ORIGIN } from '@/lib/alerts/ntfy'

let dir: string
let db: PlatformDb
let userId: number
let adminId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-ntfy-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  userId = await createAccount(db, { slug: 'devtwo', role: 'user', password: 'pw' })
  adminId = await createAccount(db, { slug: 'nico', role: 'admin', password: 'pw' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

type Call = { url: string; init: RequestInit | undefined }

/** A fetch that records what it was asked to do and answers as told. */
function fakeFetch(calls: Call[], answer: () => Response | Promise<Response>) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return answer()
  }) as unknown as typeof globalThis.fetch
}

const ok = () => new Response('1', { status: 200 })

function metrics() {
  return db
    .prepare('SELECT account_id, event, data FROM metrics ORDER BY id')
    .all() as { account_id: number | null; event: string; data: string }[]
}

function alerter(over: Partial<Parameters<typeof conversationAlerter>[0]> = {}) {
  return conversationAlerter({
    topic: 'topic-abc',
    fetch: fakeFetch([], ok),
    db,
    now: () => 1_000,
    ...over,
  })
}

describe('conversationAlerter', () => {
  it('posts the slug line to the topic and records alert_sent', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${NTFY_ORIGIN}/topic-abc`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe('devtwo started a conversation')
    // A send with no timeout holds a socket for the life of the process, and
    // nothing awaits this call, so nobody would ever notice.
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal)

    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_sent')
    expect(metrics()[0]!.account_id).toBe(userId)
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      status: 200,
    })
  })

  it('sends nothing and records nothing for an admin account', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(adminId)

    expect(calls).toHaveLength(0)
    // Suppression is not a failure. A metric here would make a deliberate
    // silence look like a broken alerter in the very log that exists to tell
    // those two apart.
    expect(metrics()).toHaveLength(0)
  })

  it('sends nothing for an account id that does not exist', async () => {
    const calls: Call[] = []
    await alerter({ fetch: fakeFetch(calls, ok) })(9_999)

    expect(calls).toHaveLength(0)
    expect(metrics()).toHaveLength(0)
  })

  it('records no_topic without attempting a request when the topic is unset', async () => {
    const calls: Call[] = []
    await alerter({ topic: undefined, fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(0)
    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_failed')
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'no_topic',
      status: null,
    })
  })

  it('treats a whitespace-only topic as unset', async () => {
    const calls: Call[] = []
    await alerter({ topic: '   ', fetch: fakeFetch(calls, ok) })(userId)

    expect(calls).toHaveLength(0)
    expect(JSON.parse(metrics()[0]!.data).reason).toBe('no_topic')
  })

  it('records http with the status on a non-2xx response', async () => {
    await alerter({
      fetch: fakeFetch([], () => new Response('nope', { status: 429 })),
    })(userId)

    expect(metrics()).toHaveLength(1)
    expect(metrics()[0]!.event).toBe('alert_failed')
    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'http',
      status: 429,
    })
  })

  it('records network when fetch rejects', async () => {
    await alerter({
      fetch: fakeFetch([], () => {
        throw new Error('getaddrinfo ENOTFOUND ntfy.sh')
      }),
    })(userId)

    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'network',
      status: null,
    })
  })

  it('records timeout separately from network', async () => {
    // What AbortSignal.timeout actually raises. Kept distinct because "ntfy.sh
    // is slow" and "the droplet has no egress" are different problems with
    // different fixes (design spec §4.4).
    await alerter({
      fetch: fakeFetch([], () => {
        throw new DOMException('timed out', 'TimeoutError')
      }),
    })(userId)

    expect(JSON.parse(metrics()[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'timeout',
      status: null,
    })
  })

  it('never rejects, even when the metric write itself fails', async () => {
    // A rejection from here is an unhandled rejection: nothing awaits the
    // alerter. Node's default for that is a process-level event, which is the
    // one thing an alert must never cause (design spec §4.3).
    const brokenDb = {
      prepare(sql: string) {
        if (sql.startsWith('INSERT INTO metrics')) {
          return {
            run() {
              throw new Error('database is locked')
            },
          }
        }
        return db.prepare(sql)
      },
    } as unknown as PlatformDb

    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch: fakeFetch([], ok),
      db: brokenDb,
      now: () => 1_000,
    })
    await expect(send(userId)).resolves.toBeUndefined()
  })

  it('never rejects when the account lookup itself fails', async () => {
    const closed = openPlatformDb(join(dir, 'closed.db'))
    closed.close()
    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch: fakeFetch([], ok),
      db: closed,
      now: () => 1_000,
    })
    await expect(send(userId)).resolves.toBeUndefined()
  })

  it('percent-encodes a topic so it cannot escape its path segment', async () => {
    const calls: Call[] = []
    await alerter({ topic: 'a/b', fetch: fakeFetch(calls, ok) })(userId)
    expect(calls[0]!.url).toBe(`${NTFY_ORIGIN}/a%2Fb`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/alerts/ntfy.test.ts`
Expected: FAIL — `Cannot find module '@/lib/alerts/ntfy'`.

- [ ] **Step 3: Add `findAccountById`**

In `lib/auth/accounts.ts`, directly below `findAccountBySlug`:

```ts
export function findAccountById(
  db: PlatformDb,
  id: number,
): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | Account
    | undefined
}
```

- [ ] **Step 4: Write the alerter**

Create `lib/alerts/ntfy.ts`:

```ts
// lib/alerts/ntfy.ts
//
// The only file that knows ntfy.sh exists.
//
// TWO PROPERTIES HOLD THIS FILE TOGETHER, and both are spec, not taste:
//
// 1. IT TAKES AN ACCOUNT ID AND NOTHING ELSE. Alerts are content-free
//    (design spec §2 item 2) — the third party learns that someone started
//    talking, never what was said. That is not enforced by discipline here;
//    there is simply no parameter through which message text could arrive.
//    Widening this signature is a spec change, and a visible one.
//
// 2. IT NEVER THROWS AND NEVER REJECTS. Nothing awaits it, so a rejection is
//    an unhandled rejection — a process-level event, over a push
//    notification. A friend's chat turn must never fail because a phone did
//    not buzz (design spec §2 item 3).
import type { PlatformDb } from '@/lib/db/platform'
import { appendMetric } from '@/lib/db/appendOnly'
import { findAccountById } from '@/lib/auth/accounts'

export const NTFY_ORIGIN = 'https://ntfy.sh'

/**
 * A hung ntfy.sh with no timeout holds a socket for the life of the process,
 * and since nothing awaits the send, nobody would ever notice. The exact
 * number is not load-bearing: well under any human patience for the signal,
 * well over ntfy.sh's normal response.
 */
export const ALERT_TIMEOUT_MS = 5_000

/** Distinguishes this alert from any later one sharing the same events. */
export const ALERT_KIND = 'conversation_started'

export type AlerterDeps = {
  topic: string | undefined
  /** Injected so no test ever reaches the network (CLAUDE.md > Testing). */
  fetch: typeof globalThis.fetch
  db: PlatformDb
  now: () => number
}

type Failure = 'http' | 'network' | 'timeout' | 'no_topic'

export function conversationAlerter(
  deps: AlerterDeps,
): (accountId: number) => Promise<void> {
  return async (accountId) => {
    try {
      const account = findAccountById(deps.db, accountId)

      // An admin is Nico, who is at the computer. Self-buzzing is how a tone
      // gets ignored (design spec §3 D2). Suppression records nothing: a
      // deliberate silence must not look like a broken alerter in the log
      // that exists to tell those two apart.
      if (!account || account.role === 'admin') return

      const topic = deps.topic?.trim()
      if (!topic) {
        // Belt to the deploy gate's braces: NTFY_TOPIC is REQUIRED, so
        // deploy/check-env.sh should have stopped this. If it somehow did
        // not, the log says so rather than the alert vanishing.
        record(deps, account.id, 'alert_failed', { reason: 'no_topic', status: null })
        return
      }

      await send(deps, account.id, topic, `${account.slug} started a conversation`)
    } catch {
      // Backstop for anything the paths above did not anticipate — a closed
      // database on the lookup, most plausibly. Property 2 above is absolute.
    }
  }
}

async function send(
  deps: AlerterDeps,
  accountId: number,
  topic: string,
  body: string,
): Promise<void> {
  try {
    const response = await deps.fetch(
      // Encoded so a topic containing '/' cannot reach a different path.
      `${NTFY_ORIGIN}/${encodeURIComponent(topic)}`,
      {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      },
    )
    if (response.ok) {
      record(deps, accountId, 'alert_sent', { status: response.status })
    } else {
      record(deps, accountId, 'alert_failed', { reason: 'http', status: response.status })
    }
  } catch (error) {
    // Both arrive as a rejection from fetch. AbortSignal.timeout raises a
    // TimeoutError specifically, which is the only thing separating "ntfy.sh
    // is slow" from "this host has no egress".
    const reason: Failure =
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network'
    record(deps, accountId, 'alert_failed', { reason, status: null })
  }
}

/**
 * Both outcomes are recorded, not only failures.
 *
 * Failure-only leaves silence ambiguous: no rows could mean nobody chatted, or
 * it could mean alerting is dead. With alert_sent, conversation starts —
 * derivable from `transcripts` — diff against alerts sent, so a stoppage is a
 * visible gap rather than an absence of evidence (design spec §4.4).
 *
 * Never throws: the write failing must not become the caller's problem, and
 * the caller here is a promise nobody holds.
 */
function record(
  deps: AlerterDeps,
  accountId: number,
  event: 'alert_sent' | 'alert_failed',
  data: { reason?: Failure; status: number | null },
): void {
  try {
    appendMetric(deps.db, {
      accountId,
      event,
      at: deps.now(),
      // No text of any kind. account_id already says who.
      data: { kind: ALERT_KIND, ...data },
    })
  } catch {
    // Losing the metric is the cheapest possible failure here.
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/alerts/ntfy.test.ts`
Expected: PASS, 11 tests.

If `records alert_sent` fails on the `data` equality, check the key order does
not matter (`toEqual` is order-insensitive) and that `status` is a number, not
a string.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add lib/alerts/ntfy.ts lib/auth/accounts.ts tests/alerts/ntfy.test.ts
git commit -m "Add the ntfy conversation alerter, wired to nothing yet

Takes an account id and nothing else, so there is no parameter through
which message text could reach ntfy.sh — content-freeness is structural
rather than a discipline. Never rejects: nothing awaits it, so a rejection
would be an unhandled rejection over a push notification.

Records both outcomes. Failure-only would leave silence ambiguous between
'nobody chatted' and 'alerting is dead', which is the one thing the metric
exists to distinguish."
```

---

### Task 3: fire it from `runTurn`

**Files:**
- Modify: `lib/chat/turn.ts`
- Test: `tests/chat/turn.test.ts`

**Interfaces:**
- Consumes: `started` from Task 1.
- Produces: `TurnDeps` gains `alert: (accountId: number) => void`. Task 4
  supplies the real one.

- [ ] **Step 1: Write the failing tests**

Two edits to `tests/chat/turn.test.ts`.

First, near the top (below the `USAGE`/`SERVED` constants), add:

```ts
/** Most tests do not care about alerting; this keeps their deps honest. */
const noAlert = () => {}
```

Then add `alert: noAlert` to **every** existing `const deps = { ... }` literal
in the file (15 of them). They currently read
`{ db, client: fakeClient(['ok']), now: () => 1_000 }` and similar; each becomes
`{ db, client: fakeClient(['ok']), now: () => 1_000, alert: noAlert }`. Do not
change anything else about those tests.

Second, append this block at the end of the file:

```ts
describe('conversation-start alerting', () => {
  function alerted(over: { client?: ChatClient; now?: () => number } = {}) {
    const calls: number[] = []
    const deps = {
      db,
      client: over.client ?? fakeClient(['ok']),
      now: over.now ?? (() => 1_000),
      alert: (accountId: number) => calls.push(accountId),
    }
    return { deps, calls }
  }

  it('alerts once, with the account id, when a conversation starts', async () => {
    const { deps, calls } = alerted()
    await runTurn(deps, input())
    expect(calls).toEqual([1])
  })

  it('does not alert on a continuation of an existing conversation', async () => {
    appendTranscript(db, {
      accountId: 1,
      sessionId: 'sess-1',
      conversationId: 'conv-a',
      promptSha: 'sha',
      role: 'user',
      body: 'earlier',
      at: 900,
    })
    const { deps, calls } = alerted()
    await runTurn(deps, input())
    expect(calls).toEqual([])
  })

  it('alerts BEFORE the model is called, not after the reply', async () => {
    // The signal is "a friend showed up", and it is worth more the sooner it
    // arrives. Ordering is asserted rather than assumed because moving the
    // call below the stream would still pass every other test here.
    const order: string[] = []
    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        order.push('stream')
        onUsage({ input: 100, cache_read: 40, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText('ok')
        onUsage({ output: 7 })
        return { usage: USAGE, stop_reason: 'end_turn', served: SERVED }
      },
    }
    const deps = {
      db,
      client,
      now: () => 1_000,
      alert: () => order.push('alert'),
    }
    await runTurn(deps, input())
    expect(order).toEqual(['alert', 'stream'])
  })

  it('still alerts when the turn errors', async () => {
    // A friend who showed up and hit an outage is when the signal matters
    // most. Gating the alert on success would make an outage a silent phone
    // (design spec §3 D1).
    const client: ChatClient = {
      async stream() {
        throw new ChatStreamError(describeError(new Error('boom')))
      },
    }
    const { deps, calls } = alerted({ client })
    const outcome = await runTurn(deps, input())
    expect(outcome.kind).toBe('error')
    expect(calls).toEqual([1])
  })
})
```

If the existing file's `input()` helper does not default `accountId` to `1`,
adjust the expected ids above to match it. Check before running.

The `ChatStreamError`/`describeError` construction must match how the existing
`logs a chat_error` test in this file builds its failing client — copy that
client's shape rather than the sketch above if they differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/chat/turn.test.ts`
Expected: FAIL — the four new tests report `calls` as `[]` or the wrong order,
because `runTurn` never calls `alert`. TypeScript will also flag `alert` as an
unknown property on `TurnDeps`; that is the same failure.

- [ ] **Step 3: Add the dependency and the call**

In `lib/chat/turn.ts`, extend `TurnDeps`:

```ts
export type TurnDeps = {
  db: PlatformDb
  client: ChatClient
  now: () => number
  /**
   * Fired when this turn STARTS a conversation. Declared as returning void
   * on purpose: the real implementation is async and fire-and-forget
   * (lib/alerts/ntfy.ts), and this type is what stops a future edit from
   * awaiting it and putting a push notification on the critical path of a
   * friend's chat turn.
   */
  alert: (accountId: number) => void
}
```

Update the destructure on line 57 and the mint on line 63, then add the call
immediately after the user row is appended:

```ts
  const { db, client, now, alert } = deps
  ...
  const { id: conversationId, started } = conversationIdFor(db, input.accountId, at)
  ...
  appendTranscript(db, { ...stamp, role: 'user', body: input.body, at })

  // AFTER the write, because the alert asserts a conversation started and an
  // insert that threw means none did. BEFORE the stream, because the model's
  // latency is not something a phone should wait on.
  //
  // Deliberately not wrapped in a try: the alerter owns its own safety and
  // provably neither throws nor rejects. A try here would instead swallow a
  // wiring mistake — an alert that never fires would look exactly like an
  // alert that fired.
  if (started) alert(input.accountId)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/chat/turn.test.ts`
Expected: PASS, including the 15 pre-existing tests.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: ONE error, in `app/api/chat/route.ts` — `alert` is missing from the
object passed to `runTurn`. That is correct and expected; Task 4 fixes it. Do
not silence it by making `alert` optional: an optional dependency is a wiring
mistake that compiles.

- [ ] **Step 6: Commit**

Gate B requires a test under `tests/` for a `lib/` change — `tests/chat/turn.test.ts`
satisfies it. The typecheck gate will block on the known route error, so this
commit uses the documented skip and says why.

```bash
git add lib/chat/turn.ts tests/chat/turn.test.ts
SKIP_TYPECHECK=1 git commit -m "Fire the conversation alert from runTurn

Called after the user row is appended (the alert asserts a conversation
started, and an insert that threw means none did) and before the stream
opens (the model's latency is not something a phone should wait on). A turn
that errors still alerts: a friend who showed up and hit an outage is when
the signal matters most.

SKIP_TYPECHECK=1: adding the required 'alert' dependency to TurnDeps leaves
app/api/chat/route.ts failing to compile until the next commit wires it.
Making the dependency optional would compile, and would make a missing
wiring silent — which is the failure this whole step is about. The next
commit restores a clean typecheck."
```

---

### Task 4: wire the route, and prove nothing leaks

**Files:**
- Modify: `app/api/chat/route.ts`
- Modify: `tests/chat/route.test.ts`
- Create: `tests/alerts/leak.test.ts`

**Interfaces:**
- Consumes: `conversationAlerter` (Task 2), `TurnDeps.alert` (Task 3).
- Produces: nothing further.

- [ ] **Step 1: Write the failing tests**

First, `tests/chat/route.test.ts`. In its `beforeEach`, alongside the existing
`process.env.PLATFORM_DB` assignment, add:

```ts
  // No test may push to a real topic. A developer with NTFY_TOPIC set in
  // their shell would otherwise buzz their own phone on every suite run.
  delete process.env.NTFY_TOPIC
```

Then add this test to the file, in the same `describe` as the other successful-turn
tests:

```ts
  it('wires a real alerter, evidenced by the no_topic row on a fresh conversation', async () => {
    // With NTFY_TOPIC deleted above, the alerter's no_topic branch is the
    // observable proof that the route built one at all. A route that passed
    // a no-op would produce no row here and every other test would stay
    // green.
    const { POST } = await import('@/app/api/chat/route')
    const response = await POST(chatRequest('hello'))
    await response.text()

    const rows = handle!
      .prepare("SELECT event, data FROM metrics WHERE event LIKE 'alert%' ORDER BY id")
      .all() as { event: string; data: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toBe('alert_failed')
    expect(JSON.parse(rows[0]!.data).reason).toBe('no_topic')
  })
```

`chatRequest('hello')` is a stand-in: read the file and reuse whatever helper
its existing successful-turn tests use to build the request and to seat a
session cookie. Do not invent a new one.

Second, create `tests/alerts/leak.test.ts`:

```ts
// tests/alerts/leak.test.ts
//
// The one test that would catch message text reaching ntfy.sh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { createAccount } from '@/lib/auth/accounts'
import { conversationAlerter } from '@/lib/alerts/ntfy'
import { CHAT_MODEL, type ChatClient } from '@/lib/chat/client'
import { runTurn } from '@/lib/chat/turn'

/** Loudly fake, and unlike anything the alert legitimately sends. */
const SENTINEL = 'PINEAPPLE-CANARY-TEST-9471'

let dir: string
let db: PlatformDb
let accountId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-leak-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
  accountId = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'pw',
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('no message text reaches ntfy.sh', () => {
  it('sends only the slug line, for a turn whose text is a sentinel', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init })
      return new Response('1', { status: 200 })
    }) as unknown as typeof globalThis.fetch

    const send = conversationAlerter({
      topic: 'topic-abc',
      fetch,
      db,
      now: () => 1_000,
    })

    // The alerter is fire-and-forget, so runTurn will not await it. Holding
    // the promise here is the only way this test can assert on a settled
    // send rather than on a race.
    const pending: Promise<void>[] = []

    const client: ChatClient = {
      async stream({ onText, onUsage, onServed }) {
        onUsage({ input: 1, cache_read: 0, cache_creation: 0 })
        onServed({ model_served: CHAT_MODEL })
        onText(`reply mentioning ${SENTINEL}`)
        onUsage({ output: 1 })
        return {
          usage: { input: 1, output: 1, cache_read: 0, cache_creation: 0 },
          stop_reason: 'end_turn',
          served: { model_served: CHAT_MODEL, fallback_fired: false },
        }
      },
    }

    await runTurn(
      {
        db,
        client,
        now: () => 1_000,
        alert: (id) => {
          pending.push(send(id))
        },
      },
      {
        accountId,
        sessionId: 'sess-1',
        body: `please remember ${SENTINEL}`,
        signal: new AbortController().signal,
        onText: () => {},
      },
    )
    await Promise.all(pending)

    // BOTH halves are required. Asserting only "the sentinel is absent" would
    // pass in a world where nothing was sent at all — a test that cannot
    // fail, which this project has shipped once already.
    expect(seen).toHaveLength(1)

    const wire = JSON.stringify({
      url: seen[0]!.url,
      body: seen[0]!.init?.body,
      headers: seen[0]!.init?.headers ?? null,
      method: seen[0]!.init?.method,
    })
    expect(wire).not.toContain(SENTINEL)
    expect(seen[0]!.init?.body).toBe('devtwo started a conversation')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/alerts/leak.test.ts tests/chat/route.test.ts`
Expected: the leak test FAILS to compile/run because `runTurn`'s deps in the
route are still missing `alert`; the route test FAILS with zero `alert%` rows.

- [ ] **Step 3: Wire the route**

In `app/api/chat/route.ts`, add the import:

```ts
import { conversationAlerter } from '@/lib/alerts/ntfy'
```

and extend the `runTurn` deps at line 85:

```ts
      const outcome = await runTurn(
        {
          db,
          client: turnClient,
          now: Date.now,
          // Built per request, and NTFY_TOPIC read at call time rather than
          // at module scope — the same reason chatClient() is deferred: a
          // configuration problem should fail the request that needed it,
          // not the module import that also serves the 401 and 400 paths.
          alert: conversationAlerter({
            topic: process.env.NTFY_TOPIC,
            fetch: globalThis.fetch,
            db,
            now: Date.now,
          }),
        },
        {
```

Leave the rest of the call unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/alerts tests/chat`
Expected: PASS.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: both clean. The typecheck error Task 3 left behind is now gone.

- [ ] **Step 6: Commit**

```bash
git add app/api/chat/route.ts tests/chat/route.test.ts tests/alerts/leak.test.ts
git commit -m "Wire the alerter into the chat route, with a leak test

NTFY_TOPIC is read at call time, not module scope, for the same reason
chatClient() is deferred: a config problem should fail the request that
needed it rather than the import that also serves 401 and 400.

The route test deletes NTFY_TOPIC so no suite run can push to a real topic,
and then asserts the no_topic row — which is the only observable proof that
the route built a real alerter rather than passing a no-op.

The leak test asserts the fetch WAS called before asserting the sentinel is
absent. Without that half it would pass in a world where nothing was sent."
```

---

### Task 5: declare the variable and document the dev topic

**Files:**
- Modify: `deploy/required-env`
- Modify: `docs/local-dev.md`
- Test: `tests/env/required.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `NTFY_TOPIC` as a `REQUIRED` entry. No code reads the list
  differently — `deploy/check-env.sh` and `lib/env/report.ts` both already
  consume it, which is the property the required-env branch was built for.

- [ ] **Step 1: Write the failing test**

Append to the `describe('the shipped deploy/required-env')` block in
`tests/env/required.test.ts`:

```ts
  it('lists NTFY_TOPIC as REQUIRED', () => {
    // By the letter of the list, one broken feature with everything else fine
    // reads DEGRADED. That reading is wrong here and the list says why:
    // DEGRADED is for absences where "its own error path carries it". This
    // absence has no error path a human meets — no 503, no error page, just a
    // phone that never buzzes. See the step-3 design spec §3 D3.
    expect(shipped.find((v) => v.name === 'NTFY_TOPIC')?.severity).toBe('REQUIRED')
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/env/required.test.ts`
Expected: FAIL — `undefined` is not `'REQUIRED'`.

- [ ] **Step 3: Add the entry**

Append to `deploy/required-env`, below the `ANTHROPIC_API_KEY` line:

```
NTFY_TOPIC         REQUIRED  # ntfy.sh topic for conversation-start alerts (lib/alerts/ntfy.ts). Absent, nothing user-visible fails and no page errors — the only symptom is a phone that never buzzes, which is the definition of the REQUIRED tier rather than the DEGRADED one.
```

Keep the existing column alignment of the two entries above it.

- [ ] **Step 4: Run the env and deploy tests**

Run: `npx vitest run tests/env tests/deploy`
Expected: PASS. `tests/env/required.test.ts` also asserts every entry has a
purpose comment, and `tests/deploy/checkEnv.test.ts` feeds the real list to
both checkers — all three should stay green with no further edits.

- [ ] **Step 5: Document the dev topic**

In `docs/local-dev.md`, in the **Chat** section, after the paragraph ending
"…see First-time setup below for the one-line fix", add:

```markdown
`NTFY_TOPIC` is the same kind of name. Set it to a topic you do **not**
subscribe to on your phone — local development sends real pushes to
`ntfy.sh` on every conversation start, deliberately, so the send path is
exercised continuously instead of debuting in production. Pick something
unguessable; an ntfy topic is a shared secret with no auth around it.
```

And in **First-time setup**, below the existing `PLATFORM_DB` echo line, add:

```bash
echo 'NTFY_TOPIC=stairwell-dev-<something-unguessable>' >> .env.local
```

Note for the record: this is the third environment variable name written into
`docs/local-dev.md` with nothing pinning it, widening residual 7 in
`docs/superpowers/ledgers/required-env.md` by one. Accepted, not closed.

- [ ] **Step 6: Full suite, typecheck, and build**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: all clean. The build is Gate D and runs on push anyway; running it
here means finding a break while the context is still loaded.

- [ ] **Step 7: Commit**

`deploy/` and `docs/` are exempt from Gate B by path, but this commit carries a
test anyway.

```bash
git add deploy/required-env docs/local-dev.md tests/env/required.test.ts
git commit -m "Declare NTFY_TOPIC REQUIRED, and document the dev topic

REQUIRED rather than DEGRADED because its absence has no error path a human
meets: no 503, no error page, just a phone that never buzzes. That is the
tier's own definition — a false green nobody goes looking for.

No code change was needed to check it: check-env.sh and lib/env/report.ts
both read the list. That is what the required-env branch was built for.

Local development sends for real, to a separate topic, rather than being
gated off by NODE_ENV — a send path that never runs outside production is
the class of thing that ships broken."
```

---

## After the plan

**Update the ledger.** Add a `## Shipped` section to
`docs/superpowers/ledgers/step3.md` recording what landed, and open a
`## Residual risks` section with at least these, which are known now:

1. **A typo'd topic passes every check.** `check-env.sh` proves presence, not
   validity; ntfy.sh accepts a publish to a topic with no subscribers and
   returns 200; the alerter records `alert_sent`. Every layer reports success
   and no phone buzzes. Only a real test push catches it — which is why the
   go-live step below is a step and not an assumption.
2. **`docs/local-dev.md` now names three environment variables** with nothing
   pinning them (required-env residual 7, widened by one).
3. **Nothing asserts the 5-second timeout value**, only that *a* signal is
   attached. A future edit could set it to 5 ms and every test would stay
   green.

**Do not deploy.** `NTFY_TOPIC` is not on the droplet, so `deploy/check-env.sh`
will abort the deploy before `npm ci` — correctly. Go-live is Nico's, in this
order:

1. Nico picks a topic name and adds `NTFY_TOPIC=<topic>` to the droplet's
   `.env` (values live only in `.env`; the guard hook denies reading it).
2. Nico installs the ntfy app and subscribes to that topic.
3. `deploy/deploy.sh` — the env gate should now pass.
4. A real conversation from a `user` account (not `nico`) buzzes the phone.
   That is the only check that catches a typo'd topic.

---

## Self-review notes

- **Spec coverage.** §4.1 → Task 1. §4.2 → Task 3. §4.3 → Task 2. §4.4 → Task 2
  (metric shape) and Task 4 (route test proves the wiring). §4.5 → Task 4.
  §4.6 → Task 5. §5 testing → the test files in Tasks 1–4 plus Task 5's list
  assertion. §6 accepted limits → carried into the ledger residuals above.
  §1 out-of-scope items appear in no task, which is correct.
- **Type consistency.** `conversationAlerter` returns
  `(accountId: number) => Promise<void>`; `TurnDeps.alert` is
  `(accountId: number) => void`. That mismatch is deliberate and assignable —
  it is what stops `runTurn` from awaiting the send.
- **Known intentional failure.** Task 3 ends with `tsc` failing on
  `app/api/chat/route.ts` and uses `SKIP_TYPECHECK=1` with the reason in the
  commit message. Task 4 restores it. An executor who sees that error at the
  end of Task 3 has not made a mistake.
