import type { PlatformDb } from '@/lib/db/platform'
import { hashPassword, newSalts, verifyPassword } from './password'

export type Account = {
  id: number
  slug: string
  role: 'user' | 'admin'
  auth_hash: string
  salt_auth: Buffer
  salt_key: Buffer
  created_at: number
}

// Lowercase letters, digits, and hyphens only, 1-32 characters. This is
// also the thing standing between account creation and an open redirect:
// app/api/unlock/route.ts builds `new URL(`/${account.slug}`, request.url)`,
// and a slug allowed to start with '/' (e.g. "/evil.com") would make that
// resolve to "//evil.com" — a post-authentication redirect off the trusted
// origin. A slug that can never contain '/' closes that off at the source,
// for every caller, rather than re-sanitizing at each place a slug gets
// interpolated into a path.
const SLUG_PATTERN = /^[a-z0-9-]{1,32}$/

// Route segments a slug must not collide with. admin/login/unlock are
// real top-level routes (app/admin, app/(auth)/login, app/(auth)/unlock);
// api and _next are reserved by the app/framework; favicon.ico is a static
// asset route.
const RESERVED_SLUGS = new Set([
  'admin',
  'login',
  'unlock',
  'api',
  '_next',
  'favicon.ico',
])

export async function createAccount(
  db: PlatformDb,
  input: { slug: string; role: 'user' | 'admin'; password: string },
): Promise<number> {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      `invalid slug '${input.slug}': must match ${SLUG_PATTERN.source} ` +
        '(lowercase letters, digits, and hyphens only, 1-32 characters)',
    )
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': reserved for a route`)
  }

  const { saltAuth, saltKey } = newSalts()
  const authHash = await hashPassword(input.password, saltAuth)
  const info = db
    .prepare(
      `INSERT INTO accounts (slug, role, auth_hash, salt_auth, salt_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.slug, input.role, authHash, saltAuth, saltKey, Date.now())
  return Number(info.lastInsertRowid)
}

export function findAccountBySlug(
  db: PlatformDb,
  slug: string,
): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE slug = ?').get(slug) as
    | Account
    | undefined
}

export async function checkPassword(
  account: Account,
  password: string,
): Promise<boolean> {
  return verifyPassword(account.auth_hash, password)
}
