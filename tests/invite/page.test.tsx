// tests/invite/page.test.tsx
// @vitest-environment jsdom
//
// S0 and S1. The interesting assertions are the ones about what this page
// does NOT say: it must not distinguish a used link from an unknown one, and
// it must not create anything.
//
// jsdom because these render to real markup and the "no password field"
// assertions are about the DOM rather than about an element tree. Same
// per-test fresh PLATFORM_DB + vi.resetModules() idiom as
// tests/routing/loginPage.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformDb } from '@/lib/db/platform'
import { DEAD_LINK, GREETING, PROMISE_BLOCK } from '@/lib/copy/onboarding'

const emptyHeaders = { get: () => null }
const cookieGet = vi.fn(() => undefined)
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-invitepage-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  vi.resetModules()
  db = undefined
})

afterEach(() => {
  vi.unstubAllGlobals()
  db?.close()
  delete process.env.PLATFORM_DB
  rmSync(dir, { recursive: true, force: true })
})

async function render(token: string, step?: string): Promise<string> {
  const { default: InvitePage } = await import('@/app/(auth)/invite/[token]/page')
  const element = await InvitePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(step ? { step } : {}),
  } as never)
  return renderToStaticMarkup(element as React.ReactElement)
}

async function seed(): Promise<{ valid: string; used: string; revoked: string }> {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { mintInvite, consumeInvite, revokeInvite } = await import('@/lib/invite/tokens')
  db = getDb()

  const valid = mintInvite(db, { slug: 'friendone', at: 1000 })

  const used = mintInvite(db, { slug: 'usedone', at: 1000 })
  const id = await createAccount(db, {
    slug: 'usedone',
    role: 'user',
    password: 'TEST-NOT-A-REAL-PASSWORD',
  })
  consumeInvite(db, { token: used, accountId: id, at: 1001 })

  const revoked = mintInvite(db, { slug: 'revokedone', at: 1000 })
  revokeInvite(db, { slug: 'revokedone', at: 1001 })

  return { valid, used, revoked }
}

function metrics(): { event: string; data: string | null }[] {
  return db!.prepare('SELECT event, data FROM metrics ORDER BY id').all() as {
    event: string
    data: string | null
  }[]
}

describe('S0 — the dead link', () => {
  it('renders one line and no form for an unknown token', async () => {
    await seed()
    const html = await render('never-minted-anywhere')

    expect(html).toContain(DEAD_LINK)
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
  })

  it('renders the dead-link constant and NOTHING ELSE', async () => {
    // Not a duplicate of the byte-for-byte test below. That one proves the two
    // invalid cases look the same as each other; this one proves the page does
    // not add words of its own to either.
    //
    // The gap it closes was found by a drill: appending '(already used)' in
    // the JSX reddened nothing, because it lands on BOTH renders identically
    // and lib/copy's own test only guards the constant. Copy that bypasses the
    // constant needs a guard at the page.
    await seed()
    const text = (await render('never-minted-anywhere'))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()

    expect(text).toBe(DEAD_LINK)
  })

  it('renders a used token and an unknown token IDENTICALLY, byte for byte', async () => {
    // The spec: "No distinction shown between 'used' and 'unknown' — same
    // message for both (leaks nothing, and the fix is identical: text Nico)."
    // Byte-for-byte, because a difference in a class name or an aria label is
    // still a difference somebody could read.
    const { used } = await seed()
    expect(await render(used)).toBe(await render('never-minted-anywhere'))
  })

  it('renders a revoked token identically too', async () => {
    const { revoked } = await seed()
    expect(await render(revoked)).toBe(await render('never-minted-anywhere'))
  })

  it('writes no invite_opened row for an invalid link', async () => {
    // A dead link is not a funnel event. Counting it would inflate the top of
    // the funnel with people who never saw an offer.
    await seed()
    await render('never-minted-anywhere')
    expect(metrics().map((m) => m.event)).not.toContain('invite_opened')
  })
})

describe('S1 — the deal', () => {
  it('greets, shows all three promise paragraphs, and offers one button', async () => {
    const { valid } = await seed()
    const html = await render(valid)

    expect(html).toContain(GREETING)
    expect(html).toContain(PROMISE_BLOCK.heading)
    // Label and body separately, because they render as separate elements —
    // asserting the concatenation would pass on markup that ran them together
    // as one grey paragraph, which is exactly the rendering the screenshot
    // review rejected (ledger D19).
    for (const half of PROMISE_BLOCK.halves) {
      expect(html).toContain(half.label)
      expect(html).toContain(half.body)
    }
    expect(html).toContain('/api/invite/accept?token=')
    expect(html.match(/<button/g) ?? []).toHaveLength(1)
  })

  it('has no checkbox — the button IS the acceptance', async () => {
    const { valid } = await seed()
    const html = await render(valid)
    expect(html).not.toContain('type="checkbox"')
  })

  it('creates nothing: no account, no session, no invite consumed', async () => {
    // This page is the consent surface and nothing else. Everything that makes
    // an account happens at S2's submit, in one transaction.
    const { valid } = await seed()
    await render(valid)

    const { readInvite } = await import('@/lib/invite/tokens')
    expect(readInvite(db!, valid)).toMatchObject({ kind: 'valid' })
    expect(
      (db!.prepare("SELECT COUNT(*) AS n FROM accounts WHERE slug = 'friendone'").get() as {
        n: number
      }).n,
    ).toBe(0)
    expect(
      (db!.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n,
    ).toBe(0)
  })

  it('records invite_opened with the slug and a device class and nothing else', async () => {
    const { valid } = await seed()
    await render(valid)

    const row = metrics().find((m) => m.event === 'invite_opened')!
    expect(JSON.parse(row.data!)).toEqual({ slug: 'friendone', device_class: 'desktop' })
  })

  it('records a SECOND open as a second row', async () => {
    // Deliberately not idempotent: "opened it twice and thought about it" is a
    // real thing that happened, and the funnel is built out of exactly those
    // rows. This pins that nobody later "optimises" it into a state change.
    const { valid } = await seed()
    await render(valid)
    await render(valid)

    expect(metrics().filter((m) => m.event === 'invite_opened')).toHaveLength(2)
  })
})
