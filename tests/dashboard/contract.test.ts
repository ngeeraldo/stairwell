// tests/dashboard/contract.test.ts
//
// activeScreen resolves a `?screen=` search-param value against a dashboard's
// own declared `screens` list. Part D, task 22: the platform owns the tab
// chrome, and this is the seam that decides which screen is "active" for a
// given render.
import { describe, expect, it } from 'vitest'
import { activeScreen, type DashboardScreen } from '@/lib/dashboard/contract'
import { dashboardLoaderFor, registeredSlugs } from '@/lib/dashboard/registry'

// Deliberately out of order: 'money' is declared first but has the HIGHER
// order, so a test that defaulted to array position instead of `order` would
// pass on an accidentally-sorted fixture and fail here.
const SCREENS: DashboardScreen[] = [
  { id: 'money', title: 'Money', order: 2 },
  { id: 'morning', title: 'Morning', order: 1 },
]

describe('activeScreen', () => {
  it('defaults to the lowest-order screen, not the first in the array', () => {
    expect(activeScreen(SCREENS, undefined).id).toBe('morning')
  })

  it('honours a requested screen', () => {
    expect(activeScreen(SCREENS, 'money').id).toBe('money')
  })

  // A URL is user input. An unknown ?screen= must not 404 or throw — it lands
  // on the morning surface, which is the same place a bare /<slug> lands.
  it('falls back to the default for an unknown screen rather than throwing', () => {
    expect(activeScreen(SCREENS, 'nope').id).toBe('morning')
  })

  it('throws on an empty screen list — a registered dashboard must declare one', () => {
    expect(() => activeScreen([], undefined)).toThrow()
  })
})

// Task 23: `DashboardModule.screens` went from optional to required now that
// every registered dashboard exports one — this proves it holds for real,
// not just at the type level. `screens?: DashboardScreen[]` would still let a
// module ship `screens: undefined` at runtime (a type is not a runtime
// check); this iterates the actual registry, loads each real module, and
// feeds its real `screens` through the real `activeScreen`, so a dashboard
// that regressed to zero screens fails here the same way it would fail in
// production — via activeScreen's own throw — rather than only via a
// compiler that a `// @ts-expect-error` could silence.
describe('every registered dashboard declares at least one screen', () => {
  it.each(registeredSlugs())('%s', async (slug) => {
    const loader = dashboardLoaderFor(slug)
    expect(loader, `${slug} must be registered`).toBeDefined()
    const { screens } = await loader!()
    expect(screens.length).toBeGreaterThan(0)
    // Resolves without throwing — the same call app/[user]/page.tsx makes
    // for a real render.
    expect(() => activeScreen(screens, undefined)).not.toThrow()
  })
})
