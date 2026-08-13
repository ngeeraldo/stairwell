import type { PlatformDb } from '@/lib/db/platform'
import { hashPassword, newSalts, verifyPassword } from './password'
import { RESERVED_SLUGS, SLUG_PATTERN } from './slug'

export type Account = {
  id: number
  slug: string
  role: 'user' | 'admin'
  auth_hash: string
  salt_auth: Buffer
  salt_key: Buffer
  created_at: number
}

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

export function findAccountById(
  db: PlatformDb,
  id: number,
): Account | undefined {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | Account
    | undefined
}

export async function checkPassword(
  account: Account,
  password: string,
): Promise<boolean> {
  return verifyPassword(account.auth_hash, password)
}
