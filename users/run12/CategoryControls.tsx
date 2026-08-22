'use client'

// users/run12/CategoryControls.tsx
//
// The three controls lib/ui/WriteAction.tsx cannot express: a per-transaction
// category MENU, a text field for naming a new bucket, and the legend's TICK
// BOX. All write through run12's own platform route, and all are built on the
// platform's own mechanics rather than on a second copy of them.
//
// ─── why not WriteAction ───────────────────────────────────────────────────
//
// WriteAction is the default for every write in this repo and is used unchanged
// elsewhere — the Refresh control inside <PlaidSources> on this very screen is
// one. But it renders a labelled BUTTON over a fixed payload, and this screen
// asks for three things a button cannot carry: a choice among categories, a
// name the friend types, and a tick box that shows its own state.
//
// lib/ui/useWriteAction.ts is the sanctioned answer and says so in its own
// header: an escape hatch "for anything a labelled button cannot express — a
// form with fields, say".
//
// SO THE LIFETIME RULE IS NOT REIMPLEMENTED HERE. The hook owns all of it —
// pending grouped by action URL, the pending state ending when the refreshed
// tree COMMITS rather than when the POST returns, the unmount cleanup, the
// 401/403 re-render, the failure sentence. This file contributes markup and one
// piece of local state, and nothing else.
//
// ─── what the grouping buys, and why all three share one route ─────────────
//
// `useWriteAction` locks every control sharing an ACTION URL while a write is in
// flight. All three post to the same route, so re-filing a transaction locks
// every other row's menu, every tick box AND the new-bucket field until the
// server has answered and the tree has re-rendered.
//
// That is correct rather than incidental: the pie, the legend and the list are
// drawn from ONE read, so a second write landing while the first was settling
// would show a friend a pie and a list that disagreed.
//
// ─── the no-JS path is real ────────────────────────────────────────────────
//
// All three render a genuine <form method="post" action={...}> with real named
// fields, exactly as WriteAction does. Without JavaScript the browser posts and
// the route's 303 sends it back to this screen; the interception is the
// enhancement, not the mechanism. That is why every submit below is a real
// submit and not an onClick.
//
// ─── this file writes free text to exactly one place ───────────────────────
//
// The name typed below reaches `custom_categories` in his own SQLCipher
// database, through the route. It is not logged, and the route emits a constant
// panel name to `metrics` rather than anything derived from it.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWriteAction, WRITE_FAILED } from '@/lib/ui/useWriteAction'

/**
 * Move one transaction into another category.
 *
 * The submit stays disabled until the choice actually differs from where the
 * transaction already sits, so pressing it always means something. That is the
 * only decision this file makes, and it is about the CONTROL rather than about
 * the data — which category a transaction is currently in arrives as a prop,
 * resolved by 004's view.
 */
export function RefileControl({
  action,
  transactionId,
  current,
  choices,
  labelFor,
  describedBy,
}: {
  action: string
  transactionId: string
  /** The category key this transaction sits in now. */
  current: string
  /** Every key it may be moved to, already ordered by the caller. */
  choices: { value: string; label: string; custom: boolean }[]
  /** How to render `current` if it is somehow outside `choices`. */
  labelFor: string
  /** The row's own description, so the menu is not an unlabelled combobox. */
  describedBy: string
}) {
  const { fire, pending, error } = useWriteAction(action)
  const [chosen, setChosen] = useState(current)
  const unchanged = chosen === current

  const mine = choices.filter((c) => c.custom)
  const bank = choices.filter((c) => !c.custom)
  // A key the menu does not offer — a bucket deleted from under an override,
  // say. Kept as an option rather than silently snapping the select to something
  // else, which would show the friend a category the row is not in.
  const orphan = choices.some((c) => c.value === current)
    ? null
    : { value: current, label: labelFor }

  return (
    <form
      method="post"
      action={action}
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        fire({ action: 'assign', transaction_id: transactionId, category: chosen })
      }}
    >
      <input type="hidden" name="action" value="assign" />
      <input type="hidden" name="transaction_id" value={transactionId} />
      <select
        name="category"
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
        disabled={pending}
        aria-label={`Category for ${describedBy}`}
        className="h-8 max-w-[11rem] rounded-md border border-input bg-transparent px-2 py-1 text-xs shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {orphan !== null && <option value={orphan.value}>{orphan.label}</option>}
        {mine.length > 0 && (
          <optgroup label="Your categories">
            {mine.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </optgroup>
        )}
        {bank.length > 0 && (
          <optgroup label="From your bank">
            {bank.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        // Disabled while the group is busy OR while the choice has not moved.
        // The route enforces neither — a disabled control is an affordance, and
        // re-filing to the category a transaction is already in is a harmless
        // no-op there.
        disabled={pending || unchanged}
        aria-busy={pending}
        className="h-8 px-2 text-xs"
      >
        {pending ? '…' : 'Move'}
      </Button>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error === WRITE_FAILED ? 'Couldn’t move that one.' : error}
        </p>
      )}
    </form>
  )
}

