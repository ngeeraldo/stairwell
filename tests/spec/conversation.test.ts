import { describe, expect, it } from 'vitest'
import { conversationRows, renderConversationMarkdown } from '@/lib/spec/conversation'

const row = (id: number, role: string, body: string, at: number) => ({
  id,
  account_id: 1,
  session_id: 's',
  conversation_id: 'c',
  prompt_sha: 'sha',
  role,
  body,
  at,
})

const spec = (id: number, version: number, at: number) => ({
  id,
  account_id: 1,
  conversation_id: 'c',
  prompt_sha: 'sha',
  payload: '{}',
  mockup_html: '',
  at,
  confirmed_at: null,
  version,
})

// readSpecs returns newest first — mirror that here.
const SPECS = [spec(2, 2, 200), spec(1, 1, 100)]
const ROWS = [
  row(1, 'user', 'before v1', 50),
  row(2, 'assistant', 'at v1', 100),
  row(3, 'user', 'after v1', 150),
  row(4, 'assistant', 'at v2', 200),
  row(5, 'user', 'after v2', 250),
]

describe('conversationRows', () => {
  it('takes everything up to a first spec', () => {
    const got = conversationRows(ROWS, SPECS[1]!, SPECS)
    expect(got.map((r) => r.body)).toEqual(['before v1', 'at v1'])
  })

  it('takes only the rows since the previous spec', () => {
    // The conversation that produced v2 — not the one that produced v1.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS)
    expect(got.map((r) => r.body)).toEqual(['after v1', 'at v2'])
  })

  it('is exclusive at the bottom and inclusive at the top', () => {
    // A row written in the same millisecond as the previous spec belongs to
    // that spec's slice, not to this one — otherwise two consecutive pulls
    // both carry it.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS)
    expect(got.some((r) => r.body === 'at v1')).toBe(false)
    expect(got.some((r) => r.body === 'at v2')).toBe(true)
  })

  it('returns oldest first', () => {
    const got = conversationRows(ROWS, SPECS[1]!, SPECS)
    expect(got[0]!.at).toBeLessThan(got[1]!.at)
  })
})

describe('renderConversationMarkdown', () => {
  const META = { slug: 'devtwo', version: 2 }

  it('names the slug and the version it belongs to', () => {
    const md = renderConversationMarkdown([ROWS[2]!], META)
    expect(md).toContain('devtwo')
    expect(md).toContain('v2')
  })

  it('carries each row verbatim under a role heading', () => {
    const md = renderConversationMarkdown([ROWS[2]!, ROWS[3]!], META)
    expect(md).toContain('## user')
    expect(md).toContain('## assistant')
    expect(md).toContain('after v1')
    expect(md).toContain('at v2')
  })

  it('does not escape or reflow what someone said', () => {
    // spec.md escapes line-leading markdown because it is a designed
    // document. This is a transcript: it is read by a builder, never
    // rendered to a friend, and altering someone's words to tidy a layout is
    // not a trade this file gets to make.
    const md = renderConversationMarkdown([row(9, 'user', '# a heading I typed', 1)], META)
    expect(md).toContain('# a heading I typed')
  })

  it('says so when there is nothing in the slice', () => {
    expect(renderConversationMarkdown([], META)).toContain('No conversation')
  })
})
