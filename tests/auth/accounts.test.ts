// tests/auth/accounts.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb } from '@/lib/db/platform'
import { createAccount, findAccountBySlug } from '@/lib/auth/accounts'

let dir: string
let db: ReturnType<typeof openPlatformDb>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-accounts-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('createAccount slug validation', () => {
  it('accepts an ordinary lowercase slug', async () => {
    await expect(
      createAccount(db, { slug: 'devone', role: 'user', password: 'pw' }),
    ).resolves.toBeGreaterThan(0)
  })

  it('accepts digits and hyphens', async () => {
    await expect(
      createAccount(db, { slug: 'dev-1', role: 'user', password: 'pw' }),
    ).resolves.toBeGreaterThan(0)
  })

  it('rejects uppercase letters', async () => {
    await expect(
      createAccount(db, { slug: 'DevOne', role: 'user', password: 'pw' }),
    ).rejects.toThrow(/invalid slug/)
  })

  it('rejects an empty slug', async () => {
    await expect(
      createAccount(db, { slug: '', role: 'user', password: 'pw' }),
    ).rejects.toThrow(/invalid slug/)
  })

  it('rejects a slug longer than 32 characters', async () => {
    await expect(
      createAccount(db, { slug: 'a'.repeat(33), role: 'user', password: 'pw' }),
    ).rejects.toThrow(/invalid slug/)
  })

  it('accepts a slug at exactly the 32-character boundary', async () => {
    await expect(
      createAccount(db, { slug: 'a'.repeat(32), role: 'user', password: 'pw' }),
    ).resolves.toBeGreaterThan(0)
  })

  it('rejects characters outside [a-z0-9-] (dots, spaces, underscores)', async () => {
    for (const slug of ['dev.one', 'dev one', 'dev_one', 'dev/one', 'dév']) {
      await expect(
        createAccount(db, { slug, role: 'user', password: 'pw' }),
        `expected '${slug}' to be rejected`,
      ).rejects.toThrow(/invalid slug/)
    }
  })

  it('rejects the exact open-redirect case: a slug beginning with a slash', async () => {
    // app/api/unlock/route.ts builds `new URL(`/${account.slug}`, request.url)`.
    // A slug of "/evil.com" would make that resolve to "//evil.com" — a
    // post-authentication redirect off the trusted origin. The leading '/'
    // alone is enough to be rejected by SLUG_PATTERN (not in [a-z0-9-]).
    await expect(
      createAccount(db, { slug: '/evil.com', role: 'user', password: 'pw' }),
    ).rejects.toThrow(/invalid slug/)
    expect(findAccountBySlug(db, '/evil.com')).toBeUndefined()
  })

  it.each(['admin', 'login', 'unlock', 'api'])(
    'rejects the reserved slug %s (shape-valid, caught by the reserved check)',
    async (slug) => {
      await expect(
        createAccount(db, { slug, role: 'user', password: 'pw' }),
      ).rejects.toThrow(/reserved/)
    },
  )

  it.each(['_next', 'favicon.ico'])(
    'rejects the reserved path %s (also shape-invalid, caught by the pattern check first)',
    async (slug) => {
      // '_next' and 'favicon.ico' contain characters SLUG_PATTERN already
      // excludes (underscore, dot), so they never reach the reserved-word
      // check — still rejected, just via a different message. The
      // important property (never insertable) is what matters here.
      await expect(
        createAccount(db, { slug, role: 'user', password: 'pw' }),
      ).rejects.toThrow(/invalid slug/)
      expect(findAccountBySlug(db, slug)).toBeUndefined()
    },
  )

  it('does not insert a row when validation rejects the slug', async () => {
    await expect(
      createAccount(db, { slug: 'admin', role: 'admin', password: 'pw' }),
    ).rejects.toThrow()
    expect(findAccountBySlug(db, 'admin')).toBeUndefined()
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as {
      n: number
    }
    expect(n).toBe(0)
  })
})
