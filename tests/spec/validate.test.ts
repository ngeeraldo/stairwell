import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import {
  parseMockupInput,
  parseSpecDraft,
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

describe('parseSpecDraft', () => {
  it('accepts a well-formed draft', () => {
    const parsed = parseSpecDraft(draft())
    expect(parsed.screens[0]!.panels[0]!.id).toBe('walked_today')
    expect(parsed.screens[0]!.panels[0]!.values[0]!.kind).toBe('entered')
  })

  it('trims strings and drops blank list entries', () => {
    const parsed = parseSpecDraft(draft({ title: '  Spaced  ', open_questions: ['a', '  ', 'b'] }))
    expect(parsed.title).toBe('Spaced')
    expect(parsed.open_questions).toEqual(['a', 'b'])
  })

  it('rejects a draft carrying based_on_version', () => {
    // The server supplies it. A model-authored one is a permanent wrong row.
    expect(() => parseSpecDraft(draft({ based_on_version: 3 }))).toThrow(SpecShapeError)
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
    expect(() => parseSpecDraft(raw)).toThrow(SpecShapeError)
  })

  it('rejects duplicate panel ids across different screens', () => {
    expect(() =>
      parseSpecDraft(
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
      parseSpecDraft(draft(screensWith(panel(), panel({ id: 'other' })))),
    ).toThrow(/duplicate value id/)
  })

  it('rejects a derived input naming a value that does not exist', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['nope'] }],
      entry: null,
    })
    expect(() => parseSpecDraft(draft(screensWith(panel(), derived)))).toThrow(/unknown value/)
  })

  it('accepts a derived input naming a value in another panel', () => {
    const derived = panel({
      id: 'streak',
      values: [{ kind: 'derived', id: 'streak_days', description: 'Consecutive days.', inputs: ['walk_flag'] }],
      entry: null,
    })
    expect(() => parseSpecDraft(draft(screensWith(panel(), derived)))).not.toThrow()
  })

  it('rejects annotates pointing at a non-synced value', () => {
    // walk_flag is `entered`. Annotation only makes sense against synced rows.
    expect(() =>
      parseSpecDraft(draft(screensWith(panel({ entry: { description: 'd', fields: [], annotates: 'walk_flag' } })))),
    ).toThrow(/annotates/)
  })

  it('accepts annotates pointing at a synced value', () => {
    const synced = panel({
      id: 'eating_out',
      values: [{ kind: 'synced', id: 'eating_out_txns', module: 'plaid', description: 'Restaurant transactions.' }],
      entry: { description: 'Tag a meal.', fields: [{ name: 'tag', type: 'text', choices: [] }], annotates: 'eating_out_txns' },
    })
    expect(() => parseSpecDraft(draft(screensWith(synced)))).not.toThrow()
  })
})

describe('sealVersion', () => {
  it('attaches the server-supplied lineage pointer', () => {
    expect(sealVersion(parseSpecDraft(draft()), 4, null).based_on_version).toBe(4)
    expect(sealVersion(parseSpecDraft(draft()), null, null).based_on_version).toBeNull()
  })
})

describe('parseSpecVersion', () => {
  it('round-trips a sealed version', () => {
    const sealed = sealVersion(parseSpecDraft(draft()), 2, null)
    expect(parseSpecVersion(JSON.stringify(sealed)).based_on_version).toBe(2)
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
    const sealed = sealVersion(parseSpecDraft(draft()), 3, [{ op: 'remove_panel', id: 'walks' }])
    const read = parseSpecVersion(JSON.stringify(sealed))
    expect(read.ops).toEqual([{ op: 'remove_panel', id: 'walks' }])
  })

  // Null means "authored whole-surface". An empty array would claim it was
  // produced by a patch that changed nothing, which is a different and
  // impossible thing.
  it('is null, not [], for a whole-surface version', () => {
    const read = parseSpecVersion(JSON.stringify(sealVersion(parseSpecDraft(draft()), null, null)))
    expect(read.ops).toBeNull()
  })

  it('reads a pre-patch stored row, which has no ops key, as null', () => {
    const { ops, ...withoutOps } = sealVersion(parseSpecDraft(draft()), 1, null)
    expect(parseSpecVersion(JSON.stringify(withoutOps)).ops).toBeNull()
  })

  it('rejects a model-authored ops key on the whole-surface path', () => {
    expect(() => parseSpecDraft(draft({ ops: [] }))).toThrow(/ops/)
  })

  it('throws on a stored ops value that is not an array or null', () => {
    const bad = JSON.stringify({ ...sealVersion(parseSpecDraft(draft()), 1, null), ops: 'nope' })
    expect(() => parseSpecVersion(bad)).toThrow(SpecShapeError)
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
