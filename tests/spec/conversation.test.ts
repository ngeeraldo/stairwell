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

// The superseded case (design §7): four specs, and only v2 was ever BUILT.
// v3 was authored, never built, and superseded by v4. Newest first again.
const SUPERSEDED_SPECS = [
  spec(4, 4, 400),
  spec(3, 3, 300),
  spec(2, 2, 200),
  spec(1, 1, 100),
]
const SUPERSEDED_ROWS = [
  row(1, 'assistant', 'at v2 — the last build', 200),
  row(2, 'user', 'the weekly average, and why TEST', 250),
  row(3, 'assistant', 'at v3 — superseded, never built', 300),
  row(4, 'user', 'also drop that panel TEST', 350),
  row(5, 'assistant', 'at v4', 400),
  row(6, 'user', 'after v4', 450),
]

describe('conversationRows', () => {
  it('takes everything up to a first spec', () => {
    // No built base at all — nothing has shipped yet, so the whole
    // conversation up to the spec belongs to this first build.
    const got = conversationRows(ROWS, SPECS[1]!, undefined)
    expect(got.map((r) => r.body)).toEqual(['before v1', 'at v1'])
  })

  it('takes only the rows since the last built version', () => {
    // The ordinary case, unchanged: every version was built, so the last
    // built version IS the row one version below. The conversation that
    // produced v2 — not the one that produced v1.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS[1]!)
    expect(got.map((r) => r.body)).toEqual(['after v1', 'at v2'])
  })

  it('is exclusive at the bottom and inclusive at the top', () => {
    // A row written in the same millisecond as the boundary spec belongs to
    // that spec's slice, not to this one — otherwise two consecutive pulls
    // both carry it.
    const got = conversationRows(ROWS, SPECS[0]!, SPECS[1]!)
    expect(got.some((r) => r.body === 'at v1')).toBe(false)
    expect(got.some((r) => r.body === 'at v2')).toBe(true)
  })

  it('returns oldest first', () => {
    const got = conversationRows(ROWS, SPECS[1]!, undefined)
    expect(got[0]!.at).toBeLessThan(got[1]!.at)
  })

  it('reaches back past a SUPERSEDED spec to the last built version', () => {
    // v3 was authored and never built; v4 supersedes it. spec.md for v4 is a
    // change against current.md, which still describes v2 — so the
    // conversation beside it has to reach back to v2 as well, or the residue
    // about the person that §5.0.1 promised survives only here is in neither
    // file.
    const got = conversationRows(SUPERSEDED_ROWS, SUPERSEDED_SPECS[0]!, SUPERSEDED_SPECS[2]!)
    expect(got.map((r) => r.body)).toEqual([
      'the weekly average, and why TEST',
      'at v3 — superseded, never built',
      'also drop that panel TEST',
      'at v4',
    ])
  })

  it('does not stop at the previous spec ROW when that row was never built', () => {
    // The defect this boundary exists to prevent, stated as its own
    // assertion: slicing on spec.version - 1 would start at v3 and drop
    // everything the friend said before it.
    const got = conversationRows(SUPERSEDED_ROWS, SUPERSEDED_SPECS[0]!, SUPERSEDED_SPECS[2]!)
    expect(got.some((r) => r.body === 'the weekly average, and why TEST')).toBe(true)
    // Still exclusive at the built boundary itself, and still stops at v4.
    expect(got.some((r) => r.body === 'at v2 — the last build')).toBe(false)
    expect(got.some((r) => r.body === 'after v4')).toBe(false)
  })

  it('takes everything up to the spec when nothing has been built yet', () => {
    // Two specs authored, neither built. That is a first build, whatever the
    // version number says.
    const got = conversationRows(SUPERSEDED_ROWS, SUPERSEDED_SPECS[0]!, undefined)
    expect(got.map((r) => r.body)).toEqual([
      'at v2 — the last build',
      'the weekly average, and why TEST',
      'at v3 — superseded, never built',
      'also drop that panel TEST',
      'at v4',
    ])
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
    //
    // ASSERTED AS EXACT TEXT, not toContain, and that is the whole point of
    // this test. `toContain('# a heading I typed')` passes on the ESCAPED
    // string too — '\\# a heading I typed' contains it — so the substring
    // form pinned nothing at all. Both defects this rule exists to prevent
    // (escaping line-leading markdown, and collapsing whitespace to tidy a
    // layout) were confirmed to leave the substring version green.
    //
    // The body below is chosen to catch either: a line-leading '#', a
    // line-leading '-', runs of interior spaces, a leading indent, an emphasis
    // marker, and a blank line between paragraphs.
    const body =
      '# a heading I typed\n' +
      '\n' +
      '  - two   spaces  and a *star*\n' +
      '> and a quote\n'

    const md = renderConversationMarkdown([row(9, 'user', body, 1)], META)

    expect(md).toBe(
      '# devtwo — the conversation behind spec v2\n' +
        '\n' +
        '<!-- Generated from the transcript by scripts/pull-spec.sh.\n' +
        '     Everything said since the last BUILT version, up to this spec —\n' +
        '     the same base current.md describes, not the previous spec row.\n' +
        '     Gitignored: this is a raw transcript, not a designed artifact.\n' +
        '     Do not hand-edit: the next pull overwrites this file. -->\n' +
        '\n' +
        '## user — 1970-01-01T00:00:00.001Z\n' +
        '\n' +
        '# a heading I typed\n' +
        '\n' +
        '  - two   spaces  and a *star*\n' +
        '> and a quote\n' +
        '\n',
    )
  })

  it('says so when there is nothing in the slice', () => {
    const md = renderConversationMarkdown([], META)
    expect(md).toContain('No conversation')
    // Names the boundary the slice actually used. This repo has no gate that
    // catches a comment going false, and this sentence is the only thing on
    // disk telling a builder what the empty file means.
    expect(md).toContain('last built version')
  })

  it('says in the header that the slice runs from the last BUILT version', () => {
    // The header is the only place the file explains its own bounds, and a
    // stale one would describe the exact defect this boundary fixes.
    const md = renderConversationMarkdown([ROWS[2]!], META)
    expect(md).toContain('last BUILT version')
  })
})
