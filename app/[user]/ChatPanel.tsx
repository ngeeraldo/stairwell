// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useState } from 'react'

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

export default function ChatPanel({ initial }: { initial: Turn[] }) {
  const [open, setOpen] = useState(true)
  const [turns, setTurns] = useState<Turn[]>(initial)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

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
          const message = raw as { t?: string; done?: boolean }
          if (message.done) done = true
          else if (typeof message.t === 'string') {
            const chunk = message.t
            setTurns((t) => updateLastTurn(t, (last) => ({ ...last, body: last.body + chunk })))
          }
        }
      }
    } catch {
      // Fall through: no done line means interrupted, which is handled below.
    }

    if (!done) {
      // Design spec section 6.1. The partial stays visible and is labelled,
      // so the screen agrees with the transcript instead of quietly showing
      // text that was never saved.
      setTurns((t) => updateLastTurn(t, (last) => ({ ...last, interrupted: true })))
    }
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
