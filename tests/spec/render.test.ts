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

<!-- Generated from the spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** devtwo
- **Spec version:** v2
- **Version date:** 2025-10-09T08:53:20.000Z

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
const version: SpecVersion = sealVersion(parseSpecDraft(draft()), null, null)

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
  null,
)

/** A version with every optional/list field populated (non-null
 * context_of_use, a non-empty open_questions), used only as the SAFE half of
 * the differential escaping test below — DANGEROUS_VERSION mirrors this
 * shape exactly (same screen/panel/value/entry-field/requirement/question
 * counts), so the two renders differ only in field CONTENT, never in how
 * many of the renderer's own fixed headings appear. */
const RICH_VERSION: SpecVersion = sealVersion(
  parseSpecDraft(draft({ open_questions: ['Wants a Monzo pot balance — is that reachable?'] })),
  null,
  null,
)

/**
 * Same shape as RICH_VERSION, field for field, but every free-text field
 * carries a SECOND LINE that looks structural. Per the review finding on
 * renderPanel's own comment (lib/spec/render.ts): a single-line fixture like
 * `'# pwned'` cannot observe an inline interpolation site, because whatever
 * precedes it on the same line (a label, a bullet, another field's value)
 * keeps it off the true start of an output line. A multi-line fixture does
 * not have that problem — text after the `'\n'` starts a fresh line
 * regardless of what came before it, which is exactly how
 * renderLegacyMarkdown's OWN differential test already catches a bug at its
 * inline `panel.shows` site. Every site below carries an attack: the four
 * top-level fields, both inline sites (screen.title, panel.title,
 * value.description, entry.fields[].name, data_requirement.table/purpose),
 * and both own-line sites (panel.intent/display/context_of_use,
 * entry.description) that aren't already covered by a dedicated test above.
 * Attack forms vary rather than repeat, including two exact collisions with
 * this renderer's own fixed heading text — the case that specifically
 * defeats any escaping approach keyed on what the injected text looks like
 * rather than on where it lands.
 */
