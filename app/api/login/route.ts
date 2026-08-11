import { getDb } from '@/lib/db/instance'
import { login } from '@/lib/auth/flow'
import { findAccountBySlug } from '@/lib/auth/accounts'
import { deriveDbKey } from '@/lib/auth/password'
import { putKey } from '@/lib/session/keymap'
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
  putKey(sessionId, await deriveDbKey(password, account.salt_key))

  // account.slug, not the raw form value: the stored slug is the one
  // SLUG_PATTERN validated at creation, which is what keeps this
  // interpolation off the open-redirect path (see lib/auth/accounts.ts).
  const response = relativeRedirect(`/${account.slug}`)
  response.cookies.set(SESSION_COOKIE, sessionId, COOKIE_OPTIONS)
  return response
}
