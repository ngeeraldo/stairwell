import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import {
  parseMockupInput,
  parseScreenMockups,
  parseSpecVersion,
  sealVersion,
} from '@/lib/spec/validate'

function panel(over: Record<string, unknown> = {}) {
  return {
    id: 'walked_today',
    title: 'Walked today?',
    intent: 'Did I walk the dog today?',
    display: 'A big yes/no with a tap-to-mark control.',
    context_of_use: 'Phone, in bed, before getting up.',
    values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
    entry: {
      description: 'One tap.',
      fields: [{ name: 'walked', type: 'boolean', choices: [] }],
      annotates: null,
    },
    ...over,
  }
}

function draft(over: Record<string, unknown> = {}) {
  return {
    title: 'Did I walk the dog today?',
    summary: 'A one-tap daily tracker.',
    background: 'Pivoted from a weather idea.',
    change_summary: 'The whole dashboard: one tap, a streak, a 30-day rate.',
    screens: [{ id: 'today', title: 'Today', order: 1, panels: [panel()] }],
    data_requirements: [{ table: 'walks', purpose: 'One row per day walked.', status: 'new' }],
    open_questions: [],
    ...over,
  }
}

const screensWith = (...panels: unknown[]) => ({
  screens: [{ id: 'today', title: 'Today', order: 1, panels }],
})

/** Absence, not null — the two are different failures and both are tested. */
const omit = (o: Record<string, unknown>, key: string) => {
  const copy = { ...o }
  delete copy[key]
  return copy
}

/**
 * The whole-surface shape is only ever READ now: parseSpecDraft, the
 * model-output validator these cases used to go through, is gone with the
 * schema it guarded (lib/spec/validate.ts's header). Every fixture below
 * therefore goes in as a STORED row and comes back through parseSpecVersion,
 * which is the only door left into draftFrom/parseScreen/parsePanel/
 * checkInvariants — and the one `specs` rejecting UPDATE makes permanent.
 */
function stored(raw: unknown, based: number | null = null, ops?: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return JSON.stringify(raw)
  const row: Record<string, unknown> = { ...(raw as Record<string, unknown>), based_on_version: based }
  if (ops !== undefined) row.ops = ops
  return JSON.stringify(row)
}

const read = (raw: unknown, based: number | null = null) => parseSpecVersion(stored(raw, based))

