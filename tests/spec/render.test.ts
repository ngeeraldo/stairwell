import { describe, expect, it } from 'vitest'
import type { Panel, SpecPayload } from '@/lib/spec/schema'
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

    // `safeMarkdown()` is applied at 8 interpolation sites in render.ts:
    // list() items (manual_logging, open_questions), panel.name,
    // panel.shows, panel.why, panel.source, payload.title, payload.summary,
    // payload.background. A fixture confined to only some of them proves
    // nothing about the rest — round 4's DANGEROUS_PAYLOAD only attacked
    // title/summary/background, so an escaping bug isolated to, say,
    // panel.shows or the list() helper would have shipped silently. Every
    // site below carries an attack, and the shape (panel count, list
    // lengths) stays identical to PAYLOAD so the differential count stays
    // meaningful. Attack forms are varied rather than repeated: a bare `#`
    // heading, a `## ` heading, a no-space `##` heading, an unterminated
    // fence, and the exact `## Summary` collision that defeated round 3
    // all appear somewhere below.
    const DANGEROUS_PAYLOAD: SpecPayload = {
      // Site: payload.title. Exact-string collision — the case that
      // defeated round 3: text equal to one of the renderer's own fixed
      // heading strings, indistinguishable from the real one by content.
      title: `${PAYLOAD.title}\n## Summary`,
      // Site: payload.summary. A heading with no space after the hashes.
      summary: `So mornings stop being a surprise.
##Sneaky heading with no space`,
      // Site: payload.background. An unterminated fence followed by a
      // bare `# ` heading — two attack forms in one field.
      background: `Checks the banking app most days.
Here is an unterminated fence:
\`\`\`

And a line starting with hash:
# This should not be a real heading`,
      panels: [
        {
          // Site: panel.name. Bare `#` heading.
          name: 'Eating out\n# Not a real heading either',
          // Site: panel.shows. `## ` heading (with a space, unlike summary's).
          shows: 'This month against last month\n## Also not a heading',
          // Site: panel.why. Unterminated fence.
          why: 'Said it is where the money goes\n```',
          // Site: panel.source. The schema constrains a real payload's
          // source to plaid/manual/derived, so this text could never
          // arrive through the validator — construct it directly and cast
          // past the type, because the escaping call exists at this site
          // regardless, and the test should hold it to the same standard.
          // Exact-string collision again, at a fifth different site.
          source: 'plaid\n## Summary' as unknown as Panel['source'],
        },
        {
          name: 'Car fund',
          shows: 'Saved so far against the target',
          why: 'Wants the number visible',
          source: 'manual',
        },
      ],
      // Site: list() — shared by manual_logging and open_questions.
      // Different attack form in each so both call sites are exercised.
      manual_logging: ['Car fund top-ups, when they happen\n# List item heading'],
      open_questions: ['Wants a Monzo pot balance — is that reachable?\n```'],
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
