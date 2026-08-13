import { describe, expect, it } from 'vitest'
import type { LegacyPanel, LegacySpecPayload } from '@/lib/spec/legacy'
import type { Panel, SpecVersion } from '@/lib/spec/schema'
import { parseSpecDraft, sealVersion } from '@/lib/spec/validate'
import { renderLegacyMarkdown, renderSpecMarkdown } from '@/lib/spec/render'

const PAYLOAD: LegacySpecPayload = {
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

describe('renderLegacyMarkdown', () => {
  it('renders every field, deterministically', () => {
    // Pin the exact bytes of the output, not just self-consistency. This catches
    // nondeterminism that reaches the output (e.g., reading the clock at second
    // granularity) AND unintended format drift. A self-comparison would not catch
    // a regression that read time at second granularity.
    const out = renderLegacyMarkdown(PAYLOAD, {
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
    const out = renderLegacyMarkdown(PAYLOAD, {
      slug: 'devtwo',
      version: 1,
      confirmedAt: 0,
    })
    expect(out).toContain('pull-spec.sh')
  })

  it('says so plainly when a list is empty rather than rendering nothing', () => {
    // A missing heading reads as "the renderer dropped it". "None." reads as
    // "the friend had none", which is the fact.
    const out = renderLegacyMarkdown(
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
    const DANGEROUS_PAYLOAD: LegacySpecPayload = {
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
          source: 'plaid\n## Summary' as unknown as LegacyPanel['source'],
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
      renderLegacyMarkdown(PAYLOAD, { slug: 'devtwo', version: 1, confirmedAt: 0 }),
    )
    const dangerousCount = countStructuralLines(
      renderLegacyMarkdown(DANGEROUS_PAYLOAD, {
        slug: 'devtwo',
        version: 1,
        confirmedAt: 0,
      }),
    )

    expect(dangerousCount).toBe(safeCount)
  })
})

// --- renderSpecMarkdown: the new whole-surface renderer ------------------
//
// Fixtures below are copied from tests/spec/validate.test.ts's panel()/draft()
// shape (same convention tests/spec/diff.test.ts already follows: "Copied ...
// per the brief, so this file's fixtures don't drift if that file's shapes
// change later") rather than imported, because a shared test-fixture module
// would let a change made for ONE test file's needs silently ripple into
// another's.

function panel(over: Partial<Panel> = {}): Panel {
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

function draft(over: Record<string, unknown> = {}): unknown {
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

/** Goes through the real validator/sealer rather than being cast, so `version`
 * is a genuine SpecVersion and not just an object that happens to typecheck
 * as one — same rationale tests/spec/diff.test.ts gives for its own `v1`. */
const version: SpecVersion = sealVersion(parseSpecDraft(draft()), null)

/** A version whose only value anywhere is `synced`, so the derived "Entered
 * by hand" section has nothing to list. Isolates the empty-section case from
 * the populated one without touching `version` itself. */
const allSyncedVersion: SpecVersion = sealVersion(
  parseSpecDraft(
    draft({
      screens: [
        {
          id: 'today',
          title: 'Today',
          order: 1,
          panels: [
            panel({
              values: [
                {
                  kind: 'synced',
                  id: 'walk_synced',
                  module: 'plaid',
                  description: 'Steps synced automatically.',
                },
              ],
              entry: null,
            }),
          ],
        },
      ],
    }),
  ),
  null,
)

/** Two screens whose ARRAY position is the reverse of their `order` field —
 * "second" is stored first, "first" is stored second. Isolates the
 * Entered-by-hand section's screen-walk order from its storage order, which
 * a self-review round caught disagreeing (collectEnteredValues originally
 * walked `version.screens` directly instead of the order-sorted copy the
 * Screens section itself renders). */
const outOfOrderVersion: SpecVersion = sealVersion(
  parseSpecDraft(
    draft({
      screens: [
        {
          id: 'second',
          title: 'Second',
          order: 2,
          panels: [
            panel({
              id: 'panel_two',
              values: [{ kind: 'entered', id: 'value_two', description: 'Second value.' }],
            }),
          ],
        },
        {
          id: 'first',
          title: 'First',
          order: 1,
          panels: [
            panel({
              id: 'panel_one',
              values: [{ kind: 'entered', id: 'value_one', description: 'First value.' }],
            }),
          ],
        },
      ],
    }),
  ),
  null,
)

const meta = { slug: 'devtwo', version: 1, confirmedAt: 1_760_000_000_000 }

/** Replaces one panel's intent in place, mirroring diff.test.ts's
 * withPanelTitle — everything else (id, screen, values, entry) is untouched,
 * isolating "intent is hostile text" as the only edit. */
function withPanelIntent(v: SpecVersion, panelId: string, intent: string): SpecVersion {
  return {
    ...v,
    screens: v.screens.map((s) => ({
      ...s,
      panels: s.panels.map((p) => (p.id === panelId ? { ...p, intent } : p)),
    })),
  }
}

describe('renderSpecMarkdown', () => {
  it('renders sections in the stable order the spec doc fixes', () => {
    const md = renderSpecMarkdown(version, meta)
    const order = ['## What changed', '## Summary', '## Background', '## Screens',
                   '## Entered by hand', '## Data requirements', '## Open questions']
    const positions = order.map((h) => md.indexOf(h))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('carries each panel id, so the build knows what the diff was talking about', () => {
    expect(renderSpecMarkdown(version, meta)).toContain('`walked_today`')
  })

  it('labels each value with its source kind', () => {
    const md = renderSpecMarkdown(version, meta)
    expect(md).toMatch(/entered.*One tap per day/i)
  })

  it('derives the entered-by-hand section from entered values', () => {
    // manual_logging is gone; this section is computed, not authored, so it can
    // never disagree with the values it summarises.
    expect(renderSpecMarkdown(version, meta)).toContain('One tap per day')
  })

  it('says so plainly when a version has no entered values', () => {
    expect(renderSpecMarkdown(allSyncedVersion, meta)).toMatch(/## Entered by hand\n\n_None\./)
  })

  it('lists entered values in screen ORDER, not array-storage order', () => {
    // outOfOrderVersion stores "second" (order: 2) before "first" (order: 1).
    // The Screens section renders by `order`, so Entered-by-hand — a
    // DIFFERENT walk over the same version — must agree with it, or the two
    // sections of one build contract would tell a reader two different
    // stories about which screen came first.
    const md = renderSpecMarkdown(outOfOrderVersion, meta)
    const enteredBlock = md.slice(md.indexOf('## Entered by hand'), md.indexOf('## Data requirements'))
    expect(enteredBlock.indexOf('First value')).toBeGreaterThanOrEqual(0)
    expect(enteredBlock.indexOf('Second value')).toBeGreaterThanOrEqual(0)
    expect(enteredBlock.indexOf('First value')).toBeLessThan(enteredBlock.indexOf('Second value'))
  })

  it('escapes a leading # or fence in every interpolated field', () => {
    // Differential: same fixture through every field, one at a time.
    for (const field of ['title', 'summary', 'background', 'change_summary']) {
      const hostile = { ...version, [field]: '# pwned\n```' }
      expect(renderSpecMarkdown(hostile, meta)).not.toMatch(/^# pwned$/m)
    }
  })

  it('escapes hostile text inside a panel and a value too', () => {
    // The step-4 ledger flagged the fixture-based escaping test as able to miss
    // a NEW interpolation site. The new renderer has many more sites, so this
    // walks panel and value fields as well, not just the top-level ones.
    const hostile = withPanelIntent(version, 'walked_today', '# pwned')
    expect(renderSpecMarkdown(hostile, meta)).not.toMatch(/^# pwned$/m)
  })

  it('is deterministic', () => {
    expect(renderSpecMarkdown(version, meta)).toBe(renderSpecMarkdown(version, meta))
  })
})
