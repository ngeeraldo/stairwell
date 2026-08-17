// tests/dashboard/contract.test.ts
//
// activeScreen resolves a `?screen=` search-param value against a dashboard's
// own declared `screens` list. Part D, task 22: the platform owns the tab
// chrome, and this is the seam that decides which screen is "active" for a
// given render.
import { describe, expect, it } from 'vitest'
import { activeScreen, type DashboardScreen } from '@/lib/dashboard/contract'

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
