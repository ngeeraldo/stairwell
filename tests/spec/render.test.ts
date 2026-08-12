import { describe, expect, it } from 'vitest'
import type { SpecPayload } from '@/lib/spec/schema'
import { renderSpecMarkdown } from '@/lib/spec/render'

const PAYLOAD: SpecPayload = {
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
    {
      name: 'Car fund',
      shows: 'Saved so far against the target',
      why: 'Wants the number visible',
      source: 'manual',
    },
  ],
  manual_logging: ['Car fund top-ups, when they happen'],
  open_questions: ['Wants a Monzo pot balance — is that reachable?'],
}

describe('renderSpecMarkdown', () => {
  it('renders every field, deterministically', () => {
    const out = renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 2,
      confirmedAt: 1_760_000_000_000,
    })
    expect(out).toBe(renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 2,
      confirmedAt: 1_760_000_000_000,
    }))

    expect(out).toContain('# Eating out and the car fund')
    expect(out).toContain('devtwo')
    expect(out).toContain('v2')
    expect(out).toContain('2025-10-09')
    expect(out).toContain('So mornings stop being a surprise.')
    expect(out).toContain('Checks the banking app most days')
    expect(out).toContain('### 1. Eating out')
    expect(out).toContain('### 2. Car fund')
    expect(out).toContain('plaid')
    expect(out).toContain('Car fund top-ups, when they happen')
    expect(out).toContain('is that reachable?')
  })

  it('warns against hand-editing, because pull-spec.sh overwrites', () => {
    const out = renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 1,
      confirmedAt: 0,
    })
    expect(out).toContain('pull-spec.sh')
  })

  it('says so plainly when a list is empty rather than rendering nothing', () => {
    // A missing heading reads as "the renderer dropped it". "None." reads as
    // "the friend had none", which is the fact.
    const out = renderSpecMarkdown(
      { ...PAYLOAD, manual_logging: [], open_questions: [] },
      { slug: 'devtwo', version: 1, confirmedAt: 0 },
    )
    expect(out).toContain('## Manual logging')
    expect(out).toContain('## Open questions')
    expect(out.match(/_None\._/g)).toHaveLength(2)
  })
})
