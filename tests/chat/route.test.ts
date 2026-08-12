// tests/chat/route.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'
import { CHAT_EFFORT, CHAT_MODEL } from '@/lib/chat/client'
import { AGENT_PROMPT, loadPrompt } from '@/lib/chat/prompt'

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
type Behaviour = 'ok' | 'refusal' | 'no-credential'
const behaviour: { value: Behaviour } = { value: 'ok' }

vi.mock('@/lib/chat/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/client')>()
  return {
    ...actual,
    anthropicClient: () => {
      if (behaviour.value === 'no-credential') {
        throw new actual.MissingCredentialError()
      }
      return {
        async stream({ onText, onUsage, onServed }: any) {
          onUsage({ input: 5, cache_read: 0, cache_creation: 0 })
          onServed({ model_served: actual.CHAT_MODEL })
          const served = {
            model_served: actual.CHAT_MODEL,
            fallback_fired: false,
          }
          const usage = { input: 5, output: 2, cache_read: 0, cache_creation: 0 }
          if (behaviour.value === 'refusal') {
            // HTTP 200, nothing delivered — see runTurn's empty-reply path.
            return { usage, stop_reason: 'refusal', served }
          }
          onText('hello ')
          onText('friend')
          onUsage({ output: 2 })
          return { usage, stop_reason: 'end_turn', served }
        },
      }
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
    expect(rows[0]!.session_id).toBe(sid)
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
      { done: true },
    ])
  })
})
