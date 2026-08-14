import { appendMetric } from '@/lib/db/appendOnly'
import { getDb } from '@/lib/db/instance'
import { relativeRedirect } from '@/lib/http/redirect'
import { registerFromInvite } from '@/lib/invite/register'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { readInvite } from '@/lib/invite/tokens'
import { COOKIE_OPTIONS, SESSION_COOKIE } from '@/lib/session/store'
import { PASSWORD_MIN_LENGTH } from '@/lib/copy/onboarding'

/**
 * S2's submit.
 *
 * The route's own job is small: read the form, check the two fields agree,
 * hand off to lib/invite/register.ts, write the metrics, set the cookie. All
 * the ordering and atomicity live in that function (onboarding ledger D13).
 *
 * THE CONFIRM FIELD IS CHECKED HERE rather than in the library, because the
 * library takes one password — a confirm field is a property of this form, not
 * of registration. The client checks it too, as they type; that is the anti-
 * typo measure, and this is the gate.
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  const back = (error: string) =>
    relativeRedirect(`/invite/${encodeURIComponent(token)}?step=password&error=${error}`)

  const form = await request.formData()
  const password = String(form.get('password') ?? '')
  const confirm = String(form.get('confirm') ?? '')

  if (password !== confirm) return back('mismatch')
  if (password.length < PASSWORD_MIN_LENGTH) return back('short')

  // Read BEFORE registering, because a successful registration consumes the
  // invite and the slug is gone from it afterwards. Only used for the metrics
  // rows below; registerFromInvite reads its own.
  const invite = readInvite(getDb(), token)
  const device_class = await readDeviceClass()

  const result = await registerFromInvite(getDb(), {
    token,
    password,
    at: Date.now(),
  })

  if (!result.ok) {
    // A spent link goes back to the page WITHOUT ?step, so the friend sees the
    // dead-link line rather than a form that cannot succeed. A server error
    // stays on the form, because trying again is the right next action.
    if (result.reason === 'invalid_token') {
      return relativeRedirect(`/invite/${encodeURIComponent(token)}`)
    }
    return back(result.reason === 'too_short' ? 'short' : 'server')
  }

  // Two rows, not one, because they record two different facts that can come
  // apart in the future: a password was chosen, and a database was brought
  // into existence. Both carry the slug and the device class and nothing else
  // — the permanent metrics policy.
  const slug = invite.kind === 'valid' ? invite.slug : result.slug
  const at = Date.now()
  appendMetric(getDb(), {
    accountId: null,
    event: 'password_set',
    data: { slug, device_class },
    at,
  })
  appendMetric(getDb(), {
    accountId: null,
    event: 'db_created',
    data: { slug, device_class },
    at,
  })

  const response = relativeRedirect(`/${result.slug}`)
  response.cookies.set(SESSION_COOKIE, result.sessionId, COOKIE_OPTIONS)
  return response
}
