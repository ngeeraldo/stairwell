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
  const list = (items: string[]) =>
    items.length === 0 ? '_None._' : items.map((i) => `- ${i}`).join('\n')

  const panels = payload.panels
    .map(
      (panel, index) =>
        `### ${index + 1}. ${panel.name}\n\n` +
        `- **Shows:** ${panel.shows}\n` +
        `- **Why:** ${panel.why}\n` +
        `- **Source:** ${panel.source}`,
    )
    .join('\n\n')

  return `# ${payload.title}

<!-- Generated from the confirmed spec record by scripts/pull-spec.sh.
     Do not hand-edit: the next pull overwrites this file. -->

- **User:** ${meta.slug}
- **Spec version:** v${meta.version}
- **Confirmed:** ${new Date(meta.confirmedAt).toISOString()}

## Summary

${payload.summary}

## Background

${payload.background}

## Panels

${panels}

## Manual logging

${list(payload.manual_logging)}

## Open questions

${list(payload.open_questions)}
`
}
