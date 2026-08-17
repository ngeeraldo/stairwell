import { describe, expect, it, vi } from 'vitest'
import { draftAnnouncement, MAX_ANNOUNCEMENT_CHARS } from '@/lib/chat/draftAnnouncement'
import type { ChatClient } from '@/lib/chat/client'

const NOTES = {
  what_shipped: 'The takeaway panel now shows a weekly total.',
  built_differently: 'Weekly rather than daily.',
}

function clientReturning(input: unknown): ChatClient {
  return {
    stream: vi.fn(),
    propose: vi.fn(async () => ({
      input,
      usage: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
      stop_reason: 'end_turn',
      served: { model_served: 'claude-opus-5', fallback_fired: false },
    })),
  } as unknown as ChatClient
}

const INPUT = {
  notes: NOTES,
  changeSummary: 'Added a takeaway panel.',
  recent: [{ role: 'user' as const, content: 'can I see takeaway spend?' }],
  signal: new AbortController().signal,
}

describe('draftAnnouncement', () => {
  it('returns the drafted message with its usage and prompt sha', async () => {
    const client = clientReturning({ message: 'Your takeaway total is up now.' })
    const result = await draftAnnouncement({ client }, INPUT)
    expect(result.message).toBe('Your takeaway total is up now.')
    expect(result.usage.output).toBe(20)
    expect(result.promptSha).toHaveLength(12)
  })

  // The structural bound from lib/build/notes.ts, asserted at the boundary
  // that actually sends bytes to a model.
  it('sends only the friend-facing notes', async () => {
    const client = clientReturning({ message: 'ok' })
    await draftAnnouncement({ client }, INPUT)
    const sent = JSON.stringify((client.propose as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(sent).toContain('weekly total')
    expect(sent).not.toContain('Monday')
  })

  it('throws on an empty message rather than returning a blank body', async () => {
    const client = clientReturning({ message: '   ' })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow(/empty/)
  })

  it('throws on a message longer than the ceiling', async () => {
    const client = clientReturning({ message: 'x'.repeat(MAX_ANNOUNCEMENT_CHARS + 1) })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow(/too long/)
  })

  it('throws when the reply is not the expected shape', async () => {
    const client = clientReturning({ text: 'wrong key' })
    await expect(draftAnnouncement({ client }, INPUT)).rejects.toThrow()
  })
})
