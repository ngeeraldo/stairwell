import { describe, expect, it } from 'vitest'
import { MOCKUP_JSON_SCHEMA, SPEC_JSON_SCHEMA } from '@/lib/spec/schema'

/** Walk every object node in a JSON Schema, including inside anyOf. */
function objectNodes(node: unknown, out: Record<string, unknown>[] = []) {
  if (typeof node !== 'object' || node === null) return out
  const n = node as Record<string, unknown>
  if (n.type === 'object') out.push(n)
  for (const value of Object.values(n)) {
    if (Array.isArray(value)) value.forEach((v) => objectNodes(v, out))
    else objectNodes(value, out)
  }
  return out
}

describe('SPEC_JSON_SCHEMA', () => {
  it('asks the model for exactly the model-authored fields', () => {
    // based_on_version is server-supplied and must NOT be here (ledger D2):
    // a model-authored lineage pointer becomes a permanent wrong row.
    // mockup_html is a separate call now (ledger D7).
    expect([...SPEC_JSON_SCHEMA.required].sort()).toEqual([
      'background',
      'change_summary',
      'data_requirements',
      'open_questions',
      'screens',
      'summary',
      'title',
    ])
    expect(Object.keys(SPEC_JSON_SCHEMA.properties).sort()).toEqual(
      [...SPEC_JSON_SCHEMA.required].sort(),
    )
  })

  it('sets additionalProperties false on every object node', () => {
    const nodes = objectNodes(SPEC_JSON_SCHEMA)
    expect(nodes.length).toBeGreaterThan(4)
    for (const node of nodes) expect(node.additionalProperties).toBe(false)
  })

  it('uses no constraint keyword outside the supported subset', () => {
    // minItems/minLength/maxLength are NOT in the structured-output subset.
    // A "min 1" rule that lives here would be silently ignored; every one of
    // them belongs in lib/spec/validate.ts instead.
    const json = JSON.stringify(SPEC_JSON_SCHEMA)
    for (const banned of ['minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum']) {
      expect(json).not.toContain(banned)
    }
  })

  it('discriminates value kinds with a const, not a bare enum', () => {
    const values = SPEC_JSON_SCHEMA.properties.screens.items.properties.panels
      .items.properties.values
    expect(values.items.anyOf.map((v: { properties: { kind: { const: string } } }) =>
      v.properties.kind.const)).toEqual(['synced', 'entered', 'derived'])
  })
})

describe('MOCKUP_JSON_SCHEMA', () => {
  it('asks for one field and nothing else', () => {
    expect([...MOCKUP_JSON_SCHEMA.required]).toEqual(['mockup_html'])
    expect(MOCKUP_JSON_SCHEMA.additionalProperties).toBe(false)
  })
})
