// tests/chat/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import { CHAT_EFFORT, CHAT_MODEL } from '@/lib/chat/client'
import { AGENT_PROMPT, loadPrompt } from '@/lib/chat/prompt'
import { CURRENT_STATE_BLOCK } from '@/lib/chat/turn'
import type { Proposal } from '@/lib/spec/author'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) =>
  name === sessionCookieName ? cookieSlot.value : undefined,
)

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}))

// The route builds a real Anthropic client. Replace the module so no test can
// construct one, and so each test can choose what that construction does.
type Behaviour =
  | 'ok'
  | 'refusal'
  | 'no-credential'
  | 'propose-ok'
  | 'propose-fail'
  | 'propose-slow'
  | 'stream-error'
const behaviour: { value: Behaviour } = { value: 'ok' }

/**
 * The system prompt the mocked client actually received on the last call.
 * Captured here (rather than added to `behaviour`) because it's read-only
 * from a test's point of view — set by the stream double, read by
 * `current.md` coverage below.
 */
const lastSystem: { value: string | undefined } = { value: undefined }

vi.mock('@/lib/chat/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/client')>()
  return {
    ...actual,
    anthropicClient: () => {
      if (behaviour.value === 'no-credential') {
        throw new actual.MissingCredentialError()
      }
      return {
        async stream({ system, onText, onUsage, onServed }: any) {
          lastSystem.value = system
          onUsage({ input: 5, cache_read: 0, cache_creation: 0 })
          onServed({ model_served: actual.CHAT_MODEL })
          const served = {
            model_served: actual.CHAT_MODEL,
            fallback_fired: false,
          }
          const usage = { input: 5, output: 2, cache_read: 0, cache_creation: 0 }
          if (behaviour.value === 'stream-error') {
            // What Anthropic returned three times in a row on 2026-08-18.
            // Thrown on every attempt, so the retry in lib/chat/turn.ts is
            // exhausted and the turn really does fail.
            throw new actual.ChatStreamError(
              { kind: 'api_error', status: null, type: 'overloaded_error' },
              'Overloaded',
            )
          }
          if (behaviour.value === 'refusal') {
            // HTTP 200, nothing delivered — see runTurn's empty-reply path.
            return { usage, stop_reason: 'refusal', served, tools_called: [] }
          }
          if (behaviour.value.startsWith('propose-')) {
            // The agent raised its hand: one text chunk, then a tool_use stop
            // with propose_spec in tools_called, which is what makes runTurn
            // call authorSpec at all.
            onText('sure, ')
            onUsage({ output: 2 })
            return { usage, stop_reason: 'tool_use', served, tools_called: ['propose_spec'] }
          }
          onText('hello ')
          onText('friend')
          onUsage({ output: 2 })
          return { usage, stop_reason: 'end_turn', served, tools_called: [] }
        },
        async propose(): Promise<never> {
          throw new Error('unused')
        },
      }
    },
  }
})

// authorSpec is a real dependency of the route (lib/spec/author.ts), not part
// of the chat client. Mocked separately so tests can choose success/failure
// without having to satisfy the real spec schema.
/**
 * Set by the 'propose-slow' double; called by a test to let authoring finish.
 * `onEnter` fires the moment authoring is entered, so a test can act at that
 * exact point instead of racing the stream.
 */
const slowAuthoring: { release?: () => void; onEnter?: () => void } = {}

/** Every signal the route has handed to authorSpec, newest last. */
const authoringSignals: AbortSignal[] = []

/**
 * EXACTLY lib/spec/author.ts's Proposal — `{ id, version, at }` and nothing
 * else. It used to carry a `payload` and a `mockup_html` that the type has
 * never had on this branch; vi.mock's factory return is untyped, so those
 * extra keys typechecked happily and read as evidence a proposal still
 * carries a spec payload. It does not: the card that rendered one is gone
 * (mockup-loop removal), and a fixture wider than the type is a claim about
 * the shape that nothing checks.
 */
const PROPOSAL_FIXTURE: Proposal = {
  id: 7,
  version: 1,
  at: 1_000_001,
}

