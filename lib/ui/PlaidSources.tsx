import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dayKey } from '@/lib/time/dayKey'
import { PlaidConnect } from './PlaidConnect'
import { WriteAction } from './WriteAction'
import type { PlaidSource, PlaidSourceStatus } from '@/modules/plaid/sources'

/**
 * THE BANK MANAGEMENT SURFACE, and every finance dashboard renders THIS ONE.
 *
 * Not offered — required (2026-08-21 plan, D4), and enforced by a sweep in
 * tests/users/plaidSurface.test.ts: a folder holding a vendored `_module_plaid`
 * migration whose dashboard.tsx does not render this component fails the suite.
 *
 * ── WHY IT IS UNIFORM RATHER THAN A SET OF PARTS TO CHOOSE FROM ─────────────
 *
 * docs/dashboard-build-rules.md §9.5 used to LIST these controls as available
 * components. A builder then wired up exactly what one friend's spec asked for
 * and no more, and shipped a screen that could be connected to once and never
 * managed again. Nothing was violated; there was nothing to violate.
 *
 * The capabilities are not a design question. A friend who connects a bank can
 * always add another, see when each last updated, reconnect a broken one,
 * change which accounts it shares, stop it, and delete it. A dashboard
 * offering four of those would leave someone stuck in a state with no way out
 * — and WHICH four would vary per friend, for no reason either of them chose.
 *
 * What a dashboard still decides is where this goes and what surrounds it.
 *
 * ── IT HOLDS NO HANDLE AND KNOWS NO SQL ─────────────────────────────────────
 *
 * `sources` arrives as data, read by modules/plaid/sources.ts from the
 * read-only handle the dashboard was given. Every control here posts to a
 * platform route, which is still the only thing that writes and still the only
 * place the four ordered auth checks live.
 *
 * ── FOUR STATES, AND THE TWO THAT GET MISSED ────────────────────────────────
 *
 * docs/dashboard-ui-ux-guidelines.md forbids rendering stale data as current.
 * Each status below is a way that would otherwise happen, and the first two
 * are the ones that get skipped:
 *
 *   never_refreshed  A bank connected seconds ago has a token and no rows for
 *                    several seconds while Plaid backfills. Saying nothing
 *                    reads as a failed connection.
 *   disconnected     Revoked, history kept. This sentence is the entire reason
 *                    plaid_items survives a disconnect instead of being
 *                    deleted — without it the rows sit there looking live.
 *   needs_login      The one failure only the friend can fix.
 *   unreachable      Something else failed, and it is not theirs to repair.
 *
 * ── DELETE IS DELIBERATELY THE PLAINEST CONTROL HERE ────────────────────────
 *
 * "Delete data" is irreversible and unrecoverable by anyone, including Nico,
 * because nobody can read the database. It sits beside "Stop updating", which
 * is the reversible thing most people actually want, and it says what it does
 * rather than being a second meaning of the same button.
 */
