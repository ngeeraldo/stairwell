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
   * blocks or spurious headings from user-supplied text. Lines beginning with
   * fence sequences (```) or # are prefixed with a space. Inline punctuation
   * is left alone: escaping every * and _ would mangle ordinary prose for no
   * benefit, and the failure mode there is cosmetic rather than structural.
   */
  const safeMarkdown = (text: string): string =>
    text
      .split('\n')
      .map((line) => {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('#') || trimmed.startsWith('```')) {
          return ' ' + line
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
