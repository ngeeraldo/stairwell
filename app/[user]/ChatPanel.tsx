// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useState } from 'react'
// Type-only: lib/spec/author.ts pulls in server-only modules (better-sqlite3
// et al), and lib/spec/stored.ts pulls in the validators. `import type` is
// erased at compile time regardless of bundler, so none of that reaches the
// client bundle — a value import here would.
import type { Proposal } from '@/lib/spec/author'
import type { StoredSpec } from '@/lib/spec/stored'

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

/**
 * What a card holds instead of a payload: the tagged union readStoredSpec
 * returns, either arm.
 *
 * An ALIAS, not a second declaration of the same union. lib/spec/stored.ts is
 * "the ONE place anything discriminates a pre-unification row from a current
 * one"; re-spelling `{kind:'version'} | {kind:'legacy'}` here would give that
 * discrimination a second home, free to drift, in the one file that renders
 * both arms to a person.
 */
export type CardSpec = StoredSpec

/** The version arm's payload shape, derived from CardSpec rather than
 * imported separately, so it cannot end up naming a different type from the
 * one this card is actually handed. */
type SpecVersionShape = Extract<CardSpec, { kind: 'version' }>['version']

/** What SpecCard needs. `confirmed` is optional because a proposal freshly
 * streamed in from the `proposal` NDJSON line has none yet — only the record
 * read back from the DB (page.tsx) carries a definite value.
 *
 * `first` is re-declared OPTIONAL, against a server type that requires it,
 * because on this side of the wire it genuinely can be missing: a streamed
 * card is JSON.parse output cast to this type, and nothing validates it.
 * `undefined` is falsy, so a bare `first ? … : …` would silently render the
 * change wording — the wrong promise — for a first dashboard. Typing it as
 * possibly-absent forces the read site to say what happens then (it falls back
 * to the page's own server-computed answer, see SpecCard). */
export type CardProposal = Omit<Proposal, 'first'> & {
  first?: boolean
  confirmed?: boolean
}

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
  /** Set when a confirm attempt resolved false (see attemptConfirm) — a
   * plain, brief failure shown on the live card. Cleared by startTurn (a
   * new turn starting) and by applyLine's proposal branch (a new card
   * arriving) — fix round 2: without both of those, a stale failure from an
   * OLDER, already-superseded card kept showing on a brand-new one that
   * nobody had touched yet. */
  confirmError: boolean
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
      // Fix round 2: a confirmError from an OLDER card must not bleed onto
      // this brand-new one — nobody has touched it yet, so "That didn't go
      // through" would be a false failure at the exact decision moment this
      // feature exists to make honest.
      confirmError: false,
      proposals: [...state.proposals, message.proposal],
    }
  }
  if (message.proposal_error) {
    return { ...state, authoring: false, proposalError: true }
  }
  return state
}

/**
 * What starts a new turn: append the pending user/assistant exchange, and
 * clear anything that belonged to the PREVIOUS turn or a previous confirm
 * attempt so it can't bleed into this one — a stale authoring wait, a stale
 * proposal_error, or (fix round 2) a stale confirmError left over from a
 * confirm attempt on a now-irrelevant card. Pure: the literal function
 * send() calls to begin a turn.
 */
