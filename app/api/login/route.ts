import { getDb } from '@/lib/db/instance'
import { appendMetric } from '@/lib/db/appendOnly'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { databaseKeyFor, login } from '@/lib/auth/flow'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { putKey } from '@/lib/session/keymap'
import { migrateUserDb } from '@/lib/db/migrate'
import { refuseDeps, refuseSession } from '@/lib/auth/refuseSession'
import { relativeRedirect } from '@/lib/http/redirect'
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session/store'

export async function POST(request: Request) {
  const form = await request.formData()
  const slug = String(form.get('slug') ?? '')
  const password = String(form.get('password') ?? '')

  const sessionId = await login(getDb(), slug, password)
  if (!sessionId) {
    return relativeRedirect('/login?error=1')
  }

  // Derive here rather than making the user type the same password again at
  // /unlock. This crosses no new trust boundary — the password is already in
  // this request body — and costs one extra Argon2 pass (~14ms).
  //
  // This does NOT make the session a standing unlock. The key still lives only
  // in the in-process map with its 4h idle TTL and 12h ceiling, so a restart
  // leaves the user authenticated but locked and /unlock is unchanged for that
  // re-lock path. tests/auth/routes.test.ts pins both halves.
  const account = findAccountBySlug(getDb(), slug)
  if (!account) {
    // Unreachable by construction: login() only returns a session id after
    // findAccountBySlug found this same slug. Fails closed rather than
    // asserting non-null, so a future refactor that breaks that invariant
    // rejects the login instead of throwing on `.salt_key`.
    return relativeRedirect('/login?error=1')
  }
  let key: Buffer
  try {
    key = await databaseKeyFor(getDb(), account, password)
  } catch {
    // login() already verified the password against auth_hash, so a
    // WrappedKeyError here means a corrupt account_keys row rather than a
    // wrong password (onboarding ledger D2). Fail the login rather than issue
    // a session whose data region can never open. No metrics row: the failure
    // is already visible as a failed login, and a new event kind for a state
    // that cannot occur is noise in a log that can never be cleaned up.
    return relativeRedirect('/login?error=1')
  }

  // BEFORE putKey, and that ordering is the whole point: a session must never
  // become usable over a half-migrated shape. On every login after the one
  // that needed it this costs a single `PRAGMA user_version` read.
  //
  // This is one of exactly three places the runner fires, and they are the
  // three places a key enters the keymap — because a key is the only thing
  // that can open a friend's database, and their session is the only moment
  // it exists.
  //
  // NOT FOR AN ADMIN. `nico` has no user space — /nico 404s, canSeeUserSpace
  // excludes admins even for their own slug — so there is no database to
  // migrate and creating one would put a real-named file in a folder that
  // should not exist. Caught by the admin login test, which is the only place
  // this distinction is visible.
  try {
    if (account.role !== 'admin') migrateUserDb(account.slug, key)
  } catch (error) {
    await refuseSession(refuseDeps(account.id), {
      sessionId,
      slug: account.slug,
      error,
    })
    return relativeRedirect('/login?error=refused')
  }
  putKey(sessionId, key)

  // An admin account has no user space — it lands on the read-only admin
  // portal instead of /<slug>, which would now 404 (canSeeUserSpace excludes
  // admins even for their own slug; see lib/auth/authorize.ts).
  //
  // account.slug, not the raw form value, for the non-admin branch: the
  // stored slug is the one SLUG_PATTERN validated at creation, which is what
  // keeps this interpolation off the open-redirect path (see
  // lib/auth/accounts.ts).
  // Written only after the key is in the map, so a row here means a login
  // that actually worked end to end — not one that authenticated and then
  // failed to open anything. The device class is what answers "where do people
  // actually glance from"; nothing else about them rides along.
  appendMetric(getDb(), {
    accountId: account.id,
    event: 'login',
    data: { device_class: await readDeviceClass() },
    at: Date.now(),
  })

  const target = account.role === 'admin' ? '/admin' : `/${account.slug}`
  const response = relativeRedirect(target)
  response.cookies.set(SESSION_COOKIE, sessionId, COOKIE_OPTIONS)
  return response
}
