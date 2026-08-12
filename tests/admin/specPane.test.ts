// tests/admin/specPane.test.ts
//
// Follows tests/admin/transcriptPane.test.ts's module-mocking setup exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import type { PlatformDb } from '@/lib/db/platform'
import type { SpecPayload } from '@/lib/spec/schema'

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

// Every field loudly fake per CLAUDE.md's synthetic-data rule, even though
// this fixture never touches seed.py — it's still data a human could read.
const SPEC_V1: SpecPayload = {
  title: 'COFFEE PALACE TEST v1',
  summary: 'Round one summary TEST.',
  background: 'Round one background TEST.',
  panels: [
    {
      name: 'Coffee spend TEST',
      shows: 'Daily coffee spend TEST',
      why: 'Track the habit TEST',
      source: 'plaid',
    },
  ],
  manual_logging: [],
  open_questions: [],
}

const SPEC_V2: SpecPayload = {
  title: 'COFFEE PALACE TEST v2',
  summary: 'Round two summary TEST.',
  background: 'Round two background TEST.',
  panels: [
    {
      name: 'Coffee spend TEST',
      shows: 'Weekly coffee spend TEST',
      why: 'Track the habit TEST',
      source: 'plaid',
    },
  ],
  manual_logging: [],
  open_questions: ['Which account holds the coffee budget TEST?'],
}

const SPEC_V3: SpecPayload = {
  title: 'COFFEE PALACE TEST v3',
  summary: 'So mornings stop being a surprise.',
  background: 'Round three background TEST.',
  panels: [
    {
      name: 'Coffee spend TEST',
      shows: 'Monthly coffee spend TEST',
      why: 'Track the habit TEST',
      source: 'plaid',
    },
  ],
  manual_logging: ['Cash coffee runs TEST'],
  open_questions: ['Is a Monzo pot reachable?'],
}

// Missing every required field except title — parseSpecPayload throws
// SpecShapeError on this, which is exactly the append-only-corrupt-row
// hazard app/[user]/page.tsx already handles (Task 3 finding).
const CORRUPT_PAYLOAD = { title: 'CORRUPT TEST — missing fields' }

describe('the spec pane', () => {
  let dir: string
  let handle: PlatformDb | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stairwell-specpane-'))
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

  async function render(
    user: string,
    opts: { as?: 'user' | 'admin'; corrupt?: boolean } = {},
  ): Promise<string> {
    const role = opts.as ?? 'admin'
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    const { insertSpec, confirmSpec } = await import('@/lib/db/specs')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()

    const targetId = await createAccount(handle, { slug: user, role: 'user', password: 'pw' })

    if (user === 'devone') {
      const v1 = insertSpec(handle, {
        accountId: targetId,
        conversationId: 'conv-1',
        promptSha: 'sha123456789',
        payload: SPEC_V1,
        mockupHtml: '<!doctype html><p>v1 preview TEST</p>',
        at: 1_000,
      })
      // Confirmed early, then the friend kept iterating — a realistic shape,
      // and it proves "Confirmed" renders without requiring it be the
      // newest row.
      confirmSpec(handle, { specId: v1, accountId: targetId, at: 1_500 })
      insertSpec(handle, {
        accountId: targetId,
        conversationId: 'conv-1',
        promptSha: 'sha123456789',
        payload: SPEC_V2,
        mockupHtml: '<!doctype html><p>v2 preview TEST</p>',
        at: 2_000,
      })
      insertSpec(handle, {
        accountId: targetId,
        conversationId: 'conv-1',
        promptSha: 'sha123456789',
        payload: SPEC_V3,
        mockupHtml: '<!doctype html><p>v3 preview TEST</p>',
        at: 3_000,
      })
      if (opts.corrupt) {
        insertSpec(handle, {
          accountId: targetId,
          conversationId: 'conv-1',
          promptSha: 'sha123456789',
          payload: CORRUPT_PAYLOAD,
          mockupHtml: '<!doctype html><p>v4 preview TEST</p>',
          at: 4_000,
        })
      }
    }

    const viewerId =
      role === 'admin'
        ? await createAccount(handle, { slug: 'nico', role: 'admin', password: 'pw' })
        : targetId
    cookieSlot.value = { value: createSession(handle, viewerId) }

    const { default: Pane } = await import('@/app/admin/[user]/page')
    const element = await Pane({ params: Promise.resolve({ user }) })
    return JSON.stringify(element)
  }

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

  it('degrades a corrupt stored payload instead of 500ing the whole pane', async () => {
    // specs is append-only: this row can never be deleted to make the
    // problem go away, so the pane must survive it forever. Anything other
    // than the expected SpecShapeError must still escape — this test only
    // proves the expected one doesn't crash the render.
    const json = await render('devone', { corrupt: true })
    expect(notFoundMock).not.toHaveBeenCalled()
    // The corrupt row (v4, newest) shows as unreadable...
    expect(json.indexOf('v4')).toBeLessThan(json.indexOf('Unreadable'))
    // ...while the valid rows around it still render in full.
    expect(json).toContain('So mornings stop being a surprise.')
    expect(json).toContain('Confirmed')
  })
})
