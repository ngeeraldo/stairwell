// tests/admin/specPane.test.ts
//
// Follows tests/admin/transcriptPane.test.ts's module-mocking setup exactly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformDb } from '@/lib/db/platform'
import type { LegacySpecPayload } from '@/lib/spec/legacy'
import type { Panel, SpecVersion } from '@/lib/spec/schema'

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
const SPEC_V1: LegacySpecPayload = {
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

const SPEC_V2: LegacySpecPayload = {
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

const SPEC_V3: LegacySpecPayload = {
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

// Missing every required field except title — parseLegacySpecPayload throws
// SpecShapeError on this, which is exactly the append-only-corrupt-row
// hazard app/[user]/page.tsx already handles (Task 3 finding).
const CORRUPT_PAYLOAD = { title: 'CORRUPT TEST — missing fields' }

function walkedTodayPanel(): Panel {
  return {
    id: 'walked_today',
    title: 'Walked today? TEST',
    intent: 'Did I walk the dog TEST?',
    display: 'Yes/no with a tap TEST.',
    context_of_use: null,
    values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day TEST.' }],
    entry: null,
  }
}

function streakPanel(): Panel {
  return {
    id: 'streak',
    title: 'Current streak TEST',
    intent: 'Keep the run going TEST.',
    display: 'A day count TEST.',
    context_of_use: null,
    values: [
      {
        kind: 'derived',
        id: 'streak_days',
        description: 'Consecutive walked days TEST.',
        inputs: ['walk_flag'],
      },
    ],
    entry: null,
  }
}

// The first structured version: no predecessor at all, so nothing to diff
// against.
const CURRENT_V1: SpecVersion = {
  title: 'COFFEE PALACE TEST current v1',
  summary: 'A one-tap tracker TEST.',
  background: 'Pivoted from weather TEST.',
  change_summary: 'The first whole-surface version TEST.',
  based_on_version: null,
  ops: null,
  screens: [{ id: 'today', title: 'Today TEST', order: 1, panels: [walkedTodayPanel()] }],
  data_requirements: [
    { table: 'walks', purpose: 'One row per walked day TEST.', status: 'new' },
  ],
  open_questions: ['Does the streak reset at midnight TEST?'],
}

// Built on v1, adding exactly one panel — so the rendered diff has a single,
// nameable added id rather than a wall of churn.
const CURRENT_V2: SpecVersion = {
  ...CURRENT_V1,
  title: 'COFFEE PALACE TEST current v2',
  change_summary: 'Added a streak panel TEST.',
  based_on_version: 1,
  screens: [
    {
      id: 'today',
      title: 'Today TEST',
      order: 1,
      panels: [walkedTodayPanel(), streakPanel()],
    },
  ],
}

// `screens` is present, so readStoredSpec commits to the CURRENT arm and
// parseSpecVersion throws — a corrupt current row, not a legacy one.
const CORRUPT_CURRENT = { title: 'CORRUPT CURRENT TEST', screens: [{ id: 'nope' }] }

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
    opts: {
      as?: 'user' | 'admin'
      corrupt?: boolean
      /** Which current-shape rows 'devthree' gets. Only that slug has them. */
      current?: 'v1' | 'v1+v2' | 'v1+corrupt' | 'legacy+v2'
    } = {},
  ): Promise<string> {
    const role = opts.as ?? 'admin'
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    const { insertSpec } = await import('@/lib/db/specs')
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
      // newest row. Nothing in the application writes spec_confirmations any
      // more (lib/db/specs.ts's confirmSpec is gone), but the pane still
      // renders a HISTORICAL confirmation — inserted directly.
      handle
        .prepare('INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)')
        .run(v1, targetId, 1_500)
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

    if (user === 'devthree') {
      insertSpec(handle, {
        accountId: targetId,
        conversationId: 'conv-3',
        promptSha: 'sha123456789',
        // The real migration shape: a friend whose v1 predates the unified
        // loop, whose v2 is the first current-shape proposal on top of it.
        payload: opts.current === 'legacy+v2' ? SPEC_V1 : CURRENT_V1,
        mockupHtml: '<!doctype html><p>current v1 preview TEST</p>',
        at: 1_000,
      })
      if (opts.current === 'v1+v2' || opts.current === 'legacy+v2') {
        insertSpec(handle, {
          accountId: targetId,
          conversationId: 'conv-3',
          promptSha: 'sha123456789',
          payload: CURRENT_V2,
          mockupHtml: '<!doctype html><p>current v2 preview TEST</p>',
          at: 2_000,
        })
      }
      if (opts.current === 'v1+corrupt') {
        insertSpec(handle, {
          accountId: targetId,
          conversationId: 'conv-3',
          promptSha: 'sha123456789',
          payload: CORRUPT_CURRENT,
          mockupHtml: '<!doctype html><p>corrupt current preview TEST</p>',
          at: 2_000,
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
    // A REAL render pass, not JSON.stringify of the element tree. The pane
    // renders through helper functions now, and JSON.stringify leaves a
    // function component unexpanded — so it serialises the PROPS handed to
    // that component and none of its output. Assertions against that would
    // pass for a helper that rendered nothing at all. Safe here because the
    // pane and its helpers use no hooks: there is no dispatcher or DOM
    // requirement SSR cannot satisfy.
    return renderToStaticMarkup(element)
  }

  it('lists every proposal in CONVERSATION order, marking the confirmed one', async () => {
    // A friend stuck on round three is visible as a friend stuck on round
    // three, not as silence.
    //
    // The order flipped with the timeline change (onboarding ledger D5): the
    // proposals are merged into the transcript now, so they read
    // oldest-at-top like the conversation they belong to, and the pane scrolls
    // to the newest on mount. "Newest first" was right for a standalone list
    // and would now put a proposal above the message that asked for it.
    const html = await render('devone')
    expect(html.indexOf('v1')).toBeLessThan(html.indexOf('v3'))
    expect(html).toContain('Confirmed')
  })

  it('puts open questions ABOVE the spec body', async () => {
    // open_questions is not documentation: it is the agent saying it refused
    // to promise something and handed the question over.
    const html = await render('devone')
    expect(html.indexOf('Is a Monzo pot reachable?')).toBeLessThan(
      html.indexOf('So mornings stop being a surprise.'),
    )
  })

  it('renders the mockup with an empty sandbox', async () => {
    const html = await render('devone')
    expect(html).toContain('sandbox=""')
    expect(html).not.toContain('allow-scripts')
  })

  it('says so plainly when there are no proposals yet', async () => {
    // Two different absences now, and they are worth distinguishing: an empty
    // conversation, and a conversation with no spec at all. The Spec tab
    // shows the CURRENT version (the newest spec — nothing confirms any
    // more), so it is the second one that decides what that tab says.
    const html = await render('devtwo')
    expect(html).toContain('No spec yet.')
    expect(html).toContain('No mockup yet.')
  })

  it('still 404s a non-admin session', async () => {
    await expect(render('devone', { as: 'user' })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('marks a legacy row as one, so nobody reads a frozen shape as a current spec', async () => {
    // A pre-unification row has no change_summary, no screens and no stable
    // ids — a reader who mistakes one for a current spec would go looking for
    // a diff that structurally cannot exist. `specs` rejects UPDATE, so these
    // rows are permanent and so is the need for this badge.
    const html = await render('devone')
    expect(html).toContain('Pre-unification spec (legacy shape)')
  })

  it('renders a current-shape row down to its screens, panels and value sourcing', async () => {
    const html = await render('devthree')
    expect(html).toContain('Today TEST')
    expect(html).toContain('Walked today? TEST')
    expect(html).toContain('Yes/no with a tap TEST.')
    // Where each value comes from is the point of the new shape: `entered`
    // means a human types it, and that is what decides whether a panel needs
    // an entry widget built for it.
    expect(html).toContain('walk_flag')
    expect(html).toContain('entered')
    // And it is NOT badged as legacy.
    expect(html).not.toContain('Pre-unification spec (legacy shape)')
  })

  it('never renders 1970 for a current spec that was never confirmed', async () => {
    // currentSpec (lib/db/specs.ts) now returns the newest spec whether or
    // not it was ever confirmed, so confirmed_at can genuinely be null. A
    // bare `new Date(current.confirmed_at!)` renders the epoch here
    // silently, in both the version label and the two renderer calls this
    // pane makes. NOT built on this file's shared `render()`/devthree
    // fixture, which uses small relative-order integers (`at: 1_000`) for
    // every spec — those are themselves indistinguishable from the
    // epoch-zero fallback this test exists to rule out (`new Date(1000)` is
    // ALSO in 1970). A real-scale timestamp is what makes "not 1970" mean
    // anything. Same assertion form as tests/admin/portal.test.tsx's
    // "says 'no activity yet' rather than showing 1970".
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
    const { insertSpec } = await import('@/lib/db/specs')
    sessionCookieName = SESSION_COOKIE
    handle = getDb()

    const targetId = await createAccount(handle, {
      slug: 'neverconfirmed',
      role: 'user',
      password: 'pw',
    })
    const REALISTIC_AT = Date.UTC(2026, 7, 19)
    insertSpec(handle, {
      accountId: targetId,
      conversationId: 'conv-1',
      promptSha: 'sha123456789',
      payload: SPEC_V1,
      mockupHtml: '<!doctype html><p>preview TEST</p>',
      at: REALISTIC_AT,
    })
    // No spec_confirmations row at all — that is the point.

    const adminId = await createAccount(handle, { slug: 'nico', role: 'admin', password: 'pw' })
    cookieSlot.value = { value: createSession(handle, adminId) }

    const { default: Pane } = await import('@/app/admin/[user]/page')
    const element = await Pane({ params: Promise.resolve({ user: 'neverconfirmed' }) })
    const html = renderToStaticMarkup(element)
    expect(html).not.toContain('1970')
  })

  it('renders the diff against the version a current row was based on', async () => {
    // The structural diff is the canonical record of what a friend asked
    // for — see lib/spec/diff.ts. The admin pane is where it gets read.
    const html = await render('devthree', { current: 'v1+v2' })
    expect(html).toContain('Changes from v1')
    expect(html).toContain('Panels added: streak')
  })

  it('says so plainly when the base version is a legacy row, rather than inventing a diff', async () => {
    // lib/spec/diff.ts compares by stable id, and a pre-unification row has
    // none anywhere in it. There is no diff to compute — only a fact to
    // state.
    const html = await render('devthree', { current: 'legacy+v2' })
    expect(html).toContain('Changes from v1')
    expect(html).toContain('first structured version')
    expect(html).not.toContain('Panels added')
  })

  it('renders a first structured version without a diff at all', async () => {
    // based_on_version null means there is no predecessor. Diffing against
    // nothing would list every screen and panel as "added", which reads as a
    // change the friend never asked for.
    const html = await render('devthree', { current: 'v1' })
    expect(html).toContain('COFFEE PALACE TEST current v1')
    expect(html).not.toContain('Changes from v')
  })

  it('degrades a corrupt CURRENT row to unreadable, leaving the rest of the pane intact', async () => {
    // Same append-only hazard as the legacy corrupt row below, on the other
    // arm of the union: `screens` is present so readStoredSpec commits to the
    // current shape, and the validation failure must not 500 the pane.
    const html = await render('devthree', { current: 'v1+corrupt' })
    expect(notFoundMock).not.toHaveBeenCalled()
    expect(html.indexOf('v2')).toBeLessThan(html.indexOf('Unreadable'))
    expect(html).toContain('COFFEE PALACE TEST current v1')
  })

  it('degrades a corrupt stored payload instead of 500ing the whole pane', async () => {
    // specs is append-only: this row can never be deleted to make the
    // problem go away, so the pane must survive it forever. Anything other
    // than the expected SpecShapeError must still escape — this test only
    // proves the expected one doesn't crash the render.
    const html = await render('devone', { corrupt: true })
    expect(notFoundMock).not.toHaveBeenCalled()
    // The corrupt row (v4, newest) shows as unreadable...
    expect(html.indexOf('v4')).toBeLessThan(html.indexOf('Unreadable'))
    // ...while the valid rows around it still render in full.
    expect(html).toContain('So mornings stop being a surprise.')
    expect(html).toContain('Confirmed')
  })
})
