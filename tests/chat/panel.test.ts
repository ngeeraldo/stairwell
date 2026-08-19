// tests/chat/panel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  applyLine,
  applyTurn,
  finishTurn,
  parseNdjson,
  pendingTurns,
  Timeline,
  startTurn,
  TurnRow,
  scrollToNewest,
  type PanelState,
} from '@/app/[user]/ChatPanel'
import { HEARTBEAT_LINE } from '@/lib/chat/heartbeat'

// tsconfig.json sets "jsx": "preserve" for Next's own SWC compiler, which
// auto-injects the JSX runtime import. vitest's esbuild transform instead
// falls back to the classic transform (bare `React.createElement(...)` calls
// with no import) for that setting, so Timeline/TurnRow's JSX would throw
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
    const turns = [...pendingTurns('first', 1000), ...pendingTurns('second', 1000)]
    const retryable = turns.filter((t) => t.role === 'assistant')

    expect(retryable.map((t) => t.source)).toEqual(['first', 'second'])
    expect(retryable[0]!.source).not.toBe(retryable[1]!.source)
  })

  it('appends the user message and an empty assistant turn to stream into', () => {
    // The assistant turn is stamped one millisecond later, so a reply can
    // never sort above the message it is replying to when both land in the
    // same tick.
    expect(pendingTurns('what should I watch?', 1000)).toEqual([
      { role: 'user', body: 'what should I watch?', at: 1000 },
      { role: 'assistant', body: '', source: 'what should I watch?', at: 1001 },
    ])
  })
})

