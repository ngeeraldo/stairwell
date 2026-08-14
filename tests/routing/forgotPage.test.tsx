// tests/routing/forgotPage.test.tsx
//
// S5. Almost every assertion here is about something that must NOT be on the
// page, which is unusual and is the point: the standing constraint is "No
// password reset path may exist anywhere, including temporarily for dev", and
// this is the page most likely to grow one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlatformDb } from '@/lib/db/platform'
import { FORGOT } from '@/lib/copy/onboarding'

const emptyHeaders = { get: () => null }
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => emptyHeaders,
}))

let dir: string
let db: PlatformDb | undefined

beforeEach(() => {
  vi.stubGlobal('React', React)
  dir = mkdtempSync(join(tmpdir(), 'stairwell-forgot-'))
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

async function render(): Promise<string> {
  const { getDb } = await import('@/lib/db/instance')
  db = getDb()
  const { default: ForgotPage } = await import('@/app/(auth)/forgot/page')
  return renderToStaticMarkup((await ForgotPage()) as React.ReactElement)
}

describe('S5 — the honest dead end', () => {
  it('says there is no reset, and why', async () => {
    const html = await render()
    expect(html).toContain(FORGOT.heading)
    for (const paragraph of FORGOT.paragraphs) expect(html).toContain(paragraph)
  })

  it('has NO form and NO input of any kind', async () => {
    // The spec: "No form, no email field." A form here would be a lie with an
    // input in it — there is nothing at the other end of it and there cannot
    // be, because nobody has a copy of the password.
    const html = await render()
    expect(html).not.toContain('<form')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<textarea')
  })

  it('offers exactly one way out, and it goes backwards', async () => {
    const html = await render()
    const links = html.match(/<a\b[^>]*href="([^"]*)"/g) ?? []
    expect(links).toHaveLength(1)
    expect(html).toContain('href="/login"')
  })

  it('contains nothing that reads as a recovery path', async () => {
    // Belt and braces beside the copy test in tests/copy: that one guards the
    // constants, this one guards the PAGE, because a page can add words and
    // controls the constants never see.
    const html = await render()
    expect(html.toLowerCase()).not.toMatch(
      /reset your password|click here to reset|send.{0,12}link|recover your account|type="email"/,
    )
  })

  it('records forgot_password_viewed with a device class and nothing else', async () => {
    await render()
    const row = db!
      .prepare("SELECT account_id, data FROM metrics WHERE event = 'forgot_password_viewed'")
      .get() as { account_id: number | null; data: string }

    // Null on purpose: whoever is reading this could not get in, so there is
    // no account id to attribute it to.
    expect(row.account_id).toBeNull()
    expect(JSON.parse(row.data)).toEqual({ device_class: 'desktop' })
  })
})
