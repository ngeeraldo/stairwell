import { describe, expect, it } from 'vitest'
import { SpecShapeError } from '@/lib/spec/schema'
import { readStoredSpec } from '@/lib/spec/stored'

const LEGACY = JSON.stringify({
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather.',
  panels: [{ name: 'Walked today?', shows: 'Yes/no', why: 'They asked', source: 'manual' }],
  manual_logging: ['One tap per day.'],
  open_questions: [],
})

const CURRENT = JSON.stringify({
  title: 'Did I walk the dog today?',
  summary: 'A one-tap tracker.',
  background: 'Pivoted from weather.',
  change_summary: 'Added a streak.',
  based_on_version: 1,
  screens: [
    {
      id: 'today',
      title: 'Today',
      order: 1,
      panels: [
        {
          id: 'walked_today',
          title: 'Walked today?',
          intent: 'Did I walk the dog?',
          display: 'Yes/no with a tap.',
          context_of_use: null,
          values: [{ kind: 'entered', id: 'walk_flag', description: 'One tap per day.' }],
          entry: null,
        },
      ],
    },
  ],
  data_requirements: [],
  open_questions: [],
})

describe('readStoredSpec', () => {
  it('reads a pre-unification row as legacy', () => {
    const stored = readStoredSpec(LEGACY)
    expect(stored.kind).toBe('legacy')
    if (stored.kind !== 'legacy') throw new Error('unreachable')
    expect(stored.payload.panels[0]!.name).toBe('Walked today?')
  })

  it('reads a current row as a version', () => {
    const stored = readStoredSpec(CURRENT)
    expect(stored.kind).toBe('version')
    if (stored.kind !== 'version') throw new Error('unreachable')
    expect(stored.version.screens[0]!.panels[0]!.id).toBe('walked_today')
  })

  it('reports a CURRENT-shaped row that is malformed as a current-shape error', () => {
    // Discrimination is on `screens`, so a row that clearly meant to be
    // current must not be reported as "bad legacy" — that message would send
    // a reader looking at the wrong schema for a row nobody can fix.
    const broken = JSON.parse(CURRENT)
    broken.screens[0].panels[0].id = 'Not A Slug'
    expect(() => readStoredSpec(JSON.stringify(broken))).toThrow(/slug/)
  })

  it('throws SpecShapeError for a row that is neither', () => {
    expect(() => readStoredSpec('{"nonsense": true}')).toThrow(SpecShapeError)
  })
})
