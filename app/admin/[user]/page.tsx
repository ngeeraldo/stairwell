// app/admin/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getDb } from '@/lib/db/instance'
import type { PlatformDb } from '@/lib/db/platform'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { readTranscript } from '@/lib/db/appendOnly'
import { currentSpec, readConfirmations, readSpecs, specByVersion } from '@/lib/db/specs'
import { SpecShapeError, type SpecVersion } from '@/lib/spec/schema'
import type { LegacySpecPayload } from '@/lib/spec/legacy'
import type { SpecChange } from '@/lib/spec/change'
import { readStoredSpec, type StoredSpec } from '@/lib/spec/stored'
import { diffVersions, type SpecDiff } from '@/lib/spec/diff'
import { renderChangeMarkdown, renderLegacyMarkdown, renderSpecMarkdown } from '@/lib/spec/render'
import { buildTimeline } from '@/lib/chat/timeline'
import { AdminTabs } from './AdminTabs'

/**
 * What a current-shape row can be shown against.
 *
 * `none` is a first structured version — based_on_version is null, there is
 * no predecessor, and diffing against nothing would report every screen and
 * panel as "added", which reads as a change nobody asked for.
 *
 * `note` covers the two cases where a predecessor exists but no diff can be
 * computed from it: a legacy base (no stable ids anywhere in it — see
 * lib/spec/diff.ts, which compares by id and nothing else) and an unreadable
 * one. Saying so is better than silence: the admin is reading this pane to
 * find out what a friend asked for.
 */
type BaseComparison =
  | { kind: 'none' }
  | { kind: 'diff'; base: number; diff: SpecDiff }
  | { kind: 'note'; base: number; note: string }

function compareToBase(
  db: PlatformDb,
  accountId: number,
  version: SpecVersion,
): BaseComparison {
  const base = version.based_on_version
  if (base === null) return { kind: 'none' }

  const row = specByVersion(db, accountId, base)
  if (!row) return { kind: 'note', base, note: 'that version is not in the record' }

  let stored: StoredSpec
  try {
    stored = readStoredSpec(row.payload)
  } catch (error) {
    // Same narrow rethrow as everywhere else in this file: a corrupt BASE row
    // is as permanent as a corrupt current one, and it must cost this row its
    // diff, not the whole pane.
    if (!(error instanceof SpecShapeError)) throw error
    return { kind: 'note', base, note: 'that version is unreadable, so there is nothing to compare' }
  }

  if (stored.kind === 'legacy') {
    return { kind: 'note', base, note: 'first structured version' }
  }
  // A change-shaped base is unreachable, and the reason is ordering rather
  // than "nothing writes that shape" (something does now — it is the only
  // shape authored). This function is only ever called with a VERSION-shaped
  // row, and it looks at a row BELOW it. Every version-shaped row was written
  // before change-only authoring existed, and nothing has authored a
  // whole-surface row since, so no row beneath a version row can be
  // change-shaped. The union is exhausted anyway, the same way it is
  // everywhere else that reads a StoredSpec: an unreachable arm that is
  // spelled out cannot become a silent fallthrough later. A change spec IS a
  // diff, so there is structurally nothing on it to diff AGAINST.
  if (stored.kind === 'change') {
    return {
      kind: 'note',
      base,
      note: 'that version is a change-only spec, so there is nothing to diff against',
    }
  }
  return { kind: 'diff', base, diff: diffVersions(stored.version, version) }
}

/** Ids as a reader sees them, with an explicit "none" rather than a blank —
 * an empty line beside a label is indistinguishable from a rendering bug. */
function idList(ids: string[]): string {
  return ids.length === 0 ? 'none' : ids.join(', ')
}

function BaseComparisonView({ comparison }: { comparison: BaseComparison }) {
  if (comparison.kind === 'none') return null
  return (
    <div className="mt-4 rounded-md border bg-muted/30 p-3 text-sm">
      {/* One template string, not "Changes from v" + {base} as sibling
          children: the heading is a single fact and splitting it makes it
          unfindable in the rendered output. */}
      <h4 className="font-medium">{`Changes from v${comparison.base}`}</h4>
      {comparison.kind === 'note' ? (
        <p><em>{comparison.note}</em></p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-muted-foreground">
          <li>{`Screens added: ${idList(comparison.diff.screens.added)}`}</li>
          <li>{`Screens removed: ${idList(comparison.diff.screens.removed)}`}</li>
          <li>{`Screens changed: ${idList(comparison.diff.screens.changed)}`}</li>
          <li>{`Panels added: ${idList(comparison.diff.panels.added)}`}</li>
          <li>{`Panels removed: ${idList(comparison.diff.panels.removed)}`}</li>
          <li>{`Panels changed: ${idList(comparison.diff.panels.changed)}`}</li>
        </ul>
      )}
    </div>
  )
}

