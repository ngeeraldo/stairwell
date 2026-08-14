// tests/admin/portal.test.tsx
//
// What the onboarding build added to the admin portal: a user list ordered by
// activity, three tabs, proposal cards inline in the conversation, the spec as
// real markdown, and a read-only mockup route.
//
// The existing tests/admin/{specPane,transcriptPane}.test.ts still cover the
// spec bodies and the authorization rules; this file covers what is new.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'stairwell_session' ? cookieSlot.value : undefined),
  }),
  headers: async () => ({ get: () => null }),
}))

const notFoundMock = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND')
})
vi.mock('next/navigation', () => ({ notFound: () => notFoundMock() }))

const MOCKUP = '<!doctype html><html><body>COFFEE PALACE TEST</body></html>'

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-adminportal-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  notFoundMock.mockClear()
  cookieSlot.value = undefined
  db = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  db?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

/** An admin session, plus whatever the caller asks for. */
async function seed(): Promise<{ devone: number; devtwo: number }> {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession } = await import('@/lib/session/store')
  db = getDb()

  const devone = await createAccount(db, {
    slug: 'devone',
    role: 'user',
    password: 'TEST-NOT-A-REAL-PASSWORD',
  })
  const devtwo = await createAccount(db, {
    slug: 'devtwo',
    role: 'user',
    password: 'TEST-NOT-A-REAL-PASSWORD',
  })
  const nico = await createAccount(db, {
    slug: 'nico',
    role: 'admin',
    password: 'TEST-NOT-A-REAL-PASSWORD',
  })
  cookieSlot.value = { value: createSession(db, nico) }
  return { devone, devtwo }
}

async function renderIndex(): Promise<string> {
  const { default: AdminPortal } = await import('@/app/admin/page')
  return renderToStaticMarkup((await AdminPortal()) as React.ReactElement)
}

async function renderUser(slug: string): Promise<string> {
  const { default: Pane } = await import('@/app/admin/[user]/page')
  return renderToStaticMarkup(
    (await Pane({ params: Promise.resolve({ user: slug }) })) as React.ReactElement,
  )
}

describe('the user list', () => {
  it('orders by last activity, newest first', async () => {
    // The question Nico opens this to answer is "who has been using it". An
    // alphabetical list answers a question nobody has.
    const { devone, devtwo } = await seed()
    const { appendTranscript } = await import('@/lib/db/appendOnly')
    appendTranscript(db!, {
      accountId: devone,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'sha',
      role: 'user',
      body: 'older',
      at: 1000,
    })
    appendTranscript(db!, {
      accountId: devtwo,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'sha',
      role: 'user',
      body: 'newer',
      at: 9000,
    })

    const html = await renderIndex()
    expect(html.indexOf('devtwo')).toBeLessThan(html.indexOf('devone'))
  })

  it('counts a dashboard open, not only a message', async () => {
    // A friend who opens their dashboard every morning and never types is the
    // most engaged user this pilot could have. Reading transcripts alone would
    // show them as silent.
    const { devone } = await seed()
    const { appendMetric } = await import('@/lib/db/appendOnly')
    appendMetric(db!, {
      accountId: devone,
      event: 'dashboard_open',
      data: { slug: 'devone', source: 'real', device_class: 'phone' },
      at: 5000,
    })

    expect(await renderIndex()).toContain(new Date(5000).toISOString())
  })

  it('says "no activity yet" rather than showing 1970', async () => {
    await seed()
    const html = await renderIndex()
    expect(html).toContain('no activity yet')
    expect(html).not.toContain('1970')
  })

  it('404s a non-admin', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    db = getDb()
    const id = await createAccount(db, {
      slug: 'devone',
      role: 'user',
      password: 'TEST-NOT-A-REAL-PASSWORD',
    })
    cookieSlot.value = { value: createSession(db, id) }

    await expect(renderIndex()).rejects.toThrow('NEXT_NOT_FOUND')
  })
})

describe('the transcript tab', () => {
  it('renders a proposal card INLINE, between the turns it happened between', async () => {
    // onboarding-ux-spec.md: "a transcript with a hole where the proposal
    // happened is a broken transcript." A proposal collected at the bottom is
    // the same hole, moved.
    const { devone } = await seed()
    const { appendTranscript } = await import('@/lib/db/appendOnly')
    const { insertSpec, confirmSpec } = await import('@/lib/db/specs')

    appendTranscript(db!, {
      accountId: devone,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'sha',
      role: 'user',
      body: 'BEFORE THE CARD',
      at: 100,
    })
    const specId = insertSpec(db!, {
      accountId: devone,
      conversationId: 'c',
      promptSha: 'sha',
      payload: { title: 'x' },
      mockupHtml: MOCKUP,
      at: 200,
    })
    appendTranscript(db!, {
      accountId: devone,
      sessionId: 's',
      conversationId: 'c',
      promptSha: 'sha',
      role: 'user',
      body: 'AFTER THE CARD',
      at: 300,
    })
    confirmSpec(db!, { specId, accountId: devone, at: 400 })

    const html = await renderUser('devone')
    const card = html.indexOf('data-spec-version="1"')
    expect(html.indexOf('BEFORE THE CARD')).toBeLessThan(card)
    expect(card).toBeLessThan(html.indexOf('AFTER THE CARD'))
    // And the confirmation as its own event, after the turn it followed.
    expect(html.indexOf('AFTER THE CARD')).toBeLessThan(html.indexOf('data-confirmation="1"'))
  })

  it('distinguishes user turns from agent turns', async () => {
    const { devone } = await seed()
    const { appendTranscript } = await import('@/lib/db/appendOnly')
    for (const [role, body, at] of [
      ['user', 'A QUESTION', 100],
      ['assistant', 'AN ANSWER', 200],
    ] as const) {
      appendTranscript(db!, {
        accountId: devone,
        sessionId: 's',
        conversationId: 'c',
        promptSha: 'sha123456789',
        role,
        body,
        at,
      })
    }

    const html = await renderUser('devone')
    expect(html).toContain('data-role="user"')
    expect(html).toContain('data-role="assistant"')
    // Which prompt produced the reply — how Nico tells an agent-v2 answer from
    // an agent-v3 one while reading a transcript that spans both.
    expect(html).toContain('sha123456789')
  })
})

