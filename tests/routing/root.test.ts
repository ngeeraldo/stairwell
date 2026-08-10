// tests/routing/root.test.ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('app shell', () => {
  it('sets a root layout with an html and body element', () => {
    const layout = readFileSync('app/layout.tsx', 'utf8')
    expect(layout).toContain('<html')
    expect(layout).toContain('<body')
  })

  it('does not ship a default Next.js landing page', () => {
    const page = readFileSync('app/page.tsx', 'utf8')
    expect(page).not.toContain('nextjs.org')
  })
})