vi.mock('@/lib/spec/author', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/spec/author')>()
  return {
    ...actual,
    // Takes its input, because one of the things the route is on the hook for
    // is which signal it puts IN that input (see authoringSignals below).
    //
    // Used to also call `input.onStage?.('mockup')` unconditionally, on every
    // path, to prove that the route's suppression of stage lines (the "no
    // proposal or stage lines reach the browser" describe block below) was
    // real rather than an artifact of nothing ever calling onStage in the
    // first place. `AuthorInput.onStage` is gone now, along with the model
    // call it used to announce (mockup-loop removal, plan
    // 2026-08-19-remove-the-mockup-loop, Task 6) — there is nothing left to
    // call, so that assertion now rests on the route emitting no stage line
    // by construction rather than on a suppressed callback.
    authorSpec: async (
      _deps: unknown,
      input: import('@/lib/spec/author').AuthorInput,
    ) => {
      authoringSignals.push(input.signal)
      if (behaviour.value === 'propose-slow') {
        slowAuthoring.onEnter?.()
        // An authoring call that does not return until the test says so —
        // the 47-97 second window the heartbeat exists to keep warm.
        await new Promise<void>((resolve) => {
          slowAuthoring.release = resolve
        })
        return PROPOSAL_FIXTURE
      }
      if (behaviour.value === 'propose-ok') {
        return PROPOSAL_FIXTURE
      }
      if (behaviour.value === 'propose-fail') {
        return undefined
      }
      throw new Error('authorSpec called on a turn that never proposed')
    },
  }
})

let dir: string
let handle: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-chatroute-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  // No test may push to a real topic. A developer with NTFY_TOPIC set in
  // their shell would otherwise buzz their own phone on every suite run.
  delete process.env.NTFY_TOPIC
  vi.resetModules()
  cookieGet.mockClear()
  cookieSlot.value = undefined
  behaviour.value = 'ok'
  handle = undefined
  authoringSignals.length = 0
  slowAuthoring.release = undefined
  slowAuthoring.onEnter = undefined
  lastSystem.value = undefined
  // Most tests want the real repo's users/ tree (signIn's slug 'devone' has a
  // real users/devone/current.md from Task 3). Only the current.md-failure
  // test below overrides this, and cleans up after itself in afterEach.
  delete process.env.USERS_DIR
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  delete process.env.USERS_DIR
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

