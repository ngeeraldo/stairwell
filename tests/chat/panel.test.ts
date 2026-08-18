// tests/chat/panel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatPanel, {
  applyLine,
  applyTurn,
  attemptConfirm,
  confirmRequest,
  DELIVERY_CHANGE,
  DELIVERY_FIRST,
  finishTurn,
  parseNdjson,
  pendingTurns,
  ProposalRegion,
  Timeline,
  SpecCard,
  startTurn,
  TurnRow,
  scrollToNewest,
  withLiveness,
  type CardProposal,
  type PanelState,
} from '@/app/[user]/ChatPanel'
import type { SpecVersion } from '@/lib/spec/schema'
import { CSP_META } from '@/lib/spec/banner'
import { HEARTBEAT_LINE } from '@/lib/chat/heartbeat'

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
    const turns = [...pendingTurns('first', 1000), ...pendingTurns('second', 1000)]
    const retryable = turns.filter((t) => t.role === 'assistant')

    expect(retryable.map((t) => t.source)).toEqual(['first', 'second'])
    expect(retryable[0]!.source).not.toBe(retryable[1]!.source)
  })

  it('appends the user message and an empty assistant turn to stream into', () => {
    // The assistant turn is stamped one millisecond later, so a reply can
    // never sort above the message it is replying to when both land in the
    // same tick (lib/chat/timeline.ts).
    expect(pendingTurns('what should I watch?', 1000)).toEqual([
      { role: 'user', body: 'what should I watch?', at: 1000 },
      { role: 'assistant', body: '', source: 'what should I watch?', at: 1001 },
    ])
  })
})

