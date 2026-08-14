// app/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import { SESSION_COOKIE } from '@/lib/session/store'
import { accountIdFor, canSeeUserSpace } from '@/lib/auth/authorize'
import { requireState } from '@/lib/session/guard'
import { resolveState } from '@/lib/session/resolve'
import { appendMetric, readTranscript } from '@/lib/db/appendOnly'
import { readDeviceClass } from '@/lib/metrics/deviceClass'
import { hasConfirmedSpecBelow, newestSpec } from '@/lib/db/specs'
import { SpecShapeError } from '@/lib/spec/schema'
import { readStoredSpec } from '@/lib/spec/stored'
import type { Proposal } from '@/lib/spec/author'
import { openUserDb } from '@/lib/db/userDb'
import type { UserDb } from '@/lib/db/userDb'
import type { DeviceClass } from '@/lib/metrics/deviceClass'
import {
  encryptedUserDbHasTables,
  openEncryptedUserDb,
  WrongKeyError,
} from '@/lib/db/encryptedUserDb'
import { logDbFailure } from '@/lib/db/failureLog'
import { getKey } from '@/lib/session/keymap'
import { dashboardLoaderFor, hasDashboard } from '@/lib/dashboard/registry'
import { hasMetric } from '@/lib/db/appendOnly'
import ChatPanel from './ChatPanel'
import { Button } from '@/components/ui/button'
import { PlaceholderCard } from './PlaceholderCard'
import { Shell } from './Shell'

/**
 * The data region, for an owner whose session is already UNLOCKED.
 *
 * Called only from the unlocked branch below, so no database file is opened
 * for a locked session — in step 6 that read needs a key a locked session does
 * not have, and a page that opened first and hid the result afterwards would
 * pass today and be wrong then.
 *
 * The dashboard component is CALLED, not returned as <Dashboard />. Returning
 * an element would defer its execution to React's render, outside this
 * try/catch, and the whole point of the catch is that bespoke per-user code is
 * the least-reviewed code in the repo. The chat surface stays OUTSIDE this
 * function on purpose: it is the surface a friend uses to report that the
 * dashboard broke.
 */

/**
 * `dashboard_error`'s payload has never been free text. `metrics` is
 * append-only and unencrypted, so a raw `.message` written through either
 * catch below is a fragment of the friend's own data, permanent, in the one
 * place this design promises never holds it — see the login page's "I can
 * see when you use it ... but not what you log", and step 5's ledger
 * residual 6, which flagged this exact pattern for revisiting once step 6
 * put a real database behind these catches. `kind` is a small closed set
 * instead, derived with `instanceof` — NOT `error.constructor.name`, which
 * lib/chat/client.ts notes is minifier-fragile in a Next production build.
 */
function dashboardErrorKind(error: unknown): 'wrong_key' | 'error' {
  return error instanceof WrongKeyError ? 'wrong_key' : 'error'
}

