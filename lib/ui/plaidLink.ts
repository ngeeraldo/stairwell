'use client'

/**
 * The mechanics of opening Plaid Link, shared by the two places that do it.
 *
 * There are two, and only because OAuth forces it:
 *
 *   lib/ui/PlaidConnect.tsx      starts a connection from a dashboard
 *   lib/ui/PlaidOAuthReturn.tsx  RESUMES one after an OAuth bank sent the
 *                                friend off to their bank's own site and back
 *
 * A non-OAuth bank never leaves the page, so one component could do the whole
 * job. An OAuth bank navigates the browser away — the tab is torn down, React
 * state is gone, and the friend comes back to a fresh page load at
 * /plaid/oauth. Resuming means re-opening Link with THE SAME link token that
 * started the flow, plus the URL they came back on.
 *
 * ── WHY sessionStorage, AND WHY THAT IS NOT A KEY IN localStorage ───────────
 *
 * The link token has to survive a full page navigation, so it has to be
 * persisted somewhere the browser keeps. CLAUDE.md is absolute that passwords
 * and database keys never appear in cookies, localStorage, URLs or any
 * persisted artifact — and a link token is none of those things. It is
 * single-use, expires in minutes, authorises nothing but opening Link, and can
 * read no account. The access token, which CAN read an account, never reaches
 * the browser at all: it is created server-side and written straight into the
 * friend's encrypted database.
 *
 * sessionStorage rather than localStorage all the same, because it is the
 * narrower of the two: it dies with the tab, so an abandoned connection leaves
 * nothing behind on a shared computer.
 */

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
const STORAGE_KEY = 'stairwell.plaid.link'

export type PlaidHandler = { open: () => void; destroy: () => void }

type PlaidGlobal = {
  create: (config: {
    token: string
    receivedRedirectUri?: string
    onSuccess: (publicToken: string) => void
    onExit: (error: unknown) => void
  }) => PlaidHandler
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal
  }
}

/**
 * What has to survive the trip to the bank's website and back.
 *
 * `connectAction` and `returnTo` travel with the token because the page the
 * friend lands on is /plaid/oauth — which knows nothing about whose connection
 * this is. Re-deriving a slug from the URL would mean trusting a value that
 * arrived from a third-party redirect; carrying it is both simpler and
 * narrower.
 */
export type LinkSession = {
  token: string
  connectAction: string
  returnTo: string
}

export function rememberLinkSession(session: LinkSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Private browsing, or storage disabled. A non-OAuth connection still
    // works — only the OAuth resume needs this — so failing here must not
    // stop the flow that is about to start.
  }
}

export function recallLinkSession(): LinkSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LinkSession>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.connectAction !== 'string' ||
      typeof parsed.returnTo !== 'string'
    ) {
      return null
    }
    return parsed as LinkSession
  } catch {
    return null
  }
}

export function forgetLinkSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do; the entry expires with the tab regardless.
  }
}

/**
 * Load Plaid's script once per page, not once per click.
 *
 * Two copies of link-initialize.js on one page is a bug that only appears on a
 * dashboard with two connect controls, which is exactly the kind of thing
 * nobody tests.
 */
export function loadPlaidScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.Plaid) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_SCRIPT}"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('script')))
      return
    }
    const script = document.createElement('script')
    script.src = PLAID_SCRIPT
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('script')) 
    document.head.appendChild(script)
  })
}

/**
 * Hand the public token to our own route.
 *
 * The header is load-bearing: lib/http/redirect.ts answers 204 when it sees it
 * and a 303 when it does not, and fetch follows redirects by default — so
 * without it the browser silently renders the whole dashboard again and lands
 * a spurious dashboard_open row in an append-only table.
 */
export async function exchangeAtConnectRoute(
  connectAction: string,
  publicToken: string,
): Promise<boolean> {
  const body = new FormData()
  body.set('public_token', publicToken)
  const response = await fetch(connectAction, {
    method: 'POST',
    body,
    headers: { 'X-Stairwell-Write': '1' },
  })
  if (!response.ok) {
    console.error('[plaid connect] exchange failed with status', response.status)
  }
  return response.ok
}