export function PlaidSources({
  slug,
  sources,
  now,
  timeZone,
}: {
  slug: string
  /** From modules/plaid/sources.ts. The dashboard reads; this renders. */
  sources: PlaidSource[]
  /**
   * The instant this page was rendered, handed down rather than read here.
   *
   * A component that called Date.now() would be a second answer to "what time
   * is it for this friend" — the app has exactly one (lib/time/dayKey.ts over
   * a stored instant), and the friend-timezone ledger is about what happens
   * when there are two.
   */
  now: number
  /** The friend's IANA zone, for rendering a stored instant as their clock. */
  timeZone?: string
}) {
  const linkTokenAction = `/api/users/${slug}/plaid/link-token`
  const connectAction = `/api/users/${slug}/plaid/connect`
  const disconnectAction = `/api/users/${slug}/plaid/disconnect`
  const refreshAction = `/api/users/${slug}/plaid/refresh`
  const returnTo = `/${slug}`

  const live = sources.filter((s) => s.status !== 'disconnected')

  if (sources.length === 0) {
    return (
      <section className="flex flex-col items-start gap-3" aria-label="Your banks">
        <p className="max-w-[42rem] text-sm text-muted-foreground">
          No bank connected yet. Connecting one brings in your accounts and transactions —
          it runs on your own device, and your bank login never reaches this server.
        </p>
        <PlaidConnect
          linkTokenAction={linkTokenAction}
          connectAction={connectAction}
          returnTo={returnTo}
        />
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Your banks">
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {sources.map((source) => (
          // <details>, NOT a client-side collapsible, and the reason is not
          // taste. Every control inside renders a real form so that a failure
          // never replaces the page with the browser's own error — which means
          // they have to be reachable with JavaScript off. A Radix collapsible
          // would hide them from exactly the friend who has no other way in.
          // This also keeps the whole surface a server component.
          <details key={source.itemId} className="group">
            <summary
              className={cn(
                'flex cursor-pointer list-none items-center gap-2 p-3 text-sm',
                'transition-colors hover:bg-muted/40',
                // The marker is drawn below; Safari needs this to drop its own.
                '[&::-webkit-details-marker]:hidden',
              )}
            >
              <StatusDot status={source.status} />
              <span className="min-w-0 flex-1 truncate font-medium">{source.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {source.accountCount === 1 ? '1 account' : `${source.accountCount} accounts`}
              </span>
              {/*
                COLLAPSED ROWS HIDE THINGS, which is the point — but never a
                problem. A dot the friend has to open a row to understand is a
                warning that does not exist.
              */}
              {describeFailures(source) !== null && (
                <span className="shrink-0 text-xs font-medium text-destructive">
                  Didn’t fully update
                </span>
              )}
              <ChevronDown
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
              />
              <span className="sr-only">Settings for {source.name}</span>
            </summary>

            <div className="flex flex-col gap-2 border-t border-border/60 bg-muted/20 p-3">
              <p className="text-sm text-muted-foreground">
                {describeStatus(source, now, timeZone)}
              </p>
              {/*
                A refresh can succeed and fail at the same time — transactions
                land, balances do not — and the connection is genuinely fine,
                so the dot stays green. This sentence is the only thing that
                stops "Updated just now" being a true statement about the
                connection and a false one about the numbers on the page.
              */}
              {describeFailures(source) !== null && (
                <p className="text-sm text-destructive">{describeFailures(source)}</p>
              )}

              <div className="flex flex-wrap items-center gap-1">
                {source.status === 'needs_login' && (
                  // The primary action, and the ONLY status where one exists:
                  // this is the single failure the friend can actually fix.
                  <PlaidConnect
                    linkTokenAction={linkTokenAction}
                    connectAction={connectAction}
                    returnTo={returnTo}
                    itemId={source.itemId}
                    reconnect
                  >
                    Sign in again
                  </PlaidConnect>
                )}

                {source.status !== 'disconnected' && (
                  <>
                    {/*
                      Which accounts a bank shares is chosen inside Plaid's own
                      UI, so this is the only place that choice can be
                      reopened. It only ever ADDS — see the connect route.
                    */}
                    <PlaidConnect
                      linkTokenAction={linkTokenAction}
                      connectAction={connectAction}
                      returnTo={returnTo}
                      itemId={source.itemId}
                      manageAccounts
                      variant={source.status === 'needs_login' ? 'ghost' : 'outline'}
                    >
                      Choose accounts
                    </PlaidConnect>

                    <WriteAction
                      action={disconnectAction}
                      payload={{ item_id: source.itemId }}
                      variant="ghost"
                      pendingLabel="Stopping…"
                      confirm="Stop this bank updating?"
                    >
                      Stop updating
                    </WriteAction>
                  </>
                )}

                {/*
                  THE QUIETEST CONTROL HERE, and the only one that destroys
                  anything. Behind the disclosure it is also no longer one
                  stray tap from a friend's whole history — which nobody,
                  including Nico, can restore.
                */}
                <WriteAction
                  action={disconnectAction}
                  payload={{ item_id: source.itemId, action: 'remove' }}
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  pendingLabel="Deleting…"
                  confirm="Delete it all? This can’t be undone"
                >
                  Delete data
                </WriteAction>
              </div>
            </div>
          </details>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/*
          A last-updated time NEXT TO the refresh control
          (docs/dashboard-ui-ux-guidelines.md > States). A refresh button with
          no time beside it invites a friend to assume the numbers are current.
        */}
        {live.length > 0 && (
          <WriteAction
            action={refreshAction}
            payload={{}}
            pendingLabel="Checking your banks…"
            failedLabel="Couldn’t reach your bank. What’s below is the last data that arrived."
          >
            Refresh
          </WriteAction>
        )}
        <span className="text-sm text-muted-foreground">{describeOverall(live, now, timeZone)}</span>
        <PlaidConnect
          linkTokenAction={linkTokenAction}
          connectAction={connectAction}
          returnTo={returnTo}
          variant="ghost"
        >
          Connect another bank
        </PlaidConnect>
      </div>
    </section>
  )
}

/**
 * The status, as a shape rather than only as a sentence.
 *
 * STATIC. Nothing here pulses or animates: a blinking dot beside a bank would
 * read as data arriving, and data only ever arrives when the friend presses
 * Refresh (docs/dashboard-ui-ux-guidelines.md > Delight / Animation).
 *
 * A hollow ring for disconnected rather than another colour — it is the
 * absence of a live connection, not a different kind of one.
 */
function StatusDot({ status }: { status: PlaidSourceStatus }) {
  const tone: Record<PlaidSourceStatus, string> = {
    live: 'bg-emerald-500',
    never_refreshed: 'bg-sky-500',
    needs_login: 'bg-amber-500',
    unreachable: 'bg-destructive',
    disconnected: 'border border-muted-foreground/50 bg-transparent',
  }
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 translate-y-[-1px] rounded-full', tone[status])}
    />
  )
}

/**
 * Plaid's product names are ours, not the friend's.
 *
 * "investment_transactions didn't come through" is a sentence nobody outside
 * this repository can act on.
 */
const PRODUCT_WORDS: Record<string, string> = {
  transactions: 'transactions',
  accounts: 'balances',
  holdings: 'investments',
  investment_transactions: 'investment activity',
  recurring: 'subscriptions and paychecks',
}

/**
 * What did NOT arrive last time, when something else did.
 *
 * Returns null when the round was clean, or when the source's own status
 * already says the whole connection failed — two sentences saying the same
 * thing in different words is worse than one.
 *
 * The friend is told to press Refresh again, because that is genuinely the
 * fix: a bank that fails intermittently usually answers on the second try, and
 * nothing can retry on their behalf — their key exists only while they are in
 * the app.
 */
function describeFailures(source: PlaidSource): string | null {
  if (source.failedProducts.length === 0) return null
  if (source.status !== 'live' && source.status !== 'never_refreshed') return null
  const words = source.failedProducts.map((p) => PRODUCT_WORDS[p] ?? p)
  const listed =
    words.length === 1
      ? words[0]!
      : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return `Your ${listed} didn’t come through. Try Refresh again.`
}

/** What one source says about itself, in the friend's words. */
function describeStatus(source: PlaidSource, now: number, timeZone?: string): string {
  switch (source.status) {
    case 'disconnected':
      // The sentence this whole soft-delete exists to make possible.
      return 'No longer updating. Your history is still here.'
    case 'needs_login':
      return 'Your bank needs you to sign in again.'
    case 'unreachable':
      return source.lastRefreshAt === null
        ? 'Couldn’t reach your bank yet.'
        : `Couldn’t reach your bank. Last updated ${ago(source.lastRefreshAt, now, timeZone)}.`
    case 'never_refreshed':
      // A freshly connected bank is WORKING, not broken. It has a token and no
      // rows for several seconds while Plaid backfills.
      return 'Connected. Waiting for your first transactions.'
    case 'live':
      return `Updated ${ago(source.lastRefreshAt, now, timeZone)}.`
  }
}

/** The one line beside the Refresh control, covering every live bank at once. */
function describeOverall(live: PlaidSource[], now: number, timeZone?: string): string {
  if (live.length === 0) return 'Nothing is updating.'
  const times = live.map((s) => s.lastRefreshAt).filter((t): t is number => t !== null)
  // The OLDEST, not the newest. "Updated 2 minutes ago" next to a bank that
  // last answered on Tuesday would be true of one connection and a false
  // statement about the numbers on the page.
  if (times.length < live.length) return 'Some of your banks haven’t sent anything yet.'
  return `Everything updated ${ago(Math.min(...times), now, timeZone)}.`
}

/**
 * A stored instant as a friend would say it.
 *
 * Relative while it is recent and absolute past a week, which is the rule
 * docs/dashboard-ui-ux-guidelines.md > Formatting sets once for everyone. No
 * clock is read: both the instant and "now" are handed in, because the app has
 * exactly one answer to what time it is for a person and a display helper is
 * not allowed to become a second one.
 */
function ago(at: number | null, now: number, timeZone?: string): string {
  if (at === null) return 'never'

  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours === 1) return '1 hour ago'
  if (hours < 24) return `${hours} hours ago`

  // Past a day it becomes a calendar question, so it is answered in the
  // FRIEND'S zone — the same instant is a different day in two places, and
  // lib/time/dayKey.ts is the one place this app resolves that.
  const then = dayKey(at, timeZone)
  const today = dayKey(now, timeZone)
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${then}T00:00:00Z`)) / 86_400_000)
  if (days <= 1) return 'yesterday'
  if (days < 7) return `on ${format(at, timeZone, { weekday: 'long' })}`

  return `on ${format(at, timeZone, {
    month: 'short',
    day: 'numeric',
    // Year only when it is not this one.
    ...(then.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  })}`
}

const format = (at: number, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...opts, ...(timeZone ? { timeZone } : {}) }).format(new Date(at))

export type { PlaidSource, PlaidSourceStatus }