describe('draftFrom, reached through parseSpecVersion', () => {
  it('accepts a well-formed stored row', () => {
    const parsed = read(draft())
    expect(parsed.screens[0]!.panels[0]!.id).toBe('walked_today')
    expect(parsed.screens[0]!.panels[0]!.values[0]!.kind).toBe('entered')
  })

  it('trims strings and drops blank list entries', () => {
    const parsed = read(draft({ title: '  Spaced  ', open_questions: ['a', '  ', 'b'] }))
    expect(parsed.title).toBe('Spaced')
    expect(parsed.open_questions).toEqual(['a', 'b'])
  })

  // The blank-entry case above is the LAUNDERING side of textList
  // (lib/spec/fields.ts): a blank string is dropped, deliberately. This is
  // the throwing side, and the two must be tested together or the first one
  // reads as permission for the second.
  //
  // It lived in tests/spec/patch.test.ts until the whole-surface authoring
  // path was deleted, where it was written as a parsePatch case — but the
  // rule it pins is textList's, not parsePatch's, and textList is live on two
  // paths: draftFrom's open_questions for every stored whole-surface row (this
  // one) and lib/spec/change.ts. A hand-rolled filter would drop 42 and let
  // this pass, which is the "the answer became none" laundering arrayField's
  // own comment warns against — in a row `specs` will never let anyone
  // correct. legacy.test.ts covers lib/spec/legacy.ts's SEPARATE textList,
  // not this one.
  it('rejects a non-string open_questions entry rather than silently dropping it', () => {
    expect(() => read(draft({ open_questions: ['keep', 42] }))).toThrow(SpecShapeError)
    expect(() => read(draft({ open_questions: ['keep', 42] }))).toThrow(/open_questions/)
  })

  it.each([
    ['a non-object', 42],
    ['zero screens', draft({ screens: [] })],
    ['a screen with zero panels', draft({ screens: [{ id: 'a', title: 'A', order: 1, panels: [] }] })],
    ['a panel with zero values', draft(screensWith(panel({ values: [] })))],
    ['an unknown value kind', draft(screensWith(panel({ values: [{ kind: 'psychic', id: 'x', description: 'y' }] })))],
    ['a blank id', draft(screensWith(panel({ id: '  ' })))],
    ['an id with a space', draft(screensWith(panel({ id: 'walked today' })))],
    ['an id with a capital', draft(screensWith(panel({ id: 'Walked' })))],
    ['a bad entry field type', draft(screensWith(panel({ entry: { description: 'd', fields: [{ name: 'n', type: 'blob', choices: [] }], annotates: null } })))],
    ['a blank annotates string', draft(screensWith(panel({ entry: { description: 'd', fields: [], annotates: '   ' } })))],
    ['a bad requirement status', draft({ data_requirements: [{ table: 't', purpose: 'p', status: 'maybe' }] })],
    ['an absent entry key', draft(screensWith(omit(panel(), 'entry')))],
    ['an absent context_of_use key', draft(screensWith(omit(panel(), 'context_of_use')))],
    // These two silently coerced to [] while every neighbouring field threw.
    // data_requirements is what tells the builder which tables a version
    // needs, so coercing it means "this dashboard needs no tables" in a build
    // contract that can never be corrected.
    ['a non-array data_requirements', draft({ data_requirements: 'walks' })],
    ['an absent data_requirements key', omit(draft(), 'data_requirements')],
    ['a null data_requirements', draft({ data_requirements: null })],
    [
      'a non-array entry fields',
      draft(screensWith(panel({ entry: { description: 'd', fields: 'walked', annotates: null } }))),
    ],
    [
      'an absent entry fields key',
      draft(screensWith(panel({ entry: { description: 'd', annotates: null } }))),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSpecVersion(stored(raw))).toThrow(SpecShapeError)
  })

  it('rejects duplicate panel ids across different screens', () => {
    expect(() =>
      read(
        draft({
          screens: [
            { id: 'a', title: 'A', order: 1, panels: [panel()] },
            { id: 'b', title: 'B', order: 2, panels: [panel()] },
          ],
        }),
      ),
    ).toThrow(/duplicate panel id/)
  })

  it('rejects duplicate value ids across different panels', () => {
    expect(() =>
      read(draft(screensWith(panel(), panel({ id: 'other' })))),
    ).toThrow(/duplicate value id/)
  })

  it('rejects a derived input naming a value that does not exist', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['nope'] }],
      entry: null,
    })
    expect(() => read(draft(screensWith(panel(), derived)))).toThrow(/unknown value/)
  })

  it('accepts a derived input naming a value in another panel', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['walk_flag'] }],
      entry: null,
    })
    expect(() => read(draft(screensWith(panel(), derived)))).not.toThrow()
  })

  it('rejects annotates pointing at a non-synced value', () => {
    // walk_flag is `entered`. Annotation only makes sense against synced rows.
    expect(() =>
      read(draft(screensWith(panel({ entry: { description: 'd', fields: [], annotates: 'walk_flag' } })))),
    ).toThrow(/annotates/)
  })

  it('accepts annotates pointing at a synced value', () => {
    const synced = panel({
      id: 'eating_out',
      values: [{ kind: 'synced', id: 'eating_out_txns', module: 'plaid', description: 'Restaurant transactions.' }],
      entry: { description: 'Tag a meal.', fields: [{ name: 'tag', type: 'text', choices: [] }], annotates: 'eating_out_txns' },
    })
    expect(() => read(draft(screensWith(synced)))).not.toThrow()
  })
})

describe('sealVersion', () => {
  it('attaches the server-supplied lineage pointer', () => {
    // The draft comes back out of parseSpecVersion rather than out of a
    // model-output validator: nothing authors this shape any more, and
    // sealVersion is still what parseSpecVersion itself constructs through.
    const base = read(draft())
    expect(sealVersion(base, 4, null).based_on_version).toBe(4)
    expect(sealVersion(base, null, null).based_on_version).toBeNull()
  })
})

describe('parseSpecVersion', () => {
  it('round-trips a sealed version', () => {
    expect(read(draft(), 2).based_on_version).toBe(2)
  })

  it('rejects a stored row with no based_on_version key', () => {
    expect(() => parseSpecVersion(JSON.stringify(draft()))).toThrow(SpecShapeError)
  })

  it('throws SpecShapeError on malformed JSON', () => {
    expect(() => parseSpecVersion('{"title": "broken')).toThrow(SpecShapeError)
  })

  it('rejects a stored row whose data_requirements is null rather than reading it as "no tables"', () => {
    // The read path is the one that matters most here: a stored row is a
    // build contract, and `specs` rejects UPDATE, so a null laundered into []
    // would tell whoever builds this version that it needs no tables at all —
    // silently, forever, in the file whose own header calls itself the last
    // gate.
    const sealed = { ...draft(), based_on_version: 1, data_requirements: null }
    expect(() => parseSpecVersion(JSON.stringify(sealed))).toThrow(/data_requirements/)
  })
})

