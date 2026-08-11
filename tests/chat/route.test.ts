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
})