/**
 * Name a new bucket.
 *
 * The field is cleared on submit rather than on success, and that is a knowing
 * choice: the hook does not report success, only failure, and a field that
 * emptied itself only once the server answered would sit there full and
 * unresponsive for the length of the round trip. On failure the message says
 * nothing was saved, which is true — the route writes or it does not.
 *
 * `maxLength` mirrors the route's own bound. It is an affordance, not the rule:
 * the route normalises and re-checks, because the no-JS path posts whatever the
 * form holds.
 */
export function NewCategoryControl({ action, maxLength }: { action: string; maxLength: number }) {
  const { fire, pending, error } = useWriteAction(action)
  const [name, setName] = useState('')
  const empty = name.trim() === ''

  return (
    <form
      method="post"
      action={action}
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (empty) return
        fire({ action: 'create', name })
        setName('')
      }}
    >
      <input type="hidden" name="action" value="create" />
      <Input
        name="name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={pending}
        maxLength={maxLength}
        placeholder="New category name"
        aria-label="New category name"
        className="h-9 w-full max-w-[16rem] text-sm"
      />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || empty}>
        {pending ? 'Adding…' : 'Add category'}
      </Button>
      {error !== null && (
        <p role="alert" className="w-full text-xs text-destructive">
          {error === WRITE_FAILED ? 'Couldn’t add that one — nothing was saved.' : error}
        </p>
      )}
    </form>
  )
}

/**
 * The legend's tick box: keep a category in the pie, or out of it.
 *
 * A SUBMIT BUTTON STYLED AS A CHECKBOX, not an <input type="checkbox">. The
 * distinction is the no-JS path: a bare checkbox posts nothing on its own, so
 * without JavaScript it would be a control that appears to work and does not. A
 * real submit always posts, and the box is drawn from the state the server
 * already sent.
 *
 * It names the TARGET state — `show` or `hide` — rather than toggling, so the
 * request says what it wants rather than what it found. Two presses racing each
 * other therefore cannot land somewhere neither asked for; the route's own
 * header makes the same point.
 */
export function CategoryToggle({
  action,
  category,
  label,
  included,
}: {
  action: string
  category: string
  label: string
  /** The state the server last rendered. This control never guesses ahead. */
  included: boolean
}) {
  const { fire, pending } = useWriteAction(action)
  const next = included ? 'hide' : 'show'

  return (
    <form
      method="post"
      action={action}
      className="flex"
      onSubmit={(event) => {
        event.preventDefault()
        fire({ action: next, category })
      }}
    >
      <input type="hidden" name="action" value={next} />
      <input type="hidden" name="category" value={category} />
      <button
        type="submit"
        disabled={pending}
        role="checkbox"
        aria-checked={included}
        aria-label={`Include ${label} in the pie`}
        className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:border-primary aria-checked:bg-primary aria-checked:text-primary-foreground"
      >
        {included && (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3"
            aria-hidden
          >
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        )}
      </button>
    </form>
  )
}
