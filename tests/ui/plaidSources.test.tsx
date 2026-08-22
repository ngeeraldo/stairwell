// tests/ui/plaidSources.test.tsx
// @vitest-environment jsdom
//
// The shared bank management surface — the screen a friend with two banks
// actually uses.
//
// Every finance dashboard renders THIS component (2026-08-21 plan, D4;
// enforced by tests/users/plaidSurface.test.ts), so what it says is what every
// friend reads. That makes the SENTENCES part of the contract, not decoration:
//
//  - a bank that stopped updating must say so, because its numbers are still
//    on screen and look exactly like live ones
//  - a bank connected seconds ago is WORKING, not broken
//  - the one failure a friend can fix must be told apart from the ones they
//    cannot
//  - a refresh control must carry a last-updated time beside it
//    (docs/dashboard-ui-ux-guidelines.md > States)
//
// Uses tests/support/dom.tsx rather than @testing-library/react, per the
// standing bar on new test dependencies (onboarding ledger D9).
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { click, mount } from '@/tests/support/dom'
import { PlaidSources } from '@/lib/ui/PlaidSources'
import type { PlaidSource } from '@/modules/plaid/sources'

// The write controls call router.refresh() on success. There is no app router
// in jsdom, and this suite is about what the surface SAYS rather than about
// WriteAction's mechanics, which tests/ui/writeAction.test.tsx already pins.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

const NOW = Date.parse('2026-08-21T18:00:00Z')

beforeEach(() => {
  vi.stubGlobal('React', React)
})

const source = (over: Partial<PlaidSource> = {}): PlaidSource => ({
  itemId: 'item_1',
  name: 'FIRST PLATYPUS BANK TEST',
  status: 'live',
  connectedAt: NOW - 86_400_000,
  disconnectedAt: null,
  lastRefreshAt: NOW - 5 * 60_000,
  lastAttemptAt: NOW - 5 * 60_000,
  accountCount: 2,
  failedProducts: [],
  ...over,
})

async function render(sources: PlaidSource[]) {
  const { container, unmount } = await mount(
    <PlaidSources slug="devtwo" sources={sources} now={NOW} timeZone="America/New_York" />,
  )
  return { text: container.textContent ?? '', container, unmount }
}

/** Every action URL the surface posts to, in render order. */
const actions = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('form')).map((f) => f.getAttribute('action'))

describe('with no bank connected', () => {
  it('says so and offers to connect one', async () => {
    const { text, container, unmount } = await render([])
    expect(text).toContain('No bank connected yet')
    expect(container.querySelectorAll('button')).toHaveLength(1)
    await unmount()
  })
})

describe('what each bank says about itself', () => {
  it('names the bank rather than its id', async () => {
    const { text, unmount } = await render([source()])
    expect(text).toContain('FIRST PLATYPUS BANK TEST')
    expect(text).not.toContain('item_1')
    await unmount()
  })

  it('says when a live bank last updated', async () => {
    const { text, unmount } = await render([source()])
    expect(text).toContain('Updated 5 minutes ago')
    await unmount()
  })

  it('says a disconnected bank is no longer updating, and that the history stayed', async () => {
    // THE SENTENCE THE SOFT DELETE EXISTS FOR. Without it these rows sit on
    // screen looking exactly like live ones, with nothing that explains them.
    const { text, unmount } = await render([
      source({ status: 'disconnected', disconnectedAt: NOW - 3_600_000 }),
    ])
    expect(text).toContain('No longer updating')
    expect(text).toContain('history is still here')
    await unmount()
  })

  it('treats a freshly connected bank as working, not broken', async () => {
    // It has a token and no rows for several seconds while Plaid backfills.
    const { text, unmount } = await render([
      source({ status: 'never_refreshed', lastRefreshAt: null, lastAttemptAt: null }),
    ])
    expect(text).toContain('Waiting for your first transactions')
    expect(text.toLowerCase()).not.toContain('couldn’t')
    await unmount()
  })

  it('sends the friend to the one door they can open', async () => {
    const { text, unmount } = await render([source({ status: 'needs_login' })])
    expect(text).toContain('sign in again')
    await unmount()
  })

  it('does not blame the friend for a failure they cannot fix', async () => {
    const { text, unmount } = await render([source({ status: 'unreachable' })])
    expect(text).toContain('Couldn’t reach your bank')
    expect(text).not.toContain('sign in again')
    await unmount()
  })

  it('counts the accounts, singular and plural', async () => {
    const one = await render([source({ accountCount: 1 })])
    expect(one.text).toContain('1 account')
    await one.unmount()
    const many = await render([source({ accountCount: 3 })])
    expect(many.text).toContain('3 accounts')
    await many.unmount()
  })
})