const DANGEROUS_VERSION: SpecVersion = sealVersion(
  parseSpecDraft({
    // Site: version.title. Exact-string collision with a real fixed heading.
    title: 'Did I walk the dog today?\n## Summary',
    // Site: version.summary. A heading with no space after the hashes.
    summary: 'A one-tap daily tracker.\n##Sneaky heading with no space',
    // Site: version.background. An unterminated fence.
    background: 'Pivoted from a weather idea.\n```\nunterminated fence',
    // Site: version.change_summary. Bare `#` heading.
    change_summary: 'The whole dashboard: one tap, a streak, a 30-day rate.\n# Not a real heading',
    screens: [
      {
        id: 'today',
        // Site: screen.title. An INLINE site ("### " + text, same line) —
        // this is the shape Important 1 is about: only a multi-line fixture
        // can observe it.
        title: 'Today\n## Background',
        order: 1,
        panels: [
          {
            id: 'walked_today',
            // Site: panel.title. Also inline ("#### `id` — " + text).
            // Exact collision with another of the renderer's own headings.
            title: 'Walked today?\n## Entered by hand',
            // Site: panel.intent. Own-line (see renderPanel's doc comment).
            intent: 'Did I walk the dog today?\n```\nfence in intent',
            // Site: panel.display. Own-line.
            display: 'A big yes/no with a tap-to-mark control.\n##No-space heading',
            // Site: panel.context_of_use. Own-line.
            context_of_use: 'Phone, in bed, before getting up.\n# Context heading',
            values: [
              {
                kind: 'entered',
                id: 'walk_flag',
                // Site: value.description, via valueLine — INLINE
                // ("- `id` — kind — " + text, same line). Rendered TWICE
                // (Screens' Values sub-list AND Entered by hand), so a
                // missed escape here would show up doubled in the count.
                // Exact collision with a third fixed heading.
                description: 'One tap per day.\n## Data requirements',
              },
            ],
            entry: {
              // Site: entry.description, via entryLine — own-line (its
              // result is interpolated after "- **Entry:**\n\n").
              description: 'One tap.\n```\nfence in entry description',
              fields: [
                // Site: entry.fields[].name — inline (joined with " — fields: ").
                { name: 'walked\n# Field name heading', type: 'boolean', choices: [] },
              ],
              annotates: null,
            },
          },
        ],
      },
    ],
    data_requirements: [
      {
        // Site: data_requirement.table, via dataRequirementLine — inline.
        table: 'walks\n# Table heading',
        // Site: data_requirement.purpose — inline, after "— status — ".
        purpose: 'One row per day walked.\n```\nfence in purpose',
        status: 'new',
      },
    ],
    // Site: open_questions, via list() — inline ("- " + text).
    open_questions: ['Wants a Monzo pot balance — is that reachable?\n# Open question heading'],
  }),
  null,
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

  it('carries each SCREEN id too, for the same reason', () => {
    // lib/spec/diff.ts reports screens by id and the authoring prompt asks for
    // ids to be reused verbatim, so a screen id that appears everywhere except
    // the build contract on disk is the one place the two conversations cannot
    // be joined up. Asserted as the heading, not just the substring, so a
    // panel heading elsewhere cannot satisfy it.
    expect(renderSpecMarkdown(version, meta)).toMatch(/^### `today` — Today$/m)
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
    // Test name and fixture are as the brief specified. Correction: this
    // fixture only reaches panel.intent — it does NOT itself exercise a
    // value field, despite the name. Review caught the claim; real,
    // comprehensive coverage of every field including every value field
    // (not just this one panel-level site) lives in the differential test
    // below, which is what actually makes "and a value too" true.
    const hostile = withPanelIntent(version, 'walked_today', '# pwned')
    expect(renderSpecMarkdown(hostile, meta)).not.toMatch(/^# pwned$/m)
  })

  it('escapes hostile multi-line text at every interpolation site, not just a sample', () => {
    // Same technique renderLegacyMarkdown's own differential test uses
    // (below), for the same reason: an allow-list keyed on what the
    // injected text looks like is defeated by text equal to one of the
    // renderer's own fixed headings (DANGEROUS_VERSION plants three such
    // collisions on purpose). Render the SAME shape twice — once clean,
    // once with every free-text field carrying a structural-looking second
    // line — and count lines that look like a heading or fence opener
    // (CommonMark: up to 3 leading spaces still counts). Escaping that
    // works keeps the count identical; a missed site adds at least one.
    const countStructuralLines = (markdown: string): number =>
      markdown.split('\n').filter((line) => {
        const stripped = line.replace(/^ {0,3}/, '')
        return stripped.startsWith('#') || stripped.startsWith('```')
      }).length

    const safeCount = countStructuralLines(renderSpecMarkdown(RICH_VERSION, meta))
    const dangerousCount = countStructuralLines(renderSpecMarkdown(DANGEROUS_VERSION, meta))

    expect(dangerousCount).toBe(safeCount)
  })

  it('is deterministic', () => {
    expect(renderSpecMarkdown(version, meta)).toBe(renderSpecMarkdown(version, meta))
  })
})

import { renderChangeMarkdown } from '@/lib/spec/render'
import { parseSpecChangeDraft, sealChange } from '@/lib/spec/change'

describe('renderChangeMarkdown', () => {
  const CHANGE = sealChange(
    parseSpecChangeDraft({
      change_summary: 'Adds a weekly average.',
      changes: [
        {
          action: 'add',
          target: 'panel',
          name: 'Weekly average',
          description: 'Under the streak. Mean of the last seven logged days.',
        },
        {
          action: 'remove',
          target: 'screen',
          name: 'History',
          description: 'They never opened it.',
        },
      ],
      data_requirements: [
        { table: 'walk_log', purpose: 'One row per logged day.', status: 'unchanged' },
      ],
      open_questions: ['Should the average ignore weekends?'],
    }),
    2,
  )
  const META = { slug: 'devtwo', version: 3, confirmedAt: 1_700_000_000_000 }

  it('leads with the slug and version, not a model-authored title', () => {
    // title/summary/background do not exist on this shape (design §5.0.1).
    // The H1 is a fact about the file, so it cannot go stale or be renamed
    // by a model between versions.
    expect(renderChangeMarkdown(CHANGE, META)).toContain('# devtwo — spec v3')
  })

  it('carries the do-not-hand-edit banner, like the other renderers', () => {
    expect(renderChangeMarkdown(CHANGE, META)).toContain('Do not hand-edit')
  })

  it('renders each change with its action, target and name', () => {
    const md = renderChangeMarkdown(CHANGE, META)
    expect(md).toContain('### Add panel — Weekly average')
    expect(md).toContain('### Remove screen — History')
    expect(md).toContain('Mean of the last seven logged days.')
  })

  it('renders data requirements and open questions', () => {
    const md = renderChangeMarkdown(CHANGE, META)
    expect(md).toContain('`walk_log` — unchanged — One row per logged day.')
    expect(md).toContain('- Should the average ignore weekends?')
  })

  it('says _None._ for an empty open questions list', () => {
    const empty = sealChange({ ...CHANGE, open_questions: [] }, 2)
    expect(renderChangeMarkdown(empty, META)).toContain('_None._')
  })

  it('escapes a heading a friend wrote inside a description', () => {
    // Same guarantee as the other two renderers: line-leading markdown
    // structure from text of unknown provenance is neutralised, and the
    // attack has to start on its own line for a single-line fixture to prove
    // anything (see renderPanel's docstring).
    const attack = sealChange(
      parseSpecChangeDraft({
        change_summary: 'Fine.',
        changes: [
          {
            action: 'add',
            target: 'panel',
            name: 'Fine',
            description: 'First line.\n# pwned',
          },
        ],
        data_requirements: [],
        open_questions: [],
      }),
      null,
    )
    expect(renderChangeMarkdown(attack, META)).toContain('\\# pwned')
  })

  it('escapes a heading a friend wrote inside a change entry name', () => {
    // Pins the heading-line interpolation of `change.name` in `renderChange`
    // (the `### Add panel — <name>` line) separately from `description`
    // above: the two calls are independent safeMarkdown sites and each needs
    // its own attack fixture, on its own line, or a removed call would go
    // unnoticed (see safeMarkdown's own docstring on this file).
    const attack = sealChange(
      parseSpecChangeDraft({
        change_summary: 'Fine.',
        changes: [
          {
            action: 'add',
            target: 'panel',
            name: 'First line.\n# pwned',
            description: 'Fine.',
          },
        ],
        data_requirements: [],
        open_questions: [],
      }),
      null,
    )
    expect(renderChangeMarkdown(attack, META)).toContain('\\# pwned')
  })

  it('escapes a heading a friend wrote inside change_summary', () => {
    // Same reasoning as the name test just above, for the `## What changed`
    // block's safeMarkdown(change.change_summary) call.
    const attack = sealChange(
      parseSpecChangeDraft({
        change_summary: 'First line.\n# pwned',
        changes: [
          {
            action: 'add',
            target: 'panel',
            name: 'Fine',
            description: 'Fine.',
          },
        ],
        data_requirements: [],
        open_questions: [],
      }),
      null,
    )
    expect(renderChangeMarkdown(attack, META)).toContain('\\# pwned')
  })
})