async function dashboardRegion(
  slug: string,
  accountId: number,
  sessionId: string,
  device_class: DeviceClass,
) {
  const loader = dashboardLoaderFor(slug)
  // The placeholder card, not a sentence. onboarding-ux-spec.md S3: it is what
  // occupies the content area for the whole interview period, so it has to be
  // a real piece of chrome rather than an apology.
  if (!loader) return <PlaceholderCard />

  // Real data wins when this friend HAS any. A user who has logged nothing
  // reads the loudly-fake database under a banner — which is what keeps
  // devone's reference dashboard working, since it is never written to.
  //
  // NOT `encryptedUserDbExists`, and the difference is a whole class of dead
  // end. Since S2 creates the file at password-set time (onboarding ledger
  // D3), existence means "this friend has an account", not "this friend has
  // data" — and an empty file read as real would send the dashboard's first
  // SELECT into the catch below and render "This dashboard failed to load",
  // permanently: the read-only handle can never create the tables, and the
  // friend has no control that would. That is the exact ssh-only state
  // createEncryptedUserDb's docstring was written to remove.
  //
  // An empty real database is described honestly by the synthetic screen and
  // its banner: nothing has been logged, so there is nothing real to render.
  // The rule that matters — the banner is never shown OVER real data — holds.
  //
  // INSIDE a try, because the predicate OPENS THE FILE and so can throw
  // WrongKeyError exactly like the open below it. Left outside, a wrong key
  // would propagate past this function into the route's default error
  // boundary, taking the chat panel and the logout button with it — the
  // surface this file's docstring says must stay reachable so a friend can
  // report that their dashboard broke.
  const key = getKey(sessionId)
  let useReal: boolean
  try {
    useReal = key !== undefined && encryptedUserDbHasTables(slug, key)
  } catch (error) {
    logDbFailure('dashboard_error', slug, error)
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_error',
      data: { slug, kind: dashboardErrorKind(error), device_class },
      at: Date.now(),
    })
    return <p>This dashboard failed to load.</p>
  }

  if (!useReal) {
    const data = openUserDb(slug)
    if (data.source === 'none') {
      return <p>Your dashboard is built, but its data has not been generated yet.</p>
    }
    return renderDashboard(loader, slug, data.db, accountId, 'synthetic', device_class)
  }

  let db: UserDb | undefined
  try {
    // openEncryptedUserDb is INSIDE this try, not before it: WrongKeyError
    // (or a corrupt file) exists for precisely this case, and an uncaught
    // throw here would propagate past this function with no error.tsx
    // anywhere in app/ — taking the whole route's default error boundary
    // over the ENTIRE page, chat panel and logout button included, which is
    // exactly the surface this file's own docstring says stays reachable so
    // a friend can report a broken dashboard.
    // readonly: a dashboard component is the least-reviewed code in the repo
    // and this handle points at the friend's real data, not at a synthetic
    // file the next deploy regenerates. The walk route's writable open is the
    // only thing that may create or migrate it — so this open also does NOT
    // apply schema.sql, which is a write. See lib/db/encryptedUserDb.ts.
    db = openEncryptedUserDb(slug, key!, { readonly: true })
    return await renderDashboard(loader, slug, db, accountId, 'real', device_class)
  } catch (error) {
    logDbFailure('dashboard_error', slug, error)
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_error',
      data: { slug, kind: dashboardErrorKind(error), device_class },
      at: Date.now(),
    })
    return <p>This dashboard failed to load.</p>
  } finally {
    // Opened per request and closed here: a handle is scoped to one key, and a
    // key is scoped to one session. Caching it process-wide is exactly the bug
    // step 5's ledger (residual 4) warns against. Guarded with `?.` because a
    // failed open leaves db unassigned — nothing to close.
    db?.close()
  }
}

async function renderDashboard(
  loader: () => Promise<{ default: (p: { slug: string; db: UserDb }) => unknown }>,
  slug: string,
  db: UserDb,
  accountId: number,
  source: 'synthetic' | 'real',
  device_class: DeviceClass,
) {
  try {
    const { default: Dashboard } = await loader()
    // CALLED, not returned as <Dashboard />: an element would defer execution
    // to React's render, outside this try, and the catch is the whole point.
    const rendered = await Dashboard({ slug, db })
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_open',
      data: { slug, source, device_class },
      at: Date.now(),
    })
    return (
      <>
        {source === 'synthetic' && (
          /*
            PLATFORM CHROME, and it has to look like it.
            
            CLAUDE.md: "The banner is the only thing distinguishing the two
            screens." Unstyled it rendered as one more line of the dashboard,
            in the same type as the numbers it is warning about — which the
            first screenshot review caught. It is bordered and tinted now so it
            reads as a notice at a glance, before a word of it is read.
            
            Amber rather than destructive: nothing is wrong here. It is telling
            someone what they are looking at.
            
            The COPY is unchanged and pinned in
            tests/routing/dashboardRegion.test.ts, the way the login page's
            promises are pinned. The second sentence is said to the PERSON, not
            to a demonstrator: the sample looks like a real record, and their
            first tap replaces all of it with one day, because the real
            database is created by that tap and starts empty. Anyone who
            mistook the sample for their own would read that as having lost
            something.
          */
          <div
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          >
            <p className="font-medium">SYNTHETIC DATA — every number below is fake.</p>
            <p className="mt-1">
              This sample history isn&apos;t yours. Your own record starts empty, with
              your first tap.
            </p>
          </div>
        )}
        {rendered}
      </>
    )
  } catch (error) {
    logDbFailure('dashboard_error', slug, error)
    appendMetric(getDb(), {
      accountId,
      event: 'dashboard_error',
      data: { slug, kind: dashboardErrorKind(error), device_class },
      at: Date.now(),
    })
    return <p>This dashboard failed to load.</p>
  }
}

