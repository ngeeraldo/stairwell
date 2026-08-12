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
    // Pin the exact bytes of the output, not just self-consistency. This catches
    // nondeterminism that reaches the output (e.g., reading the clock at second
    // granularity) AND unintended format drift. A self-comparison would not catch
    // a regression that read time at second granularity.
    const out = renderSpecMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 2,
      confirmedAt: 1_760_000_000_000,
    })
    expect(out).toBe(`# Eating out and the car fund

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** devtwo
- **Spec version:** v2
- **Confirmed:** 2025-10-09T08:53:20.000Z

## Summary

So mornings stop being a surprise.

## Background

Checks the banking app most days, does not trust it.

## Panels

### 1. Eating out

- **Shows:** This month against last month
- **Why:** Said it is where the money goes
- **Source:** plaid

### 2. Car fund

- **Shows:** Saved so far against the target
- **Why:** Wants the number visible
- **Source:** manual

## Manual logging

- Car fund top-ups, when they happen

## Open questions

- Wants a Monzo pot balance — is that reachable?
`)
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

  it('escapes line-leading markdown structure to prevent unterminated code blocks and spurious headings', () => {
    // A field containing an unterminated ``` fence should not swallow all
    // following sections into inert code text. A field containing # at
    // line start should not spoof real headings. Use backslash escaping to
    // neutralise user-supplied structure while preserving readability.
    const out = renderSpecMarkdown(
      {
        ...PAYLOAD,
        background: `Checks the banking app most days.
Here is an unterminated fence:
\`\`\`

And a line starting with hash:
# This should not be a real heading`,
      },
      { slug: 'devtwo', version: 1, confirmedAt: 0 },
    )
    // Verify the real section headings are still there and not inside code.
    expect(out).toContain('## Panels')
    expect(out).toContain('## Manual logging')
    expect(out).toContain('## Open questions')

    // Structural assertion: CommonMark rule violation check. After stripping
    // up to 3 leading spaces, no line should start with # (which would be a
    // heading) or ``` (which would be a fence), UNLESS it's a heading created
    // by the renderer. The renderer creates headings with #, ##, ###, and they
    // appear at known structural positions.
    const rendererHeadingPatterns = [
      /^# /, // h1: title
      /^## Summary$/,
      /^## Background$/,
      /^## Panels$/,
      /^### \d+\./, // h3: panel heading
      /^## Manual logging$/,
      /^## Open questions$/,
    ]

    const lines = out.split('\n')
    for (const line of lines) {
      const stripped = line.replace(/^ {0,3}/, '')

      // Check for dangerous # (user-supplied heading)
      if (stripped.startsWith('#')) {
        const isRendererHeading = rendererHeadingPatterns.some((pattern) =>
          pattern.test(stripped),
        )
        expect(
          isRendererHeading,
          `User content should not create headings: ${stripped}`,
        ).toBe(true)
      }

      // Check for dangerous ``` (user-supplied fence)
      if (stripped.startsWith('```')) {
        expect.fail(`User content should not create fences: ${stripped}`)
      }
    }
  })
})