describe('how it says when a bank last updated', () => {
  // docs/dashboard-ui-ux-guidelines.md > Formatting decides this once for
  // everyone: relative while it is recent, absolute past a week, year only
  // when it is not this one. It is a shared component, so getting it wrong
  // gets it wrong on every friend's dashboard at once.
  const at = (ms: number) => render([source({ lastRefreshAt: NOW - ms })])

  it('says "just now" under a minute', async () => {
    const { text, unmount } = await at(30_000)
    expect(text).toContain('Updated just now')
    await unmount()
  })

  it('counts minutes and hours, singular and plural', async () => {
    for (const [ms, said] of [
      [60_000, '1 minute ago'],
      [45 * 60_000, '45 minutes ago'],
      [3_600_000, '1 hour ago'],
      [5 * 3_600_000, '5 hours ago'],
    ] as const) {
      const { text, unmount } = await at(ms)
      expect(text).toContain(said)
      await unmount()
    }
  })

  it('says "yesterday" rather than "26 hours ago"', async () => {
    const { text, unmount } = await at(26 * 3_600_000)
    expect(text).toContain('yesterday')
    await unmount()
  })

  it('names the weekday inside the last week', async () => {
    // NOW is a Friday; three days back is Tuesday in America/New_York.
    const { text, unmount } = await at(3 * 86_400_000)
    expect(text).toContain('on Tuesday')
    await unmount()
  })

  it('switches to a date past a week', async () => {
    const { text, unmount } = await at(20 * 86_400_000)
    expect(text).toContain('on Aug 1')
    expect(text).not.toContain('2026')
    await unmount()
  })

  it('adds the year only when it is not this one', async () => {
    const { text, unmount } = await at(300 * 86_400_000)
    expect(text).toContain('2025')
    await unmount()
  })

  it('resolves the day in the FRIEND’S zone, not the server’s', async () => {
    // 01:30 UTC on the 22nd is still the 21st in New York, so this instant is
    // "yesterday" for them and "today" for a server reading UTC. The app has
    // one answer to what day it is for a person; this uses it.
    const lateUtc = Date.parse('2026-08-22T01:30:00Z')
    const { container, unmount } = await mount(
      <PlaidSources
        slug="devtwo"
        sources={[source({ lastRefreshAt: Date.parse('2026-08-21T01:30:00Z') })]}
        now={lateUtc}
        timeZone="America/New_York"
      />,
    )
    expect(container.textContent).toContain('yesterday')
    await unmount()
  })
})

describe('when a refresh half-worked', () => {
  // A real friend's bank fails intermittently and answers on the second press.
  // Before this, the row said "Updated just now" with a green dot while its
  // balances had not arrived — true about the connection, false about the
  // numbers on the page.
  it('says what did not come through, and to try again', async () => {
    const { text, unmount } = await render([source({ failedProducts: ['accounts'] })])
    expect(text).toContain('Your balances didn’t come through. Try Refresh again.')
    await unmount()
  })

  it('uses the friend’s words for a product, never ours', async () => {
    const { text, unmount } = await render([
      source({ failedProducts: ['investment_transactions'] }),
    ])
    expect(text).toContain('investment activity')
    expect(text).not.toContain('investment_transactions')
    await unmount()
  })

  it('lists several as a sentence rather than as a dump', async () => {
    const { text, unmount } = await render([
      source({ failedProducts: ['accounts', 'holdings', 'recurring'] }),
    ])
    expect(text).toContain('balances, investments and subscriptions and paychecks')
    await unmount()
  })

  it('shows the warning on the COLLAPSED row, not only inside it', async () => {
    // A row a friend has to open to discover a problem is a warning that does
    // not exist.
    const { container, unmount } = await render([source({ failedProducts: ['accounts'] })])
    const summary = container.querySelector('summary')
    expect(summary?.textContent).toContain('Didn’t fully update')
    await unmount()
  })

  it('says nothing when the last round was clean', async () => {
    const { container, unmount } = await render([source()])
    expect(container.querySelector('summary')?.textContent).not.toContain('Didn’t fully update')
    await unmount()
  })

  it('does not repeat itself when the WHOLE connection failed', async () => {
    // "Couldn't reach your bank" already said it. Two sentences saying the
    // same thing in different words is worse than one.
    const { text, unmount } = await render([
      source({ status: 'unreachable', failedProducts: ['accounts', 'transactions'] }),
    ])
    expect(text).toContain('Couldn’t reach your bank')
    expect(text).not.toContain('didn’t come through')
    await unmount()
  })
})

describe('the row collapses until a friend opens it', () => {
  it('shows the bank, its state and its size without being opened', async () => {
    const { container, unmount } = await render([source()])
    const summary = container.querySelector('summary')!
    expect(summary.textContent).toContain('FIRST PLATYPUS BANK TEST')
    expect(summary.textContent).toContain('2 accounts')
    await unmount()
  })

  it('keeps every control reachable with no JavaScript', async () => {
    // <details> rather than a client-side collapsible, deliberately: every
    // control in here renders a real form so a failure never replaces the page
    // with a browser error, and hiding them behind JS would strand exactly the
    // friend who has no other way in.
    const { container, unmount } = await render([source()])
    expect(container.querySelector('details')).not.toBeNull()
    // The forms are in the markup whether or not the row is open.
    expect(container.querySelectorAll('form').length).toBeGreaterThan(0)
    await unmount()
  })
})

