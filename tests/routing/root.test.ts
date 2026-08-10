import { describe, expect, it, vi } from 'vitest'

const redirect = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirect(path),
}))

describe('app shell', () => {
  it('sends the root path to login', async () => {
    const { default: Home } = await import('@/app/page')
    Home()
    expect(redirect).toHaveBeenCalledWith('/login')
  })
})
