// tests/chat/opening.test.ts
//
// The chat used to open empty, so agent-v4's "You speak first" had nothing to
// act on — the model is only called in response to a user message, and there
// is none on the first render. These tests pin the parse (anchored to the
// heading, loud on failure) and the write-once guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as promptModule from '@/lib/chat/prompt'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPlatformDb, type PlatformDb } from '@/lib/db/platform'
import { appendTranscript, readTranscript } from '@/lib/db/appendOnly'
import {
  OPENING_HEADING,
  OpeningMessageError,
  ensureOpeningMessage,
  openingMessage,
  parseOpeningMessage,
} from '@/lib/chat/opening'

let dir: string
let db: PlatformDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-opening-'))
  db = openPlatformDb(join(dir, 'synthetic.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('parsing the opener', () => {
  it('reads the blockquote under the heading', () => {
    const text = `# Prompt\n\n${OPENING_HEADING}\n\nsome preamble\n\n> Hello there.\n>\n> A second line.\n\n## Next section\n\n> not this one\n`
    expect(parseOpeningMessage(text)).toBe('Hello there.\n\nA second line.')
  })

  it('is anchored to the HEADING, not to the first blockquote in the file', () => {
    // The condition Nico set, and the failure it prevents: a positional parse
    // starts returning a different quote the first time a prompt version adds
    // a quoted example above this section, and the symptom is a friend greeted
    // with the wrong words rather than an error anyone sees.
    const text = `# Prompt\n\n## Some earlier section\n\n> AN EXAMPLE, NOT THE OPENER\n\n${OPENING_HEADING}\n\n> The real opener.\n`
    expect(parseOpeningMessage(text)).toBe('The real opener.')
  })

  it('stops at the next heading', () => {
    const text = `${OPENING_HEADING}\n\n> Mine.\n\n## Your job\n\n> Not mine.\n`
    expect(parseOpeningMessage(text)).toBe('Mine.')
  })

  it('throws when the section is missing', () => {
    expect(() => parseOpeningMessage('# Prompt\n\nno such section\n')).toThrow(
      OpeningMessageError,
    )
  })

  it('throws when the section has no blockquote', () => {
    expect(() =>
      parseOpeningMessage(`${OPENING_HEADING}\n\nprose but no quote\n`),
    ).toThrow(OpeningMessageError)
  })

  it('throws rather than returning an empty opener', () => {
    // THE IMPORTANT ONE. transcripts rejects DELETE, so a blank assistant row
    // written at first render is a permanent blank first impression — and it
    // would look exactly like the bug this module fixes. Loud beats silent.
    expect(() => parseOpeningMessage(`${OPENING_HEADING}\n\n>\n>\n`)).toThrow(
      OpeningMessageError,
    )
  })

  it('parses the SHIPPED prompt, not just fixtures', () => {
    // The fixtures above prove the parser; this proves it against the real
    // file, so a prompt version that reshapes the section fails here rather
    // than in front of a friend.
    const body = openingMessage()
    expect(body.length).toBeGreaterThan(40)
    expect(body).toContain('keep track of')
  })
})

describe('writing the opener', () => {
  const input = { accountId: 1, sessionId: 's1', at: 1_000 }

  it('writes one assistant row into an empty transcript', () => {
    expect(ensureOpeningMessage(db, input)).toBe(true)
    const rows = readTranscript(db, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.role).toBe('assistant')
    expect(rows[0]!.body).toBe(openingMessage())
  })

  it('never writes twice', () => {
    ensureOpeningMessage(db, input)
    expect(ensureOpeningMessage(db, { ...input, at: 2_000 })).toBe(false)
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('stays quiet when the friend has already said something', () => {
    // The guard is an EMPTY transcript, not first_session_start — that metric
    // is load-bearing system state (ledger D8) and keeps its single job.
    appendTranscript(db, {
      accountId: 1,
      sessionId: 's1',
      conversationId: 'c1',
      promptSha: 'abc',
      role: 'user',
      body: 'I got here first',
      at: 500,
    })
    expect(ensureOpeningMessage(db, input)).toBe(false)
    expect(readTranscript(db, 1)).toHaveLength(1)
  })

  it('greets an account that reached the shell before this existed', () => {
    // Such an account already has first_session_start and an empty chat. Had
    // the guard been that metric, it would never be greeted at all.
    expect(ensureOpeningMessage(db, input)).toBe(true)
  })

  it('throws rather than swallowing — the caller decides what that costs', () => {
    // ensureOpeningMessage is deliberately not defensive: writing an empty
    // opener into an append-only table is worse than failing. Its ONE render
    // call site (app/[user]/page.tsx) wraps it for that reason — an uncaught
    // throw there would take the friend's whole page, chat and logout
    // included — and instrumentation.ts checks the same parse at boot so the
    // failure is loud somewhere nobody has to be looking at a browser.
    const broken = { ...input, accountId: 2 }
    const spy = vi.spyOn(promptModule, 'loadPrompt').mockReturnValue({
      text: '# A prompt with no opening section\n',
      sha: 'deadbeefcafe',
    })
    expect(() => ensureOpeningMessage(db, broken)).toThrow(OpeningMessageError)
    expect(readTranscript(db, 2)).toHaveLength(0)
    spy.mockRestore()
  })

  it('stamps the prompt sha that produced the words', () => {
    ensureOpeningMessage(db, input)
    const row = db
      .prepare('SELECT prompt_sha FROM transcripts WHERE account_id = 1')
      .get() as { prompt_sha: string }
    expect(row.prompt_sha).toMatch(/^[0-9a-f]{12}$/)
  })
})