async function postWithSignal(body: unknown, signal: AbortSignal) {
  const { POST } = await import('@/app/api/chat/route')
  return POST(
    new Request('http://localhost/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      signal,
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

/** Create an admin account and a session for it (no key needed — the admin check runs first). */
async function signInAdmin() {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  const id = await createAccount(handle, {
    slug: 'nico',
    role: 'admin',
    password: 'pw',
  })
  const sid = createSession(handle, id)
  cookieSlot.value = { value: sid }
  return { accountId: id, sid }
}

describe('POST /api/chat — admin', () => {
  it('403s an admin, before anything is written: no transcript row, no metrics row, no model call', async () => {
    // Not 404: unlike the page, there is nothing to hide here — the caller
    // is asking about their own account and already knows their own role.
    const { accountId } = await signInAdmin()
    const res = await post({ body: 'hi' })

    expect(res.status).toBe(403)
    // No streamed body at all — proof the model was never called and the
    // ReadableStream never started.
    expect(await res.text()).toBe('')

    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)

    const rows = handle!.prepare('SELECT event FROM metrics').all()
    expect(rows).toHaveLength(0)
  })

  it('still 403s an admin whose client would throw on missing credentials — pins that the guard runs before the credential path, not merely that it exists', async () => {
    // The test above stubs the client into its default healthy behaviour, so
    // it stays green even if the isAdmin() check were moved below the body
    // parse and chatClient() construction — it would just never exercise
    // that ordering. Stubbing the SAME missing-credential behaviour used by
    // the "no credential" suite below proves the guard runs first: if it
    // didn't, this would write a permanent chat_error row against the
    // admin's own account (metrics is append-only) and answer 503 instead
    // of 403.
    const { accountId } = await signInAdmin()
    behaviour.value = 'no-credential'

    const res = await post({ body: 'hi' })

    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')

    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)

    const rows = handle!.prepare('SELECT event FROM metrics').all()
    expect(rows).toHaveLength(0)
  })
})

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

  it('wires a real alerter, evidenced by the no_topic row on a fresh conversation', async () => {
    // With NTFY_TOPIC deleted in beforeEach, the alerter's no_topic branch is
    // the observable proof that the route built one at all. A route that
    // passed a no-op would produce no row here and every other test in this
    // file would stay green.
    await signIn(true)
    const res = await post({ body: 'hi' })
    await res.text()

    const rows = handle!
      .prepare(
        "SELECT event, data FROM metrics WHERE event LIKE 'alert%' ORDER BY id",
      )
      .all() as { event: string; data: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toBe('alert_failed')
    expect(JSON.parse(rows[0]!.data)).toEqual({
      kind: 'conversation_started',
      reason: 'no_topic',
      status: null,
    })
  })

  it('alerts spec_authored when authoring returns a proposal', async () => {
    // Wired at the ROUTE, not inside authorSpec — the point that already
    // knows the outcome. NTFY_TOPIC stays unset (beforeEach), so this lands
    // as an alert_failed/no_topic row, same proof-of-attempt pattern as the
    // "wires a real alerter" test above: no network reached, but the kind on
    // the row proves the call was made.
    await signIn(false)
    behaviour.value = 'propose-ok'
    const res = await post({ body: 'help me build a dashboard' })
    await res.text()

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event LIKE 'alert%' ORDER BY id")
      .all() as { data: string }[]
    const kinds = rows.map((r) => JSON.parse(r.data).kind)
    expect(kinds).toEqual(['conversation_started', 'spec_authored'])
  })

  it('alerts spec_failed when authoring returns nothing', async () => {
    await signIn(false)
    behaviour.value = 'propose-fail'
    const res = await post({ body: 'help me build a dashboard' })
    await res.text()

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event LIKE 'alert%' ORDER BY id")
      .all() as { data: string }[]
    const kinds = rows.map((r) => JSON.parse(r.data).kind)
    expect(kinds).toEqual(['conversation_started', 'spec_failed'])
  })

  it('alerts neither spec_authored nor spec_failed on a turn that never proposed', async () => {
    // The tool was never called, so there is nothing to alert on — an
    // ordinary turn must not manufacture a build signal.
    await signIn(false)
    behaviour.value = 'ok'
    const res = await post({ body: 'hi' })
    await res.text()

    const rows = handle!
      .prepare("SELECT data FROM metrics WHERE event LIKE 'alert%' ORDER BY id")
      .all() as { data: string }[]
    const kinds = rows.map((r) => JSON.parse(r.data).kind)
    expect(kinds).toEqual(['conversation_started'])
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
      // Between the last chunk and `done`: the exchange is committed, and the
      // browser is told so BEFORE authoring can drop the connection.
      { saved: true },
      { done: true },
    ])
  })

  it('answers an unlocked session too', async () => {
    await signIn(true)
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)

    // An ORDINARY turn, on the real repo's users/devone/current.md (beforeEach
    // deletes USERS_DIR, so this reads the actual committed file, not a
    // fixture). The malformed-file test below only proves the DEGRADED path;
    // nothing before this proved a VALID current.md actually reaches the
    // model at all. lastSystem.value is the same capture that test reads.
    expect(lastSystem.value).toContain(CURRENT_STATE_BLOCK)
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
    expect(rows[0]!.session_id).toBe(sid)
  })

  it('400s on an empty or missing body rather than writing a row', async () => {
    const { accountId } = await signIn(false)
    expect((await post({ body: '   ' })).status).toBe(400)
    expect((await post({})).status).toBe(400)

    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)
  })

  it('no longer accepts a confirmation trigger — an old-shaped POST 400s like any other bodiless one', async () => {
    // This route used to special-case `{trigger: 'confirmation'}`, sending a
    // body-less, product-initiated turn straight into runTurn (no `body`
    // needed). Nothing confirms any more, so that field is just an unknown
    // property now: no `body` string means a 400, exactly like any other
    // request with nothing to say, and no model call is spent and no row is
    // written on it.
    const { accountId } = await signIn(false)
    expect((await post({ trigger: 'confirmation' })).status).toBe(400)

    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)
  })

  it('beats while the authoring call is slow, so the connection never goes silent', async () => {
    // The regression this exists for: between the reply finishing and the
    // proposal coming back, the route used to send nothing for 47-97 seconds,
    // and 5 of 12 authoring attempts died in that window with the client
    // connection torn down (unified-loop ledger D13).
    const { HEARTBEAT_MS } = await import('@/lib/chat/heartbeat')
    await signIn(false)
    behaviour.value = 'propose-slow'

    vi.useFakeTimers()
    try {
      const res = await postWithSignal({ body: 'hi' }, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + 10)
      slowAuthoring.release!()
      const got = await lines(res)

      expect(got.filter((l) => (l as { hb?: number }).hb === 1)).toHaveLength(3)
      // The beats did not displace anything: the real turn still completed —
      // `done` only arrives after runTurn has awaited authoring to the end.
      expect(got.at(-1)).toEqual({ done: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops beating the moment the client goes away', async () => {
    // enqueue() onto a controller whose consumer has disconnected throws, and
    // this one fires on a timer with no request left to fail.
    const { HEARTBEAT_MS } = await import('@/lib/chat/heartbeat')
    await signIn(false)
    behaviour.value = 'propose-slow'

    vi.useFakeTimers()
    try {
      const aborter = new AbortController()
      const res = await postWithSignal({ body: 'hi' }, aborter.signal)
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 10)
      aborter.abort()
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 5)
      slowAuthoring.release!()
      const got = await lines(res)

      expect(got.filter((l) => (l as { hb?: number }).hb === 1)).toHaveLength(1)
      // And the abort still suppresses the terminal line, unchanged.
      expect(got.some((l) => (l as { done?: boolean }).done)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('authors the proposal on a signal the client cannot abort', async () => {
    // The whole point of RunTurnInput.authoringSignal, pinned at the layer that
    // supplies it. Before this the route passed request.signal straight
    // through, so a wifi hop mid-preview destroyed work already in flight.
    await signIn(false)
    behaviour.value = 'propose-slow'

    const entered = new Promise<void>((resolve) => {
      slowAuthoring.onEnter = resolve
    })
    const aborter = new AbortController()
    const res = await postWithSignal({ body: 'hi' }, aborter.signal)

    await entered
    // The friend's connection dies while the preview is being drawn.
    aborter.abort()
    slowAuthoring.release!()
    await lines(res)

    const handed = authoringSignals.at(-1)!
    expect(handed.aborted).toBe(false)
    expect(handed).not.toBe(aborter.signal)
  })

  it('tells the browser the TURN failed, rather than leaving it to guess', async () => {
    // Without this line the panel can only fall back to "interrupted — not
    // saved", which points at the connection. On 2026-08-18 that made three
    // Anthropic Overloaded responses read to a friend as a broken laptop.
    await signIn(false)
    behaviour.value = 'stream-error'

    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)
    const seen = await lines(res)

    expect(seen).toContainEqual({ turn_failed: true })
    // No done, because nothing was saved — and no `saved` either.
    expect(seen.some((l) => (l as { done?: boolean }).done)).toBe(false)
    expect(seen.some((l) => (l as { saved?: boolean }).saved)).toBe(false)
  })

  it('sends NDJSON, not JSON', async () => {
    await signIn(false)
    const res = await post({ body: 'hi' })
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
  })

  it('omits the terminal done line when the turn delivered nothing', async () => {
    // The panel drives its "interrupted — not saved" marker entirely off this
    // line's ABSENCE, and an empty reply saves no assistant row. If a new
    // outcome kind ever slipped past the gate, the screen would claim a reply
    // was saved that the transcript does not contain.
    await signIn(false)
    behaviour.value = 'refusal'

    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)
    expect(await lines(res)).toEqual([])
  })

  it('does not write an assistant row for an empty reply', async () => {
    const { accountId } = await signIn(false)
    behaviour.value = 'refusal'
    await (await post({ body: 'hi' })).text()

    const { readTranscript } = await import('@/lib/db/appendOnly')
    const rows = readTranscript(handle!, accountId)
    expect(rows.map((r) => r.role)).toEqual(['user'])
  })
})

describe('POST /api/chat — no proposal or stage lines reach the browser', () => {
  // The card, the two buttons and the two-stage progress bar are gone from
  // the friend's screen (app/[user]/ChatPanel.tsx). This describe block pins
  // the absence on the WIRE, not just in the panel: a deletion with no test
  // can be silently undone by a future edit that re-adds the enqueue calls
  // without anyone noticing the panel already ignores them.

  it('streams only the reply, saved and done — even on a turn that triggers authoring', async () => {
    // THE CASE THAT MATTERS MOST: authoring really did run (runTurn still
    // calls authorSpec — only the wire messages went), and still nothing
    // about it reaches the browser. A test against an ORDINARY turn (the
    // tool never called) would pass for the wrong reason — there'd be
    // nothing to suppress in the first place.
    await signIn(false)
    behaviour.value = 'propose-ok'

    const res = await post({ body: 'help me build a dashboard' })
    const seen = await lines(res)

    // authorSpec really was invoked for this turn — the absence below is a
    // suppression, not an accident of nothing happening.
    expect(authoringSignals).toHaveLength(1)

    // No 'stage' line, because there is no longer a stage to report:
    // AuthorInput.onStage and the model call it used to announce are gone
    // (mockup-loop removal, plan 2026-08-19-remove-the-mockup-loop, Task 6).
    // This assertion used to prove the route SUPPRESSED a callback the mocked
    // authorSpec called unconditionally; now it proves the same absence by
    // construction — nothing on either side has a stage left to emit.
    expect(seen.map((l) => Object.keys(l as object)).flat()).toEqual(['t', 'saved', 'done'])
    expect(seen.some((l) => 'authoring' in (l as object))).toBe(false)
    expect(seen.some((l) => 'stage' in (l as object))).toBe(false)
    expect(seen.some((l) => 'proposal' in (l as object))).toBe(false)
    expect(seen.some((l) => 'proposal_error' in (l as object))).toBe(false)
  })

  it('emits neither authoring nor proposal lines on an ordinary turn', async () => {
    await signIn(false)
    behaviour.value = 'ok'

    const res = await post({ body: 'hi' })
    const seen = await lines(res)
    expect(
      seen.some((l) => 'authoring' in (l as object) || 'proposal' in (l as object) || 'proposal_error' in (l as object)),
    ).toBe(false)
  })

  it('still emits done when authoring fails — a completed chat turn is still a completed chat turn', async () => {
    // The assistant row for it exists, and the friend really did receive
    // that reply; a failed proposal must not suppress it. There is no more
    // `proposal_error` line to check for — nothing on the friend's screen
    // ever reported that failure to begin with.
    await signIn(false)
    behaviour.value = 'propose-fail'

    const res = await post({ body: 'help me build a dashboard' })
    const seen = await lines(res)
    expect(seen).toContainEqual({ done: true })
    expect(seen.some((l) => 'authoring' in (l as object))).toBe(false)
    expect(seen.some((l) => 'proposal' in (l as object))).toBe(false)
    expect(seen.some((l) => 'proposal_error' in (l as object))).toBe(false)
  })
})

describe('POST /api/chat — no credential', () => {
  it('503s and records the outage in the metrics log', async () => {
    // A total chat outage used to surface as a 200 with an errored body and
    // ZERO rows in either sacred table — invisible in the log this project
    // treats as ground truth.
    const { accountId } = await signIn(false)
    behaviour.value = 'no-credential'

    const res = await post({ body: 'hi' })
    expect(res.status).toBe(503)

    const rows = handle!
      .prepare('SELECT event, data FROM metrics ORDER BY id')
      .all() as { event: string; data: string | null }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.event).toBe('chat_error')
    expect(JSON.parse(rows[0]!.data!)).toMatchObject({ kind: 'no_api_key' })

    // And nothing was written to the transcript for a turn that never ran.
    const { readTranscript } = await import('@/lib/db/appendOnly')
    expect(readTranscript(handle!, accountId)).toHaveLength(0)
  })

  it('records a no_api_key chat_error carrying the full documented shape', async () => {
    // Residual 8: this row used to be a second, narrower chat_error shape.
    // Anyone grouping chat_error by prompt_sha silently dropped it.
    //
    // Asserts every field's VALUE, not merely its presence: a presence-only
    // check would pass for a flipped fallback_fired, swapped status/type, or
    // a non-zero placeholder counter — exactly the failure mode this task
    // exists to close for the previous (narrower) shape. metrics is
    // append-only, so a defect like that would ship permanently.
    await signIn(false)
    behaviour.value = 'no-credential'
    await post({ body: 'hi' })

    const row = handle!
      .prepare("SELECT data FROM metrics WHERE event = 'chat_error' ORDER BY id DESC LIMIT 1")
      .get() as { data: string }
    const data = JSON.parse(row.data) as Record<string, unknown>
    expect(data).toEqual({
      input: 0,
      output: 0,
      cache_read: 0,
      cache_creation: 0,
      model: CHAT_MODEL,
      effort: CHAT_EFFORT,
      // The agent prompt's hash specifically, not merely hex-shaped.
      prompt_sha: loadPrompt(AGENT_PROMPT).sha,
      context: 'interview',
      model_served: CHAT_MODEL,
      fallback_fired: false,
      kind: 'no_api_key',
      status: null,
      type: null,
      delivered_chars: 0,
    })
  })

  it('retries construction on the next request rather than caching the failure', async () => {
    await signIn(false)
    behaviour.value = 'no-credential'
    expect((await post({ body: 'hi' })).status).toBe(503)

    behaviour.value = 'ok'
    const res = await post({ body: 'hi' })
    expect(res.status).toBe(200)
    expect(await lines(res)).toEqual([
      { t: 'hello ' },
      { t: 'friend' },
      // Between the last chunk and `done`: the exchange is committed, and the
      // browser is told so BEFORE authoring can drop the connection.
      { saved: true },
      { done: true },
    ])
  })
})

