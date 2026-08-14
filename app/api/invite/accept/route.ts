import { appendMetric } from '@/lib/db/appendOnly'
import { getDb } from '@/lib/db/instance'
import { relativeRedirect } from '@/lib/http/redirect'
import { readInvite } from '@/lib/invite/tokens'
import { readDeviceClass } from '@/lib/metrics/deviceClass'

/**
 * S1's accept. Records that the promise was read, and moves to S2.
 *
 * It creates nothing and consumes nothing — the account, the key and the token
 * consumption all happen at S2's submit, in one transaction
 * (lib/invite/register.ts). This route exists only so that "they read it and
 * said yes" is a fact in the record rather than an inference from the fact
 * that an account exists.
 *
 * Host-relative redirects, like every other route handler here: the app runs
 * behind Caddy, and `new URL(path, request.url)` names the internal origin.
 * See lib/http/redirect.ts.
 */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  const invite = readInvite(getDb(), token)

  if (invite.kind === 'invalid') {
    // Back to the same page, which renders the dead-link line. NOT a 404 and
    // NOT an error: a link that expired between opening it and pressing the
    // button is an ordinary thing to have happen, and the friend needs the one
    // sentence that tells them what to do about it.
    return relativeRedirect(`/invite/${encodeURIComponent(token)}`)
  }

  // accountId is null because there is no account yet — that is the whole
  // point of this row's position in the funnel. The slug is a name Nico
  // assigned, not something the friend authored, so it may ride here; nothing
  // else about them may.
  appendMetric(getDb(), {
    accountId: null,
    event: 'promise_accepted',
    data: { slug: invite.slug, device_class: await readDeviceClass() },
    at: Date.now(),
  })

  return relativeRedirect(`/invite/${encodeURIComponent(token)}?step=password`)
}
