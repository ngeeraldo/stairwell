// app/admin/[user]/page.tsx
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db/instance'
import type { PlatformDb } from '@/lib/db/platform'
import { SESSION_COOKIE } from '@/lib/session/store'
import { isAdmin } from '@/lib/auth/authorize'
import { readConversations } from '@/lib/db/appendOnly'
import { readSpecs, specByVersion } from '@/lib/db/specs'
import { SpecShapeError, type SpecVersion } from '@/lib/spec/schema'
import type { LegacySpecPayload } from '@/lib/spec/legacy'
import { readStoredSpec, type StoredSpec } from '@/lib/spec/stored'
import { diffVersions, type SpecDiff } from '@/lib/spec/diff'

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
    <>
      {/* One template string, not "Changes from v" + {base} as sibling
          children: the heading is a single fact and splitting it makes it
          unfindable in the rendered output. */}
      <h4>{`Changes from v${comparison.base}`}</h4>
      {comparison.kind === 'note' ? (
        <p><em>{comparison.note}</em></p>
      ) : (
        <ul>
          <li>{`Screens added: ${idList(comparison.diff.screens.added)}`}</li>
          <li>{`Screens removed: ${idList(comparison.diff.screens.removed)}`}</li>
          <li>{`Screens changed: ${idList(comparison.diff.screens.changed)}`}</li>
          <li>{`Panels added: ${idList(comparison.diff.panels.added)}`}</li>
          <li>{`Panels removed: ${idList(comparison.diff.panels.removed)}`}</li>
          <li>{`Panels changed: ${idList(comparison.diff.panels.changed)}`}</li>
        </ul>
      )}
    </>
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
      <h4>{version.title}</h4>
      {/* What changed, above the summary, for the same reason the friend's
          own card leads with it: on a tweak the summary is text that was
          already read last time. */}
      <p>{version.change_summary}</p>
      <p>{version.summary}</p>
      <p>{version.background}</p>
      <ul>
        {screens.map((screen) => (
          <li key={screen.id}>
            <strong>{screen.title}</strong>
            <ul>
              {screen.panels.map((panel) => (
                <li key={panel.id}>
                  <strong>{panel.title}</strong> — {panel.display}
                  <ul>
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
          <h4>Data requirements</h4>
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
      <h4>{payload.title}</h4>
      <p>{payload.summary}</p>
      <p>{payload.background}</p>
      <ul>
        {payload.panels.map((panel) => (
          <li key={panel.name}>
            <strong>{panel.name}</strong> — {panel.shows} ({panel.why}, {panel.source})
          </li>
        ))}
      </ul>
      {payload.manual_logging.length > 0 && (
        <>
          <h4>Manual logging</h4>
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
  const conversations = readConversations(getDb(), account.id)

  return (
    <main>
      <h1>{user}</h1>
      <section aria-label="Proposed specs">
        <h2>Specs</h2>
        {specs.length === 0 ? (
          <p>No spec yet.</p>
        ) : (
          specs.map((spec) => {
            // specs is append-only — a row can never be edited or deleted,
            // so a payload that was malformed at write time (or corrupted
            // since) outlives every later fix forever. Degrade THIS card to
            // "unreadable" rather than let the throw become a 500 for the
            // whole admin pane. Anything other than the expected shape
            // error still escapes, because that's a bug this page has no
            // business hiding — same narrow rethrow as app/[user]/page.tsx,
            // which handles the identical hazard (Task 3 finding).
            //
            // readStoredSpec covers BOTH shapes and reports a malformed
            // current-shape row as a current-shape error, so this one catch
            // handles a corrupt row on either arm.
            let stored: StoredSpec | undefined
            try {
              stored = readStoredSpec(spec.payload)
            } catch (error) {
              if (!(error instanceof SpecShapeError)) throw error
              stored = undefined
            }

            // Both arms carry open questions, and they render ABOVE the rest
            // of the spec either way: they are not part of the build
            // description, they are the agent saying it refused to promise
            // something and handed the question over.
            const openQuestions =
              stored === undefined
                ? []
                : stored.kind === 'version'
                  ? stored.version.open_questions
                  : stored.payload.open_questions

            return (
              <article key={spec.id} data-spec-id={spec.id}>
                <h3>
                  v{spec.version} — {new Date(spec.at).toISOString()}
                  {spec.confirmed_at !== null ? ' — Confirmed' : ''}
                </h3>
                {stored === undefined ? (
                  <p>Unreadable proposal (corrupt payload).</p>
                ) : (
                  <>
                    {openQuestions.length > 0 && (
                      <>
                        <h4>Open questions</h4>
                        <ul>
                          {openQuestions.map((question) => (
                            <li key={question}>{question}</li>
                          ))}
                        </ul>
                      </>
                    )}
                    {stored.kind === 'version' ? (
                      <>
                        <VersionBody version={stored.version} />
                        <BaseComparisonView
                          comparison={compareToBase(getDb(), account.id, stored.version)}
                        />
                      </>
                    ) : (
                      <LegacyBody payload={stored.payload} />
                    )}
                    {/* Sealed off exactly like the friend's own preview
                        (app/[user]/ChatPanel.tsx): an empty sandbox grants
                        nothing — no scripts, no same-origin, no forms, no
                        top-level navigation. The admin portal is not a
                        softer target than the chat surface it's reviewing.
                        tests/spec/sandbox.test.ts pins this. */}
                    <iframe
                      title={`Preview of ${
                        stored.kind === 'version' ? stored.version.title : stored.payload.title
                      }`}
                      srcDoc={spec.mockup_html}
                      sandbox=""
                    />
                  </>
                )}
              </article>
            )
          })
        )}
      </section>
      {conversations.length === 0 ? (
        <p>No transcript yet.</p>
      ) : (
        conversations.map((conversation) => (
          <section key={conversation.id}>
            <h2>
              {/* readConversations only ever builds non-empty groups, so
                  rows[0] always exists; the `!` just satisfies
                  noUncheckedIndexedAccess. */}
              {new Date(conversation.rows[0]!.at).toISOString()} —{' '}
              {conversation.rows.length} messages
            </h2>
            <ol>
              {conversation.rows.map((row) => (
                <li key={row.id}>
                  <strong>{row.role}</strong>{' '}
                  <time dateTime={new Date(row.at).toISOString()}>
                    {new Date(row.at).toISOString()}
                  </time>{' '}
                  <code>{row.prompt_sha}</code>
                  <p>{row.body}</p>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}

      {/* Same reasoning as app/admin/page.tsx: an admin has no user space, so
          without this the only logout on this page is the browser's cookie
          jar. A POST form because /api/logout answers POST only. */}
      <form method="post" action="/api/logout">
        <button type="submit">Log out</button>
      </form>
    </main>
  )
}