describe('ops on a stored version', () => {
  it('round-trips through parseSpecVersion', () => {
    const version = parseSpecVersion(stored(draft(), 3, [{ op: 'remove_panel', id: 'walks' }]))
    expect(version.ops).toEqual([{ op: 'remove_panel', id: 'walks' }])
  })

  // Null means "authored whole-surface". An empty array would claim it was
  // produced by a patch that changed nothing, which is a different and
  // impossible thing.
  it('is null, not [], for a whole-surface version', () => {
    expect(parseSpecVersion(stored(draft(), null, null)).ops).toBeNull()
  })

  it('reads a pre-patch stored row, which has no ops key, as null', () => {
    // stored() omits `ops` entirely when it is not passed — absence, not null.
    expect(parseSpecVersion(stored(draft(), 1)).ops).toBeNull()
  })

  it('throws on a stored ops value that is not an array or null', () => {
    expect(() => parseSpecVersion(stored(draft(), 1, 'nope'))).toThrow(SpecShapeError)
  })

  // Final review, Minor 10. The top-level "ops is not an array" case above
  // was covered; the per-ELEMENT parseOp call (`rawOps.map((o, i) =>
  // parseOp(o, ...))`) was only "correct by inspection" — untested on this
  // read path. It matters specifically here because `specs` is append-only:
  // a row with one malformed op, once written, can never be edited, only
  // read forever after by exactly this function.
  it('throws on a stored ops array containing one malformed element', () => {
    const bad = stored(draft(), 1, [{ op: 'remove_panel', id: 'walks' }, { op: 'not_a_real_op' }])
    expect(() => parseSpecVersion(bad)).toThrow(SpecShapeError)
    // Names WHICH element and why, the same diagnosability the top-level
    // "not an array" case gets — not just "something in here is wrong".
    expect(() => parseSpecVersion(bad)).toThrow(/ops\[1\]/)
  })
})

describe('parseMockupInput', () => {
  it('returns the html', () => {
    expect(parseMockupInput({ mockup_html: '<!doctype html><p>COFFEE PALACE TEST</p>' })).toContain('TEST')
  })

  it('rejects an empty mockup', () => {
    expect(() => parseMockupInput({ mockup_html: '   ' })).toThrow(SpecShapeError)
  })
})

describe('parseScreenMockups', () => {
  it('accepts exactly the requested screens', () => {
    expect(parseScreenMockups({ screens: [{ id: 'a', html: '<section/>' }] }, ['a'])).toHaveLength(1)
  })

  it('throws on a missing screen', () => {
    expect(() => parseScreenMockups({ screens: [] }, ['a'])).toThrow(/missing screen "a"/)
  })

  it('throws on an unrequested screen', () => {
    // The requested screen ('a') must also be present here — otherwise the
    // missing-screen check above fires first and this never reaches the
    // "not requested" branch it's meant to isolate.
    expect(() =>
      parseScreenMockups(
        { screens: [{ id: 'a', html: 'x' }, { id: 'b', html: 'y' }] },
        ['a'],
      ),
    ).toThrow(/not requested/)
  })

  it('accepts an empty call when nothing was requested', () => {
    // A meta-only patch affects no screen; lib/spec/author.ts skips the call
    // entirely in that case, but the parser itself must not treat "nothing
    // requested, nothing returned" as an error.
    expect(parseScreenMockups({ screens: [] }, [])).toEqual([])
  })

  it('returns screenId/html pairs, not the raw id/html keys', () => {
    const [fragment] = parseScreenMockups(
      { screens: [{ id: 'today', html: '<section class="screen">hi</section>' }] },
      ['today'],
    )
    expect(fragment).toEqual({ screenId: 'today', html: '<section class="screen">hi</section>' })
  })

  it('rejects a non-array screens field', () => {
    expect(() => parseScreenMockups({ screens: 'nope' }, ['a'])).toThrow(SpecShapeError)
  })

  it('rejects a screen entry missing html', () => {
    expect(() => parseScreenMockups({ screens: [{ id: 'a' }] }, ['a'])).toThrow(SpecShapeError)
  })
})
