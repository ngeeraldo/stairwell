// lib/chat/confirmations.ts
//
// What the agent is told about confirmations it cannot otherwise see.
//
// THE DEFECT THIS FIXES, stated plainly: the agent's whole conversational
// context is the `transcripts` table (lib/chat/turn.ts -> toMessages), and
// pressing "Build this" writes to `specs`, `spec_confirmations` and `metrics`
// and to NONE of it. So the agent proposed, the friend confirmed, and the next
// turn the agent could not tell the confirmation had happened — it re-proposed
// an identical version, which is exactly what was observed in testing. The
// "After they confirm" section of platform/prompts/agent-v4.md was dead text
// against this codebase until this module existed.
//
// NOTHING NEW IS PERSISTED TO FIX IT — onboarding ledger D5/D5a, and the same
// ruling lib/chat/timeline.ts already implements for RENDERING. A confirmation
// is already a permanent row with its own timestamp; writing a second copy into
// `transcripts` would put an un-deletable duplicate of a permanent fact in the
// one table this project calls sacred. timeline.ts merges the two at read time
// for the screen; this merges them at request-build time for the model. One
// idea, two consumers, zero new rows — and it works retroactively, so a version
// confirmed weeks ago becomes visible without inventing history.
import type { ChatMessage } from './history'

export type Confirmation = { version: number; at: number }

/**
 * Which channel carried the note this turn — stamped on every metrics row for
 * the turn (lib/chat/turn.ts).
 *
 * OBSERVABILITY, not telemetry-for-its-own-sake. `system_prompt` means the
 * degraded path engaged: the note reached the model but lost its position in
 * the conversation, which is the property that makes the prompt's "respond to
 * it once" work. That degradation is otherwise completely invisible — the chat
 * keeps working and only the agent's behaviour gets subtly worse — so a model
 * swap could quietly disable half of this feature and nobody would know which
 * change did it. Carries a channel name and nothing else: no version, no
 * timestamp, no content (CLAUDE.md > Metrics).
 */
export type NoteChannel = 'none' | 'messages' | 'system_prompt'

/**
 * Models that accept a `system` role INSIDE the messages array.
 *
 * This is a real API capability rather than a workaround — the operator
 * channel for mid-conversation context — and it is exactly the shape the
 * prompt describes ("their confirmation appears in this conversation").
 *
 * It is MODEL-GATED, and an unsupported model does not degrade: it returns a
 * 400 and the friend's chat stops working entirely. CHAT_MODEL is an env
 * override (deploy/required-env: "has an intended default"), so an operator
 * pointing it at a model that lacks this would take chat down with a change
 * that looks unrelated. The allowlist plus the prompt-suffix fallback below is
 * what stops a model swap from being an outage.
 */
export const MODELS_WITH_MID_CONVERSATION_SYSTEM = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-fable-5',
  'claude-mythos-5',
] as const

export function supportsMidConversationSystem(model: string): boolean {
  return (MODELS_WITH_MID_CONVERSATION_SYSTEM as readonly string[]).includes(
    model,
  )
}

/**
 * The sentence, or null when there is nothing to say.
 *
 * TIMESTAMP, NOT A DAY, and deliberately: a day needs a timezone, this module
 * has none, and CLAUDE.md is explicit that a read and a write disagreeing about
 * the calendar writes a row that is wrong forever. An ISO instant is unambiguous
 * without one, and it is what the ruling asked for ("user confirmed vN at
 * <timestamp>").
 *
 * `isNew` is the whole reason this takes `lastAssistantAt`. The prompt says
 * "Respond to it once", and a note that reads the same on every subsequent turn
 * would invite the agent to acknowledge a weeks-old confirmation again and
 * again. A confirmation is NEW when the agent has not spoken since it happened;
 * after that it is standing context.
 */
export function confirmationNote(
  confirmations: Confirmation[],
  lastAssistantAt: number | null,
): string | null {
  if (confirmations.length === 0) return null

  // readConfirmations sorts oldest-first; the newest is the current one.
  const newest = confirmations[confirmations.length - 1]!
  const at = new Date(newest.at).toISOString()
  const isNew = lastAssistantAt === null || newest.at > lastAssistantAt

  return isNew
    ? `The person pressed "Build this" and confirmed v${newest.version} at ${at}. This is new since your last message.`
    : `The person's current confirmed version is v${newest.version}, confirmed at ${at}.`
}

/**
 * Where the note goes, given what the model supports.
 *
 * ON THE SUPPORTED PATH the note is appended as the LAST message, after the
 * turn's own user row — not spliced in next to the proposal it belongs to.
 * That is not a shortcut: the API requires a system message to follow a `user`
 * message and to be either last or followed by an assistant turn. A
 * confirmation always follows an ASSISTANT proposal in our transcript, so the
 * in-place position the reading eye wants is the one position the API rejects.
 * Last-after-the-user-row satisfies both rules and still reaches the model on
 * the turn where it matters.
 *
 * ON THE FALLBACK PATH the same sentence is appended to the system prompt. It
 * loses its place in the conversation — which is the part that makes "respond
 * once" work — so it is a degradation, stated here rather than hidden.
 */
export function applyConfirmationNote(
  messages: ChatMessage[],
  system: string,
  note: string | null,
  model: string,
): { messages: ChatMessage[]; system: string; channel: NoteChannel } {
  if (note === null) return { messages, system, channel: 'none' }

  // Cannot be messages[0], and must follow a user message. An empty history
  // has neither, and a history whose last row is not a user row would put the
  // note in a position the API rejects. runTurn appends the user row before
  // building messages, so the supported case is the normal one — this guard is
  // for the shapes toMessages can still produce (a leading-assistant history
  // is trimmed away entirely, leaving []).
  const last = messages[messages.length - 1]
  const placeable = last !== undefined && last.role === 'user'

  if (!placeable || !supportsMidConversationSystem(model)) {
    return { messages, system: `${system}\n\n${note}`, channel: 'system_prompt' }
  }
  return {
    messages: [...messages, { role: 'system', content: note }],
    system,
    channel: 'messages',
  }
}
