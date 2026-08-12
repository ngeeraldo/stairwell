// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useState } from 'react'
// Type-only: lib/spec/author.ts pulls in server-only modules (better-sqlite3
// et al). `import type` is erased at compile time regardless of bundler, so
// none of that reaches the client bundle — a value import here would.
import type { Proposal } from '@/lib/spec/author'

const TOGGLE_KEY = 'stairwell:chat-open'

type Turn = {
  role: 'user' | 'assistant'
  body: string
  /** True when the stream ended without a {done:true} line — nothing saved. */
  interrupted?: boolean
  /**
   * The message that produced this turn, carried so its own retry button
   * re-sends it. See pendingTurns.
   */
  source?: string
}

/**
 * The two turns a send appends: the user's message, and the empty assistant
 * turn that streams into it.
 *
 * `source` rides on the assistant Turn rather than a component-level ref
 * because every interrupted turn renders its own retry button. A single ref
 * holds only the most recent send, so with two interrupted turns on screen the
 * OLDER button re-sent the NEWER message — writing a permanent transcript row
 * the user never asked to send, to a table that cannot be corrected.
 */
export function pendingTurns(text: string): Turn[] {
  return [
    { role: 'user', body: text },
    { role: 'assistant', body: '', source: text },
  ]
}

/**
 * Split a buffer into complete NDJSON values plus whatever trailing partial
 * line is left. Exported because this is where the interrupted rule is
 * decided: the reply is only saved if a {done:true} line arrives.
 */
