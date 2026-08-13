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
    expect(groups[1]!.rows.map((r) => r.body)).toEqual(['first ever', 'still first'])
  })

  it('orders rows inside a conversation oldest-first', () => {
    write('c', 'earlier', 1_000)
    write('c', 'later', 2_000)
    expect(readConversations(db, 1)[0]!.rows.map((r) => r.body)).toEqual([
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

  it("404s for the admin's own slug — /nico 404s at the user-space page too, and nothing should render it here either", async () => {
    // The lookup query filters AND role = 'user'. Without that filter, this
    // would resolve the admin's own account and render its (empty)
    // transcript — the only thing standing between "no route serves the
    // admin's own conversations" and one quietly doing so now that /nico
    // 404s at app/[user]/page.tsx.
    await setup('admin')
    const { default: Pane } = await import('@/app/admin/[user]/page')
    await expect(
      Pane({ params: Promise.resolve({ user: 'nico' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
