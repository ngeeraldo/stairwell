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

export async function createAccount(
  db: PlatformDb,
  input: { slug: string; role: 'user' | 'admin'; password: string },
): Promise<number> {
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
