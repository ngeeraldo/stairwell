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

  it('does not let user content add headings or code fences beyond the renderer\'s own', () => {
    // Any allow-list keyed on line TEXT can be defeated by attacker text
    // that equals an allowed string. Round 2 exempted anything matching
    // /^# /, which the fixture `# This should not be a real heading` also
    // matched. Round 3 replaced that with a Set of the renderer's exact
    // heading strings — but five of those strings (e.g. `## Summary`) are
    // FIXED, present verbatim in every render, so a payload field whose
    // text is exactly `## Summary` is indistinguishable from the real one
    // no matter which field produced it.
    //
    // Stop trying to name the renderer's own headings. Instead render the
    // SAME payload shape twice — once with safe text, once with dangerous
    // fixtures substituted in — and count lines that LOOK structural
    // (heading or code-fence-opener, per the CommonMark rule that up to
    // three leading spaces still counts) in each. Escaping that works
    // keeps the count identical: an attacker's injected heading or fence
    // is an ADDITIONAL structural-looking line, so the count rises no
    // matter what text it carries — `# Anything`, `## Summary`, or a
    // string nobody anticipated.
    const countStructuralLines = (markdown: string): number =>
      markdown.split('\n').filter((line) => {
        // CommonMark tolerates up to 3 leading spaces before a line is
        // still interpreted as a heading or a fence opener.
        const stripped = line.replace(/^ {0,3}/, '')
        return stripped.startsWith('#') || stripped.startsWith('```')
      }).length

    const DANGEROUS_PAYLOAD: SpecPayload = {
      ...PAYLOAD,
      // Fixture 1: an unterminated fence followed by a spoofed heading,
      // in `background`.
      background: `Checks the banking app most days.
Here is an unterminated fence:
\`\`\`

And a line starting with hash:
# This should not be a real heading`,
      // Fixture 2: a heading with no space after the hashes, in
      // `summary` — a different field from fixture 1.
      summary: `So mornings stop being a surprise.
##Sneaky heading with no space`,
      // Fixture 3: text EXACTLY equal to one of the renderer's own fixed
      // heading strings, in `title` — a different field again. This is
      // the case that defeated round 3: a content-keyed allow-list
      // exempts this exact string regardless of which field produced it.
      // A count does not care what the text says, only that it is one
      // more structural-looking line than the safe render has.
      title: `${PAYLOAD.title}\n## Summary`,
    }

    const safeCount = countStructuralLines(
      renderSpecMarkdown(PAYLOAD, { slug: 'devtwo', version: 1, confirmedAt: 0 }),
    )
    const dangerousCount = countStructuralLines(
      renderSpecMarkdown(DANGEROUS_PAYLOAD, {
        slug: 'devtwo',
        version: 1,
        confirmedAt: 0,
      }),
    )

    expect(dangerousCount).toBe(safeCount)
  })
})