const EMPTY_PANEL: PanelState = {
  turns: [],
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

/**
 * Every button on a turn row (e.g. Retry, Reload). Matches shadcn's `Button`
 * component as well as a raw `<button>`, because the row renders the former —
 * a walker looking only for the string 'button' finds nothing and every
 * assertion built on it passes vacuously, which is the failure mode this
 * suite keeps catching in itself.
 */
function findButtons(node: unknown, out: Elem[] = []): Elem[] {
  if (!isElement(node)) return out
  const isButton =
    node.type === 'button' ||
    (typeof node.type === 'function' && (node.type as { name?: string }).name === 'Button')
  if (isButton) {
    out.push(node)
  }
  const children = (node.props as { children?: unknown }).children
  if (Array.isArray(children)) {
    for (const child of children) findButtons(child, out)
  } else {
    findButtons(children, out)
  }
  return out
}

describe('scrollToNewest', () => {
  it('puts the bottom of the list in view', () => {
    const el = { scrollTop: 0, scrollHeight: 4000 }
    scrollToNewest(el)
    expect(el.scrollTop).toBe(4000)
  })

  it('does nothing when there is no list yet', () => {
    // The ref is null on the render before the <ol> exists, and a chat that
    // threw on first paint would be a worse bug than the one this fixes.
    expect(() => scrollToNewest(null)).not.toThrow()
  })
})

describe('Timeline', () => {
  it('renders turns in their own array order — no merge needed for one list', () => {
    // buildTimeline (lib/chat/timeline.ts) used to merge turns with proposal
    // cards and confirmation events, each stamped with its own `at`. Both are
    // gone from this surface, so Timeline renders `turns` directly rather
    // than folding a single list through a three-way merge.
    const html = JSON.stringify(
      Timeline({
        turns: [
          { role: 'user', body: 'FIRST TURN TEST', at: 100 },
          { role: 'assistant', body: 'SECOND TURN TEST', at: 200 },
        ],
        busy: false,
        onRetry: () => {},
      }),
    )
    expect(html.indexOf('FIRST TURN TEST')).toBeLessThan(html.indexOf('SECOND TURN TEST'))
  })

  it('renders the thinking indicator after the turns', () => {
    // Timeline nests <ThinkingRow /> as JSX rather than calling it as a plain
    // function, so JSON.stringify on the bare element tree would leave that
    // child unexpanded (its `type` is a function, dropped by JSON.stringify).
    // renderToStaticMarkup performs a real render pass instead.
    const html = renderToStaticMarkup(
      Timeline({
        turns: [{ role: 'user', body: 'hi', at: 100 }],
        busy: true,
        thinking: true,
        onRetry: () => {},
      }),
    )
    expect(html).toContain('data-role="thinking"')
  })
})

describe('TurnRow', () => {
  it('renders the interrupted marker and a retry button', () => {
    const row = TurnRow({
      turn: { role: 'assistant', body: 'partial', at: 1000, interrupted: true, source: 'hi' },
      busy: false,
      onRetry: () => {},
    })
    const json = JSON.stringify(row)
    expect(json).toContain('interrupted — not saved')
    expect(findButtons(row)).toHaveLength(1)
  })

  it('blames our end, not the connection, when the turn failed upstream', () => {
    const row = TurnRow({
      turn: { role: 'assistant', body: '', at: 1000, interrupted: true, failed: true, source: 'hi' },
      busy: false,
      onRetry: () => {},
    })
    const json = JSON.stringify(row)

    expect(json).toContain('something went wrong on my end')
    // Not the connection wording — that is what sent a friend to check their
    // wifi while Anthropic was overloaded. The data-interrupted ATTRIBUTE is
    // still true and still useful (the stream really did stop); it is the
    // sentence a person reads that must not blame their network.
    expect(json).not.toContain('interrupted — not saved')
    // Retry, not Reload: nothing was written, so re-sending is correct here.
    expect(json).toContain('Retry')
    expect(json).not.toContain('Reload')
  })

  it('applyLine marks the turn failed', () => {
    const waiting: PanelState = {
      ...EMPTY_PANEL,
      turns: [{ role: 'assistant', body: '', at: 1000 }],
    }
    const failed = applyLine(waiting, { turn_failed: true })
    expect(failed.turns[0]?.failed).toBe(true)
  })

  it('tells a SAVED interrupted turn apart from a lost one', () => {
    // THE LIE THIS FIXES. On 2026-08-18 a friend was told "interrupted — not
    // saved" about transcripts row 150, which was committed and is still
    // there. `interrupted` means the stream stopped; only `saved` says whether
    // anything survived.
    const row = TurnRow({
      turn: {
        role: 'assistant',
        body: 'Dropped. Give me about a minute to draw this up.',
        at: 1000,
        interrupted: true,
        saved: true,
        source: 'hi',
      },
      busy: false,
      onRetry: () => {},
    })
    const json = JSON.stringify(row)

    expect(json).not.toContain('not saved')
    expect(json).toContain('the reply is still there')
    // Reload, never Retry: the message is already in an append-only table and
    // the reply already exists, so re-sending duplicates a row for an answer
    // that came back.
    expect(json).toContain('Reload')
    expect(json).not.toContain('Retry')
  })

  it('does not dim a saved turn\'s text', () => {
    // Greying the body out says "this was never real". For a saved turn the
    // body is in `transcripts`, and dimming it would contradict the line
    // underneath saying so.
    const saved = JSON.stringify(
      TurnRow({
        turn: { role: 'assistant', body: 'kept', at: 1000, interrupted: true, saved: true },
        busy: false,
        onRetry: () => {},
      }),
    )
    const lost = JSON.stringify(
      TurnRow({
        turn: { role: 'assistant', body: 'kept', at: 1000, interrupted: true },
        busy: false,
        onRetry: () => {},
      }),
    )

    expect(saved).not.toContain('opacity')
    expect(lost).toContain('opacity')
  })

  it('renders nothing extra for a turn that was not interrupted', () => {
    const row = TurnRow({ turn: { role: 'assistant', body: 'done', at: 1000 }, busy: false, onRetry: () => {} })
    expect(JSON.stringify(row)).not.toContain('interrupted')
  })

  it('makes the speaker VISIBLE, not just machine-readable', () => {
    // data-role was the only thing separating the two, which means a friend
    // reading their own interview saw one undifferentiated column of text.
    // This asserts the two roles render DIFFERENTLY — not the exact classes,
    // which are a design choice somebody should be free to change — plus the
    // one property the difference has to have: the user's turn is the one in
    // a bubble, and the agent's is plain.
    const props = { busy: false, onRetry: () => {} }
    const userRow = JSON.stringify(
      TurnRow({ turn: { role: 'user', body: 'A QUESTION TEST', at: 100 }, ...props }),
    )
    const agentRow = JSON.stringify(
      TurnRow({ turn: { role: 'assistant', body: 'AN ANSWER TEST', at: 200 }, ...props }),
    )

    expect(userRow).toContain('data-role')
    expect(agentRow).toContain('data-role')
    // The bubble, on one side only. bg-chat-user rather than bg-muted: muted
    // is 0.97 neutral on a 0.98 neutral background, a difference you can
    // measure and cannot see, which is what the first version shipped.
    expect(userRow).toContain('rounded-2xl')
    expect(userRow).toContain('bg-chat-user')
    expect(agentRow).not.toContain('rounded-2xl')
    expect(agentRow).not.toContain('bg-chat-user')
  })

  it('keeps the blank lines the agent wrote', () => {
    // Not cosmetic. The agent's replies contain paragraph breaks, and HTML
    // collapses every run of whitespace into one space — so a structured
    // answer arrived as a single unbroken block. whitespace-pre-wrap is what
    // makes the rendered turn agree with the stored transcript, on BOTH roles.
    const props = { busy: false, onRetry: () => {} }
    for (const role of ['user', 'assistant'] as const) {
      const row = JSON.stringify(TurnRow({ turn: { role, body: 'a\n\nb', at: 1 }, ...props }))
      expect(row).toContain('whitespace-pre-wrap')
    }
  })
})

describe('applyLine / finishTurn / applyTurn — panel state transitions', () => {
  it('ignores a heartbeat line completely — it is not text, and it is not a state change', () => {
    // The server puts a byte on the wire every few seconds during authoring
    // (lib/chat/heartbeat.ts). It must be inert here: appended to no turn's
    // body, and changing no field. A heartbeat that leaked into `t` would
    // write "{}" into the friend's reply on screen.
    const beaten = applyLine(EMPTY_PANEL, HEARTBEAT_LINE)
    expect(beaten).toEqual(EMPTY_PANEL)
  })

  it('a heartbeat is not mistaken for the terminal done line', () => {
    // If it were, a stream that really did die mid-authoring would render as a
    // completed turn — the exact opposite of the marker bug, and worse.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const state = applyTurn(seeded, [{ t: 'partial' }, HEARTBEAT_LINE])
    expect(state.turns.at(-1)?.interrupted).toBe(true)
  })

  it('a turn whose stream carried heartbeats still completes normally', () => {
    // applyTurn folds the same primitives send()'s read loop calls, so this is
    // the real per-line path with beats interleaved where they really land.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const state = applyTurn(seeded, [
      { t: 'Dropped. ' },
      HEARTBEAT_LINE,
      HEARTBEAT_LINE,
      { done: true },
    ])
    expect(state.turns.at(-1)?.body).toBe('Dropped. ')
    expect(state.turns.at(-1)?.interrupted).toBeUndefined()
  })

  it('a saved line marks the turn durable, and finishTurn keeps that through an interrupt', () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: 'hi', at: 1000 }] }
    const saved = applyLine(seeded, { saved: true })
    expect(saved.turns[0]?.saved).toBe(true)

    // The connection then dies: interrupted AND saved, which is the
    // combination the renderer reads to stop claiming nothing landed.
    const dropped = finishTurn(saved, false)
    expect(dropped.turns[0]?.interrupted).toBe(true)
    expect(dropped.turns[0]?.saved).toBe(true)
  })

  it('leaves saved unset when no saved line ever arrived', () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const dropped = finishTurn(seeded, false)
    expect(dropped.turns[0]?.interrupted).toBe(true)
    expect(dropped.turns[0]?.saved).toBeUndefined()
  })

  it('finishTurn marks the last turn interrupted only when done never arrived', () => {
    const state: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: 'partial', at: 1000 }] }
    expect(finishTurn(state, false).turns[0]?.interrupted).toBe(true)
    expect(finishTurn(state, true).turns[0]?.interrupted).toBeUndefined()
  })

  it('startTurn appends the pending user/assistant exchange', () => {
    const state = startTurn(EMPTY_PANEL, 'hello', 1000)
    expect(state.turns).toEqual([
      { role: 'user', body: 'hello', at: 1000 },
      { role: 'assistant', body: '', source: 'hello', at: 1001 },
    ])
  })
})