describe('the controls every friend gets', () => {
  it('offers to connect ANOTHER bank once one exists', async () => {
    // The control whose absence started this plan.
    const { text, unmount } = await render([source()])
    expect(text).toContain('Connect another bank')
    await unmount()
  })

  it('offers to change which accounts a bank shares', async () => {
    const { text, unmount } = await render([source()])
    expect(text).toContain('Choose accounts')
    await unmount()
  })

  it('makes the two destructive controls ask before they act', async () => {
    // Stopping and deleting both take something away — one reversibly, one
    // not — and both sit in a row a friend scans quickly. Neither fires on a
    // single press. The mechanics are pinned in tests/ui/writeAction.test.tsx;
    // what matters here is that these two, and only these two, ask.
    const { container, unmount } = await render([source()])
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(labels).toContain('Stop updating')
    expect(labels).toContain('Delete data')

    const deleteButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Delete data',
    )!
    await click(deleteButton)
    expect(deleteButton.textContent).toContain('can’t be undone')
    await unmount()
  })

  it('offers stopping and deleting as SEPARATE controls', async () => {
    // They have different consequences and only one is reversible. A friend
    // offered a single "remove" would sometimes destroy history they wanted.
    const { text, unmount } = await render([source()])
    expect(text).toContain('Stop updating')
    expect(text).toContain('Delete data')
    await unmount()
  })

  it('names the bank in every write it posts', async () => {
    // With two banks, an unaddressed disconnect is a coin flip on a
    // destructive action — and the route refuses one anyway.
    const { container, unmount } = await render([source(), source({ itemId: 'item_2' })])
    const ids = Array.from(container.querySelectorAll('input[name="item_id"]')).map((i) =>
      i.getAttribute('value'),
    )
    expect(ids.filter((id) => id === 'item_1').length).toBeGreaterThan(0)
    expect(ids.filter((id) => id === 'item_2').length).toBeGreaterThan(0)
    await unmount()
  })

  it('marks the delete control, and only that one, as a removal', async () => {
    const { container, unmount } = await render([source()])
    const removals = Array.from(container.querySelectorAll('input[name="action"]')).map((i) =>
      i.getAttribute('value'),
    )
    expect(removals).toEqual(['remove'])
    await unmount()
  })

  it('posts every write to a platform route on this origin', async () => {
    const { container, unmount } = await render([source()])
    for (const action of actions(container)) {
      expect(action?.startsWith('/api/users/devtwo/plaid/')).toBe(true)
    }
    await unmount()
  })

  it('offers no stop or reconnect for an already-disconnected bank', async () => {
    // Its token was destroyed when it was disconnected. Offering a repair for
    // a connection that cannot be repaired is worse than offering nothing.
    const { text, unmount } = await render([source({ status: 'disconnected' })])
    expect(text).not.toContain('Stop updating')
    expect(text).not.toContain('sign in again')
    // But it can still be deleted — otherwise the friend is stuck with it.
    expect(text).toContain('Delete data')
    await unmount()
  })
})

describe('the refresh control and its time', () => {
  it('carries a last-updated time beside it', async () => {
    // docs/dashboard-ui-ux-guidelines.md > States. A refresh button with no
    // time next to it invites the friend to assume the numbers are current.
    const { text, unmount } = await render([source()])
    expect(text).toContain('Refresh')
    expect(text).toContain('Everything updated 5 minutes ago')
    await unmount()
  })

  it('reports the OLDEST bank’s time, not the newest', async () => {
    // "Updated 2 minutes ago" beside a bank that last answered on Tuesday is
    // true of one connection and a false statement about the page.
    const { text, unmount } = await render([
      source({ itemId: 'item_1', lastRefreshAt: NOW - 2 * 60_000 }),
      source({ itemId: 'item_2', lastRefreshAt: NOW - 3 * 3_600_000 }),
    ])
    expect(text).toContain('Everything updated 3 hours ago')
    await unmount()
  })

  it('does not claim everything updated when one bank never has', async () => {
    const { text, unmount } = await render([
      source({ itemId: 'item_1' }),
      source({ itemId: 'item_2', status: 'never_refreshed', lastRefreshAt: null }),
    ])
    expect(text).toContain('haven’t sent anything yet')
    await unmount()
  })

  it('ignores disconnected banks when saying what is current', async () => {
    // A revoked bank's last update is not a claim about the live ones.
    const { text, unmount } = await render([
      source({ itemId: 'item_1', lastRefreshAt: NOW - 60_000 }),
      source({
        itemId: 'item_2',
        status: 'disconnected',
        lastRefreshAt: NOW - 30 * 86_400_000,
      }),
    ])
    expect(text).toContain('Everything updated 1 minute ago')
    await unmount()
  })

  it('offers no refresh at all when nothing is live', async () => {
    const { text, unmount } = await render([source({ status: 'disconnected' })])
    expect(text).toContain('Nothing is updating')
    expect(text).not.toContain('Refresh')
    await unmount()
  })
})
