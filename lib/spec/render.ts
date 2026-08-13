import type { LegacySpecPayload } from './legacy'
import type { DataRequirement, EntryWidget, Panel, Screen, SpecVersion, ValueSpec } from './schema'

/** The metadata both renderers stamp below the title: who this build contract
 * is for, which confirmed version it is, and when it was confirmed. Shared
 * because the two renderers agree on exactly this much. */
type RenderMeta = { slug: string; version: number; confirmedAt: number }

/**
 * Neutralise line-leading markdown structure to prevent unterminated code
 * blocks or spurious headings from user-supplied text. Backslash-escape
 * the leading # or the first backtick of a leading fence. CommonMark honours
 * backslash escapes for both, and unlike indentation does not turn the line
 * into a code block — the friend's sentence keeps looking like a sentence.
 * Preserve the line's original leading whitespace; insert the backslash
 * before the first non-whitespace character.
 *
 * Module-scoped and shared by BOTH renderers below. A prior review of this
 * file recorded the known weakness of a fixture-based escaping test: a new
 * interpolation site added with no matching fixture regresses silently. The
 * new whole-surface renderer has many more interpolation sites than the old
 * six-field one — every panel field, every value description — so a SECOND
 * copy of this function living inside renderSpecMarkdown would only double
 * the number of places that weakness could hide. One copy, used everywhere
 * text of unknown provenance reaches the page.
 */
function safeMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)(.*)$/)
      if (!match || match[2] === undefined) return line
      const leadingWhitespace = match[1] ?? ''
      const rest = match[2]
      if (rest.startsWith('#') || rest.startsWith('```')) {
        return leadingWhitespace + '\\' + rest
      }
      return line
    })
    .join('\n')
}

/** Also shared, for the same reason as safeMarkdown above: every bullet list
 * in either renderer's output — panels, open questions, entered-by-hand
 * values, data requirements — goes through this one implementation of
 * "escape each item, or say `_None._` if there is nothing to list." */
function list(items: string[]): string {
  return items.length === 0
    ? '_None._'
    : items.map((i) => `- ${safeMarkdown(i)}`).join('\n')
}

/**
 * A confirmed spec, as the build contract on disk (the OLD six-field shape).
 *
 * Rendered from the stored payload rather than stored as text, so improving
 * how a spec reads lets every past spec be re-exported in the new format
 * (design spec section 2.1). Deterministic: same input, same bytes, so a
 * re-export produces no spurious diff.
 *
 * FROZEN in the same sense lib/spec/legacy.ts is: this renders rows nobody
 * can ever fix (specs rejects UPDATE), so its behaviour must not move even
 * as renderSpecMarkdown below takes over new confirmations. Renamed from
 * `renderSpecMarkdown` — body otherwise untouched.
 */
export function renderLegacyMarkdown(
  payload: LegacySpecPayload,
  meta: RenderMeta,
): string {
  const panels = payload.panels
    .map(
      (panel, index) =>
        `### ${index + 1}. ${safeMarkdown(panel.name)}\n\n` +
        `- **Shows:** ${safeMarkdown(panel.shows)}\n` +
        `- **Why:** ${safeMarkdown(panel.why)}\n` +
        `- **Source:** ${safeMarkdown(panel.source)}`,
    )
    .join('\n\n')

  return `# ${safeMarkdown(payload.title)}

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** ${meta.slug}
- **Spec version:** v${meta.version}
- **Confirmed:** ${new Date(meta.confirmedAt).toISOString()}

## Summary

${safeMarkdown(payload.summary)}

## Background

${safeMarkdown(payload.background)}

## Panels

${panels}

## Manual logging

${list(payload.manual_logging)}

## Open questions

${list(payload.open_questions)}
`
}

/** `` `id` — kind — description `` for one value. `id` is a validated slug
 * (lib/spec/validate.ts's ID pattern excludes anything markdown-structural)
 * so it is safe unescaped; `kind` is one of three fixed enum literals. Only
 * `description` is model-authored free text, so only it goes through
 * safeMarkdown — but it goes through every time this is called, in both the
 * per-panel Values sub-list and the derived Entered-by-hand section below,
 * which is why both reuse this one function rather than each formatting the
 * line by hand. */
function valueLine(value: ValueSpec): string {
  return `- \`${value.id}\` — ${value.kind} — ${safeMarkdown(value.description)}`
}

/**
 * One panel's block within its screen: an `####` heading carrying the
 * panel's id (the diff and the build both key off it, so the doc must too),
 * then one labelled bullet per field.
 *
 * Every field below is rendered as "- **Label:**" followed by a BLANK LINE
 * and then the escaped text on its own — never "- **Label:** text" inline.
 * That is a deliberate departure from renderLegacyMarkdown's inline style
 * just above. Inline embedding ("- **Intent:** " + text) can never place
 * attacker text at the true start of an output line, because the label
 * always precedes it on the same line — so escaping at an inline site is
 * cosmetic, not load-bearing, and a bug there would leave every test green.
 * Giving the field its own line is what makes safeMarkdown's job at THIS
 * site actually do something a test can catch, which is exactly what the
 * step-4 ledger's "new interpolation site, no matching fixture" weakness
 * calls for: a real regression, not just an unexercised call.
 */
