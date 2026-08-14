// tests/ui/primitives.test.tsx
// @vitest-environment jsdom
//
// The styling layer's own tests. Two jobs:
//
//  1. Pin the behaviour of the one primitive we WROTE (PasswordField). The
//     vendored shadcn components are exempt from Gate B and are not tested
//     here — testing them would pin somebody else's implementation.
//  2. Prove a Radix component works under this harness HERE, rather than
//     discovering it does not in Task 15 when a dialog is load-bearing — and
//     record WHERE Radix puts its content, which every later dialog assertion
//     depends on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { click, mount, type } from '@/tests/support/dom'
import { cn } from '@/lib/utils'
import { PasswordField } from '@/lib/ui/PasswordField'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

beforeEach(() => {
  vi.stubGlobal('React', React)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('cn', () => {
  it('lets a caller class win over the component default', () => {
    // The reason tailwind-merge is in the tree at all: without it both classes
    // ship and the cascade, not the caller, decides which applies. Every
    // `className` override in this build depends on this being true.
    expect(cn('px-4 py-2', 'px-6')).toBe('py-2 px-6')
  })
})

describe('PasswordField', () => {
  it('starts masked, reveals on toggle, and keeps the same input', async () => {
    const { container, unmount } = await mount(
      <PasswordField name="password" label="Password" autoComplete="new-password" />,
    )

    expect(container.querySelector('input')!.type).toBe('password')
    await type(container.querySelector('input'), 'half typed')

    await click(container.querySelector('button[type="button"]'))

    // The SAME input, still holding what was typed. A second, parallel text
    // input would be the obvious wrong implementation and would pass a test
    // that only checked for a visible plaintext value.
    expect(container.querySelectorAll('input')).toHaveLength(1)
    expect(container.querySelector('input')!.type).toBe('text')
    expect(container.querySelector('input')!.value).toBe('half typed')

    await unmount()
  })

  it('reports what was typed, so a form can gate its submit on it', async () => {
    const seen: string[] = []
    const { container, unmount } = await mount(
      <PasswordField
        name="password"
        label="Password"
        autoComplete="new-password"
        onValueChange={(v) => seen.push(v)}
      />,
    )

    await type(container.querySelector('input'), 'a sentence works')

    expect(seen.at(-1)).toBe('a sentence works')

    await unmount()
  })

  it('renders an inline error where a form can put one', async () => {
    const { container, unmount } = await mount(
      <PasswordField
        name="confirm"
        label="Confirm"
        autoComplete="new-password"
        error="Passwords don’t match."
      />,
    )

    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'Passwords don’t match.',
    )
    expect(container.querySelector('input')!.getAttribute('aria-invalid')).toBe('true')

    await unmount()
  })
})

describe('Radix under this harness', () => {
  it('a shadcn Dialog opens, and its content lands on document.body', async () => {
    // The fact every later dialog assertion depends on: Radix PORTALS its
    // content onto document.body, not into the mounted container. A test that
    // queried the container would find nothing and read as "the dialog never
    // opened".
    //
    // This also stands in for "does Radix work in jsdom at all", which the
    // plan assumed needed a pile of shims and which the Task 2 drill showed it
    // does not — see tests/support/dom.tsx.
    const { container, unmount } = await mount(
      <Dialog>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Preview</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(document.body.textContent).not.toContain('Preview')

    await click(container.querySelector('button'))

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Preview')
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    await unmount()
  })
})