describe('the spec tab', () => {
  it('renders REAL markdown, not a wall of preformatted text', async () => {
    const { devone } = await seed()
    const { insertSpec, confirmSpec } = await import('@/lib/db/specs')
    const specId = insertSpec(db!, {
      accountId: devone,
      conversationId: 'c',
      promptSha: 'sha',
      payload: {
        title: 'COFFEE PALACE TEST tracker',
        summary: 'A one-tap tracker.',
        background: 'Walks the dog TEST.',
        panels: [
          { name: 'Streak', shows: 'Days in a row', why: 'Momentum', source: 'manual' },
        ],
        manual_logging: ['the walk'],
        open_questions: [],
      },
      mockupHtml: MOCKUP,
      at: 100,
    })
    confirmSpec(db!, { specId, accountId: devone, at: 200 })

    const html = await renderUser('devone')
    // A heading that is a heading. renderLegacyMarkdown emits '# <title>', so
    // an <h1> in the output is the proof that markdown was parsed rather than
    // dumped.
    expect(html).toMatch(/<h1[^>]*>COFFEE PALACE TEST tracker<\/h1>/)
    expect(html).not.toContain('# COFFEE PALACE TEST tracker')
    expect(html).toContain('v1 — confirmed')
    // The "do not hand-edit" banner is addressed to whoever opens spec.md in
    // an editor, not to whoever is reading this pane. react-markdown does not
    // render raw HTML, so it arrived here as a visible paragraph of body copy
    // until it was stripped — found by the screenshot review.
    expect(html).not.toContain('Do not hand-edit')
  })

  it('does not render raw HTML embedded in a payload', async () => {
    // The default react-markdown behaviour, asserted because it is
    // load-bearing rather than incidental: a spec payload is model-authored,
    // and the admin portal must not be a softer target than the chat surface
    // it is reviewing.
    const { devone } = await seed()
    const { insertSpec, confirmSpec } = await import('@/lib/db/specs')
    const specId = insertSpec(db!, {
      accountId: devone,
      conversationId: 'c',
      promptSha: 'sha',
      payload: {
        title: 'Tracker',
        summary: '<img src=x onerror=alert(1)> TEST',
        background: 'b',
        panels: [{ name: 'p', shows: 's', why: 'w', source: 'manual' }],
        manual_logging: [],
        open_questions: [],
      },
      mockupHtml: MOCKUP,
      at: 100,
    })
    confirmSpec(db!, { specId, accountId: devone, at: 200 })

    const html = await renderUser('devone')
    // No <img> ELEMENT is created. Asserted on the tag rather than on the
    // attribute text: `onerror=` appears in the output and should — as
    // escaped, inert TEXT inside the paragraph, which is exactly the correct
    // outcome. An assertion against the substring would have been asserting
    // that the payload's words vanish, which is a different and wrong
    // requirement.
    expect(html).not.toMatch(/<img\b/)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('the admin mockup route', () => {
  async function get(slug: string, version: string): Promise<Response> {
    const { GET } = await import('@/app/admin/mockup/[user]/[version]/route')
    return GET(new Request(`http://localhost/admin/mockup/${slug}/${version}`), {
      params: Promise.resolve({ user: slug, version }),
    })
  }

  it('serves any user’s version to an admin, read-only', async () => {
    const { devone } = await seed()
    const { insertSpec } = await import('@/lib/db/specs')
    insertSpec(db!, {
      accountId: devone,
      conversationId: 'c',
      promptSha: 'sha',
      payload: { title: 'x' },
      mockupHtml: MOCKUP,
      at: 100,
    })

    const response = await get('devone', '1')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(MOCKUP)
    expect(response.headers.get('content-security-policy')).toBe('sandbox')
  })

  it('404s a non-admin, telling them nothing about whether it exists', async () => {
    const { getDb } = await import('@/lib/db/instance')
    const { createAccount } = await import('@/lib/auth/accounts')
    const { createSession } = await import('@/lib/session/store')
    const { insertSpec } = await import('@/lib/db/specs')
    db = getDb()
    const id = await createAccount(db, {
      slug: 'devone',
      role: 'user',
      password: 'TEST-NOT-A-REAL-PASSWORD',
    })
    insertSpec(db, {
      accountId: id,
      conversationId: 'c',
      promptSha: 'sha',
      payload: { title: 'x' },
      mockupHtml: MOCKUP,
      at: 100,
    })
    cookieSlot.value = { value: createSession(db, id) }

    expect((await get('devone', '1')).status).toBe(404)
  })

  it('404s an unknown user and an unknown version', async () => {
    await seed()
    expect((await get('nobody', '1')).status).toBe(404)
    expect((await get('devone', '99')).status).toBe(404)
    expect((await get('devone', 'abc')).status).toBe(404)
  })
})
