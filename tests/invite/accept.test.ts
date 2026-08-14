// tests/invite/accept.test.ts
//
// S1's accept POST. It records that the promise was read and moves to S2 —
// and, just as importantly, creates nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const emptyHeaders = { get: () => null }
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => emptyHeaders,
}))

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-invite-accept-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  db = undefined
})

afterEach(() => {
  db?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

async function post(token: string): Promise<Response> {
  const { POST } = await import('@/app/api/invite/accept/route')
  return POST(
    new Request(`http://localhost/api/invite/accept?token=${encodeURIComponent(token)}`, {
      method: 'POST',
    }),
  )
}

async function mint(): Promise<string> {
  const { getDb } = await import('@/lib/db/instance')
  const { mintInvite } = await import('@/lib/invite/tokens')
  db = getDb()
  return mintInvite(db, { slug: 'friendone', at: 1000 })
}

function metricEvents(): string[] {
  return (db!.prepare('SELECT event FROM metrics ORDER BY id').all() as { event: string }[]).map(
    (r) => r.event,
  )
}

describe('POST /api/invite/accept', () => {
  it('records promise_accepted and sends the friend to the password step', async () => {
    const token = await mint()
    const response = await post(token)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(
      `/invite/${encodeURIComponent(token)}?step=password`,
    )
    expect(metricEvents()).toContain('promise_accepted')
  })

  it('sends the Location RELATIVE, because the app runs behind a proxy', async () => {
    // lib/http/redirect.ts, and the two step-1b outages that produced it: an
    // absolute Location here names the internal origin and every local check
    // still passes.
    const token = await mint()
    const location = (await post(token)).headers.get('location')!
    expect(location.startsWith('/')).toBe(true)
    expect(location.startsWith('//')).toBe(false)
  })

  it('records the slug and a device class and nothing else', async () => {
    const token = await mint()
    await post(token)

    const row = db!
      .prepare("SELECT account_id, data FROM metrics WHERE event = 'promise_accepted'")
      .get() as { account_id: number | null; data: string }
    // account_id is null because there is no account yet — which is the whole
    // point of this row's position in the funnel.
    expect(row.account_id).toBeNull()
    expect(JSON.parse(row.data)).toEqual({ slug: 'friendone', device_class: 'desktop' })
  })

  it('creates nothing and consumes nothing', async () => {
    const token = await mint()
    await post(token)

    const { readInvite } = await import('@/lib/invite/tokens')
    expect(readInvite(db!, token)).toMatchObject({ kind: 'valid' })
    expect((db!.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0)
    expect((db!.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0)
  })

  it('sends an invalid token back to the page, which shows the dead-link line', async () => {
    // Not a 404 and not an error. A link that expired between opening it and
    // pressing the button is an ordinary thing to have happen, and the friend
    // needs the one sentence that says what to do about it.
    const { getDb } = await import('@/lib/db/instance')
    db = getDb()

    const response = await post('never-minted')

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/invite/never-minted')
    expect(metricEvents()).not.toContain('promise_accepted')
  })
})
