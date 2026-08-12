import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Design spec: expiry is enforced "on access and by a sweep interval, so an
 * idle process does not retain keys." instrumentation.ts is the only thing
 * that schedules lib/session/keymap.ts's sweep() — nothing else calls it
 * outside tests. These tests exercise register() directly rather than
 * booting Next.js, mirroring how middleware.ts's tests exercise
 * lib/session/resolve.ts instead of the edge runtime.
 */
describe('instrumentation.ts', () => {
  const originalRuntime = process.env.NEXT_RUNTIME

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME
    else process.env.NEXT_RUNTIME = originalRuntime
  })

  it("schedules keymap sweep() on an unref'd interval in the nodejs runtime", async () => {
    process.env.NEXT_RUNTIME = 'nodejs'
    const unref = vi.fn()
    const fakeTimer = { unref } as unknown as NodeJS.Timeout
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeTimer)

    const { sweep, SWEEP_INTERVAL_MS } = await import('@/lib/session/keymap')
    const { register } = await import('@/instrumentation')
    await register()

    expect(setIntervalSpy).toHaveBeenCalledWith(sweep, SWEEP_INTERVAL_MS)
    // .unref() must be called on the timer itself, not just constructed —
    // otherwise the interval would hold the Node event loop open forever.
    expect(unref).toHaveBeenCalledTimes(1)
  })

  it('schedules nothing outside the nodejs runtime (e.g. the edge middleware isolate)', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const setIntervalSpy = vi.spyOn(global, 'setInterval')

    const { register } = await import('@/instrumentation')
    await register()

    expect(setIntervalSpy).not.toHaveBeenCalled()
  })

  it('reports missing env without throwing, and not on the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge'
    const { register } = await import('@/instrumentation')
    // The edge isolate has no keymap and no database handle; register() must
    // return without touching either.
    await expect(register()).resolves.toBeUndefined()
  })

  it('never rejects even if the required-env list cannot be read', async () => {
    // Startup must survive a missing list. A server that will not boot
    // because it could not find its own checklist is worse than the gap.
    process.env.NEXT_RUNTIME = 'nodejs'
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/nonexistent-path-for-test')
    vi.spyOn(global, 'setInterval').mockReturnValue({
      unref: vi.fn(),
    } as unknown as NodeJS.Timeout)

    const { register } = await import('@/instrumentation')
    await expect(register()).resolves.toBeUndefined()
    cwd.mockRestore()
  })
})
