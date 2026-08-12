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

/** What SpecCard needs. `confirmed` is optional because a proposal freshly
 * streamed in from the `proposal` NDJSON line has none yet — only the record
 * read back from the DB (page.tsx) carries a definite value. */
export type CardProposal = Proposal & { confirmed?: boolean }

/**
 * The moment a promise gets made.
 *
 * `live` is false for a superseded card: it stays visible in the scrollback
 * so the conversation reads as a history of what was offered, but it carries
 * no buttons. The server enforces the same rule (409), because a stale tab is
 * not bound by what this rendered.
 */
export function SpecCard({
  proposal,
  live,
  busy,
  onConfirm,
}: {
  proposal: CardProposal
  live: boolean
  busy: boolean
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
        <p><em>Building this one.</em></p>
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
          {/* Fixed chrome, not agent prose: this is the most load-bearing
              promise in the pilot and it is made at the exact moment the
              friend decides, so it cannot depend on a model remembering to
              say it. Passive, and it names nobody — the agent is not the one
              building, and naming Nico turns the surface into a middleman.
              It promises no notification, because nothing can deliver one
              (architecture-overview.md line 49: delivery nudges stay
              out-of-app). */}
          <p>
            <small>
              Your dashboard gets built as soon as possible — at the latest,
              it&apos;ll be here tomorrow morning.
            </small>
          </p>
        </>
      ) : null}
    </section>
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
  const [turns, setTurns] = useState<Turn[]>(initial)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  // Seeded from the DB record so a friend who closes the tab mid-decision
  // comes back to the same card, still confirmable. New proposals APPEND
  // rather than replace, so an earlier one supersedes into scrollback
  // history (rendered inert) instead of vanishing.
  const [proposals, setProposals] = useState<CardProposal[]>(proposal ? [proposal] : [])
  // True from the `authoring` line until a proposal/proposal_error line (or
  // the stream simply ending, e.g. on abort) resolves the wait.
  const [authoring, setAuthoring] = useState(false)
  const [proposalError, setProposalError] = useState(false)
  // Guards the confirm buttons across ALL cards, not just the live one — a
  // second click while the first POST is in flight must not fire twice.
  const [confirming, setConfirming] = useState(false)

  // The highest spec id seen, computed by VALUE rather than by array
  // position — "the last one appended" and "the newest one" happen to
  // coincide today, but a rule that means "newest" should say so, not lean
  // on ordering that a later change could quietly break.
  const newestId = proposals.reduce<number | undefined>(
    (max, p) => (max === undefined || p.id > max ? p.id : max),
    undefined,
  )

  async function onConfirm(specId: number) {
    if (confirming) return
    setConfirming(true)
    try {
      const response = await fetch('/api/spec/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ specId }),
      })
      if (response.ok) {
        setProposals((ps) => ps.map((p) => (p.id === specId ? { ...p, confirmed: true } : p)))
      }
      // A non-ok response (404/409) means the card is stale or gone; leaving
      // it un-confirmed and live is honest — a page reload will pick up
      // whatever the server actually holds.
    } catch {
      // Network failure: leave unconfirmed. The button re-enables so the
      // friend can just press it again.
    } finally {
      setConfirming(false)
    }
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

  // Update the last turn in place. Centralised because noUncheckedIndexedAccess
  // makes `next[next.length - 1]` possibly-undefined at the type level, and
  // every caller below needs the same "there is always a last turn once a
  // send() has started" guarantee without repeating the guard.
  function updateLastTurn(turns: Turn[], patch: (last: Turn) => Turn): Turn[] {
    const next = [...turns]
    const last = next[next.length - 1]
    if (!last) return next
    next[next.length - 1] = patch(last)
    return next
  }

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setTurns((t) => [...t, ...pendingTurns(text)])
    setDraft('')
    // Fresh turn, fresh authoring state — a leftover wait/error from a
    // previous turn must not bleed into this one.
    setAuthoring(false)
    setProposalError(false)

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
          const message = raw as {
            t?: string
            done?: boolean
            authoring?: boolean
            proposal?: CardProposal
            proposal_error?: boolean
          }
          if (message.done) done = true
          else if (typeof message.t === 'string') {
            const chunk = message.t
            setTurns((t) => updateLastTurn(t, (last) => ({ ...last, body: last.body + chunk })))
          } else if (message.authoring) {
            setAuthoring(true)
          } else if (message.proposal) {
            // Appended, not assigned: the card already on screen (from an
            // earlier turn or the page-load prop) becomes superseded rather
            // than disappearing — see CardProposal's docstring. Independent
            // of `done`: on the no-usable-text path the route can emit this
            // line with no following {done:true}, and the card is honest
            // either way — see the `interrupted` handling below.
            const newProposal = message.proposal
            setAuthoring(false)
            setProposalError(false)
            setProposals((p) => [...p, newProposal])
          } else if (message.proposal_error) {
            setAuthoring(false)
            setProposalError(true)
          }
        }
      }
    } catch {
      // Fall through: no done line means interrupted, which is handled below.
    }

    if (!done) {
      // Design spec section 6.1. The partial stays visible and is labelled,
      // so the screen agrees with the transcript instead of quietly showing
      // text that was never saved. A proposal card from THIS turn (if any)
      // stays visible too — no assistant text was saved, but the card is a
      // separately-recorded fact (its own specs row) and both are honest.
      setTurns((t) => updateLastTurn(t, (last) => ({ ...last, interrupted: true })))
    }
    // The wait is over one way or another — completed, errored, or the
    // stream simply ended (e.g. abort) without either line arriving.
    setAuthoring(false)
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
        {turns.map((turn, i) => (
          <li key={i} data-role={turn.role} data-interrupted={turn.interrupted}>
            <p style={turn.interrupted ? { opacity: 0.5 } : undefined}>{turn.body}</p>
            {turn.interrupted && (
              <p>
                <em>interrupted — not saved</em>{' '}
                {/* A retry is an ordinary new turn: the user row from the
                    interrupted exchange was already written and cannot be
                    amended, so the transcript honestly shows the message
                    twice. Design spec section 6.1. */}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => send(turn.source ?? '')}
                >
                  retry
                </button>
              </p>
            )}
          </li>
        ))}
      </ol>

      {authoring && <p>Putting together a preview…</p>}
      {proposalError && (
        <p>
          <em>Couldn&apos;t put together a preview this time — say more and I&apos;ll try again.</em>
        </p>
      )}
      {proposals.map((p) => (
        <SpecCard
          key={p.id}
          proposal={p}
          live={p.id === newestId}
          busy={confirming}
          onConfirm={onConfirm}
        />
      ))}

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