/**
 * The whole surface of a current-shape proposal: screens in `order`, their
 * panels, and every value's SOURCING — synced/entered/derived is what decides
 * whether a panel needs an entry widget built for it, a module wired up, or
 * neither, so it is the field this pane exists to surface.
 */
function VersionBody({ version }: { version: SpecVersion }) {
  const screens = [...version.screens].sort((a, b) => a.order - b.order)
  return (
    <>
      <h4 className="font-medium">{version.title}</h4>
      {/* What changed, above the summary, for the same reason the friend's
          own card leads with it: on a tweak the summary is text that was
          already read last time. */}
      <p>{version.change_summary}</p>
      <p className="text-muted-foreground">{version.summary}</p>
      <p className="text-muted-foreground">{version.background}</p>
      <ul className="mt-2 space-y-1">
        {screens.map((screen) => (
          <li key={screen.id}>
            <strong>{screen.title}</strong>
            <ul className="ml-4 space-y-1">
              {screen.panels.map((panel) => (
                <li key={panel.id}>
                  <strong>{panel.title}</strong> — {panel.display}
                  <ul className="ml-4 text-muted-foreground">
                    {panel.values.map((value) => (
                      <li key={value.id}>
                        <code>{value.id}</code> — {value.kind} — {value.description}
                        {value.kind === 'synced' ? ` (module: ${value.module})` : ''}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {version.data_requirements.length > 0 && (
        <>
          <h4 className="mt-2 font-medium">Data requirements</h4>
          <ul>
            {version.data_requirements.map((requirement) => (
              <li key={requirement.table}>
                <code>{requirement.table}</code> — {requirement.status} —{' '}
                {requirement.purpose}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * A pre-unification row, rendered exactly as this pane always rendered it,
 * plus a badge saying what it is. `specs` rejects UPDATE, so these rows can
 * never be rewritten into the current shape — without the badge, a reader
 * would go looking for a change_summary and a diff that structurally cannot
 * exist for them.
 */
function LegacyBody({ payload }: { payload: LegacySpecPayload }) {
  return (
    <>
      <p><em>Pre-unification spec (legacy shape)</em></p>
      <h4 className="font-medium">{payload.title}</h4>
      <p>{payload.summary}</p>
      <p className="text-muted-foreground">{payload.background}</p>
      <ul className="mt-2 space-y-1">
        {payload.panels.map((panel) => (
          <li key={panel.name}>
            <strong>{panel.name}</strong> — {panel.shows} ({panel.why}, {panel.source})
          </li>
        ))}
      </ul>
      {payload.manual_logging.length > 0 && (
        <>
          <h4 className="mt-2 font-medium">Manual logging</h4>
          <ul>
            {payload.manual_logging.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * A change-only proposal: what the friend asked to change, and nothing about
 * what already exists. The whole surface is users/<slug>/current.md, which
 * this pane deliberately does not duplicate — a second copy of the current
 * state is a second thing that can be out of date.
 */
function ChangeBody({ change }: { change: SpecChange }) {
  return (
    <>
      <p>{change.change_summary}</p>
      <ul className="mt-2 space-y-1">
        {change.changes.map((entry, index) => (
          <li key={`${entry.target}-${entry.name}-${index}`}>
            <strong>
              {entry.action} {entry.target} — {entry.name}
            </strong>
            <p className="text-muted-foreground">{entry.description}</p>
          </li>
        ))}
      </ul>
      {change.data_requirements.length > 0 && (
        <>
          <h4 className="mt-2 font-medium">Data requirements</h4>
          <ul>
            {change.data_requirements.map((requirement) => (
              <li key={requirement.table}>
                <code>{requirement.table}</code> — {requirement.status} — {requirement.purpose}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * The spec markdown, without the banner that belongs to the FILE.
 *
 * `renderSpecMarkdown` leads with an HTML comment — "Generated from the
 * confirmed spec record by scripts/pull-spec.sh. Do not hand-edit" — which is
 * exactly right for `users/<slug>/spec.md`, where someone might open it in an
 * editor and start typing. In this pane it is addressed to nobody: react
 * -markdown does not render raw HTML (deliberately — see the Spec tab), so the
 * comment arrived as a visible paragraph of body copy above the summary.
 *
 * Found by the screenshot review — the first attempt at this anchored to the
 * start of the document and stripped nothing, because the banner sits after
 * the H1.
 *
 * STANDALONE comment blocks only: a comment occupying whole lines of its own,
 * which is how the renderer emits it. A `<!--` inside a sentence a friend
 * wrote stays exactly where they put it, because removing someone's words to
 * tidy a layout is not a trade this pane gets to make.
 */
function withoutFileBanner(markdown: string): string {
  return markdown.replace(/(^|\n)[ \t]*<!--[\s\S]*?-->[ \t]*(?=\n|$)/g, '$1').trim()
}

/** readStoredSpec, with the narrow rethrow every consumer in this file uses. */
function readOrUndefined(payload: string): StoredSpec | undefined {
  try {
    return readStoredSpec(payload)
  } catch (error) {
    // specs is append-only — a row that was malformed at write time outlives
    // every later fix forever. Degrade THIS card rather than let the throw
    // become a 500 for the whole pane. Anything other than the expected shape
    // error still escapes, because that's a bug this page has no business
    // hiding.
    if (!(error instanceof SpecShapeError)) throw error
    return undefined
  }
}

/**
 * A proposal, as it appears INLINE in the conversation.
 *
 * onboarding-ux-spec.md: "Admin transcript pane renders the same cards inline,
 * so Nico reads the conversation the way the user experienced it — a
 * transcript with a hole where the proposal happened is a broken transcript."
 *
 * Not the friend's own SpecCard — that component is gone from
 * app/[user]/ChatPanel.tsx along with its confirm controls, since a friend no
 * longer confirms anything. This pane still renders every proposal as a card,
 * though: it is Nico's permanent visual record of what was offered at each
 * point in the conversation, read-only by a standing rule
 * (lib/auth/authorize.ts), unaffected by whatever the friend's own screen
 * currently shows. What it shares with the old friend-facing card is the
 * SHAPE — version label, title, what changed. It no longer shows the mockup:
 * MockupDialog and the route it read from are gone as of the mockup-loop
 * removal (plan 2026-08-19-remove-the-mockup-loop, Task 6) — nothing composes
 * or serves mockup HTML any more.
 */
function InlineCard({
  version,
  stored,
  openQuestions,
  comparison,
}: {
  version: number
  stored: StoredSpec | undefined
  openQuestions: string[]
  comparison: BaseComparison | undefined
}) {
  return (
    <li data-spec-version={version} className="rounded-lg border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">v{version}</p>
      {stored === undefined ? (
        <p>Unreadable proposal (corrupt payload).</p>
      ) : (
        <>
          {/* Open questions render ABOVE the rest either way: they are not
              part of the build description, they are the agent saying it
              refused to promise something and handed the question over. */}
          {openQuestions.length > 0 && (
            <>
              <h4 className="font-medium">Open questions</h4>
              <ul className="mb-2 list-disc pl-5">
                {openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </>
          )}
          {stored.kind === 'change' ? (
            <ChangeBody change={stored.change} />
          ) : stored.kind === 'version' ? (
            <VersionBody version={stored.version} />
          ) : (
            <LegacyBody payload={stored.payload} />
          )}
          {comparison && <BaseComparisonView comparison={comparison} />}
        </>
      )}
    </li>
  )
}

/**
 * Read-only transcript + spec pane. The admin portal is not a back door into
 * a dashboard (lib/auth/authorize.ts) — it reads the platform database only,
 * which is the visibility the onboarding promise already covers.
 */
export default async function TranscriptPane({
  params,
}: {
  params: Promise<{ user: string }>
}) {
  const { user } = await params
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value
  if (!isAdmin(getDb(), sessionId)) notFound()

  const account = getDb()
    .prepare("SELECT id FROM accounts WHERE slug = ? AND role = 'user'")
    .get(user) as { id: number } | undefined
  if (!account) notFound()

  const specs = readSpecs(getDb(), account.id)
  const confirmations = readConfirmations(getDb(), account.id)

  // ONE ordered list, from the same function the friend's own panel uses
  // (lib/chat/timeline.ts). "A transcript with a hole where the proposal
  // happened is a broken transcript" — and a transcript where the proposal is
  // collected at the bottom is the same hole, moved.
  //
  // Oldest at top: the spec asks for newest at the bottom, auto-scrolled,
  // which is reading order for a conversation. The scroll is AdminTabs' job.
  const items = buildTimeline<
    { role: string; body: string; prompt_sha: string },
    (typeof specs)[number]
  >({
    turns: readTranscript(getDb(), account.id).map((row) => ({ at: row.at, turn: row })),
    proposals: specs.map((spec) => ({ at: spec.at, proposal: spec })),
    confirmations,
  })

  const current = currentSpec(getDb(), account.id)
  const currentStored = current ? readOrUndefined(current.payload) : undefined

  return (
    <main className="mx-auto max-w-[680px] space-y-6 p-4 md:p-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">{user}</h1>
        <a href="/admin" className="text-sm underline underline-offset-4">
          All users
        </a>
      </div>

      <AdminTabs
        transcript={
          items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transcript yet.</p>
          ) : (
            <ol className="space-y-4 py-2 text-sm">
              {items.map((item, index) => {
                if (item.kind === 'confirmation') {
                  return (
                    <li
                      key={`confirmed-${item.version}-${item.at}`}
                      data-confirmation={item.version}
                      className="text-xs text-muted-foreground"
                    >
                      Confirmed v{item.version} — {new Date(item.at).toISOString()}
                    </li>
                  )
                }
                if (item.kind === 'proposal') {
                  const stored = readOrUndefined(item.proposal.payload)
                  return (
                    <InlineCard
                      key={`spec-${item.proposal.id}`}
                      version={item.proposal.version}
                      stored={stored}
                      openQuestions={
                        stored === undefined
                          ? []
                          : stored.kind === 'change'
                            ? stored.change.open_questions
                            : stored.kind === 'version'
                              ? stored.version.open_questions
                              : stored.payload.open_questions
                      }
                      comparison={
                        stored?.kind === 'version'
                          ? compareToBase(getDb(), account.id, stored.version)
                          : undefined
                      }
                    />
                  )
                }
                return (
                  <li key={`turn-${index}`} data-role={item.turn.role}>
                    {/* User and agent turns have to be distinguishable at a
                        glance — the spec asks for it, and a wall of identical
                        paragraphs is what this pane is read INSTEAD of. */}
                    <div className="mb-1 flex items-baseline gap-2">
                      <span
                        className={
                          item.turn.role === 'assistant'
                            ? 'text-xs font-medium text-muted-foreground'
                            : 'text-xs font-semibold'
                        }
                      >
                        {item.turn.role}
                      </span>
                      <time
                        dateTime={new Date(item.at).toISOString()}
                        className="text-xs text-muted-foreground"
                      >
                        {new Date(item.at).toISOString()}
                      </time>
                      {/* Which prompt produced this. Muted, but kept: it is
                          how Nico tells a reply from agent-v2 from one from
                          agent-v3 while reading a transcript that spans both,
                          and prompt_sha is stamped on every row precisely so
                          that question has an answer. */}
                      <code className="text-xs text-muted-foreground">
                        {item.turn.prompt_sha}
                      </code>
                    </div>
                    <p
                      className={
                        item.turn.role === 'assistant'
                          ? 'whitespace-pre-wrap rounded-md bg-muted/40 p-3'
                          : 'whitespace-pre-wrap rounded-md border p-3'
                      }
                    >
                      {item.turn.body}
                    </p>
                  </li>
                )
              })}
            </ol>
          )
        }
        spec={
          current === undefined || currentStored === undefined ? (
            <p className="py-4 text-sm text-muted-foreground">No spec yet.</p>
          ) : (
            <div className="py-4">
              <p className="mb-3 text-xs text-muted-foreground">
                {/* currentSpec (lib/db/specs.ts) now returns the newest spec
                    whether or not it was ever confirmed, so confirmed_at can
                    genuinely be null — fall back to the spec's own authored
                    timestamp, same as scripts/export-spec.ts. (This used to
                    cite lib/spec/author.ts's currentVersionBlock as well;
                    that function no longer exists.) Worded "as of", not
                    "confirmed": nothing confirms any more. */}
                {`v${current.version} — as of ${new Date(current.confirmed_at ?? current.at).toISOString()}`}
              </p>
              {/*
                REAL MARKDOWN, not preformatted text. The build contract is
                read here, and headings that are headings are the difference
                between reading it and scanning it.

                react-markdown does NOT render raw HTML by default, and that
                default is load-bearing rather than incidental: a spec payload
                is model-authored, and the admin portal must not be a softer
                target than the chat surface it is reviewing.
              */}
              <div className="prose-sm space-y-2 [&_code]:text-xs [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-medium [&_li]:ml-4 [&_li]:list-disc [&_ul]:my-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {(() => {
                    const specMeta = {
                      slug: user,
                      version: current.version,
                      confirmedAt: current.confirmed_at ?? current.at,
                    }
                    return withoutFileBanner(
                      currentStored.kind === 'change'
                        ? renderChangeMarkdown(currentStored.change, specMeta)
                        : currentStored.kind === 'version'
                          ? renderSpecMarkdown(currentStored.version, specMeta)
                          : renderLegacyMarkdown(currentStored.payload, specMeta),
                    )
                  })()}
                </ReactMarkdown>
              </div>
            </div>
          )
        }
      />

      {/* Same reasoning as app/admin/page.tsx: an admin has no user space, so
          without this the only logout on this page is the browser's cookie
          jar. A POST form because /api/logout answers POST only. */}
      <form method="post" action="/api/logout" className="border-t pt-4">
        <button type="submit" className="text-sm underline underline-offset-4">
          Log out
        </button>
      </form>
    </main>
  )
}
