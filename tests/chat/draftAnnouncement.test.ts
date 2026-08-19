import { describe, expect, it, vi } from 'vitest'
import { draftAnnouncement, MAX_ANNOUNCEMENT_CHARS } from '@/lib/chat/draftAnnouncement'
import type { ChatClient } from '@/lib/chat/client'
import { friendFacing, parseBuildNotes } from '@/lib/build/notes'

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
  //
  // The fixture is a REAL BuildNotes, parsed by the actual parser, with a
  // sentinel in EACH builder-only section — not a bare FriendFacingNotes
  // literal that never carried builder-only content to begin with. An
  // earlier version of this test used such a literal and could not fail: the
  // string "Monday" it checked for was never present anywhere in the input,
  // so the assertion was vacuously true and would have stayed green even if
  // draftAnnouncement forwarded the WHOLE BuildNotes object, "## Open" and
  // "## Notes for the next build" included. This version passes the parsed
  // notes through friendFacing() — the same call a real caller makes — so
  // the sentinels genuinely exist in the source and genuinely must not
  // survive the trip. This is the assertion standing between a builder's
  // private note and a friend's permanent transcript.
  it('sends only the friend-facing notes', async () => {
    const rawNotes = parseBuildNotes(
      [
        '---',
        'slug: testfriend',
        'version: 1',
        'built_at: 2026-08-17',
        '---',
        '',
        '## What shipped',
        '',
        'The takeaway panel now shows a weekly total.',
        '',
        '## Built differently',
        '',
        'Weekly rather than daily.',
        '',
        '## Open',
        '',
        'SENTINEL_OPEN_MUST_NOT_LEAK',
        '',
        '## Notes for the next build',
        '',
        'SENTINEL_NEXT_BUILD_MUST_NOT_LEAK',
        '',
      ].join('\n'),
    )

    const client = clientReturning({ message: 'ok' })
    await draftAnnouncement({ client }, { ...INPUT, notes: friendFacing(rawNotes) })
    const sent = JSON.stringify((client.propose as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(sent).toContain('weekly total')
    expect(sent).not.toContain('SENTINEL_OPEN_MUST_NOT_LEAK')
    expect(sent).not.toContain('SENTINEL_NEXT_BUILD_MUST_NOT_LEAK')
  })

  // Task 9 fix: the user message used to label changeSummary "The version
  // they confirmed" while announce-v2.md's system prompt now tells the model
  // nothing was confirmed in advance and there is no preview — the same
  // false premise the prompt fix removed, still live one layer down in the
  // payload. Asserting the literal wording (not just "no 'confirmed'
  // anywhere," which the notes JSON or a future changeSummary value could
  // accidentally satisfy or violate either way) pins that this specific
  // label agrees with the prompt it accompanies.
  it('labels the change summary without claiming it was confirmed', async () => {
    const client = clientReturning({ message: 'ok' })
    await draftAnnouncement({ client }, INPUT)
    const sent = JSON.stringify((client.propose as ReturnType<typeof vi.fn>).mock.calls[0]![0])
    expect(sent).toContain('The change summary from the version that shipped')
    expect(sent).not.toContain('they confirmed')
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
