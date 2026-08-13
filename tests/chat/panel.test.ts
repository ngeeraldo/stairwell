// tests/chat/panel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
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
  SpecCard,
  startTurn,
  TurnRow,
  withLiveness,
  type CardProposal,
  type PanelState,
} from '@/app/[user]/ChatPanel'
import type { SpecVersion } from '@/lib/spec/schema'

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
}

/**
 * A pre-unification row, in the exact shape a friend's `specs` table already
 * holds for real. `specs` rejects UPDATE, so these keep arriving at this card
 * forever — the legacy arm is not a transitional courtesy.
 */
const LEGACY_PROPOSAL: CardProposal = {
  id: 7,
  version: 1,
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
  screens: [{ id: 'today', title: 'Today', order: 1, panels: [walkedTodayPanel()] }],
  data_requirements: [],
  open_questions: [],
}

const VERSION_PROPOSAL: CardProposal = {
  id: 43,
  version: 2,
  spec: { kind: 'version', version: VERSION },
  mockup_html: '<!doctype html><html><body>COFFEE PALACE TEST</body></html>',
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
  proposalError: false,
  confirmError: false,
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

  it('keeps the delivery line on a confirmed card', () => {
    // The promise becomes operative exactly when it's confirmed, and a
    // friend reloading afterwards should still see the timeframe.
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
    expect(json).toContain(
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

  it('shows the same delivery line on a confirmed card as on the live one', () => {
    for (const first of [true, false]) {
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
      const line = first ? DELIVERY_FIRST : DELIVERY_CHANGE
      expect(live).toContain(line)
      expect(done).toContain(line)
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

describe('ProposalRegion — the authoring wait, an honest failure, and the cards', () => {
  it('renders the authoring wait from an authoring line', () => {
    const region = ProposalRegion({
      authoring: true,
      proposalError: false,
      proposals: [],
      confirming: false,
      confirmError: false,
      first: true,
      onConfirm: () => {},
    })
    expect(JSON.stringify(region)).toContain('Putting together a preview')
  })

  it('renders a proposal_error line as an honest failure — and adds no card', () => {
    // Fix round 1 finding: the version of this test that only checked
    // parseNdjson's JSON parsing was vacuous — deleting the entire error
    // paragraph AND the proposal_error branch left it green. This drives
    // ProposalRegion itself, the real function ChatPanel renders from.
    const region = ProposalRegion({
      authoring: false,
      proposalError: true,
      proposals: [],
      confirming: false,
      confirmError: false,
      first: true,
      onConfirm: () => {},
    })
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
      ProposalRegion({
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
    const older = { ...PROPOSAL, id: 42, confirmed: true }
    const newer = { ...PROPOSAL, id: 43 }
    const text = htmlText(
      renderToStaticMarkup(
        ProposalRegion({
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
    expect(text.split(DELIVERY_CHANGE)).toHaveLength(3)
    expect(text).not.toContain(DELIVERY_FIRST)
  })
})

describe('TurnRow', () => {
  it('renders the interrupted marker and a retry button', () => {
    const row = TurnRow({
      turn: { role: 'assistant', body: 'partial', interrupted: true, source: 'hi' },
      busy: false,
      onRetry: () => {},
    })
    const json = JSON.stringify(row)
    expect(json).toContain('interrupted — not saved')
    expect(findButtons(row)).toHaveLength(1)
  })

  it('renders nothing extra for a turn that was not interrupted', () => {
    const row = TurnRow({ turn: { role: 'assistant', body: 'done' }, busy: false, onRetry: () => {} })
    expect(JSON.stringify(row)).not.toContain('interrupted')
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

  it('finishTurn marks the last turn interrupted only when done never arrived', () => {
    const state: PanelState = { ...EMPTY_PANEL, turns: [{ role: 'assistant', body: 'partial' }] }
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
      expect(startTurn(stale, 'anything else').confirmError).toBe(false)
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
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('build me something') }
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
      ProposalRegion({
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
    const seeded: PanelState = { ...EMPTY_PANEL, turns: pendingTurns('build me something') }
    const state = applyTurn(seeded, [{ t: 'sure, ' }, { proposal: PROPOSAL }, { done: true }])
    const assistantTurn = state.turns.find((t) => t.role === 'assistant')
    expect(assistantTurn?.interrupted).toBeUndefined()
    expect(state.proposals).toEqual([PROPOSAL])
  })
})
