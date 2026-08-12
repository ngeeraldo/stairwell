import type { SpecPayload } from './schema'

/**
 * A confirmed spec, as the build contract on disk.
 *
 * Rendered from the stored payload rather than stored as text, so improving
 * how a spec reads lets every past spec be re-exported in the new format
 * (design spec section 2.1). Deterministic: same input, same bytes, so a
 * re-export produces no spurious diff.
 */
export function renderSpecMarkdown(
  payload: SpecPayload,
  meta: { slug: string; version: number; confirmedAt: number },
): string {
  /**
   * Neutralise line-leading markdown structure to prevent unterminated code
   * blocks or spurious headings from user-supplied text. Backslash-escape
   * the leading # or the first backtick of a leading fence. CommonMark honours
   * backslash escapes for both, and unlike indentation does not turn the line
   * into a code block — the friend's sentence keeps looking like a sentence.
   * Preserve the line's original leading whitespace; insert the backslash
   * before the first non-whitespace character.
   */
  const safeMarkdown = (text: string): string =>
    text
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

  const list = (items: string[]) =>
    items.length === 0
      ? '_None._'
      : items.map((i) => `- ${safeMarkdown(i)}`).join('\n')

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