export function parseNdjson(buffer: string): { lines: unknown[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const lines: unknown[] = []
  for (const part of parts) {
    if (part.trim() === '') continue
    lines.push(JSON.parse(part))
  }
  return { lines, rest }
}

// Update the last turn in place. Module-level (not a component method)
// because applyLine/finishTurn below need it too, and noUncheckedIndexedAccess
// makes `next[next.length - 1]` possibly-undefined at the type level — every
// caller needs the same "there is always a last turn once a send() has
// started" guarantee without repeating the guard.
function updateLastTurn(turns: Turn[], patch: (last: Turn) => Turn): Turn[] {
  const next = [...turns]
  const last = next[next.length - 1]
  if (!last) return next
  next[next.length - 1] = patch(last)
  return next
}

/** What SpecCard needs. `confirmed` is optional because a proposal freshly
 * streamed in from the `proposal` NDJSON line has none yet — only the record
 * read back from the DB (page.tsx) carries a definite value. */
export type CardProposal = Proposal & { confirmed?: boolean }

/**
 * Everything ChatPanel holds about the transcript and the proposal flow,
 * gathered into one object so it can be updated through ONE pure reducer
 * (applyLine/finishTurn below) rather than four independent setStates that
 * each have to remember which of the others to also touch.
 *
 * This split exists for testability as much as for tidiness: ChatPanel
 * itself uses hooks, so it cannot be called directly in a test (no dispatcher
 * outside a real render) — the way SpecCard could be, which is why SpecCard
 * was pulled out as its own export in the first place. Pulling the STATE
 * TRANSITIONS out too, as plain functions with no React in them, means the
 * interesting logic (a proposal line superseding a card, an interrupted turn
 * coexisting with a proposal, only the newest proposal being live) is
 * directly testable without a DOM, instead of living entirely inside a
 * component nothing in this test suite can drive.
 */
export type PanelState = {
  turns: Turn[]
  proposals: CardProposal[]
  /** True from the `authoring` line until a proposal/proposal_error line (or
   * the turn simply ending) resolves the wait. */
  authoring: boolean
  proposalError: boolean
}

/**
 * Apply ONE parsed NDJSON line (never `{done:true}` — the caller peels that
 * off first, see applyTurn/send) to panel state. Pure: this is the literal
 * function send()'s read loop calls for every line, so a test driving it
 * directly is driving the real per-line logic, not a re-implementation of
 * it.
 */
export function applyLine(state: PanelState, raw: unknown): PanelState {
  const message = raw as {
    t?: string
    authoring?: boolean
    proposal?: CardProposal
    proposal_error?: boolean
  }
  if (typeof message.t === 'string') {
    const chunk = message.t
    return {
      ...state,
      turns: updateLastTurn(state.turns, (last) => ({ ...last, body: last.body + chunk })),
    }
  }
  if (message.authoring) {
    return { ...state, authoring: true }
  }
  if (message.proposal) {
    // Appended, not assigned: the card already on screen (from an earlier
    // turn or the page-load prop) becomes superseded rather than
    // disappearing — see CardProposal's docstring and withLiveness below.
    // Independent of `done`: on the no-usable-text path the route can emit
    // this line with no following {done:true}. finishTurn (below) decides
    // the interrupted marker separately, so a proposal card and "interrupted
    // — not saved" can coexist honestly on the same turn — neither branch
    // here knows or cares whether `done` ever arrives.
    return {
      ...state,
      authoring: false,
      proposalError: false,
      proposals: [...state.proposals, message.proposal],
    }
  }
  if (message.proposal_error) {
    return { ...state, authoring: false, proposalError: true }
  }
  return state
}

/**
 * What happens once a turn's stream ends, whether that's a real
 * {done:true}, an error, or the connection just closing (e.g. abort). Pure,
 * and the second (and last) primitive send() composes — see applyTurn below
 * for how a test recreates a full turn from these two building blocks.
 */
export function finishTurn(state: PanelState, done: boolean): PanelState {
  if (done) return { ...state, authoring: false }
  // Design spec section 6.1. The partial stays visible and is labelled, so
  // the screen agrees with the transcript instead of quietly showing text
  // that was never saved. Any proposal card added by applyLine during this
  // same turn is untouched — see applyLine's proposal branch.
  return {
    ...state,
    authoring: false,
    turns: updateLastTurn(state.turns, (last) => ({ ...last, interrupted: true })),
  }
}

/**
 * Fold a full NDJSON line sequence into the resulting panel state, exactly
 * as send()'s read loop + its post-loop finishTurn call would, but
 * synchronously and without a fetch. Built from applyLine and finishTurn —
 * the same two functions send() calls — so this is a convenience for
 * driving that real logic with a fixed line sequence, not a parallel
 * reimplementation of it. Exported for tests that need to assert on a
 * complete turn (e.g. the coexistence of a proposal card with an
 * interrupted marker) rather than one line at a time.
 */
export function applyTurn(state: PanelState, lines: unknown[]): PanelState {
  let next = state
  let done = false
  for (const raw of lines) {
    if ((raw as { done?: boolean }).done) {
      done = true
      continue
    }
    next = applyLine(next, raw)
  }
  return finishTurn(next, done)
}

/**
 * Pair every proposal with whether IT is the one that's currently
 * confirmable — only the newest is (design spec 5.2). Pulled out of the
 * render entirely, rather than computed inline in JSX, so that rule has
 * real test coverage: JSX inside a hook-bearing component can't be driven
 * without a DOM, so any logic left there is untested by construction.
 * ChatPanel's render does nothing more than map over this function's
 * output.
 */
export function withLiveness(
  proposals: CardProposal[],
): { proposal: CardProposal; live: boolean }[] {
  const newestId = proposals.reduce<number | undefined>(
    (max, p) => (max === undefined || p.id > max ? p.id : max),
    undefined,
  )
  return proposals.map((proposal) => ({ proposal, live: proposal.id === newestId }))
}

/** The exact request confirming a proposal makes. Exported so the request
 * shape (method, url, and — this is the specific thing a wrong key would
 * silently break — the `specId` body key the server expects) has real
 * coverage: a test can call this directly rather than re-implementing a
 * POST body inside a test double. */
export function confirmRequest(specId: number): { url: string; init: RequestInit } {
  return {
    url: '/api/spec/confirm',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ specId }),
    },
  }
}

/**
 * Attempt to confirm a proposal, resolving to whether it worked. NEVER
 * resolves to nothing and never throws: a 400/404/409 and a network failure
 * both resolve `false`, so the caller (ChatPanel's onConfirm) always has an
 * explicit fact to act on instead of a swallowed non-event at the single
 * most important moment in the product.
 */
export async function attemptConfirm(specId: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const { url, init } = confirmRequest(specId)
    const response = await fetchImpl(url, init)
    return response.ok
  } catch {
    return false
  }
}

