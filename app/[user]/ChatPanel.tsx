// app/[user]/ChatPanel.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
// Type-only: lib/spec/author.ts pulls in server-only modules (better-sqlite3
// et al), and lib/spec/stored.ts pulls in the validators. `import type` is
// erased at compile time regardless of bundler, so none of that reaches the
// client bundle — a value import here would.
import type { Proposal } from '@/lib/spec/author'
import type { StoredSpec } from '@/lib/spec/stored'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { buildTimeline } from '@/lib/chat/timeline'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { MockupDialog } from './MockupDialog'

type Turn = {
  role: 'user' | 'assistant'
  body: string
  /**
   * When this turn happened, so it can be ordered against proposals and
   * confirmations (lib/chat/timeline.ts). Transcript rows bring the stored
   * value; a turn created by send() stamps Date.now(), which is naturally
   * later than anything already on screen.
   */
  at: number
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
  /**
   * Confirmations, as timeline events (onboarding ledger D5a). Seeded from
   * `spec_confirmations` on page load and appended when a confirm succeeds in
   * this session, so the event appears where the friend actually decided
   * rather than where the card was offered — which can be days earlier.
   */
  confirmations: { version: number; at: number }[]
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
export function startTurn(state: PanelState, text: string, at: number): PanelState {
  return {
    ...state,
    turns: [...state.turns, ...pendingTurns(text, at)],
    authoring: false,
    proposalError: false,
    confirmError: false,
  }
}

/**
 * A turn the product started: an empty assistant turn and nothing else.
 *
 * No user turn, because nobody typed. Pure and exported for the same reason
 * startTurn is — the interesting state transitions are testable without a DOM.
 */
export function startAgentTurn(state: PanelState, at: number): PanelState {
  return {
    ...state,
    turns: [...state.turns, { role: 'assistant', body: '', at }],
    authoring: false,
    proposalError: false,
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
    /*
      CARD ANATOMY, top to bottom, exactly as onboarding-ux-spec.md lists it:
      version label + title + one-line description → scaled-down live mockup
      preview → collapsed "Details" disclosure → confirm control.
      
      The order is the argument. The visual carries the pitch, so it comes
      before the words; the behavioural spec is present but collapsed, because
      "the mockup renders synthetic numbers and cannot communicate behaviour —
      and what the user confirms is the whole versioned spec, not just the
      picture."
      
      NO CARD STATE MACHINE. Nothing here is stored per card: what renders is a
      conditional over spec-version data the loop already has. Confirmed →
      label; else newest → confirm control; else → an inert card, version label
      only. Correctness lives server-side, where a confirm on any non-newest
      version is rejected with a 409.
    */
    <section
      aria-label="Proposed dashboard"
      data-spec-id={proposal.id}
      className="space-y-4 rounded-lg border bg-card p-4"
    >
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">v{proposal.version}</p>
        <h3 className="font-semibold">{title}</h3>
        {/* What changed comes FIRST, above the summary. On a tweak the summary
            is text they already read last time, and burying the one new
            sentence underneath it is how a one-word relabel becomes invisible
            on the card where they approve it. */}
        <p className="text-sm">
          {spec.kind === 'version' ? spec.version.change_summary : spec.payload.summary}
        </p>
      </div>

      {/* Scaled to the column, and non-interactive at card size — which the
          spec explicitly allows, and `pointer-events-none` implements without
          a second mechanism.
          
          `src`, not `srcDoc`: one serving route for the card and the dialog
          (onboarding ledger D14), so what a friend inspects at full size is
          byte-identical to what they were shown here.
          
          Sealed off either way. An empty sandbox grants nothing — no scripts,
          no same-origin, no forms, no top-level navigation — so model-authored
          markup can never run code in a friend's session, and the preview
          stays a LAYOUT promise rather than a behaviour promise somebody then
          has to build. tests/spec/sandbox.test.ts pins this. */}
      {/*
        SCALED DOWN, not cropped. The iframe is laid out at twice the column's
        width and half scale, so the preview shows the mockup as a small whole
        rather than the top-left corner of a full-size one — which is what the
        first screenshot review found.
        
        CSS only: a JS-measured scale factor would be a second implementation
        of the arrangement rule the shell exists to avoid, and it would render
        differently on the server than on the client for a frame.
        
        `pointer-events-none` implements "non-interactive at card size is
        fine" without a second mechanism; the full-screen dialog is where a
        friend actually looks.
      */}
      <div className="h-64 w-full overflow-hidden rounded-md border bg-background">
        <iframe
          title={`Preview of ${title}`}
          src={`/mockup/${proposal.version}`}
          sandbox=""
          className="pointer-events-none h-[32rem] w-[200%] origin-top-left scale-50 border-0"
        />
      </div>

      <div className="flex items-center gap-2">
        <MockupDialog src={`/mockup/${proposal.version}`} title={title} />
      </div>

      {/* Collapsed by default, and always present. The visual carries the
          pitch; this is what they are actually confirming. */}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="px-0">
            Details
          </Button>
        </CollapsibleTrigger>
        {/*
          forceMount: the content stays in the DOM and Radix marks it `hidden`
          when closed, rather than unmounting it. Two reasons, and neither is
          about tests — the build contract a friend is confirming should be
          findable by a browser's own find-in-page and by assistive tech, and a
          Details block that does not exist until clicked is not "always
          present" in any sense the spec would recognise.
        */}
        <CollapsibleContent forceMount className="pt-2 text-sm data-[state=closed]:hidden">
          {spec.kind === 'version' ? (
            <>
              <p className="mb-2 text-muted-foreground">{spec.version.summary}</p>
              <VersionBody version={spec.version} />
            </>
          ) : (
            <>
              {/* The frozen arm, rendered as it always was. `specs` rejects
                  UPDATE, so these rows can never be rewritten into the current
                  shape and this markup has no end date — lib/spec/legacy.ts. */}
              <ul className="list-disc space-y-1 pl-5">
                {spec.payload.panels.map((panel) => (
                  <li key={panel.name}>
                    <strong>{panel.name}</strong> — {panel.shows}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>

      {proposal.confirmed ? (
        /*
          THE CARD STATES THE FACT AND SAYS NOTHING ELSE. The timeframe used to
          be repeated here, on the reasoning that a friend reloading later
          should still see it. That reasoning was right while nothing else
          spoke after a confirmation — but the agent now sees the confirmation
          (lib/chat/confirmations.ts) and agent-v4.md's "After they confirm"
          makes those two commitments its job, in its own words, in the
          conversation. Keeping a copy here would be two versions of one
          promise that can drift apart, which is the argument
          lib/copy/onboarding.ts makes about the promise block.

          The LIVE card below keeps its delivery line: that one is part of the
          pitch a friend reads BEFORE deciding, and nothing else says it at the
          moment the decision is made.
        */
        <div className="space-y-1">
          <p className="text-sm font-medium">Building this one.</p>
        </div>
      ) : live ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(proposal.id)}
            >
              Build this
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                /* just keep talking */
              }}
            >
              Not quite yet
            </Button>
          </div>
          {confirmError && (
            <p className="text-sm text-destructive">
              <em>That didn&apos;t go through — try again.</em>
            </p>
          )}
          <p className="text-xs text-muted-foreground">{delivery}</p>
        </div>
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
}: {
  authoring: boolean
  proposalError: boolean
}) {
  return (
    <>
      {authoring && <p className="text-muted-foreground">Putting together a preview…</p>}
      {proposalError && (
        <p className="text-muted-foreground">
          <em>Couldn&apos;t put together a preview this time — say more and I&apos;ll try again.</em>
        </p>
      )}
    </>
  )
}

/**
 * A confirmation, where it happened.
 *
 * Small and inert on purpose. It is a FACT, not a card: giving it card weight
 * would make the scrollback read as two proposals, and what actually happened
 * is that one of them was accepted.
 */
export function ConfirmationRow({ version, at }: { version: number; at: number }) {
  return (
    <li data-confirmation={version} className="text-xs text-muted-foreground">
      Confirmed v{version} — {new Date(at).toLocaleString()}
    </li>
  )
}

/**
 * Put the newest item in view.
 *
 * A plain function taking anything with the two properties, not a hook and not
 * a method, for the reason everything interesting in this file is pulled out:
 * a scroll that only happens inside a `useEffect` is a scroll no test in this
 * suite can drive. This is the operation; whether the effect fires is the
 * screenshot review's half of the job (`card-proposal`, which is precisely
 * where it was caught).
 *
 * Found by the screenshot gate, not by a test, and it had been true since the
 * chat surface was built: the transcript rendered top-down inside an
 * `overflow-y-auto` list that nothing ever scrolled, so a friend returning to
 * their interview landed on their FIRST message. It went unseen because the
 * shot fixture had an empty transcript until now — the proposal card was the
 * only thing in the column, so nothing had to scroll for it to be visible.
 */
export function scrollToNewest(el: { scrollTop: number; scrollHeight: number } | null): void {
  if (!el) return
  el.scrollTop = el.scrollHeight
}

/**
 * The conversation as one ordered list: turns, proposal cards, and
 * confirmations, each where it happened.
 *
 * Cards used to render in a region BELOW the whole transcript, so a proposal
 * made on Tuesday sat at the bottom of Thursday's conversation, detached from
 * the exchange that produced it (onboarding ledger D5). The confirmation was
 * worse: it showed as the card changing state at the moment it was OFFERED,
 * and those two timestamps can be days apart (D5a).
 *
 * A component with no hooks, so a test can drive it directly — the same reason
 * SpecCard and TurnRow were pulled out.
 */
export function Timeline({
  turns,
  proposals,
  confirmations,
  busy,
  thinking = false,
  confirming,
  confirmError,
  first,
  onConfirm,
  onRetry,
  listRef,
}: {
  turns: Turn[]
  proposals: CardProposal[]
  confirmations: { version: number; at: number }[]
  busy: boolean
  thinking?: boolean
  confirming: boolean
  confirmError: boolean
  /** Threaded straight through from the page, and the FALLBACK each card uses
   * when it carries no answer of its own. Passed to every card, not just the
   * live one: a superseded or already-confirmed card still shows a promise.
   * It is not the answer for cards that arrived after the page rendered —
   * those bring their own (see SpecCard's `first`). */
  first: boolean
  onConfirm: (specId: number) => void
  onRetry: (source: string) => void
  /**
   * The scroll container, held by ChatPanel so this component can stay
   * hookless and directly callable in a test — the same reason SpecCard and
   * TurnRow are separate exports. Optional, so those direct calls need not
   * supply one.
   */
  listRef?: React.RefObject<HTMLOListElement | null>
}) {
  const live = withLiveness(proposals)
  const liveById = new Map(live.map(({ proposal, live: isLive }) => [proposal.id, isLive]))

  const items = buildTimeline<Turn, CardProposal>({
    turns: turns.map((turn) => ({ at: turn.at, turn })),
    proposals: proposals.map((proposal) => ({ at: proposal.at, proposal })),
    confirmations,
  })

  return (
    <ol ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto text-sm">
      {items.map((item, index) => {
        if (item.kind === 'turn') {
          return (
            <TurnRow
              key={`turn-${index}`}
              turn={item.turn}
              busy={busy}
              onRetry={onRetry}
            />
          )
        }
        if (item.kind === 'confirmation') {
          return (
            <ConfirmationRow
              key={`confirmed-${item.version}-${item.at}`}
              version={item.version}
              at={item.at}
            />
          )
        }
        const isLive = liveById.get(item.proposal.id) ?? false
        return (
          <li key={`spec-${item.proposal.id}`}>
            <SpecCard
              proposal={item.proposal}
              live={isLive}
              busy={confirming}
              first={first}
              confirmError={isLive && confirmError}
              onConfirm={onConfirm}
            />
          </li>
        )
      })}
      {thinking && <ThinkingRow />}
    </ol>
  )
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
 * SpecCard/ProposalRegion.
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
        style={turn.interrupted ? { opacity: 0.5 } : undefined}
      >
        {turn.body}
      </p>
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
  confirmations = [],
  first,
}: {
  initial: Turn[]
  /** Seeded from `spec_confirmations`, so a decision made last week still
   * shows where it was made (onboarding ledger D5a). */
  confirmations?: { version: number; at: number }[]
  /** Typed as the CLIENT-side shape, not the server's `Proposal`, because that
   * is what it becomes the moment it is seeded into panel state alongside
   * cards decoded off the wire. A full server-built proposal is assignable. */
  proposal?: CardProposal & { confirmed: boolean }
  /** True when the card the page rendered is this account's first dashboard.
   * Server-computed, and the fallback for any card that carries no answer of
   * its own — see SpecCard's `first`. */
  first: boolean
}) {
  // Seeded from the DB record so a friend who closes the tab mid-decision
  // comes back to the same card, still confirmable.
  const [panel, setPanel] = useState<PanelState>({
    turns: initial,
    proposals: proposal ? [proposal] : [],
    confirmations,
    authoring: false,
    proposalError: false,
    confirmError: false,
  })
  const listRef = useRef<HTMLOListElement>(null)
  // Anchor to the newest item whenever the number of things in the timeline
  // changes: on first paint, when a send appends a turn, and when a proposal
  // card or a confirmation arrives.
  //
  // Deliberately NOT on every streamed chunk. Following the text token by
  // token would yank a friend back down the moment they scrolled up to re-read
  // something mid-reply, and the turn they are watching was already anchored
  // when it started. The cost is that a long reply grows past the fold; the
  // alternative takes the scrollbar away from them, which is worse.
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const itemCount = panel.turns.length + panel.proposals.length + panel.confirmations.length
  // itemCount AND busy. Count alone anchored the turn when it STARTED and then
  // let the reply grow past the fold as it streamed — the friend watched the
  // answer they asked for scroll out of view. `busy` flips false the moment the
  // reply is complete, so this scrolls once more when the message has actually
  // arrived, which is the thing the friend wanted to see.
  //
  // Still NOT per streamed chunk, and that restraint is unchanged: following
  // token by token yanks a friend back down the instant they scroll up to
  // re-read something mid-reply. Two anchors per turn, not two hundred.
  useEffect(() => {
    scrollToNewest(listRef.current)
  }, [itemCount, busy])

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
        // The event, at the moment they decided. Stamped from the client
        // clock, which is the only clock this side of the wire has — the
        // server's own `spec_confirmations.at` replaces it on the next load,
        // and the two only have to agree about ORDER, not about the value.
        confirmations: [
          ...p.confirmations,
          { version: p.proposals.find((x) => x.id === specId)?.version ?? 0, at: Date.now() },
        ],
      }))
      // The acknowledgment, now rather than on their next message. After the
      // card state updates, so the confirmed card is already on screen when
      // the reply starts arriving under it.
      void acknowledgeConfirmation()
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

  async function send(text: string) {
    if (!text.trim() || busy) return
    setBusy(true)
    setPanel((p) => startTurn(p, text, Date.now()))
    setDraft('')
    await streamTurn({ body: text })
  }

  /**
   * Ask the agent to respond to a confirmation, immediately.
   *
   * Pressing "Build this" used to record the decision and produce silence —
   * agent-v4 promises an acknowledgment, but nothing ran a turn, so it waited
   * for the friend's next message. That is the wrong moment to say nothing:
   * they have just committed to something.
   *
   * No user bubble, because they did not type anything — only the empty
   * assistant turn the reply streams into.
   */
  async function acknowledgeConfirmation() {
    if (busy) return
    setBusy(true)
    setPanel((p) => startAgentTurn(p, Date.now()))
    await streamTurn({ trigger: 'confirmation' })
  }

  /** The read loop, shared by both kinds of turn. */
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
        turns={panel.turns}
        proposals={panel.proposals}
        confirmations={panel.confirmations}
        busy={busy}
        thinking={isThinking(panel.turns, busy)}
        confirming={confirming}
        confirmError={panel.confirmError}
        first={first}
        onConfirm={onConfirm}
        onRetry={(source) => void send(source)}
      />

      {/* Below the list, not in it: these describe what is happening NOW,
          rather than something that happened at a point in the conversation. */}
      <ProposalRegion authoring={panel.authoring} proposalError={panel.proposalError} />

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
