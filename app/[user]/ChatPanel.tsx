// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

type Turn = {
  role: 'user' | 'assistant'
  body: string
  /**
   * When this turn happened. Transcript rows bring the stored value; a turn
   * created by send() stamps Date.now(), which is naturally later than
   * anything already on screen.
   */
  at: number
  /**
   * True when the stream ended without a {done:true} line — the turn did not
   * run to completion. On its own this says NOTHING about what was persisted;
   * pair it with `saved` below to know which.
   */
  interrupted?: boolean
  /**
   * True once the server has confirmed this exchange is committed — the
   * `{saved:true}` line, sent the moment the assistant row and its chat_turn
   * metric land.
   *
   * `interrupted` without this means nothing was written and a retry is the
   * right move. `interrupted` WITH this means the reply is durable and only
   * the connection dropped afterward — retrying there would re-send a
   * message that is already in an append-only table, for a reply that
   * already exists.
   */
  saved?: boolean
  /**
   * True when the TURN failed upstream — the model call errored, so there is no
   * reply and nothing was written. Distinct from a plain `interrupted`, which
   * says the stream stopped and points at the CONNECTION: this one is our end.
   * Telling a friend their network dropped when Anthropic was overloaded sends
   * them to restart a router that is working fine.
   */
  failed?: boolean
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
/**
 * Whether to show the thinking indicator.
 *
 * A pure predicate rather than a piece of state, for the reason everything in
 * this file is pulled out: derived state that only exists inside a component
 * is state no test here can drive.
 *
 * The condition is BUSY AND the reply is still empty. `pendingTurns` appends
 * the assistant turn the instant send() fires, so "busy" alone would keep the
 * skeleton on screen underneath the words as they stream. The gap this fills
 * is the one between pressing send and the first token — which on a thinking
 * model is long enough to wonder whether the send worked.
 */
export function isThinking(turns: Turn[], busy: boolean): boolean {
  if (!busy) return false
  const last = turns[turns.length - 1]
  return last?.role === 'assistant' && last.body === ''
}

export function pendingTurns(text: string, at: number): Turn[] {
  return [
    { role: 'user', body: text, at },
    // One millisecond later, so the reply can never sort above the message it
    // is replying to when both are stamped in the same tick.
    { role: 'assistant', body: '', source: text, at: at + 1 },
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
 * Everything ChatPanel holds about the transcript, gathered into one object
 * so it can be updated through ONE pure reducer (applyLine/finishTurn below)
 * rather than scattered setStates.
 *
 * This split exists for testability as much as for tidiness: ChatPanel
 * itself uses hooks, so it cannot be called directly in a test (no dispatcher
 * outside a real render). Pulling the STATE TRANSITIONS out as plain
 * functions with no React in them means the interesting logic is directly
 * testable without a DOM, instead of living entirely inside a component
 * nothing in this test suite can drive.
 *
 * There used to be more here — a proposal card's state, a two-stage
 * authoring wait, a confirm-attempt failure flag. All of it drove a preview
 * card and its buttons, which are gone: the agent now says in words that it
 * has what it needs, and the build lands without anyone confirming
 * anything. `turns` is what's left.
 */
export type PanelState = {
  turns: Turn[]
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
    saved?: boolean
    turn_failed?: boolean
  }
  if (typeof message.t === 'string') {
    const chunk = message.t
    return {
      ...state,
      turns: updateLastTurn(state.turns, (last) => ({ ...last, body: last.body + chunk })),
    }
  }
  if (message.turn_failed) {
    return {
      ...state,
      turns: updateLastTurn(state.turns, (last) => ({ ...last, failed: true })),
    }
  }
  if (message.saved) {
    // Recorded on the TURN, not on the panel: two interrupted turns can be on
    // screen at once and they can disagree about whether they were saved — the
    // same reason `source` lives here rather than in a component-level ref.
    return {
      ...state,
      turns: updateLastTurn(state.turns, (last) => ({ ...last, saved: true })),
    }
  }
  return state
}

/**
 * What starts a new turn: append the pending user/assistant exchange. Pure:
 * the literal function send() calls to begin a turn.
 */
export function startTurn(state: PanelState, text: string, at: number): PanelState {
  return {
    ...state,
    turns: [...state.turns, ...pendingTurns(text, at)],
  }
}

/**
 * What happens once a turn's stream ends, whether that's a real
 * {done:true}, an error, or the connection just closing (e.g. abort). Pure,
 * and the second (and last) primitive send() composes — see applyTurn below
 * for how a test recreates a full turn from these two building blocks.
 */
export function finishTurn(state: PanelState, done: boolean): PanelState {
  if (done) return state
  // Design spec section 6.1. The partial stays visible and is labelled, so
  // the screen agrees with the transcript instead of quietly showing text
  // that was never saved.
  return {
    ...state,
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
 * function does is the literal code send() runs.
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
 * Put the newest item in view.
 *
 * A plain function taking anything with the two properties, not a hook and not
 * a method, for the reason everything interesting in this file is pulled out:
 * a scroll that only happens inside a `useEffect` is a scroll no test in this
 * suite can drive.
 *
 * Found by the screenshot gate, not by a test, and it had been true since the
 * chat surface was built: the transcript rendered top-down inside an
 * `overflow-y-auto` list that nothing ever scrolled, so a friend returning to
 * their interview landed on their FIRST message.
 */
export function scrollToNewest(el: { scrollTop: number; scrollHeight: number } | null): void {
  if (!el) return
  el.scrollTop = el.scrollHeight
}

/**
 * How far from the bottom still counts as "at the bottom", in pixels.
 *
 * Not zero, and the reason is render order: a streamed chunk is in the DOM
 * before the effect that measures runs, so the container is already taller than
 * it was when the friend was last at the bottom. Exact equality would read
 * every single chunk as "they scrolled up" and the panel would never follow
 * anything.
 */
export const NEAR_BOTTOM_SLACK = 64

/**
 * Is the friend still parked at the bottom of the transcript?
 *
 * This is the whole reason the panel may now follow a reply as it streams. The
 * standing objection to per-chunk anchoring was real — dragging someone back
 * down the instant they scroll up to re-read something mid-reply takes the
 * scrollbar away from them — and the answer is to ask first rather than to stop
 * following. Scrolled to the bottom means "keep me there"; scrolled up means
 * "leave me alone", until they come back down.
 *
 * A plain predicate over the three numbers rather than a hook, for the same
 * reason as scrollToNewest above: a rule that only exists inside a `useEffect`
 * is a rule no test in this suite can drive.
 *
 * Null is PINNED, not unpinned. The ref is null on the render before the <ol>
 * exists, and treating that as "they scrolled up" would leave the follow
 * permanently switched off from first paint.
 */
export function isNearBottom(
  el: { scrollTop: number; scrollHeight: number; clientHeight: number } | null,
  slack: number = NEAR_BOTTOM_SLACK,
): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

/**
 * What the friend looks at between pressing send and the first word arriving.
 *
 * STOCK shadcn `Skeleton` and nothing else — Nico's ruling. It is
 * `animate-pulse`, a Tailwind built-in, on the vendored component the CLI
 * wrote; there is no bespoke keyframe, no dot-bounce, no timing to maintain.
 * `components/ui/*` stays exactly as `npx shadcn@latest add` produced it
 * (CLAUDE.md), so the whole treatment lives here in two lines of layout.
 *
 * Shaped like the agent's reply that is about to replace it — full width, left
 * aligned, two lines — so the column does not jump when the real text lands.
 *
 * `aria-live="polite"` and a real label, because a pulsing grey rectangle
 * announces nothing to a screen reader and "did it hear me" is exactly the
 * question this element exists to answer.
 */
export function ThinkingRow() {
  return (
    <li data-role="thinking" aria-live="polite" className="space-y-2">
      <span className="sr-only">Thinking…</span>
      {/*
        bg-foreground/15, not the stock `bg-muted`. Muted is a hair off the
        page background — the first version was invisible on a real screen, so
        the one element whose entire job is answering "did that send?" answered
        nothing. Overridden at the CALL SITE: components/ui/* stays as the CLI
        wrote it (CLAUDE.md), and the pulse itself is still stock.
      */}
      <Skeleton className="h-4 w-[85%] bg-foreground/15" />
      <Skeleton className="h-4 w-[60%] bg-foreground/15" />
    </li>
  )
}

/**
 * One turn's row: the body, and — when the stream ended without
 * {done:true} — the "interrupted, not saved" marker and its retry button.
 * No hooks of its own, pulled out for the same testability reason as
 * everything else in this file.
 *
 * WHO SAID IT IS VISIBLE, not just readable by a machine. Both roles rendered
 * as identical paragraphs, distinguished only by a `data-role` attribute — so
 * a friend scrolling their own interview saw one undifferentiated column of
 * text and had to infer the speaker from the words. The attribute stays (the
 * admin transcript and the tests both key on it); what is new is that it now
 * has a visual counterpart.
 *
 * The shape is the one every LLM chat surface has converged on, and the
 * convergence is the argument — this is the surface a friend has already used
 * elsewhere, so it should not need learning:
 *
 *   user      — a bubble, rounded and LIGHT BLUE, right-aligned, capped at 85%
 *                so it reads as an aside rather than a column. The first
 *                version used --muted, which is 0.97 neutral on a 0.98 neutral
 *                background: a difference you can measure and cannot see.
 *                --chat-user is a tint of the accent hue — see app/globals.css,
 *                edit 5.
 *   assistant — no bubble, no tint, full width. The reply is the substance of
 *                the page; boxing it would make the page a list of boxes.
 *
 * `whitespace-pre-wrap` on both, which is a correctness fix wearing a styling
 * change's clothes: the agent's replies contain blank lines between
 * paragraphs, and until now HTML collapsed every one of them into a single
 * space.
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
  const user = turn.role === 'user'
  return (
    <li data-role={turn.role} data-interrupted={turn.interrupted}>
      <p
        // `ml-auto w-fit` rather than a flex row on the <li>: the interrupted
        // marker below is a sibling, and making the row a flex container would
        // put it alongside the bubble instead of under it.
        className={
          user
            ? 'ml-auto w-fit max-w-[85%] rounded-2xl bg-chat-user px-4 py-2.5 whitespace-pre-wrap text-chat-user-foreground'
            : 'whitespace-pre-wrap'
        }
        // Dimmed only when the text really was lost. A SAVED turn's body is
        // sitting in `transcripts`, and greying it out would contradict the
        // line below it saying so.
        style={turn.interrupted && !turn.saved ? { opacity: 0.5 } : undefined}
      >
        {turn.body}
      </p>
      {/* TWO DIFFERENT FAILURES, and telling them apart is the whole point.
          `interrupted` alone means the stream stopped; `saved` says whether
          anything survived it. Before the server sent {saved:true} the panel
          could only assume the worst, and on 2026-08-18 it told a friend
          "not saved" about a reply that was already in an append-only
          table. */}
      {turn.interrupted &&
        (turn.failed ? (
          <p>
            {/* OURS, NOT THEIRS. An upstream failure said "interrupted" until
                2026-08-18, which reads as a network problem — which is why
                three Anthropic Overloaded responses in a row looked to a
                friend like a broken laptop. Retry IS the right control here:
                nothing was written, so re-sending is correct rather than a
                duplicate. */}
            <em>something went wrong on my end — nothing was saved</em>{' '}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRetry(turn.source ?? '')}
            >
              Retry
            </Button>
          </p>
        ) : turn.saved ? (
          <p>
            <em>saved — the connection dropped, and the reply is still there</em>{' '}
            {/* Reload, not Retry. The message is already in `transcripts` and
                the reply already exists, so re-sending would duplicate a row
                for an answer that came back. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </p>
        ) : (
          <p>
            <em>interrupted — not saved</em>{' '}
            {/* A retry is an ordinary new turn: the user row from the
                interrupted exchange was already written and cannot be
                amended, so the transcript honestly shows the message twice.
                Design spec section 6.1. */}
            {/* The vendored Button, not a bare <button>: Tailwind's preflight
                strips native button chrome, so an unstyled one rendered as
                plain text indistinguishable from the marker beside it — a
                control nobody could tell was clickable. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRetry(turn.source ?? '')}
            >
              Retry
            </Button>
          </p>
        ))}
    </li>
  )
}

/**
 * The conversation, top to bottom.
 *
 * Used to merge turns with proposal cards and confirmation events, each
 * rendered where it happened (lib/chat/timeline.ts's `buildTimeline`, still
 * used by the admin transcript pane for exactly that). ChatPanel no longer
 * has either of those: there is no card to place and no confirmation to mark,
 * so `turns` is the only thing on screen and its own array order — the order
 * the transcript was read in, with each send() appending to the end — is
 * already the right order. No merge needed for one list.
 *
 * A component with no hooks, so a test can drive it directly.
 */
export function Timeline({
  turns,
  busy,
  thinking = false,
  onRetry,
  listRef,
  onScroll,
}: {
  turns: Turn[]
  busy: boolean
  thinking?: boolean
  onRetry: (source: string) => void
  /**
   * The scroll container, held by ChatPanel so this component can stay
   * hookless and directly callable in a test. Optional, so those direct
   * calls need not supply one.
   */
  listRef?: React.RefObject<HTMLOListElement | null>
  /**
   * Fires on the container's own scroll events, so ChatPanel can record
   * whether the friend is still parked at the bottom. Optional for the same
   * reason listRef is.
   */
  onScroll?: () => void
}) {
  return (
    <ol
      ref={listRef}
      onScroll={onScroll}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto text-sm"
    >
      {turns.map((turn, index) => (
        <TurnRow key={`turn-${index}`} turn={turn} busy={busy} onRetry={onRetry} />
      ))}
      {thinking && <ThinkingRow />}
    </ol>
  )
}

export default function ChatPanel({
  initial,
}: {
  initial: Turn[]
}) {
  const [panel, setPanel] = useState<PanelState>({
    turns: initial,
  })
  const listRef = useRef<HTMLOListElement>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  // WHETHER THE FRIEND IS STILL AT THE BOTTOM, recorded from their own scroll
  // events. A ref and not state: nothing renders differently because of it, and
  // a setState per scroll event would re-render the whole transcript while a
  // reply is streaming into it.
  //
  // Starts true, because a fresh panel is at the bottom by construction (the
  // first effect below puts it there) and the only thing that can move it since
  // is a scroll, which is exactly what updates this.
  const pinned = useRef(true)

  // Anchor to the newest item whenever the number of turns changes (first
  // paint, and every send), as the newest reply GROWS, and once more when the
  // turn ends.
  //
  // `bodyLength` is the one that matters and the one that was missing. Anchoring
  // on `itemCount` and `busy` alone meant a reply was anchored when it STARTED
  // and then not again until the whole turn finished — and on a turn that calls
  // propose_spec, "the whole turn" includes the 47-97 second authoring call
  // (see lib/chat/turn.ts's authoringSignal). The agent's "here's what I'm
  // having built" message landed below the fold and stayed there for a minute,
  // so the moment a friend said "that's everything" the screen appeared not to
  // answer. `busy` stays in the list: a turn can end without adding a character
  // (an interrupted marker, a retry button) and that still changes the height.
  //
  // This used to be deliberately NOT per-chunk, on the grounds that following
  // token by token yanks back a friend who scrolled up mid-reply. That
  // objection is real and is now answered directly by `pinned` rather than by
  // refusing to follow: someone at the bottom is kept there, and someone who
  // scrolled away is left alone until they come back.
  const itemCount = panel.turns.length
  const bodyLength = panel.turns[panel.turns.length - 1]?.body.length ?? 0
  useEffect(() => {
    if (!pinned.current) return
    scrollToNewest(listRef.current)
  }, [itemCount, bodyLength, busy])

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setPanel((p) => startTurn(p, text, Date.now()))
    setDraft('')
    await streamTurn({ body: text })
  }

  /** The read loop, shared by every turn. */
  async function streamTurn(payload: Record<string, unknown>) {
    let done = false
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
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

  // OPEN/CLOSED IS NOT THIS COMPONENT'S BUSINESS ANY MORE.
  //
  // It used to own the toggle and persist it in localStorage under
  // 'stairwell:chat-open'. Both are gone: the spec lists persistence of panel
  // state across sessions as a non-goal, and the default now comes from the
  // server — open until a dashboard is deployed, collapsed after (onboarding
  // ledger D7). app/[user]/Shell.tsx owns the boolean and the button, because
  // it is the layer that knows which arrangement they mean.
  //
  // Keeping the old behaviour would have meant a friend who collapsed the chat
  // once during their interview never seeing it open on the morning their
  // dashboard landed.
  return (
    <section aria-label="Chat" className="flex h-full min-h-0 flex-col gap-4">
      <Timeline
        listRef={listRef}
        onScroll={() => {
          pinned.current = isNearBottom(listRef.current)
        }}
        turns={panel.turns}
        busy={busy}
        thinking={isThinking(panel.turns, busy)}
        onRetry={(source) => void send(source)}
      />

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say anything — every request is data I need."
          rows={3}
          className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" size="lg" className="w-full" disabled={busy}>
          Send
        </Button>
      </form>
    </section>
  )
}