describe('POST /api/chat — a current.md that exists but does not parse', () => {
  // Missing "## Deliberately not included" on purpose — this is what makes
  // parseCurrentState (and therefore readCurrentState) throw.
  const MALFORMED = `---
slug: devone
version: 4
---

## What this is for
A dashboard whose builder left a section out.

## Screens
One screen.

## Panels
A panel.

## What can be entered
Nothing.
`

  it('degrades to no state block, rather than taking the request down, and records the failure', async () => {
    // A real file on disk, under a USERS_DIR this test owns — not the real
    // repo's users/devone/, which has a valid current.md from Task 3.
    const usersDir = join(dir, 'users')
    mkdirSync(join(usersDir, 'devone'), { recursive: true })
    writeFileSync(join(usersDir, 'devone', 'current.md'), MALFORMED)
    process.env.USERS_DIR = usersDir

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await signIn(false)
    const res = await post({ body: 'hi' })

    // THE REGRESSION THIS COVERS: readCurrentState throws on an unparseable
    // file, and that used to sit uncaught inside ReadableStream.start() —
    // no reply, no assistant row, no chat_error metric, on a surface whose
    // whole design promise is that it keeps working when other things fail.
    expect(res.status).toBe(200)
    expect(await lines(res)).toEqual([
      { t: 'hello ' },
      { t: 'friend' },
      { saved: true },
      { done: true },
    ])

    // The agent talked as if no dashboard were described — the same
    // degradation an ABSENT current.md produces, not a labelled-but-empty
    // block.
    expect(lastSystem.value).not.toContain(CURRENT_STATE_BLOCK)

    // Not silent: logDbFailure's one stderr line, so an operator can tell a
    // malformed current.md apart from an absent one.
    expect(
      errorSpy.mock.calls.some(([line]) =>
        String(line).includes('current_state_failed'),
      ),
    ).toBe(true)
    errorSpy.mockRestore()
  })
})
