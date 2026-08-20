// tests/metrics/renderTrigger.test.ts
//
// Why a render happened. See the design doc §7.3 for the coupling this
// depends on: every navigation in this app is a plain document load (the tab
// strip is bare `<a href="?screen=">` anchors), so an `rsc` header means a
// router.refresh() and nothing else.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const headerSlot: { value: string | null } = { value: null }
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'rsc' ? headerSlot.value : null) }),
}))

beforeEach(() => {
  headerSlot.value = null
})

describe('readRenderTrigger', () => {
  it('reads a plain document load as nav', async () => {
    const { readRenderTrigger } = await import('@/lib/metrics/renderTrigger')
    expect(await readRenderTrigger()).toBe('nav')
  })

  it('reads an RSC request as refresh', async () => {
    headerSlot.value = '1'
    const { readRenderTrigger } = await import('@/lib/metrics/renderTrigger')
    expect(await readRenderTrigger()).toBe('refresh')
  })
})
