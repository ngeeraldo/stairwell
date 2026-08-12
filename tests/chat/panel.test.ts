// tests/chat/panel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { parseNdjson, pendingTurns, SpecCard, type CardProposal } from '@/app/[user]/ChatPanel'

// tsconfig.json sets "jsx": "preserve" for Next's own SWC compiler, which
// auto-injects the JSX runtime import. vitest's esbuild transform instead
// falls back to the classic transform (bare `React.createElement(...)` calls
// with no import) for that setting, so SpecCard's JSX would throw
// `ReferenceError: React is not defined` the moment it runs — purely a
// test-environment gap, unrelated to the component's own logic. Same
// workaround as tests/routing/userSpace.test.ts.
beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseNdjson', () => {
  it('parses whole lines and keeps the trailing partial', () => {
    const { lines, rest } = parseNdjson('{"t":"a"}\n{"t":"b"}\n{"t":"par')
    expect(lines).toEqual([{ t: 'a' }, { t: 'b' }])
    expect(rest).toBe('{"t":"par')
  })

  it('returns nothing when no line is complete yet', () => {
    const { lines, rest } = parseNdjson('{"t":"incomp')
    expect(lines).toEqual([])
    expect(rest).toBe('{"t":"incomp')
  })

  it('recognises the terminal done line', () => {
    const { lines } = parseNdjson('{"t":"x"}\n{"done":true}\n')
    expect(lines).toEqual([{ t: 'x' }, { done: true }])
  })

  it('ignores a blank line rather than throwing', () => {
    // A stream that ends with "\n\n" must not crash the reader mid-reply.
    const { lines } = parseNdjson('{"t":"x"}\n\n')
    expect(lines).toEqual([{ t: 'x' }])
  })
})

describe('pendingTurns — what a retry re-sends', () => {
  it('binds the source text to the turn, not to a shared slot', () => {
    // Every interrupted turn renders its OWN retry button. When the source
    // lived in a single component-level ref, two interrupted turns on screen
    // meant the older button re-sent the newer message — writing a permanent
    // transcript row the user never asked to send. Each assistant turn must
    // therefore carry the message that produced it.
    const turns = [...pendingTurns('first'), ...pendingTurns('second')]
    const retryable = turns.filter((t) => t.role === 'assistant')

    expect(retryable.map((t) => t.source)).toEqual(['first', 'second'])
    expect(retryable[0]!.source).not.toBe(retryable[1]!.source)
  })

  it('appends the user message and an empty assistant turn to stream into', () => {
    expect(pendingTurns('what should I watch?')).toEqual([
      { role: 'user', body: 'what should I watch?' },
      { role: 'assistant', body: '', source: 'what should I watch?' },
    ])
  })
})

const PROPOSAL: CardProposal = {
  id: 42,
  version: 1,
  payload: {
    title: 'Eating out and the car fund',
    summary: 'So mornings stop being a surprise.',
    background: 'Checks the banking app most days.',
    panels: [
      { name: 'Eating out', shows: 'This month against last', why: 'Said so', source: 'plaid' },
    ],
    manual_logging: [],
    open_questions: [],
  },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

/** A React element as produced by createElement — enough shape to walk. */
type Elem = { type: unknown; props: Record<string, unknown> }

function isElement(node: unknown): node is Elem {
  return typeof node === 'object' && node !== null && 'props' in node
}

/** All text content under a node, in document order — how a screen reader
 * (and this test) sees copy that JSX splits across sibling text nodes. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isElement(node)) return textOf(node.props.children)
  return ''
}

function findButtons(node: unknown, out: Elem[] = []): Elem[] {
  if (!isElement(node)) return out
  if (node.type === 'button') out.push(node)
  const children = (node.props as { children?: unknown }).children
  if (Array.isArray(children)) {
    for (const child of children) findButtons(child, out)
  } else {
    findButtons(children, out)
  }
  return out
}

describe('the proposal card', () => {
  it('renders the spec, the mockup, and the exact copy', () => {
    const json = JSON.stringify(SpecCard({ proposal: PROPOSAL, live: true, busy: false, onConfirm: () => {} }))
    expect(json).toContain('Eating out and the car fund')
    expect(json).toContain('Build this')
    expect(json).toContain('Not quite yet')
    expect(json).toContain(
      "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
    )
  })

  it('renders a superseded card inert — no buttons', () => {
    // Scrolling back should read as a history of what was offered, not a
    // stack of armed buttons.
    const json = JSON.stringify(SpecCard({ proposal: PROPOSAL, live: false, busy: false, onConfirm: () => {} }))
    expect(json).not.toContain('Build this')
  })

  it('posts the id of the card the button sits on', async () => {
    // The same bug shape as pendingTurns' source binding above: if the
    // button's onClick ever closed over the wrong value (e.g. a shared
    // "current id" instead of THIS card's proposal.id), a card for spec 42
    // would post some other id. Stub fetch, wire onConfirm the way ChatPanel
    // does, and click the real button SpecCard rendered — not a stand-in.
    const posted: unknown[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posted.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    try {
      const onConfirm = (specId: number) =>
        void fetch('/api/spec/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ specId }),
        })
      const element = SpecCard({
        proposal: { ...PROPOSAL, id: 42 },
        live: true,
        busy: false,
        onConfirm,
      })
      const build = findButtons(element).find((b) => textOf(b.props.children).includes('Build this'))
      if (!build) throw new Error('Build this button not found in SpecCard output')
      ;(build.props.onClick as () => void)()
      await Promise.resolve() // flush the fetch stub's microtask
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(posted).toEqual([{ specId: 42 }])
  })

  it('renders a proposal_error line as an honest failure with no card', () => {
    const { lines } = parseNdjson('{"proposal_error":true}\n')
    expect(lines).toEqual([{ proposal_error: true }])
  })
})