function renderPanel(panel: Panel): string {
  const parts: string[] = [
    `#### \`${panel.id}\` — ${safeMarkdown(panel.title)}`,
    `- **Intent:**\n\n${safeMarkdown(panel.intent)}`,
    `- **Shows:**\n\n${safeMarkdown(panel.display)}`,
  ]
  if (panel.context_of_use !== null) {
    parts.push(`- **When/where:**\n\n${safeMarkdown(panel.context_of_use)}`)
  }
  parts.push(`- **Values:**\n\n${panel.values.map(valueLine).join('\n')}`)
  if (panel.entry !== null) {
    parts.push(`- **Entry:**\n\n${entryLine(panel.entry)}`)
  }
  return parts.join('\n\n')
}

/** An entry widget's description, plus its fields and (when set) the synced
 * value it annotates — enough for a human reading the build contract to know
 * what the widget collects, without dumping the full field-type schema. */
function entryLine(entry: EntryWidget): string {
  const fields = entry.fields.length
    ? ' — fields: ' + entry.fields.map((f) => `${safeMarkdown(f.name)} (${f.type})`).join(', ')
    : ''
  const annotates = entry.annotates !== null ? ` — annotates \`${entry.annotates}\`` : ''
  return `${safeMarkdown(entry.description)}${fields}${annotates}`
}

function renderScreen(screen: Screen): string {
  return `### ${safeMarkdown(screen.title)}\n\n${screen.panels.map(renderPanel).join('\n\n')}`
}

/** `` `table` — status — purpose `` for one data requirement, mirroring
 * valueLine's shape and field order ("table + status + purpose") so the two
 * sibling list formats in this file read the same way. */
function dataRequirementLine(requirement: DataRequirement): string {
  return `- \`${safeMarkdown(requirement.table)}\` — ${requirement.status} — ${safeMarkdown(requirement.purpose)}`
}

/**
 * Walk every screen and panel, in the SAME order the Screens section above
 * renders them, for values whose kind is `entered`. This is the WHOLE basis
 * of the "Entered by hand" section below: computed from the values
 * themselves rather than authored as a separate list, so it can never name a
 * value that isn't there or omit one that is. The old shape's
 * `manual_logging` was a model-authored list with no such guarantee — see
 * design ledger D1. Taking the already-sorted screens (rather than
 * `version.screens` directly) matters here: otherwise this section could
 * list values in an order that disagrees with the Screens section a few
 * paragraphs above it, for a version whose screens weren't stored in `order`.
 */
function collectEnteredValues(screensInOrder: Screen[]): ValueSpec[] {
  const entered: ValueSpec[] = []
  for (const screen of screensInOrder) {
    for (const panel of screen.panels) {
      for (const value of panel.values) {
        if (value.kind === 'entered') entered.push(value)
      }
    }
  }
  return entered
}

/**
 * The new whole-surface spec, as the build contract on disk.
 *
 * Emits, in a fixed order: an H1 title with the generated-file banner; the
 * slug/version/confirmed metadata list; `## What changed`; `## Summary`;
 * `## Background`; `## Screens` (each screen in `order`, each panel carrying
 * its id); `## Entered by hand` (derived — see collectEnteredValues);
 * `## Data requirements`; `## Open questions`. Deterministic: a pure
 * function of `version` and `meta`, so a re-export produces no spurious diff.
 */
export function renderSpecMarkdown(version: SpecVersion, meta: RenderMeta): string {
  const screensInOrder = [...version.screens].sort((a, b) => a.order - b.order)
  const screensSection = screensInOrder.map(renderScreen).join('\n\n')

  const entered = collectEnteredValues(screensInOrder)
  const enteredSection = entered.length === 0 ? '_None._' : entered.map(valueLine).join('\n')

  const dataRequirementsSection =
    version.data_requirements.length === 0
      ? '_None._'
      : version.data_requirements.map(dataRequirementLine).join('\n')

  return `# ${safeMarkdown(version.title)}

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** ${meta.slug}
- **Spec version:** v${meta.version}
- **Confirmed:** ${new Date(meta.confirmedAt).toISOString()}

## What changed

${safeMarkdown(version.change_summary)}

## Summary

${safeMarkdown(version.summary)}

## Background

${safeMarkdown(version.background)}

## Screens

${screensSection}

## Entered by hand

${enteredSection}

## Data requirements

${dataRequirementsSection}

## Open questions

${list(version.open_questions)}
`
}
