import { describe, expect, it } from 'vitest'
import { parseLegacySpecPayload } from '@/lib/spec/legacy'
import { SpecShapeError } from '@/lib/spec/schema'

/**
 * legacy.ts is a READER now: the authoring exports it briefly carried
 * (LEGACY_SPEC_JSON_SCHEMA, LegacySpecInput, parseLegacySpecInput) are gone
 * with the switch to the whole-surface shape, and nothing may author this
 * shape again. The validation coverage they used to carry lives here instead,
 * driving the one surviving entry point — these rows can never be repaired
 * (`specs` rejects UPDATE), so the reader still has to reject junk loudly.
 */
function good(over: Record<string, unknown> = {}) {
  return {
    title: 'Eating out and the car fund',
    summary: 'So mornings stop being a surprise.',
    background: 'Checks the banking app most days, does not trust it.',
    panels: [
      {
        name: 'Eating out',
        shows: 'This month against last month',
        why: 'Said it is where the money goes',
        source: 'plaid',
      },
    ],
    manual_logging: ['Weight, most mornings'],
    open_questions: [],
    ...over,
  }
}

describe('parseLegacySpecPayload', () => {
  it('accepts a well-formed stored payload JSON', () => {
    const result = parseLegacySpecPayload(JSON.stringify(good()))
    expect(result.title).toBe('Eating out and the car fund')
    expect(result.panels[0]!.source).toBe('plaid')
    // mockup_html is a separate column, never part of the payload.
    expect(result).not.toHaveProperty('mockup_html')
  })

  it('trims whitespace and drops blank list entries', () => {
    const result = parseLegacySpecPayload(
      JSON.stringify(good({ title: '  Spaced  ', manual_logging: ['a', '   ', 'b'] })),
    )
    expect(result.title).toBe('Spaced')
    expect(result.manual_logging).toEqual(['a', 'b'])
  })

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['a missing field', (() => { const g = good(); delete (g as Record<string, unknown>).summary; return g })()],
    ['an empty title', good({ title: '   ' })],
    ['a non-string title', good({ title: 7 })],
    ['panels that are not an array', good({ panels: {} })],
    ['zero panels', good({ panels: [] })],
    ['a panel missing a field', good({ panels: [{ name: 'a', shows: 'b', why: 'c' }] })],
    ['a bad panel source', good({ panels: [{ name: 'a', shows: 'b', why: 'c', source: 'sql' }] })],
    ['a non-string list item', good({ open_questions: [3] })],
    ['manual_logging that is not an array', good({ manual_logging: 'weight' })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseLegacySpecPayload(JSON.stringify(raw))).toThrow(SpecShapeError)
  })

  it('allows empty manual_logging and open_questions', () => {
    const result = parseLegacySpecPayload(
      JSON.stringify(good({ manual_logging: [], open_questions: [] })),
    )
    expect(result.manual_logging).toEqual([])
    expect(result.open_questions).toEqual([])
  })

  it('throws SpecShapeError specifically when JSON is malformed', () => {
    expect(() => parseLegacySpecPayload('{"title": "broken')).toThrow(SpecShapeError)
  })
})
