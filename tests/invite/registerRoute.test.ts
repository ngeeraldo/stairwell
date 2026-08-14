// tests/invite/registerRoute.test.ts
//
// The route around registerFromInvite: the confirm field, the metrics, the
// cookie, and where each failure sends the friend.
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

const PASSWORD = 'a short sentence works'

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-register-route-'))
  process.env.PLATFORM_DB = join(dir, 'platform.db')
  process.env.USERS_DIR = join(dir, 'users')
  vi.resetModules()
  db = undefined
})

afterEach(() => {
  db?.close()
  delete process.env.PLATFORM_DB
  delete process.env.USERS_DIR
  rmSync(dir, { recursive: true, force: true })
})

async function mint(): Promise<string> {
  const { getDb } = await import('@/lib/db/instance')
  const { mintInvite } = await import('@/lib/invite/tokens')
  db = getDb()
  return mintInvite(db, { slug: 'friendone', at: 1000 })
}

// No return annotation: the handler returns a NextResponse (relativeRedirect
// builds one), and typing it as the DOM `Response` would hide `.cookies` —
// which is the thing this file most needs to assert on.
async function post(token: string, fields: Record<string, string>) {
  const { POST } = await import('@/app/api/invite/register/route')
  return POST(
    new Request(`http://localhost/api/invite/register?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: new URLSearchParams(fields),
    }),
  )
}

function metricRows(): { event: string; data: string | null; account_id: number | null }[] {
  return db!.prepare('SELECT event, data, account_id FROM metrics ORDER BY id').all() as {
    event: string
    data: string | null
    account_id: number | null
  }[]
}

describe('POST /api/invite/register', () => {
  it('lands the friend in their own space with a session cookie', async () => {
    const token = await mint()
    const response = await post(token, { password: PASSWORD, confirm: PASSWORD })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/friendone')
    const cookie = response.cookies.get('stairwell_session')
    expect(cookie?.value).toBeTruthy()
    expect(cookie?.httpOnly).toBe(true)
  })

  it('writes password_set and db_created, each with a slug and a device class', async () => {
    const token = await mint()
    await post(token, { password: PASSWORD, confirm: PASSWORD })

    const events = metricRows().map((r) => r.event)
    expect(events).toContain('password_set')
    expect(events).toContain('db_created')
    for (const row of metricRows()) {
      expect(JSON.parse(row.data!)).toEqual({ slug: 'friendone', device_class: 'desktop' })
    }
  })

  it('sends a mismatch back to the form, creating nothing', async () => {
    const token = await mint()
    const response = await post(token, { password: PASSWORD, confirm: 'something else' })

    expect(response.headers.get('location')).toContain('step=password&error=mismatch')
    expect((db!.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0)
    const { readInvite } = await import('@/lib/invite/tokens')
    expect(readInvite(db!, token)).toMatchObject({ kind: 'valid' })
  })

  it('sends a short password back to the form even when both fields agree', async () => {
    // The client disables the button on the same rule. This is the gate.
    const token = await mint()
    const response = await post(token, { password: 'nine char', confirm: 'nine char' })

    expect(response.headers.get('location')).toContain('error=short')
    expect((db!.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n).toBe(0)
  })

  it('sends a spent link to the DEAD-LINK page, not back to the form', async () => {
    // Back to the form would be cruel: the form cannot succeed, and they would
    // keep typing passwords into it. The dead-link line tells them what to do.
    const token = await mint()
    await post(token, { password: PASSWORD, confirm: PASSWORD })

    const second = await post(token, { password: PASSWORD, confirm: PASSWORD })
    expect(second.headers.get('location')).toBe(`/invite/${encodeURIComponent(token)}`)
    expect(second.headers.get('location')).not.toContain('step=password')
  })

  it('keeps every Location relative, because the app runs behind a proxy', async () => {
    const token = await mint()
    for (const response of [
      await post(token, { password: PASSWORD, confirm: 'nope' }),
      await post(token, { password: PASSWORD, confirm: PASSWORD }),
    ]) {
      const location = response.headers.get('location')!
      expect(location.startsWith('/')).toBe(true)
      expect(location.startsWith('//')).toBe(false)
    }
  })
})