// Fixed chrome, not agent prose: this is the most load-bearing promise in
// the pilot and it is made at the exact moment the friend decides, so it
// cannot depend on a model remembering to say it. Passive, and it names
// nobody — the agent is not the one building, and naming Nico turns the
// surface into a middleman. It promises no notification, because nothing
// can deliver one (architecture-overview.md line 49: delivery nudges stay
// out-of-app). A single constant, not copy typed twice, so the confirmed
// and not-yet-confirmed cards can never drift apart on the one line that
// matters most.
const DELIVERY_LINE =
  "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning."

/**
 * The moment a promise gets made.
 *
 * `live` is false for a superseded card: it stays visible in the scrollback
 * so the conversation reads as a history of what was offered, but it carries
 * no buttons. The server enforces the same rule (409), because a stale tab is
 * not bound by what this rendered.
 *
 * `confirmError` is honest, brief failure feedback for a confirm attempt
 * that did not succeed (§Important 3, fix round 1) — no invented promise,
 * just the fact that it didn't go through. Only meaningful (and only ever
 * passed true) on the live, unconfirmed card: nothing failed on a
 * superseded or already-confirmed one.
 */
export function SpecCard({
  proposal,
  live,
  busy,
  confirmError,
  onConfirm,
}: {
  proposal: CardProposal
  live: boolean
  busy: boolean
  confirmError?: boolean
  onConfirm: (specId: number) => void
}) {
  const { payload } = proposal
  return (
    <section aria-label="Proposed dashboard" data-spec-id={proposal.id}>
      <h3>{payload.title}</h3>
      <p>{payload.summary}</p>
      <ul>
        {payload.panels.map((panel) => (
          <li key={panel.name}>
            <strong>{panel.name}</strong> — {panel.shows}
          </li>
        ))}
      </ul>

      {/* Sealed off: an empty sandbox grants nothing — no scripts, no
          same-origin, no forms, no top-level navigation. Model-authored
          markup can therefore never run code in a friend's session, and the
          preview stays a LAYOUT promise rather than a behaviour promise
          somebody then has to build. tests/spec/sandbox.test.ts pins this. */}
      <iframe
        title={`Preview of ${payload.title}`}
        srcDoc={proposal.mockup_html}
        sandbox=""
      />

      {proposal.confirmed ? (
        <>
          <p><em>Building this one.</em></p>
          {/* The promise becomes operative exactly when it's confirmed, and
              a friend reloading afterwards should still see the timeframe —
              dropping this line here would be the one moment it matters
              most. */}
          <p><small>{DELIVERY_LINE}</small></p>
        </>
      ) : live ? (
        <>
          <p>
            <button type="button" disabled={busy} onClick={() => onConfirm(proposal.id)}>
              Build this
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => { /* just keep talking */ }}>
              Not quite yet
            </button>
          </p>
          {confirmError && (
            <p><em>That didn&apos;t go through — try again.</em></p>
          )}
          <p><small>{DELIVERY_LINE}</small></p>
        </>
      ) : null}
    </section>
  )
}

/**
 * The authoring wait, an honest proposal_error failure, and every proposal
 * card. No hooks of its own — same reason as SpecCard — so it can be driven
 * directly in a test instead of relying on state that merely IMPLIES what
 * would have rendered. tests/chat/panel.test.ts drives this with a
 * proposal_error line and confirms both the failure text renders AND no
 * card appears — the property the vacuous parseNdjson-only version of that
 * test (fix round 1 finding) could never have caught.
 */
export function ProposalRegion({
  authoring,
  proposalError,
  proposals,
  confirming,
  confirmError,
  onConfirm,
}: {
  authoring: boolean
  proposalError: boolean
  proposals: CardProposal[]
  confirming: boolean
  confirmError: boolean
  onConfirm: (specId: number) => void
}) {
  return (
    <>
      {authoring && <p>Putting together a preview…</p>}
      {proposalError && (
        <p>
          <em>Couldn&apos;t put together a preview this time — say more and I&apos;ll try again.</em>
        </p>
      )}
      {withLiveness(proposals).map(({ proposal, live }) => (
        <SpecCard
          key={proposal.id}
          proposal={proposal}
          live={live}
          busy={confirming}
          confirmError={live && confirmError}
          onConfirm={onConfirm}
        />
      ))}
    </>
  )
}

/**
 * One turn's row: the body, and — when the stream ended without
 * {done:true} — the "interrupted, not saved" marker and its retry button.
 * No hooks of its own, pulled out for the same testability reason as
 * SpecCard/ProposalRegion.
 */