const PROPOSAL: CardProposal = {
  id: 42,
  version: 1,
  at: 1_000_001,
  spec: {
    kind: 'legacy',
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
  },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
  preview_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

/**
 * A pre-unification row, in the exact shape a friend's `specs` table already
 * holds for real. `specs` rejects UPDATE, so these keep arriving at this card
 * forever — the legacy arm is not a transitional courtesy.
 */
const LEGACY_PROPOSAL: CardProposal = {
  id: 7,
  version: 1,
  at: 1_000_001,
  spec: {
    kind: 'legacy',
    payload: {
      title: 'Did I walk the dog today?',
      summary: 'A one-tap tracker.',
      background: 'Pivoted from weather TEST.',
      panels: [
        { name: 'Walked today?', shows: 'Yes/no', why: 'They asked', source: 'manual' },
      ],
      manual_logging: ['One tap per day.'],
      open_questions: [],
    },
  },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
  preview_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

function walkedTodayPanel() {
  return {
    id: 'walked_today',
    title: 'Walked today?',
    intent: 'Did I walk the dog?',
    display: 'Yes/no with a tap.',
    context_of_use: null,
    values: [
      { kind: 'entered' as const, id: 'walk_flag', description: 'One tap per day.' },
    ],
    entry: null,
  }
}

function streakPanel() {
  return {
    id: 'streak',
    title: 'Current streak',
    intent: 'Keep the run going.',
    display: 'A day count.',
    context_of_use: null,
    values: [
      {
        kind: 'derived' as const,
        id: 'streak_days',
        description: 'Consecutive walked days.',
        inputs: ['walk_flag'],
      },
    ],
    entry: null,
  }
}

const VERSION: SpecVersion = {
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather TEST.',
  change_summary: 'Added a streak.',
  based_on_version: 1,
  ops: null,
  screens: [{ id: 'today', title: 'Today', order: 1, panels: [walkedTodayPanel()] }],
  data_requirements: [],
  open_questions: [],
}

const VERSION_PROPOSAL: CardProposal = {
  id: 43,
  version: 2,
  at: 1_000_002,
  spec: { kind: 'version', version: VERSION },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
  preview_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

/**
 * Two screens, so "lists every panel" cannot be satisfied by walking only the
 * first screen — the bug a single-screen fixture could never see.
 *
 * Stored with `order` DISAGREEING with array position, on purpose: nothing
 * stops a model emitting screens in some other sequence, and the card, the
 * admin pane and spec.md must all read the proposal the same way round.
 */
const TWO_SCREEN_PROPOSAL: CardProposal = {
  id: 44,
  version: 3,
  at: 1_000_003,
  spec: {
    kind: 'version',
    version: {
      ...VERSION,
      screens: [
        { id: 'history', title: 'History', order: 2, panels: [streakPanel()] },
        { id: 'today', title: 'Today', order: 1, panels: [walkedTodayPanel()] },
      ],
    },
  },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
  preview_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
}

const noop = () => {}

/**
 * renderToStaticMarkup escapes text content, so `it'll` reaches the markup as
 * `it&#x27;ll` — a raw `toContain(DELIVERY_FIRST)` would fail against a page
 * that renders the sentence perfectly. Decode instead of weakening the
 * assertion to some apostrophe-free fragment: the point of these tests is the
 * WHOLE sentence, byte for byte.
 */
function htmlText(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const EMPTY_PANEL: PanelState = {
  turns: [],
  proposals: [],
  authoring: false,
  authoringStage: null,
  proposalError: false,
  confirmError: false,
  confirmations: [],
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
 * Every CONFIRM control on a card.
 *
 * It matches shadcn's `Button` component as well as a raw `<button>`, because
 * the card renders the former now — a walker looking only for the string
 * 'button' finds nothing and every assertion built on it passes vacuously,
 * which is the failure mode this suite keeps catching in itself.
 *
 * It also EXCLUDES the chrome controls: "View full screen" opens a dialog and
 * "Details" toggles a disclosure. Neither confirms anything, and counting them
 * would make "an inert card has no buttons" false for a card that is inert.
 */
const CHROME_LABELS = ['View full screen', 'Details', 'Close']

function findButtons(node: unknown, out: Elem[] = []): Elem[] {
  if (!isElement(node)) return out
  const isButton =
    node.type === 'button' ||
    (typeof node.type === 'function' && (node.type as { name?: string }).name === 'Button')
  if (isButton && !CHROME_LABELS.includes(textOf((node.props as { children?: unknown }).children).trim())) {
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

describe('the proposal card', () => {
  it('renders the spec, the mockup, and the exact copy', () => {
    const json = JSON.stringify(
      SpecCard({ proposal: PROPOSAL, live: true, busy: false, first: true, onConfirm: noop }),
    )
    expect(json).toContain('Eating out and the car fund')
    expect(json).toContain('Build this')
    expect(json).toContain('Not quite yet')
    expect(json).toContain(
      "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
    )
  })

  it('renders a superseded card inert — genuinely no buttons, not just no "Build this" text', () => {
    // Scrolling back should read as a history of what was offered, not a
    // stack of armed buttons. Asserting `not.toContain('Build this')` alone
    // would still pass if "Not quite yet" survived, or if the whole card
    // vanished — neither of which is the property this test means to pin.
    const element = SpecCard({
      proposal: PROPOSAL,
      live: false,
      busy: false,
      first: true,
      onConfirm: noop,
    })
    expect(findButtons(element)).toEqual([])
  })

  it('states the fact on a confirmed card and leaves the timeframe to the agent', () => {
    // INVERTED 2026-08-14. This test used to require the opposite, on the
    // reasoning that a friend reloading later should still see the timeframe —
    // sound while nothing else spoke after a confirmation. The agent now sees
    // confirmations (lib/chat/confirmations.ts) and agent-v4.md's "After they
    // confirm" makes those commitments its job, so the card repeating them
    // would be a second copy of a promise, free to drift from the first.
    const json = JSON.stringify(
      SpecCard({
        proposal: { ...PROPOSAL, confirmed: true },
        live: true,
        busy: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(json).toContain('Building this one.')
    expect(json).not.toContain(
      "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
    )
  })

  it('leads a current-shape card with what changed, not with the summary', () => {
    // The one-word relabel case is the whole reason the unified loop exists:
    // a friend re-reading their own card needs "what did I just ask for"
    // before "what is this dashboard", or the change is buried in copy they
    // already read last time.
    const html = renderToStaticMarkup(
      SpecCard({
        proposal: VERSION_PROPOSAL,
        live: true,
        busy: false,
        first: false,
        onConfirm: noop,
      }),
    )
    expect(html.indexOf('Added a streak')).toBeLessThan(html.indexOf('A one-tap tracker'))
  })

  it('lists every panel of a current-shape card, across screens', () => {
    const html = renderToStaticMarkup(
      SpecCard({
        proposal: TWO_SCREEN_PROPOSAL,
        live: true,
        busy: false,
        first: false,
        onConfirm: noop,
      }),
    )
    expect(html).toContain('Walked today?')
    expect(html).toContain('Current streak')
    // ...and in `order`, not in whatever sequence the model happened to emit.
    // The admin pane and spec.md both sort by `order`; a card that did not
    // would show the friend a different proposal from the one being built.
    expect(html.indexOf('Walked today?')).toBeLessThan(html.indexOf('Current streak'))
  })

  it('still renders a legacy card exactly as before', () => {
    // `specs` rejects UPDATE, so a pre-unification row can never be rewritten
    // into the current shape. This arm has no end date.
    const html = renderToStaticMarkup(
      SpecCard({
        proposal: LEGACY_PROPOSAL,
        live: true,
        busy: false,
        first: false,
        onConfirm: noop,
      }),
    )
    expect(html).toContain('Did I walk the dog today?')
    expect(html).toContain('Walked today?')
  })

  it('promises tomorrow morning on a first dashboard', () => {
    const text = htmlText(
      renderToStaticMarkup(
        SpecCard({
          proposal: VERSION_PROPOSAL,
          live: true,
          busy: false,
          first: true,
          onConfirm: noop,
        }),
      ),
    )
    expect(text).toContain(DELIVERY_FIRST)
    expect(text).not.toContain(DELIVERY_CHANGE)
  })

  it('promises a few hours on a later change', () => {
    // The card must not tell someone their one-word relabel arrives tomorrow
    // morning when the agent just said small changes land within hours.
    const text = htmlText(
      renderToStaticMarkup(
        SpecCard({
          proposal: VERSION_PROPOSAL,
          live: true,
          busy: false,
          first: false,
          onConfirm: noop,
        }),
      ),
    )
    expect(text).toContain(DELIVERY_CHANGE)
    expect(text).not.toContain(DELIVERY_FIRST)
  })

  it('makes the promise on the LIVE card and hands the rest to the agent', () => {
    // CHANGED 2026-08-14, and the direction matters. The confirmed card used
    // to repeat the timeframe on the reasoning that a friend reloading later
    // should still see it. That held while nothing else spoke after a
    // confirmation — but the agent now SEES confirmations
    // (lib/chat/confirmations.ts) and agent-v4.md's "After they confirm" makes
    // those two commitments its job, in its own words. Two copies of one
    // promise are two things that can drift, which is the argument
    // lib/copy/onboarding.ts makes about the promise block.
    //
    // The live card keeps its line: that is the promise a friend reads BEFORE
    // deciding, and nothing else says it at the moment the decision is made.
    for (const first of [true, false]) {
      const line = first ? DELIVERY_FIRST : DELIVERY_CHANGE
      const live = htmlText(
        renderToStaticMarkup(
          SpecCard({
            proposal: VERSION_PROPOSAL,
            live: true,
            busy: false,
            first,
            onConfirm: noop,
          }),
        ),
      )
      const done = htmlText(
        renderToStaticMarkup(
          SpecCard({
            proposal: { ...VERSION_PROPOSAL, confirmed: true },
            live: false,
            busy: false,
            first,
            onConfirm: noop,
          }),
        ),
      )
      expect(live).toContain(line)
      expect(done).not.toContain(line)
      // It still says the thing that IS the card's own job: what state it is in.
      expect(done).toContain('Building this one.')
    }
  })

  it('keeps the first-dashboard wording byte-identical to what shipped in step 4', () => {
    // The behaviour-preserving requirement, pinned. This is the most
    // load-bearing promise in the pilot and it is made at the exact moment the
    // friend decides.
    expect(DELIVERY_FIRST).toBe(
      "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning.",
    )
  })

  it('shows a plain, brief failure when a confirm attempt did not succeed — no invented promise', () => {
    const json = JSON.stringify(
      SpecCard({
        proposal: PROPOSAL,
        live: true,
        busy: false,
        first: true,
        confirmError: true,
        onConfirm: noop,
      }),
    )
    expect(json).toContain("didn't go through")
    // No "we'll notify you" / no new promise invented on top of the one the
    // delivery line already makes.
    expect(json).not.toMatch(/let you know|notify/i)
  })

  describe('confirmRequest — the real POST a click makes', () => {
    it('posts to /api/spec/confirm with the specId body key the server expects', () => {
      const { url, init } = confirmRequest(42)
      expect(url).toBe('/api/spec/confirm')
      expect(init.method).toBe('POST')
      expect(JSON.parse(String(init.body))).toEqual({ specId: 42 })
    })
  })

  describe('attemptConfirm — never silently swallows a result', () => {
    it('resolves true on a 2xx response', async () => {
      const fakeFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch
      await expect(attemptConfirm(42, fakeFetch)).resolves.toBe(true)
    })

    it('resolves false — not silence — on a non-ok response (e.g. a superseded 409)', async () => {
      const fakeFetch = (async () => new Response(null, { status: 409 })) as typeof fetch
      await expect(attemptConfirm(42, fakeFetch)).resolves.toBe(false)
    })

    it('resolves false on a network failure, rather than throwing', async () => {
      const fakeFetch = (async () => {
        throw new Error('offline')
      }) as typeof fetch
      await expect(attemptConfirm(42, fakeFetch)).resolves.toBe(false)
    })
  })

  it('posts the id of the card the button sits on, via the real confirm request', async () => {
    // The same bug shape as pendingTurns' source binding above: if the
    // button's onClick ever closed over the wrong value (e.g. a shared
    // "current id" instead of THIS card's proposal.id), a card for spec 42
    // would post some other id. This drives SpecCard's REAL onClick and
    // attemptConfirm's REAL request-building — nothing here re-implements
    // the POST inside the test body.
    const posted: { url: string; method: string | undefined; body: unknown }[] = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    let confirming: Promise<boolean> | undefined
    const onConfirm = (specId: number) => {
      confirming = attemptConfirm(specId, fakeFetch)
    }
    const element = SpecCard({
      proposal: { ...PROPOSAL, id: 42 },
      live: true,
      busy: false,
      first: true,
      onConfirm,
    })
    const build = findButtons(element).find((b) => textOf(b.props.children).includes('Build this'))
    if (!build) throw new Error('Build this button not found in SpecCard output')
    ;(build.props.onClick as () => void)()
    await confirming

    expect(posted).toEqual([{ url: '/api/spec/confirm', method: 'POST', body: { specId: 42 } }])
  })
})

describe('withLiveness — only the newest proposal is confirmable', () => {
  it('marks the older of two proposals inert and the newer one live', () => {
    const older = { ...PROPOSAL, id: 42 }
    const newer = { ...PROPOSAL, id: 43 }
    const withLive = withLiveness([older, newer])

    expect(withLive).toEqual([
      { proposal: older, live: false },
      { proposal: newer, live: true },
    ])

    // And prove it through the actual card render, not just the flag: the
    // older card must carry zero buttons, the newer one the full pair.
    const olderCard = SpecCard({ ...withLive[0]!, busy: false, first: true, onConfirm: noop })
    const newerCard = SpecCard({ ...withLive[1]!, busy: false, first: true, onConfirm: noop })
    expect(findButtons(olderCard)).toEqual([])
    expect(findButtons(newerCard)).toHaveLength(2)
  })

  it('is insensitive to array order — "newest" means highest id, not "last in the list"', () => {
    const older = { ...PROPOSAL, id: 42 }
    const newer = { ...PROPOSAL, id: 43 }
    expect(withLiveness([newer, older])).toEqual([
      { proposal: newer, live: true },
      { proposal: older, live: false },
    ])
  })
})


/**
 * ProposalRegion stopped rendering cards in the timeline change (onboarding
 * ledger D5): they are merged into the conversation by `Timeline` now, so they
 * appear where they happened rather than in a block below everything.
 *
 * These call sites were written to pin JSX PLUMBING — that `live` is threaded
 * per card, that `first` reaches every card — and that plumbing simply moved.
 * Routing them here keeps the properties pinned at their new home instead of
 * deleting tests that still describe something true.
 */
function cards(props: {
  authoring?: boolean
  proposalError?: boolean
  proposals: CardProposal[]
  confirming: boolean
  confirmError: boolean
  first: boolean
  onConfirm: (specId: number) => void
}) {
  return Timeline({
    turns: [],
    proposals: props.proposals,
    confirmations: [],
    busy: false,
    confirming: props.confirming,
    confirmError: props.confirmError,
    first: props.first,
    onConfirm: props.onConfirm,
    onRetry: () => {},
  })
}

describe('ProposalRegion — the authoring wait, an honest failure, and the cards', () => {
  it('names the stage the wait is actually in', () => {
    // One static sentence for a minute reads as a frozen screen. The two
    // stages are real server events — the agent deciding to propose, then the
    // spec validating and the drawing call starting — and the second is where
    // most of the minute goes, which is the thing worth telling someone.
    // renderToStaticMarkup, not JSON.stringify: the copy lives in a child
    // component, which a plain element tree never invokes.
    const writing = htmlText(
      renderToStaticMarkup(
        ProposalRegion({ authoring: true, authoringStage: 'spec', proposalError: false }),
      ),
    )
    expect(writing).toContain('Writing the spec')
    expect(writing).not.toContain('Drawing the preview')

    const drawing = htmlText(
      renderToStaticMarkup(
        ProposalRegion({ authoring: true, authoringStage: 'mockup', proposalError: false }),
      ),
    )
    expect(drawing).toContain('Drawing the preview')
  })

  it('MOVES THE BAR between the two stages, not only the words', () => {
    // WHAT NICO ACTUALLY SEES. The stage pipeline works end to end — author.ts
    // fires it, runTurn forwards it, the route emits it, the panel reads it —
    // and the friend still watches one bar sit at the same width from the
    // first second to the last. Reported as "the progress bar starts and ends
    // at around 1/3 of the width, never moving to 2/3", which is exactly what
    // a fixed `w-40` does in a chat column.
    //
    // A shape that looks like a progress bar and never advances reads as a
    // frozen screen, which is the thing this element was added to prevent. It
    // does not become a dishonest percentage by moving: each step is a REAL
    // server event, and there are exactly two of them, so there are exactly
    // two widths. Nothing crawls, and nothing is interpolated against a timer.
    const markup = (stage: 'spec' | 'mockup') =>
      renderToStaticMarkup(
        ProposalRegion({ authoring: true, authoringStage: stage, proposalError: false }),
      )

    const writing = markup('spec')
    const drawing = markup('mockup')

    // The bar is a different width in the second stage than in the first.
    // Asserted as a difference rather than against literal class names, so
    // restyling the wait does not fail this — only flattening it does.
    const barClass = (html: string) =>
      /class="([^"]*)"[^>]*data-slot="skeleton"|data-slot="skeleton"[^>]*class="([^"]*)"/.exec(
        html,
      )
    expect(barClass(writing)).not.toBeNull()
    expect(barClass(drawing)).not.toBeNull()
    expect(barClass(writing)![0]).not.toBe(barClass(drawing)![0])

    // And it advances rather than retreating: the drawing stage is the later
    // and longer half, so its bar is the wider one.
    const width = (html: string) => {
      const found = /w-\[(\d+)%\]/.exec(barClass(html)![0])
      return found ? Number(found[1]) : NaN
    }
    expect(width(drawing)).toBeGreaterThan(width(writing))
  })

  it('shows a wait even when no stage line has arrived yet', () => {
    // The stage line can lose the race with the authoring line, and a wait
    // with no words at all would be worse than the old static sentence.
    const region = htmlText(
      renderToStaticMarkup(ProposalRegion({ authoring: true, proposalError: false })),
    )
    expect(region).toContain('Writing the spec')
  })

  it('renders a proposal_error line as an honest failure — and adds no card', () => {
    // Fix round 1 finding: the version of this test that only checked
    // parseNdjson's JSON parsing was vacuous — deleting the entire error
    // paragraph AND the proposal_error branch left it green. This drives
    // ProposalRegion itself, the real function ChatPanel renders from.
    const region = ProposalRegion({ authoring: false, proposalError: true })
    const json = JSON.stringify(region)
    expect(json).toContain("Couldn't put together a preview this time")
    expect(json).not.toContain('aria-label="Proposed dashboard"')
    expect(json).not.toContain('data-spec-id')
  })

  it('renders the older of two proposals inert and only the newer one confirmable', () => {
    // Fix round 2: this is finding 2's original mutation (live={live} ->
    // live={true} in ProposalRegion's JSX) at its structural home. The
    // withLiveness describe block above already proves the computation is
    // right; this proves ProposalRegion actually WIRES that computed value
    // into each SpecCard, which is a separate fact — JSX plumbing that a
    // correct helper function does not, by itself, guarantee is used.
    const older = { ...PROPOSAL, id: 42 }
    const newer = { ...PROPOSAL, id: 43 }
    const html = renderToStaticMarkup(
      cards({
        authoring: false,
        proposalError: false,
        proposals: [older, newer],
        confirming: false,
        confirmError: false,
        first: true,
        onConfirm: () => {},
      }),
    )
    // Two <section> cards; split on the marker so each half's assertions
    // can't accidentally match content that belongs to the OTHER card.
    const sections = html.split('<section aria-label="Proposed dashboard"').slice(1)
    expect(sections).toHaveLength(2)
    expect(sections[0]).not.toContain('Build this')
    expect(sections[1]).toContain('Build this')
  })

  it('threads the delivery promise through to every card rather than each card deciding', () => {
    // Exactly the same class of bug as the live={live} -> live={true}
    // mutation pinned just above, on the one line in the product that must
    // never be wrong. Every other delivery test in this file drives SpecCard
    // directly, so hardcoding `first` HERE — the JSX plumbing — reds none of
    // them: a correct SpecCard does not, by itself, guarantee ProposalRegion
    // hands it the page's answer instead of its own guess. Both cards are
    // asserted — the older one confirmed, so it renders the promise through
    // SpecCard's OTHER branch, and a mutation that fixes `first` on only one
    // of the two still reds this.
    // Both cards LIVE-eligible would be a different scenario; here the older
    // is confirmed, so after the 2026-08-14 change only the newer renders a
    // delivery line. The mutation this test exists to kill — ProposalRegion
    // hardcoding `first` instead of threading the page's answer — still reds
    // it, because the line that IS rendered is the wrong one.
    const older = { ...PROPOSAL, id: 42, confirmed: true }
    const newer = { ...PROPOSAL, id: 43 }
    const text = htmlText(
      renderToStaticMarkup(
        cards({
          authoring: false,
          proposalError: false,
          proposals: [older, newer],
          confirming: false,
          confirmError: false,
          first: false,
          onConfirm: noop,
        }),
      ),
    )
    expect(text.split(DELIVERY_CHANGE)).toHaveLength(2)
    expect(text).not.toContain(DELIVERY_FIRST)
  })
})

describe('a card that arrives mid-session carries its own delivery promise', () => {
  it('prefers the streamed card\'s own answer over the page-load one', () => {
    // The whole sequence, in the order it actually happens: the friend
    // confirmed v1 yesterday, so today's page load says first=true (correct
    // for v1's card). They then ask for a one-word relabel, and v2 streams in
    // through the `proposal` line. Only that line knows v2 is a change — the
    // page computed `first` once, before v2 existed, and never re-renders.
    // Driving applyTurn means this goes through the literal per-line reducer
    // send()'s read loop calls, which is the path page-load tests cannot see.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('call it eating out', 1000) }
    const state = applyTurn(seeded, [
      { authoring: true },
      { proposal: { ...VERSION_PROPOSAL, id: 99, first: false } },
      { done: true },
    ])

    const text = htmlText(
      renderToStaticMarkup(
        cards({
          authoring: state.authoring,
          proposalError: state.proposalError,
          proposals: state.proposals,
          confirming: false,
          confirmError: false,
          first: true,
          onConfirm: noop,
        }),
      ),
    )
    expect(text).toContain(DELIVERY_CHANGE)
    expect(text).not.toContain(DELIVERY_FIRST)
  })

  it('falls back to the page-load answer for a card that carries none', () => {
    // The page-load card is built by app/[user]/page.tsx and does carry its
    // own answer, but the streamed one is JSON.parse output cast to a type
    // nothing validates. `undefined` is falsy, so a bare `first ? … : …` would
    // silently pick the CHANGE wording — the wrong promise, on the one
    // sentence in the pilot that must never be wrong. Falling back to the
    // page's server-computed boolean degrades that to "right for the card the
    // page rendered" instead.
    const text = htmlText(
      renderToStaticMarkup(
        SpecCard({
          proposal: VERSION_PROPOSAL,
          live: true,
          busy: false,
          first: true,
          onConfirm: noop,
        }),
      ),
    )
    expect(text).toContain(DELIVERY_FIRST)
  })

  it('lets the live card contradict the page-level answer', () => {
    // v1 (their first dashboard, confirmed) and v2 (a relabel) coexist in the
    // scrollback after a tweak. A single page-level boolean cannot be right
    // for both, which is the defect in one sentence.
    //
    // NARROWED 2026-08-14: only the live card carries a delivery line now, so
    // the property is no longer "two different promises on screen" but "the one
    // promise on screen is the LIVE card's own, not the page's". The mutation
    // this defends against — a hardcoded `first` at the region's call site — is
    // unchanged, because the page here says first=true and the correct render
    // says the opposite.
    const older = { ...VERSION_PROPOSAL, id: 42, first: true, confirmed: true }
    const newer = { ...VERSION_PROPOSAL, id: 43, first: false }
    const text = htmlText(
      renderToStaticMarkup(
        cards({
          authoring: false,
          proposalError: false,
          proposals: [older, newer],
          confirming: false,
          confirmError: false,
          first: true,
          onConfirm: noop,
        }),
      ),
    )
    expect(text).toContain(DELIVERY_CHANGE)
    expect(text).not.toContain(DELIVERY_FIRST)
  })

  describe('ChatPanel wires the page\'s answer into the region', () => {
    // ChatPanel's own <ProposalRegion first={first}> call site was unpinned:
    // every other delivery test drives SpecCard or ProposalRegion directly, so
    // hardcoding `first` HERE reds none of them. ChatPanel uses hooks, so —
    // unlike every other component in this file — it cannot be called as a
    // plain function: React needs to own the render for a dispatcher to exist.
    // createElement + renderToStaticMarkup gives it one. useState works there
    // and useEffect simply never runs, which is fine: the seam is the FIRST
    // render, and the only thing the effect does is read localStorage for the
    // open/closed toggle (default open, which is what this needs).
    //
    // The proposal deliberately carries NO `first` of its own, so the only
    // thing that can decide the wording is the prop being threaded through.
    const pageLoadCard = { ...VERSION_PROPOSAL, confirmed: false }
    const renderPanel = (first: boolean) =>
      htmlText(
        renderToStaticMarkup(
          React.createElement(ChatPanel, { initial: [], proposal: pageLoadCard, first }),
        ),
      )

    it('threads first=true through to the card', () => {
      const text = renderPanel(true)
      expect(text).toContain(DELIVERY_FIRST)
      expect(text).not.toContain(DELIVERY_CHANGE)
    })

    it('threads first=false through to the card', () => {
      const text = renderPanel(false)
      expect(text).toContain(DELIVERY_CHANGE)
      expect(text).not.toContain(DELIVERY_FIRST)
    })
  })
})

describe('the card previews only the affected surface', () => {
  it('renders the scoped preview, not the whole dashboard', () => {
    // Markers coined for this test, not the words "morning"/"money" the brief
    // sketch uses — PROPOSAL's own summary ("So mornings stop being a
    // surprise.") contains "morning" as a substring, which made an earlier
    // draft of this test pass vacuously against the OLD `src="/mockup/…"`
    // iframe that never embeds either field's content at all.
    const json = JSON.stringify(
      SpecCard({
        proposal: {
          ...PROPOSAL,
          preview_html: '<section>affectedscreenmarker</section>',
          mockup_html:
            '<section>affectedscreenmarker</section><section>untouchedscreenmarker</section>',
        },
        live: true,
        busy: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(json).toContain('affectedscreenmarker')
    expect(json).not.toContain('untouchedscreenmarker')
  })

  it('falls back to the whole mockup for a card with no scoped preview', () => {
    // A pre-task-19 shape: the streamed line (or a stale client bundle) can
    // in principle carry no preview_html at all. Undefined is falsy, so this
    // is the same hazard as the `first` fallback just above, on the field
    // this task adds — a card with this screen's content must still show it
    // rather than rendering blank or throwing.
    const { preview_html: _unused, ...legacy } = {
      ...PROPOSAL,
      mockup_html: '<section>wholedashboardmarker</section>',
    }
    const json = JSON.stringify(
      SpecCard({
        proposal: legacy as CardProposal,
        live: true,
        busy: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(json).toContain('wholedashboardmarker')
  })

  // Final review, Important 3. A pre-branch mockup_html never passed through
  // composeMockup, so it carries none of Task 25's meta CSP — this is the
  // same "no scoped preview" fallback as the test above, with an external
  // <img> in the fallback document standing in for the real hazard: a raw,
  // pre-branch document reaching the srcDoc boundary unprotected. withCsp is
  // applied at that boundary (SpecCard's previewHtml) regardless of which
  // arm supplied the html, so the tag must show up here even though this
  // document was never built by composeMockup.
  it('CSP-protects the whole-mockup fallback too, for a pre-branch document with an external reference', () => {
    const { preview_html: _unused, ...legacy } = {
      ...PROPOSAL,
      mockup_html:
        '<!doctype html><html><head></head><body>' +
        '<img src="https://evil.example.test/pixel.png">' +
        '</body></html>',
    }
    const json = JSON.stringify(
      SpecCard({
        proposal: legacy as CardProposal,
        live: true,
        busy: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(json).toContain(JSON.stringify(CSP_META).slice(1, -1))
  })

  // The same defect shape as ledger D9's: a value computed once per page load
  // and applied to cards that stream in later. `preview_html` has to ride on
  // the proposal itself for exactly the reason `first` does — a card proposed
  // mid-conversation arrives through the `proposal` NDJSON line with no page
  // re-render behind it, so anything computed once at page load cannot
  // describe it.
  it("uses each card's own preview when one streams in mid-conversation", () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('call it eating out', 1000) }
    const state = applyTurn(seeded, [
      { authoring: true },
      {
        proposal: {
          ...VERSION_PROPOSAL,
          id: 99,
          preview_html: '<section>onlythemoneyscreen</section>',
          mockup_html: '<section>onlythemoneyscreen</section><section>untouchedgymscreen</section>',
        },
      },
      { done: true },
    ])

    const html = renderToStaticMarkup(
      cards({
        authoring: state.authoring,
        proposalError: state.proposalError,
        proposals: state.proposals,
        confirming: false,
        confirmError: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(html).toContain('onlythemoneyscreen')
    expect(html).not.toContain('untouchedgymscreen')
  })

  it('falls back to the page-load mockup for a streamed card with no preview of its own', () => {
    // Mirrors the `first` fallback test above (the same D9 shape), driven
    // through the real streaming path this time rather than SpecCard
    // directly — proving applyTurn/Timeline carry a preview-less proposal
    // through without ever substituting some OTHER card's value onto it.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('call it eating out', 1000) }
    const { preview_html: _unused, ...streamedProposal } = {
      ...VERSION_PROPOSAL,
      id: 99,
      mockup_html: '<section>wholedashboardfallback</section>',
    }
    const state = applyTurn(seeded, [
      { authoring: true },
      { proposal: streamedProposal },
      { done: true },
    ])

    const html = renderToStaticMarkup(
      cards({
        authoring: state.authoring,
        proposalError: state.proposalError,
        proposals: state.proposals,
        confirming: false,
        confirmError: false,
        first: true,
        onConfirm: noop,
      }),
    )
    expect(html).toContain('wholedashboardfallback')
  })
})

describe('scrollToNewest', () => {
  it('puts the bottom of the list in view', () => {
    // Found by the screenshot review, not by this suite: the friend's chat
    // opened at the TOP of the conversation, so a returning friend landed on
    // their own first message and the proposal card they were meant to press
    // "Build this" on was below the fold. It had been true since the surface
    // was built, and stayed invisible because the shot fixture's transcript
    // was empty until the fixture gained a conversation.
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
    expect(json).toContain('the preview may still be on its way')
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
  it('appends a proposal line without touching authoring/proposalError-unrelated fields', () => {
    const next = applyLine(EMPTY_PANEL, { proposal: PROPOSAL })
    expect(next.proposals).toEqual([PROPOSAL])
    expect(next.authoring).toBe(false)
    expect(next.proposalError).toBe(false)
  })

  it('sets authoring on an authoring line, clears it on a proposal or proposal_error line', () => {
    const waiting = applyLine(EMPTY_PANEL, { authoring: true })
    expect(waiting.authoring).toBe(true)

    const proposed = applyLine(waiting, { proposal: PROPOSAL })
    expect(proposed.authoring).toBe(false)

    const failed = applyLine(waiting, { proposal_error: true })
    expect(failed.authoring).toBe(false)
    expect(failed.proposalError).toBe(true)
  })

  it('ignores a heartbeat line completely — it is not text, and it is not a state change', () => {
    // The server now puts a byte on the wire every few seconds during the
    // authoring wait (lib/chat/heartbeat.ts). It must be inert here: appended
    // to no turn's body, and changing no field. A heartbeat that leaked into
    // `t` would write "{}" into the friend's reply on screen.
    const waiting = applyLine(EMPTY_PANEL, { authoring: true })
    const beaten = applyLine(waiting, HEARTBEAT_LINE)
    expect(beaten).toEqual(waiting)
  })

  it('a heartbeat is not mistaken for the terminal done line', () => {
    // If it were, a stream that really did die mid-authoring would render as a
    // completed turn — the exact opposite of the marker bug, and worse: it
    // would claim a proposal was coming that never arrives.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const state = applyTurn(seeded, [
      { t: 'partial' },
      { authoring: true },
      HEARTBEAT_LINE,
    ])
    expect(state.turns.at(-1)?.interrupted).toBe(true)
  })

  it('a turn whose stream carried heartbeats still completes normally', () => {
    // applyTurn folds the same primitives send()'s read loop calls, so this is
    // the real per-line path with beats interleaved where they really land.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const state = applyTurn(seeded, [
      { t: 'Dropped. ' },
      HEARTBEAT_LINE,
      { authoring: true },
      HEARTBEAT_LINE,
      HEARTBEAT_LINE,
      { proposal: PROPOSAL },
      { done: true },
    ])
    expect(state.turns.at(-1)?.body).toBe('Dropped. ')
    expect(state.turns.at(-1)?.interrupted).toBeUndefined()
    expect(state.proposals).toEqual([PROPOSAL])
    expect(state.authoring).toBe(false)
  })

  it('a saved line marks the turn durable, and finishTurn keeps that through an interrupt', () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: 'hi', at: 1000 }] }
    const saved = applyLine(seeded, { saved: true })
    expect(saved.turns[0]?.saved).toBe(true)

    // The connection then dies during authoring: interrupted AND saved, which
    // is the combination the renderer reads to stop claiming nothing landed.
    const dropped = finishTurn(saved, false)
    expect(dropped.turns[0]?.interrupted).toBe(true)
    expect(dropped.turns[0]?.saved).toBe(true)
  })

  it('leaves saved unset when no saved line ever arrived', () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: '', at: 1000 }] }
    const dropped = finishTurn(applyLine(seeded, { authoring: true }), false)
    expect(dropped.turns[0]?.interrupted).toBe(true)
    expect(dropped.turns[0]?.saved).toBeUndefined()
  })

  it('finishTurn marks the last turn interrupted only when done never arrived', () => {
    const state: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: 'partial', at: 1000 }] }
    expect(finishTurn(state, false).turns[0]?.interrupted).toBe(true)
    expect(finishTurn(state, true).turns[0]?.interrupted).toBeUndefined()
  })

  describe('a stale confirmError does not bleed onto an untouched card (fix round 2)', () => {
    // Scenario: press "Build this" on spec 42, the server 409s, confirmError
    // becomes true. Rather than retrying, the friend keeps talking and spec
    // 43 streams in. Without clearing confirmError at both of these points,
    // the brand-new card — which nobody has touched — would render "That
    // didn't go through" before any confirm attempt was ever made on it.

    it('startTurn clears a stale confirmError when a new turn begins', () => {
      const stale: PanelState = { ...EMPTY_PANEL, confirmError: true }
      expect(startTurn(stale, 'anything else', 1000).confirmError).toBe(false)
    })

    it('applyLine clears a stale confirmError the moment a new proposal card arrives', () => {
      const stale: PanelState = { ...EMPTY_PANEL, confirmError: true }
      expect(applyLine(stale, { proposal: PROPOSAL }).confirmError).toBe(false)
    })
  })

  it('a proposal line with no following done renders the card AND the interrupted marker — neither swallowed', () => {
    // The carried finding this task exists to close: on the no-usable-text
    // path the route can emit `{"proposal":...}` with no following
    // `{"done":true}`. Drives applyTurn (the same applyLine/finishTurn
    // pieces send() calls) with exactly that line sequence, then renders
    // both halves for real through TurnRow and ProposalRegion.
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('build me something', 1000) }
    const state = applyTurn(seeded, [
      { t: 'sure, ' },
      { authoring: true },
      { proposal: PROPOSAL },
      // no {done:true}
    ])

    // The specific turn this send() call produced — not "the last item" of
    // an array that could hold anything, but the one and only assistant
    // turn this seeded state contains.
    const assistantTurn = state.turns.find((t) => t.role === 'assistant')
    expect(assistantTurn?.interrupted).toBe(true)
    expect(state.proposals).toEqual([PROPOSAL])

    const turnJson = JSON.stringify(TurnRow({ turn: assistantTurn!, busy: false, onRetry: () => {} }))
    expect(turnJson).toContain('interrupted — not saved')

    // ProposalRegion nests <SpecCard> as JSX rather than calling it as a
    // plain function, so JSON.stringify on the bare element tree would leave
    // that child unexpanded (its `type` is a function, dropped by
    // JSON.stringify, same reason a client component stays opaque inside a
    // server component's returned tree — see tests/routing/userSpace.test.ts).
    // renderToStaticMarkup performs a real render pass instead: safe here
    // because neither ProposalRegion nor SpecCard uses hooks, so there's no
    // dispatcher/DOM requirement SSR can't satisfy.
    const regionHtml = renderToStaticMarkup(
      cards({
        authoring: state.authoring,
        proposalError: state.proposalError,
        proposals: state.proposals,
        confirming: false,
        confirmError: false,
        first: true,
        onConfirm: () => {},
      }),
    )
    expect(regionHtml).toContain('Eating out and the car fund')
    expect(regionHtml).toContain('Build this')
  })

  it('a completed turn with a proposal is not marked interrupted', () => {
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('build me something', 1000) }
    const state = applyTurn(seeded, [{ t: 'sure, ' }, { proposal: PROPOSAL }, { done: true }])
    const assistantTurn = state.turns.find((t) => t.role === 'assistant')
    expect(assistantTurn?.interrupted).toBeUndefined()
    expect(state.proposals).toEqual([PROPOSAL])
  })
})
