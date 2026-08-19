import { describe, expect, it } from 'vitest'
import { MOCKUP_JSON_SCHEMA, SCREEN_MOCKUP_JSON_SCHEMA } from '@/lib/spec/schema'

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

// SPEC_JSON_SCHEMA's own describe block is gone with the constant: nothing
// constrains a model to the whole-surface shape any more. The equivalent
// assertions for the LIVE shape live in tests/spec/change.test.ts against
// SPEC_CHANGE_JSON_SCHEMA. What remains here is the two mockup schemas, kept
// as HISTORICAL constants (lib/spec/schema.ts) rather than deleted.

describe('MOCKUP_JSON_SCHEMA', () => {
  it('asks for one field and nothing else', () => {
    expect([...MOCKUP_JSON_SCHEMA.required]).toEqual(['mockup_html'])
    expect(MOCKUP_JSON_SCHEMA.additionalProperties).toBe(false)
  })
})

describe('SCREEN_MOCKUP_JSON_SCHEMA', () => {
  it('asks for one array field and nothing else', () => {
    expect([...SCREEN_MOCKUP_JSON_SCHEMA.required]).toEqual(['screens'])
    expect(SCREEN_MOCKUP_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(SCREEN_MOCKUP_JSON_SCHEMA.properties.screens.type).toBe('array')
  })

  it('requires exactly id and html on each screen entry, nothing else', () => {
    const item = SCREEN_MOCKUP_JSON_SCHEMA.properties.screens.items
    expect(item.additionalProperties).toBe(false)
    expect([...item.required].sort()).toEqual(['html', 'id'])
    expect(Object.keys(item.properties).sort()).toEqual([...item.required].sort())
  })

  it('sets additionalProperties false on every object node', () => {
    const nodes = objectNodes(SCREEN_MOCKUP_JSON_SCHEMA)
    expect(nodes.length).toBeGreaterThan(1)
    for (const node of nodes) expect(node.additionalProperties).toBe(false)
  })

  it('has no minItems — zero affected screens was a legitimate call shape', () => {
    // Historical, like the constant itself. A meta-only patch touched no
    // screen, and that empty result was legitimate: the caller skipped the
    // call on it rather than the schema forbidding it. Both the caller and
    // the composer that consumed the result are deleted (mockup-loop
    // removal), so this pins the frozen constant, not live behaviour.
    expect(JSON.stringify(SCREEN_MOCKUP_JSON_SCHEMA)).not.toContain('minItems')
  })
})
