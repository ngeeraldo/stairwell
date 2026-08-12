import { describe, expect, it } from 'vitest'
import {
  SPEC_JSON_SCHEMA,
  SpecShapeError,
  parseSpecInput,
  parseSpecPayload,
} from '@/lib/spec/schema'

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
    mockup_html: '<!doctype html><html><body><p>COFFEE PALACE TEST</p></body></html>',
    ...over,
  }
}

describe('parseSpecInput', () => {
  it('accepts a well-formed payload and splits the mockup out', () => {
    const { payload, mockupHtml } = parseSpecInput(good())
    expect(payload.title).toBe('Eating out and the car fund')
    expect(payload.panels[0]!.source).toBe('plaid')
    expect(mockupHtml).toContain('COFFEE PALACE TEST')
    // mockup_html is a separate column, never part of the payload.
    expect(payload).not.toHaveProperty('mockup_html')
  })

  it('trims whitespace and drops blank list entries', () => {
    const { payload } = parseSpecInput(
      good({ title: '  Spaced  ', manual_logging: ['a', '   ', 'b'] }),
    )
    expect(payload.title).toBe('Spaced')
    expect(payload.manual_logging).toEqual(['a', 'b'])
  })

  it.each([
    ['a non-object', 42],
    ['null', null],
    ['a missing field', (() => { const g = good(); delete (g as Record<string, unknown>).summary; return g })()],
    ['an empty title', good({ title: '   ' })],
    ['an empty mockup', good({ mockup_html: '' })],
    ['a non-string title', good({ title: 7 })],
    ['panels that are not an array', good({ panels: {} })],
    ['zero panels', good({ panels: [] })],
    ['a panel missing a field', good({ panels: [{ name: 'a', shows: 'b', why: 'c' }] })],
    ['a bad panel source', good({ panels: [{ name: 'a', shows: 'b', why: 'c', source: 'sql' }] })],
    ['a non-string list item', good({ open_questions: [3] })],
    ['manual_logging that is not an array', good({ manual_logging: 'weight' })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSpecInput(raw)).toThrow(SpecShapeError)
  })

  it('allows empty manual_logging and open_questions', () => {
    const { payload } = parseSpecInput(
      good({ manual_logging: [], open_questions: [] }),
    )
    expect(payload.manual_logging).toEqual([])
    expect(payload.open_questions).toEqual([])
  })
})

describe('parseSpecPayload', () => {
  it('accepts a well-formed stored payload JSON', () => {
    const payload = {
      title: 'Eating out and the car fund',
      summary: 'So mornings stop being a surprise.',
      background: 'Checks the banking app most days, does not trust it.',
      panels: [
        {
          name: 'Eating out',
          shows: 'This month against last month',
          why: 'Said it is where the money goes',
          source: 'plaid' as const,
        },
      ],
      manual_logging: ['Weight, most mornings'],
      open_questions: [],
    }
    const json = JSON.stringify(payload)
    const result = parseSpecPayload(json)
    expect(result.title).toBe('Eating out and the car fund')
    expect(result.panels[0]!.source).toBe('plaid')
  })

  it('rejects a stored payload that is malformed in a payload field', () => {
    const malformedPayload = {
      title: '',
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
    }
    const json = JSON.stringify(malformedPayload)
    expect(() => parseSpecPayload(json)).toThrow(SpecShapeError)
  })

  it('throws SpecShapeError specifically when JSON is malformed', () => {
    const invalidJson = '{"title": "broken'
    expect(() => parseSpecPayload(invalidJson)).toThrow(SpecShapeError)
  })
})

describe('SPEC_JSON_SCHEMA', () => {
  it('requires exactly the fields the validator requires', () => {
    // The schema constrains the model and the validator guards the database.
    // If they drift, the model is told to produce one shape and we accept
    // another, and the mismatch only shows up as a spec_error in production.
    expect([...SPEC_JSON_SCHEMA.required].sort()).toEqual([
      'background',
      'manual_logging',
      'mockup_html',
      'open_questions',
      'panels',
      'summary',
      'title',
    ])
    expect(Object.keys(SPEC_JSON_SCHEMA.properties).sort()).toEqual(
      [...SPEC_JSON_SCHEMA.required].sort(),
    )
  })

  it('pins the panel source enum to the three real sources', () => {
    expect(
      SPEC_JSON_SCHEMA.properties.panels.items.properties.source.enum,
    ).toEqual(['plaid', 'manual', 'derived'])
  })
})
