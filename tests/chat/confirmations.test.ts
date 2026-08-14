// tests/chat/confirmations.test.ts
//
// The agent could not see confirmations at all before this module: runTurn's
// context is transcripts, and /api/spec/confirm writes to specs,
// spec_confirmations and metrics — none of which reach the model. The observed
// symptom was the agent re-proposing an identical version after one had been
// confirmed. These tests pin the fix and, more importantly, pin the two
// properties that make it safe: nothing is persisted, and the note lands
// somewhere the API will actually accept.
import { describe, expect, it } from 'vitest'
import {
  applyConfirmationNote,
  confirmationNote,
  supportsMidConversationSystem,
} from '@/lib/chat/confirmations'
import type { ChatMessage } from '@/lib/chat/history'

const AT = Date.UTC(2026, 7, 14, 16, 30, 0)
const user = (content: string): ChatMessage => ({ role: 'user', content })
const assistant = (content: string): ChatMessage => ({
  role: 'assistant',
  content,
})

describe('the confirmation note', () => {
  it('says nothing when nothing has been confirmed', () => {
    expect(confirmationNote([], null)).toBeNull()
  })

  it('names the version and the instant', () => {
    const note = confirmationNote([{ version: 2, at: AT }], null)
    expect(note).toContain('v2')
    expect(note).toContain('2026-08-14T16:30:00.000Z')
  })

  it('is a timestamp, never a bare day', () => {
    // A day needs a timezone this module does not have, and CLAUDE.md is
    // explicit about what a read and a write disagreeing about the calendar
    // costs. An ISO instant needs no zone to be unambiguous.
    const note = confirmationNote([{ version: 1, at: AT }], null)!
    expect(note).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('reports the NEWEST version when several have been confirmed', () => {
    const note = confirmationNote(
      [
        { version: 1, at: AT - 5000 },
        { version: 2, at: AT },
      ],
      null,
    )!
    expect(note).toContain('v2')
    expect(note).not.toContain('v1')
  })

  it('marks a confirmation the agent has not spoken since as NEW', () => {
    // This is what makes the prompt's "Respond to it once" implementable.
    const note = confirmationNote([{ version: 1, at: AT }], AT - 1000)!
    expect(note).toContain('new since your last message')
  })

  it('stops calling it new once the agent has spoken since', () => {
    // Without this, a weeks-old confirmation reads as fresh on every single
    // turn and invites the agent to acknowledge it again and again.
    const note = confirmationNote([{ version: 1, at: AT }], AT + 1000)!
    expect(note).not.toContain('new since')
    expect(note).toContain('current confirmed version is v1')
  })
})

describe('where the note is placed', () => {
  const note = 'The person confirmed v1.'

  it('leaves the request untouched when there is no note', () => {
    const messages = [user('hi')]
    const result = applyConfirmationNote(messages, 'SYS', null, 'claude-opus-5')
    expect(result.messages).toEqual(messages)
    expect(result.system).toBe('SYS')
  })

  it('appends it as a system message, after the trailing user row', () => {
    // Both API placement rules at once: a system message must FOLLOW a user
    // message, and must be last (or followed by an assistant turn). The
    // position the reading eye wants — next to the proposal it answers —
    // follows an ASSISTANT row, which is the one placement the API rejects.
    const result = applyConfirmationNote(
      [assistant('here is a proposal'), user('sounds good')],
      'SYS',
      note,
      'claude-opus-5',
    )
    expect(result.messages).toHaveLength(3)
    expect(result.messages[2]).toEqual({ role: 'system', content: note })
    expect(result.messages[1]!.role).toBe('user')
    expect(result.system).toBe('SYS')
  })

  it('never makes the note the first message', () => {
    // messages[0] cannot be a system message. An empty history has no user row
    // to follow, so the note has to go somewhere else entirely.
    const result = applyConfirmationNote([], 'SYS', note, 'claude-opus-5')
    expect(result.messages).toEqual([])
    expect(result.system).toContain(note)
  })

  it('falls back to the system prompt on a model without the capability', () => {
    // Mid-conversation system messages are model-gated and an unsupported
    // model does not degrade — it 400s, and the friend's chat stops. CHAT_MODEL
    // is an env override, so this path is what stops a model swap from being an
    // outage.
    const result = applyConfirmationNote(
      [user('hi')],
      'SYS',
      note,
      'claude-sonnet-5',
    )
    expect(result.messages).toEqual([user('hi')])
    expect(result.system).toContain(note)
    expect(result.messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('knows which models carry the capability', () => {
    expect(supportsMidConversationSystem('claude-opus-5')).toBe(true)
    expect(supportsMidConversationSystem('claude-sonnet-5')).toBe(false)
  })
})
