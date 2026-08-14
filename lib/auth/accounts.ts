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

/**
 * The account row, inserted SYNCHRONOUSLY from material the caller already has.
 *
 * Split out of `createAccount` for one reason, and it is a hard constraint
 * rather than a preference: **better-sqlite3 transactions cannot contain
 * `await`.** Registration has to create an account, store a wrapped key,
 * consume an invite and create a session as one unit that rolls back together
 * (lib/invite/register.ts) — so every Argon2 pass has to happen BEFORE the
 * transaction opens, and what runs inside it must be pure inserts.
 *
 * It also keeps the Argon2 work out of a held write lock, which is a real
 * benefit at any number of users above one.
 *
 * Validation lives here rather than in the async wrapper so BOTH callers get
 * it. The slug reaching this from an invite was already validated at mint
 * time; that is defence in depth, not a reason to skip it.
 */
export function insertAccount(
  db: PlatformDb,
  input: {
    slug: string
    role: 'user' | 'admin'
    authHash: string
    saltAuth: Buffer
    saltKey: Buffer
    createdAt: number
  },
): number {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      `invalid slug '${input.slug}': must match ${SLUG_PATTERN.source} ` +
        '(lowercase letters, digits, and hyphens only, 1-32 characters)',
    )
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': reserved for a route`)
  }

  const info = db
    .prepare(
      `INSERT INTO accounts (slug, role, auth_hash, salt_auth, salt_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.slug,
      input.role,
      input.authHash,
      input.saltAuth,
      input.saltKey,
      input.createdAt,
    )
  return Number(info.lastInsertRowid)
}

/**
 * Create an account from a plaintext password.
 *
 * The convenient form, used by the dev-user script and by every test. The
 * registration path does NOT use it — see insertAccount above for why.
 */
export async function createAccount(
  db: PlatformDb,
  input: { slug: string; role: 'user' | 'admin'; password: string },
): Promise<number> {
  const { saltAuth, saltKey } = newSalts()
  return insertAccount(db, {
    slug: input.slug,
    role: input.role,
    authHash: await hashPassword(input.password, saltAuth),
    saltAuth,
    saltKey,
    createdAt: Date.now(),
  })
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