export default async function UserSpace({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params

  // Still enforced: anonymous goes to /login. A locked session now passes
  // through to the page — the lock is applied to the data region below.
  await requireState(`/${user}`)

  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value

  // 404, never 403: a 403 would confirm that the other dev user exists.
  if (!canSeeUserSpace(getDb(), sessionId, user)) notFound()

  // canSeeUserSpace has already proven a session exists, so this is only
  // undefined if the session vanished between the two reads.
  const accountId = accountIdFor(getDb(), sessionId)
  if (accountId === undefined) notFound()

  const unlocked = resolveState(getDb(), sessionId) === 'unlocked'
  // Resolved once for the whole render: first_session_start and the dashboard
  // region's own rows should agree about what kind of screen this is.
  const device_class = await readDeviceClass()

  const newest = newestSpec(getDb(), accountId)
  // Which delivery promise the card rendered from the record makes. Computed
  // HERE, from the record, because ChatPanel is a client component with no
  // database and the alternative — the agent remembering to say it — is
  // exactly what the fixed chrome exists to replace.
  //
  // The question is "is the card on screen this account's FIRST dashboard",
  // which is NOT "has this account ever confirmed anything" — see
  // hasConfirmedSpecBelow. Asking the unbounded version meant a friend who
  // pressed "Build this" on their first card and then RELOADED saw that same
  // card promise their whole first dashboard within a few hours. The card's
  // own comment says a friend reloading afterwards should still see the
  // timeframe; it has to be the right one.
  //
  // Bounded by the displayed proposal's version, so: nothing confirmed yet →
  // true; only this card confirmed → still true, it really is their first
  // dashboard; an earlier spec confirmed with a newer proposal above it →
  // false. No proposal at all means no card to promise anything about, and
  // true is the honest default for an account with no dashboard yet.
  const first =
    newest === undefined || !hasConfirmedSpecBelow(getDb(), accountId, newest.version)

  // Rendered from the record on load, so a friend who closes the tab
  // mid-decision comes back to the same card, still confirmable.
  let proposal: (Proposal & { confirmed: boolean }) | undefined
  if (newest) {
    try {
      proposal = {
        id: newest.id,
        version: newest.version,
        // Carried on the card itself, not only handed to ChatPanel as a prop:
        // every card must answer for itself, because a card proposed later in
        // this same session arrives through the `proposal` NDJSON line with no
        // re-render behind it (see Proposal.first). The prop stays as the
        // fallback for a streamed card that somehow carries none.
        first,
        // readStoredSpec, not either parser directly: it is the one place
        // that decides which shape a row is, and the card renders whichever
        // arm comes back. A row written before the unified loop can never be
        // rewritten (specs rejects UPDATE), so both arms are permanent.
        spec: readStoredSpec(newest.payload),
        mockup_html: newest.mockup_html,
        confirmed: newest.confirmed_at !== null,
      }
    } catch (error) {
      // specs is append-only, so a corrupt row can never be deleted to make
      // this go away. Degrade to no card rather than let the throw become a
      // 500 for the friend — anything OTHER than the expected shape error
      // still escapes, because that's a bug this page has no business
      // hiding.
      if (!(error instanceof SpecShapeError)) throw error
      proposal = undefined
    }
  }

  // The shell's one boolean (onboarding-ux-spec.md S3). "Deployed" is exactly
  // "is this slug in lib/dashboard/registry.ts" — a line there is what makes a
  // dashboard render at all, so nothing else in the system can disagree.
  //
  // Open during the interview, because the chat is where the action is;
  // collapsed once a dashboard exists, because the morning glance is
  // dashboard-first and the chat is one tap away.
  const chatOpenByDefault = !hasDashboard(user)

  // The first time this account ever reaches the shell. Written once, ever,
  // and the guard reads an append-only table to decide — which makes this the
  // SECOND metrics row in the codebase that is system state rather than
  // telemetry (onboarding ledger D8, and CLAUDE.md's sacred-data section).
  if (!hasMetric(getDb(), accountId, 'first_session_start')) {
    appendMetric(getDb(), {
      accountId,
      event: 'first_session_start',
      data: { device_class },
      at: Date.now(),
    })
  }

  return (
    <Shell
      chatOpenByDefault={chatOpenByDefault}
      chat={
        <ChatPanel
          initial={readTranscript(getDb(), accountId).map((row) => ({
            role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            body: row.body,
          }))}
          proposal={proposal}
          first={first}
        />
      }
      content={
        <div className="space-y-8">
          {unlocked ? (
            await dashboardRegion(user, accountId, sessionId!, device_class)
          ) : (
            <p className="text-sm text-muted-foreground">
              Locked.{' '}
              <a href="/unlock" className="underline underline-offset-4">
                Unlock
              </a>{' '}
              to see your data.
            </p>
          )}

          {/*
            Inside the content column's footer rather than floating: the shell
            is the whole page now, and a logout control pinned outside it would
            have to pick one of the two arrangements to belong to.
          */}
          <form method="post" action="/api/logout" className="pt-4">
            <Button type="submit" variant="ghost" size="sm">
              Log out
            </Button>
          </form>
        </div>
      }
    />
  )
}