export function TurnRow({
  turn,
  busy,
  onRetry,
}: {
  turn: Turn
  busy: boolean
  onRetry: (source: string) => void
}) {
  return (
    <li data-role={turn.role} data-interrupted={turn.interrupted}>
      <p style={turn.interrupted ? { opacity: 0.5 } : undefined}>{turn.body}</p>
      {turn.interrupted && (
        <p>
          <em>interrupted — not saved</em>{' '}
          {/* A retry is an ordinary new turn: the user row from the
              interrupted exchange was already written and cannot be
              amended, so the transcript honestly shows the message twice.
              Design spec section 6.1. */}
          <button type="button" disabled={busy} onClick={() => onRetry(turn.source ?? '')}>
            retry
          </button>
        </p>
      )}
    </li>
  )
}

export default function ChatPanel({
  initial,
  proposal,
}: {
  initial: Turn[]
  proposal?: Proposal & { confirmed: boolean }
}) {
  const [open, setOpen] = useState(true)
  // Seeded from the DB record so a friend who closes the tab mid-decision
  // comes back to the same card, still confirmable.
  const [panel, setPanel] = useState<PanelState>({
    turns: initial,
    proposals: proposal ? [proposal] : [],
    authoring: false,
    proposalError: false,
  })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // Guards the confirm buttons across ALL cards, not just the live one — a
  // second click while the first POST is in flight must not fire twice.
  const [confirming, setConfirming] = useState(false)
  // Set when a confirm attempt resolved false (bad request, 404, 409, or a
  // network failure) — see attemptConfirm. Reset at the start of the next
  // attempt so a stale failure doesn't linger after a successful retry.
  const [confirmError, setConfirmError] = useState(false)

  async function onConfirm(specId: number) {
    if (confirming) return
    setConfirming(true)
    setConfirmError(false)
    const ok = await attemptConfirm(specId, fetch)
    if (ok) {
      setPanel((p) => ({
        ...p,
        proposals: p.proposals.map((x) => (x.id === specId ? { ...x, confirmed: true } : x)),
      }))
    } else {
      // A non-ok response (404/409) means the card is stale or gone; a
      // network failure means nothing was learned either way. Either way
      // the friend is told, plainly, rather than the button just quietly
      // re-enabling with no explanation at the moment they decided.
      setConfirmError(true)
    }
    setConfirming(false)
  }

  useEffect(() => {
    setOpen(window.localStorage.getItem(TOGGLE_KEY) !== 'closed')
  }, [])

  function toggle() {
    setOpen((wasOpen) => {
      window.localStorage.setItem(TOGGLE_KEY, wasOpen ? 'closed' : 'open')
      return !wasOpen
    })
  }

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setPanel((p) => ({
      ...p,
      turns: [...p.turns, ...pendingTurns(text)],
      // Fresh turn, fresh authoring state — a leftover wait/error from a
      // previous turn must not bleed into this one.
      authoring: false,
      proposalError: false,
    }))
    setDraft('')

    let done = false
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      const reader = response.body?.getReader()
      if (!reader) throw new Error('no body')

      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        const { lines, rest } = parseNdjson(buffer)
        buffer = rest
        for (const raw of lines) {
          if ((raw as { done?: boolean }).done) {
            done = true
            continue
          }
          setPanel((p) => applyLine(p, raw))
        }
      }
    } catch {
      // Fall through: no done line means interrupted, which finishTurn below
      // handles the same way as an ordinary incomplete stream.
    }

    setPanel((p) => finishTurn(p, done))
    setBusy(false)
  }

  if (!open) {
    return (
      <button type="button" onClick={toggle}>
        Show chat
      </button>
    )
  }

  return (
    <section aria-label="Chat">
      <ol>
        {panel.turns.map((turn, i) => (
          <TurnRow key={i} turn={turn} busy={busy} onRetry={(source) => void send(source)} />
        ))}
      </ol>

      <ProposalRegion
        authoring={panel.authoring}
        proposalError={panel.proposalError}
        proposals={panel.proposals}
        confirming={confirming}
        confirmError={confirmError}
        onConfirm={onConfirm}
      />

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say anything — every request is data I need."
        />
        <button type="submit" disabled={busy}>
          Send
        </button>
      </form>

      <button type="button" onClick={toggle}>
        Hide chat
      </button>
    </section>
  )
}