export function startTurn(state: PanelState, text: string): PanelState {
  return {
    ...state,
    turns: [...state.turns, ...pendingTurns(text)],
    authoring: false,
    proposalError: false,
    confirmError: false,
  }
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
 * Whether a raw NDJSON line is the turn's terminal `{done:true}` line.
 * Pulled out to its own function — rather than inlined separately in
 * send()'s read loop and in applyTurn below — specifically because fix
 * round 1 shipped both with the SAME inline check by hand, and fix round 2
 * flagged that as a duplication risk: a mutation to how "this is the done
 * line" is decided could diverge silently between the copy send() runs and
 * the copy tests exercise. Now there is exactly one copy, and both call it.
 */
function isDoneLine(raw: unknown): boolean {
  return Boolean((raw as { done?: boolean }).done)
}

/**
 * Fold a full NDJSON line sequence into the resulting panel state,
 * synchronously and without a fetch. Built from isDoneLine, applyLine, and
 * finishTurn — the SAME three primitives send()'s read loop calls for a
 * live stream (see send() below) — so the done-peeling decision and the
 * per-line state update are defined in exactly one place each, not
 * duplicated between a "real" copy and a "test" copy that could diverge.
 *
 * What is genuinely NOT shared, and cannot be without a DOM: send()
 * accumulates `done` across MULTIPLE `reader.read()` chunks one line array
 * at a time, rather than folding one fixed array like this function does,
 * and it is send() itself — a hook-bearing component body this suite
 * cannot drive — that decides when to call finishTurn with the accumulated
 * value. That orchestration is the residual gap; everything else this
 * function does is the literal code send() runs. See task-11-report.md's
 * residual-mutations list for the full accounting.
 */
export function applyTurn(state: PanelState, lines: unknown[]): PanelState {
  let next = state
  let done = false
  for (const raw of lines) {
    if (isDoneLine(raw)) {
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

// Fixed chrome, not agent prose, for the same reason it always was: this is
// the most load-bearing promise in the pilot and it is made at the exact
// moment the friend decides, so it cannot depend on a model remembering to
// say it. What is NEW is that there are two of them.
//
// Under the unified loop the same card carries a one-word relabel and a
// first dashboard. One sentence cannot be honest about both — "tomorrow
// morning" over-promises the wait on a small change and contradicts what the
// agent's own prompt says (small changes land within a few hours). Selected
// by whether this account has a confirmed version yet, computed server-side.
//
// Both are still passive and name nobody — the agent is not the one building,
// and naming Nico turns the surface into a middleman — and neither promises a
// notification, because nothing can deliver one (architecture-overview.md
// line 49: delivery nudges stay out-of-app). Constants, not copy typed twice,
// so the confirmed and not-yet-confirmed cards can never drift apart on the
// one line that matters most.
export const DELIVERY_FIRST =
  "Your dashboard gets built as soon as possible — at the latest, it'll be here tomorrow morning."
export const DELIVERY_CHANGE =
  'This gets built as soon as possible — small changes usually land within a few hours.'

/** The title, from whichever arm this card holds. Pulled out because the
 * heading and the iframe's accessible name both need it, and a card that
 * announced a different preview from the one it shows would be worse than
 * either mistake alone. */
function cardTitle(spec: CardSpec): string {
  return spec.kind === 'version' ? spec.version.title : spec.payload.title
}

/**
 * The whole surface, screen by screen.
 *
 * Every screen's panels, not just the first screen's: a friend whose change
 * touched a second screen must be able to see it on the card they are about
 * to press "Build this" on. Each panel shows its title and its `display` —
 * what will be on the screen — rather than `intent`, which is the reason for
 * it and reads as the agent explaining itself back to them.
 *
 * Sorted by `order`, exactly as the admin pane sorts it
 * (app/admin/[user]/page.tsx) and as renderSpecMarkdown sorts it before
 * writing spec.md. Nothing stops a model emitting screens in an order other
 * than `order`, and if this mapped the raw array the friend approving a
 * proposal and the person building it would be reading the same proposal in
 * two different sequences.
 */
function VersionBody({ version }: { version: SpecVersionShape }) {
  const screens = [...version.screens].sort((a, b) => a.order - b.order)
  return (
    <ul>
      {screens.map((screen) => (
        <li key={screen.id}>
          <strong>{screen.title}</strong>
          <ul>
            {screen.panels.map((panel) => (
              <li key={panel.id}>
                <strong>{panel.title}</strong> — {panel.display}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  )
}

/**
 * The moment a promise gets made.
 *
 * `live` is false for a superseded card: it stays visible in the scrollback
 * so the conversation reads as a history of what was offered, but it carries
 * no buttons. The server enforces the same rule (409), because a stale tab is
 * not bound by what this rendered.
 *
 * `first` selects the delivery promise, and is computed server-side from the
 * record — this component has no database and must not guess. It has no
 * default for the same reason: a defaulted `first` is a wrong promise made
 * silently.
 *
 * The card's OWN answer wins over the prop, and that ordering is the fix for
 * a real contradiction: the prop is computed once, during a page render, for
 * the card that existed then. A card proposed later in the same conversation
 * arrives through the `proposal` NDJSON line with no re-render behind it, so
 * the prop describes a different card — and a friend who confirmed their first
 * dashboard yesterday and asked for a one-word relabel today was told the
 * relabel would be here "at the latest, tomorrow morning". Every card the
 * server emits now carries its own answer (lib/spec/author.ts); the prop is
 * what a card that somehow carries none falls back to, which is right for the
 * page-load card and never worse than guessing.
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
  first,
  confirmError,
  onConfirm,
}: {
  proposal: CardProposal
  live: boolean
  busy: boolean
  first: boolean
  confirmError?: boolean
  onConfirm: (specId: number) => void
}) {
  const { spec } = proposal
  const title = cardTitle(spec)
  // One expression, read twice below, so the confirmed and unconfirmed halves
  // of this card cannot disagree about what was promised.
  const delivery = (proposal.first ?? first) ? DELIVERY_FIRST : DELIVERY_CHANGE
  return (
    <section aria-label="Proposed dashboard" data-spec-id={proposal.id}>
      <h3>{title}</h3>
      {spec.kind === 'version' ? (
        <>
          {/* What changed comes FIRST, above the summary. On a tweak the
              summary is text they already read last time, and burying the
              one new sentence underneath it is how a one-word relabel
              becomes invisible on the card where they approve it. */}
          <p>{spec.version.change_summary}</p>
          <p>{spec.version.summary}</p>
          <VersionBody version={spec.version} />
        </>
      ) : (
        <>
          {/* The frozen arm, rendered exactly as it was before the unified
              loop. `specs` rejects UPDATE, so these rows can never be
              rewritten into the current shape and this markup has no end
              date — see lib/spec/legacy.ts. */}
          <p>{spec.payload.summary}</p>
          <ul>
            {spec.payload.panels.map((panel) => (
              <li key={panel.name}>
                <strong>{panel.name}</strong> — {panel.shows}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Sealed off: an empty sandbox grants nothing — no scripts, no
          same-origin, no forms, no top-level navigation. Model-authored
          markup can therefore never run code in a friend's session, and the
          preview stays a LAYOUT promise rather than a behaviour promise
          somebody then has to build. tests/spec/sandbox.test.ts pins this. */}
      <iframe
        title={`Preview of ${title}`}
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
          <p><small>{delivery}</small></p>
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
          <p><small>{delivery}</small></p>
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
  first,
  onConfirm,
}: {
  authoring: boolean
  proposalError: boolean
  proposals: CardProposal[]
  confirming: boolean
  confirmError: boolean
  /** Threaded straight through from the page, and the FALLBACK each card uses
   * when it carries no answer of its own. Passed to every card, not just the
   * live one: a superseded or already-confirmed card still shows a promise.
   * It is not the answer for cards that arrived after the page rendered —
   * those bring their own (see SpecCard's `first`). */
  first: boolean
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
          first={first}
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
  first,
}: {
  initial: Turn[]
  /** Typed as the CLIENT-side shape, not the server's `Proposal`, because that
   * is what it becomes the moment it is seeded into panel state alongside
   * cards decoded off the wire. A full server-built proposal is assignable. */
  proposal?: CardProposal & { confirmed: boolean }
  /** True when the card the page rendered is this account's first dashboard.
   * Server-computed, and the fallback for any card that carries no answer of
   * its own — see SpecCard's `first`. */
  first: boolean
}) {
  const [open, setOpen] = useState(true)
  // Seeded from the DB record so a friend who closes the tab mid-decision
  // comes back to the same card, still confirmable.
  const [panel, setPanel] = useState<PanelState>({
    turns: initial,
    proposals: proposal ? [proposal] : [],
    authoring: false,
    proposalError: false,
    confirmError: false,
  })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // Guards the confirm buttons across ALL cards, not just the live one — a
  // second click while the first POST is in flight must not fire twice.
  const [confirming, setConfirming] = useState(false)

  async function onConfirm(specId: number) {
    if (confirming) return
    setConfirming(true)
    setPanel((p) => ({ ...p, confirmError: false }))
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
      // Cleared by startTurn/applyLine's proposal branch (see PanelState),
      // not here — see fix round 2.
      setPanel((p) => ({ ...p, confirmError: true }))
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
    setPanel((p) => startTurn(p, text))
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
          if (isDoneLine(raw)) {
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
        confirmError={panel.confirmError}
        first={first}
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
