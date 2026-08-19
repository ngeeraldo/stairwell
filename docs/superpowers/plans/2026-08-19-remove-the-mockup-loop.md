# Removing the mockup and the confirmation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend asks for a change, the agent agrees in words and writes a spec in the background, Nico builds it, and the announcement tells them — with no mockup drawn and nothing to confirm.

**Architecture:** `propose_spec` keeps its empty schema and still ends the turn; what changes is everything after it. The mockup call, the per-screen fragment machinery and the preview card are deleted; `announceTarget` stops keying off confirmations and keys off `notes/v<n>.md` instead, which exists only for versions actually built. Specs stay whole-surface — that is plan 3.

**Tech Stack:** TypeScript, Next.js App Router, vitest, better-sqlite3-multiple-ciphers, bash.

**Spec:** `docs/superpowers/specs/2026-08-18-built-is-truth-design.md`

## Global Constraints

- **This is plan 2 of 3.** Plan 1 (`current.md`) is merged. Plan 3 makes specs change-only and adds `conversation.md`. **Specs stay whole-surface in this plan** — do not touch `lib/spec/schema.ts`'s `SpecDraft`, `lib/spec/patch.ts`, or `lib/spec/stored.ts`'s discriminator. They go in plan 3.
- **Do not work on `main`.** Nico creates the branch. Run `git branch --show-current` first and stop if it says `main`.
- **Nothing sacred is dropped.** `spec_screen_mockups` and `spec_confirmations` stop being written but keep their rows, their tables and their append-only triggers. `specs.mockup_html` stays a `NOT NULL` column. Dropping or altering any of them is schema surgery on an append-only table, which CLAUDE.md restricts to `lib/db/reshape.ts` (zero-rows proof) and `lib/db/migrate.ts`.
- **Prompt files are added, never edited** once their commit reaches `main`. `agent-v7.md` is a new file; `agent-v5.md` and `agent-v6.md` are not touched. A prompt created *within this branch* may still be edited before merge — CLAUDE.md states that boundary.
- **`platform/prompts/*.md` files are never deleted**, only de-referenced: `prompt_sha` is stamped on transcript and spec rows that already exist, and removing a file its hash names would orphan them.
- **Metrics never carry user values.** Every metric row this plan touches keeps that bound.
- Tests run with `npx vitest run` (scope with a path). Gate B: a commit touching `app/`, `lib/`, `platform/`, `scripts/` needs a test under `tests/`.
- **No test in the default suite may reach the network.** Clients are injected parameters.

---

### Task 1: Announce from the build notes, not from a confirmation

**Files:**
- Modify: `lib/chat/announce.ts` (`announceTarget`, `alreadyAnnounced`, `AnnounceTarget`)
- Modify: `scripts/announce-deploy.ts` (the `runAnnounce` target call, if its shape changes)
- Test: `tests/chat/announce.test.ts`

**Interfaces:**
- Consumes: `readBuildNotes` / `notesPath` from `@/lib/build/notes`, `newestSpec` and `readSpecs` from `@/lib/db/specs`.
- Produces: `announceTarget(db, slug, usersDir?)` returning the same `AnnounceTarget` union, now selected by build notes.

**This task comes first deliberately.** Task 3 removes confirmations, and `announceTarget` currently finds its target with `currentSpec` — "the newest spec that has a confirmation". Once nothing confirms, that helper would return the newest spec whether or not it was ever built, and the announcer would speak about a spec that does not exist as a dashboard. Re-keying announce BEFORE removing confirmations means no commit in this plan leaves the announcer wrong.

**What "built" means now.** `users/<slug>/notes/v<n>.md` exists only for versions that were actually built and committed — that is what makes it the honest marker. So: **announce the highest version that has a notes file and has no `deploy_announced` metric row.** The version numbers still come from `specs` row position, unchanged.

- [ ] **Step 1: Write the failing test**

`tests/chat/announce.test.ts` already has the fixtures you need, and one you
must add. It has:

- `currentPayload(overrides?: Partial<SpecVersion>): SpecVersion`
- `confirmAVersion(db, slug, overrides?)` — inserts a spec AND confirms it,
  bumping a module-level `specSeq`
- `MOCKUP`, a constant mockup document
- a module-level `db`, `dir` and `accountId`

`confirmAVersion` is the wrong shape for these tests: the state under test is a
spec that was authored and never confirmed, which is now every spec. Add a
sibling that stops before the confirmation, and rewrite `confirmAVersion` to
call it so the two cannot drift:

```typescript
/** Insert a spec without confirming it — the only shape this plan produces. */
function authorAVersion(
  db: PlatformDb,
  slug: string,
  overrides: Partial<SpecVersion> = {},
): number {
  const account = findAccountBySlug(db, slug)
  if (!account) throw new Error(`no account with slug '${slug}'`)
  specSeq += 1
  return insertSpec(db, {
    accountId: account.id,
    conversationId: `conv-${slug}-${specSeq}`,
    promptSha: `sha-${slug}-${specSeq}`,
    payload: currentPayload(overrides),
    mockupHtml: MOCKUP,
    at: 1_000 + specSeq,
  })
}
```

Plus two local helpers these tests need:

```typescript
/** A minimal notes file that readBuildNotes accepts. Four sections, in order,
 *  with a non-empty "What shipped" — lib/build/notes.ts rejects anything else. */
function writeNote(usersDir: string, slug: string, version: number): void {
  const dir = join(usersDir, slug, 'notes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `v${version}.md`),
    `---\nslug: ${slug}\nversion: ${version}\nbuilt_at: 2026-08-19\n---\n\n` +
      '## What shipped\nA panel TEST.\n\n' +
      '## Built differently\n\n' +
      '## Open\n\n' +
      '## Notes for the next build\n',
  )
}

function markAnnounced(db: PlatformDb, specId: number, accountId: number): void {
  appendMetric(db, {
    accountId,
    event: 'deploy_announced',
    data: { spec_id: specId },
    at: 2_000,
  })
}
```

Then the tests:

```typescript
describe('announceTarget keys off build notes', () => {
  it('targets the highest version that has a notes file', () => {
    // Two specs, notes for v1 only. v2 is authored but not built — the state
    // between a friend asking and Nico building, which used to be impossible
    // because nothing was authored without a card in front of it.
    authorAVersion(db, slug)
    authorAVersion(db, slug)
    writeNote(usersDir, slug, 1)

    const target = announceTarget(db, slug, usersDir)
    expect(target.ok).toBe(true)
    expect(target.ok && target.version).toBe(1)
  })

  it('reports nothing to announce when no version has notes', () => {
    authorAVersion(db, slug)
    const target = announceTarget(db, slug, usersDir)
    expect(target.ok).toBe(false)
    expect(!target.ok && target.reason).toBe('no_build_notes')
  })

  it('skips a version already announced rather than announcing an older one', () => {
    // v2 announced, v1 also built. Announcing v1 now would tell a friend
    // about an older build than the one they already have.
    authorAVersion(db, slug)
    const second = authorAVersion(db, slug)
    writeNote(usersDir, slug, 1)
    writeNote(usersDir, slug, 2)
    markAnnounced(db, second, accountId)

    const target = announceTarget(db, slug, usersDir)
    expect(target.ok).toBe(false)
    expect(!target.ok && target.reason).toBe('already_announced')
  })

  it('does not require a confirmation', () => {
    // The point of the whole task: no spec_confirmations row exists in this
    // fixture, and the announcement still finds its target.
    authorAVersion(db, slug)
    writeNote(usersDir, slug, 1)
    expect(announceTarget(db, slug, usersDir).ok).toBe(true)
  })
})
```

These tests need their own account and users tree rather than sharing the
file's module-level ones, since they assert on version NUMBERS and the existing
fixtures bump `specSeq` globally. Give this describe block a fresh slug and a
`mkdtempSync` users directory, following how the file already builds `dir`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/chat/announce.test.ts`
Expected: FAIL — `announceTarget` takes two arguments, and `no_build_notes` is not a member of its reason union.

- [ ] **Step 3: Rewrite `announceTarget`**

In `lib/chat/announce.ts`:

- Widen the failure arm: `{ ok: false; reason: 'no_build_notes' | 'already_announced' }`. `'no_confirmed_spec'` goes — nothing confirms any more, and a reason nobody can produce is a lie in a type.
- Add an optional `usersDir` parameter threaded to `notesPath`, so tests can point at a temp tree. Default to `lib/build/notes.ts`'s own default.
- Replace the `currentSpec` call with a walk over `readSpecs(db, account.id)` — which is already newest-first — taking the first row whose `notes/v<n>.md` exists on disk. Use `existsSync(notesPath(slug, version, usersDir))`; do not parse the note here. Parsing is `runAnnounce`'s job and it reports parse failures with their own message, which this function has no way to surface.
- Keep `alreadyAnnounced(db, accountId, spec.id)` exactly as it is. It keys on `spec_id`, spec ids are unchanged, and `deploy_announced` rows already written keep meaning what they said.
- Keep `first: !hasConfirmedSpecBelow(...)` for now — Task 3 renames that helper, and doing it here would make two tasks touch the same line for different reasons.

Write the reasoning into the comment above the walk: notes exist only for versions that were built, which is why they and not `specs` decide what is announceable.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat/announce.test.ts tests/scripts/announceDeploy.test.ts`
Expected: PASS. If `announceDeploy.test.ts` asserts on the `no_confirmed_spec` reason string, update those assertions to the new reason — the operator-facing message for "nothing to announce" changes with it, and `scripts/announce-deploy.ts` must print something true. A missing notes file already has its own dedicated message via `NotesMissingError`; this new reason is the different case where no version has notes at all.

- [ ] **Step 5: Commit**

```bash
git add lib/chat/announce.ts scripts/announce-deploy.ts tests/chat/announce.test.ts tests/scripts/announceDeploy.test.ts
git commit -m "Announce the newest version that has build notes, not a confirmation

notes/v<n>.md exists only for versions actually built, which makes it the
honest marker now that a spec can be authored without anyone confirming it."
```

---

### Task 2: Take the preview card off the friend's screen

**Files:**
- Modify: `app/[user]/ChatPanel.tsx`
- Modify: `app/[user]/page.tsx`
- Modify: `app/api/chat/route.ts`
- Test: `tests/chat/panel.test.ts`, `tests/chat/panelWiring.test.tsx`, `tests/chat/route.test.ts`, `tests/routing/shell.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a `ChatPanel` with no `proposal` prop, no `SpecCard` export, and no `stage`/`authoring` state.

**Do this before Task 3.** The card's confirm button posts to the confirm route; removing the route first would leave a button that 404s in an intermediate commit.

- [ ] **Step 1: Delete the card and its state**

From `app/[user]/ChatPanel.tsx` remove:

- The `SpecCard` component and everything only it uses — `cardTitle`, `withBanner`, `withCsp`, the `DELIVERY_FIRST`/`DELIVERY_CHANGE` constants, the confirm handler, the two buttons, and the `srcDoc` iframe.
- `CardProposal`, the `proposals` array in `PanelState`, `withLiveness`, and the proposal arms of `applyLine`/`finishTurn`.
- `authoring` and `stage` from `PanelState`, and the two-stage progress bar with its "Writing the spec… / Drawing the preview…" copy.
- The `proposal` and `confirmations` props.

Keep `ThinkingRow` and the ordinary thinking indicator: a friend still waits for a reply, and that wait is unchanged.

`buildTimeline` (`lib/chat/timeline.ts`) merges transcript turns with proposals and confirmations. With both gone it has one input; simplify it to match rather than leaving a merge of one list, and update `tests/chat/timeline.test.ts`.

- [ ] **Step 2: Stop the page building a proposal**

In `app/[user]/page.tsx`, remove the block that reads the newest spec, calls `readStoredSpec`, and builds the card's props — including its `try`/`catch` and the `pageLoadPreview` composition. Remove the `proposal` and confirmed-state props passed to `ChatPanel`.

Leave `first_session_start`, `ensureOpeningMessage`, `dashboard_open`, the tab strip and the banner untouched. None of them are about the card.

- [ ] **Step 3: Stop the route streaming proposal lines**

In `app/api/chat/route.ts`, remove the `{ proposal }`, `{ proposal_error }`, `{ authoring: true }` and `{ stage }` enqueues, and the `onStage` callback passed into `runTurn`. Keep `{ saved: true }` — it tells the browser the exchange was committed, which is still true and still worth saying.

`runTurn` still calls `authorSpec`; only the wire messages go. Remove `onStage` from `RunTurnInput` in `lib/chat/turn.ts` and from every test that passes it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/chat tests/routing`
Expected: FAIL first, then PASS as you update them. Tests asserting a card renders, a confirm button posts, or a stage line arrives are testing deleted behaviour — delete those cases rather than weakening them. Tests asserting the transcript renders, the thinking indicator appears, or `{ saved: true }` arrives must still pass unchanged; if one of those breaks, you have removed too much.

Add one test to `tests/chat/route.test.ts` pinning the absence: an ordinary turn that triggers authoring streams no `proposal` and no `stage` line. A deletion with no test can be silently undone.

- [ ] **Step 5: Review the screens as pictures**

```bash
npm run shots -- --task=2
```

`screenshots/screens.ts` describes what each screen must look like. Screens whose description mentions a proposal card no longer can — update those entries to describe what the screen now shows. This is a review gate, not a test: look at the images. CLAUDE.md requires it before a commit, and it has caught things no test in this repo can see.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Remove the proposal card, its two buttons and the staged wait

A friend no longer confirms anything: the agent says in words that it has what
it needs, and the build arrives. The card, the mockup preview it framed, and
the two-stage progress bar go with it."
```

---

### Task 3: Stop confirming specs

**Files:**
- Delete: `app/api/spec/confirm/route.ts`
- Modify: `lib/db/specs.ts` (`currentSpec`, `hasConfirmedSpec`, `hasConfirmedSpecBelow`, `confirmSpec`)
- Modify: `lib/chat/confirmations.ts`, `lib/chat/turn.ts` (the confirmation merge)
- Modify: `lib/chat/context.ts` (`contextFor`)
- Test: `tests/db/specs.test.ts`, `tests/chat/confirmations.test.ts`, `tests/routing/*`

**Interfaces:**
- Consumes: Task 2's removal of the confirm button.
- Produces: `currentSpec` = the newest spec row; `hasSpec(db, accountId)`; `hasSpecBelow(db, accountId, version)`.

**`spec_confirmations` keeps its rows, its table and its triggers.** Nothing writes to it again. Rows already there record real decisions real people made and stay readable.

- [ ] **Step 1: Write the failing test**

`tests/db/specs.test.ts` has `write(accountId, title, at): number`, which
inserts a spec and returns its id, plus a module-level `db`. Use it.

```typescript
describe('currentSpec after confirmations were removed', () => {
  it('returns the newest spec row, confirmed or not', () => {
    // No spec_confirmations row is written anywhere here — that is the point.
    // The newest spec IS the contract now.
    const account = freshAccount()
    write(account, 'first', 1_000)
    const newest = write(account, 'second', 2_000)

    expect(currentSpec(db, account)?.id).toBe(newest)
  })

  it('hasSpec is false until an account has one', () => {
    const account = freshAccount()
    expect(hasSpec(db, account)).toBe(false)
    write(account, 'first', 1_000)
    expect(hasSpec(db, account)).toBe(true)
  })

  it('still reports a historical confirmation without anything writing one', () => {
    // spec_confirmations keeps its rows and its trigger. Nothing in the
    // application writes there any more; reading one still works.
    const account = freshAccount()
    const id = write(account, 'first', 1_000)
    db.prepare('INSERT INTO spec_confirmations (spec_id, account_id, at) VALUES (?, ?, ?)')
      .run(id, account, 1_500)
    expect(readSpecs(db, account)[0]!.confirmed_at).toBe(1_500)
  })
})
```

`freshAccount()` is a local helper returning a new account id — follow however
the file already creates accounts for its existing cases. A fresh account per
test matters here: `currentSpec` reads the newest row for an account, so
sharing one across cases would make later tests depend on earlier inserts.

Use the file's existing fixture helpers rather than inventing new ones — read its top first.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/specs.test.ts`
Expected: FAIL — `hasSpec` is not exported, and `currentSpec` returns `undefined` for an unconfirmed row.

- [ ] **Step 3: Make the changes**

In `lib/db/specs.ts`:

```typescript
/**
 * The newest proposal. The build contract.
 *
 * It used to be "the newest proposal that has a confirmation" — the friend
 * pressing Build this is what promoted a proposal to the thing Nico built.
 * Nothing confirms any more, so the newest spec IS the contract, and
 * `readSpecs` already returns newest-first.
 *
 * `confirmed_at` stays on SpecRecord and stays populated for rows that have a
 * historical confirmation. spec_confirmations is append-only and keeps every
 * row it holds; this function simply no longer asks about them.
 */
export function currentSpec(db: PlatformDb, accountId: number): SpecRecord | undefined {
  return readSpecs(db, accountId)[0]
}
```

Rename `hasConfirmedSpec` → `hasSpec` and `hasConfirmedSpecBelow` → `hasSpecBelow`, and change both to query `specs` alone rather than joining `spec_confirmations`. Update every call site: `lib/chat/context.ts`'s `contextFor`, `lib/chat/announce.ts`'s `first`, and `app/[user]/page.tsx` if it calls either.

**`contextFor` keeps returning the literal string `'tweak'`.** Its own comment already explains why — `metrics` is append-only and cannot be migrated, so renaming the value would split one series across two spellings for a wording change (unified-loop ledger D11). Only the helper it calls changes.

Delete `confirmSpec` and `app/api/spec/confirm/route.ts`. Delete `lib/chat/confirmations.ts`'s writer if it has one; keep `readConfirmations` and the confirmation-note merge in `lib/chat/turn.ts` — a friend who confirmed something last month said a real thing, and the agent should still see it in their history.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Tests exercising the confirm route are testing a deleted route — delete those cases. `tests/alerts/leak.test.ts` and anything asserting the `spec_confirmed` alert fires will need attention; that alert is handled in Task 5, so for now leave the `ALERT_TEXT` key in place and only remove the call site if one exists in deleted code.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Stop confirming specs; the newest spec is the build contract

spec_confirmations keeps its rows, its table and its append-only triggers —
nothing writes there again. hasConfirmedSpec becomes hasSpec, and contextFor
keeps emitting 'tweak' because metrics cannot be migrated."
```

---

### Task 4: Stop authoring a mockup

**Files:**
- Modify: `lib/spec/author.ts`
- Modify: `lib/chat/prompt.ts` (de-reference `MOCKUP_PROMPT`, `MOCKUP_SCREENS_PROMPT`)
- Test: `tests/spec/author.test.ts`

**Interfaces:**
- Consumes: Task 2's removal of `preview_html` consumers.
- Produces: `Proposal` without `mockup_html` or `preview_html`; `authorSpec` making exactly one model call.

**`specs.mockup_html` stays a `NOT NULL` column and receives `''`.** Altering the column would mean recreating an append-only table that holds rows — schema surgery CLAUDE.md restricts to `reshape.ts` and `migrate.ts`, neither of which applies. An empty string is honest and readable: a row with `mockup_html = ''` is one authored after mockups were removed. Write that reasoning into the code at the insert site, because a bare `''` argument looks like a bug to the next reader.

- [ ] **Step 1: Write the failing test**

`tests/spec/author.test.ts` already has what you need: `fake(options?)`
returning `{ client, ... }` with a recorded call list, `deps(client)`, the
`INPUT` constant, `metrics()`, and a module-level `db`. Read its top and use
them; do not build new fixtures.

```typescript
describe('authorSpec no longer draws a mockup', () => {
  it('makes exactly ONE model call', async () => {
    // Two was the old shape: the spec, then the per-screen mockup. The second
    // call is what this task removes, and a count is the only assertion that
    // notices if it comes back.
    const f = fake()
    await authorSpec(deps(f.client), INPUT)
    expect(f.calls).toHaveLength(1)
  })

  it('stores an empty mockup_html rather than failing the NOT NULL column', async () => {
    // The column stays — altering it would be schema surgery on an
    // append-only table. '' readably means "authored after mockups were
    // removed"; a row that failed to insert would mean nothing at all.
    await authorSpec(deps(fake().client), INPUT)
    const row = db
      .prepare('SELECT mockup_html FROM specs ORDER BY id DESC LIMIT 1')
      .get() as { mockup_html: string }
    expect(row.mockup_html).toBe('')
  })

  it('writes no spec_screen_mockups row', async () => {
    await authorSpec(deps(fake().client), INPUT)
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM spec_screen_mockups')
      .get() as { n: number }
    expect(row.n).toBe(0)
  })

  it('writes no mockup_prompt_sha on the spec_proposed row', async () => {
    // The metric's shape is part of the contract: a field naming a prompt
    // that no longer runs would be permanently misleading in an append-only
    // table.
    await authorSpec(deps(fake().client), INPUT)
    const proposed = metrics().find((m) => m.event === 'spec_proposed')
    expect(proposed).toBeDefined()
    expect(proposed!.data).not.toHaveProperty('mockup_prompt_sha')
  })
})
```

`fake()`'s recorded-call accessor may be named something other than `.calls` —
read its definition (around line 137) and use whatever it actually exposes. If
it records only the last call, extend it to record all of them; a one-call
assertion is the core of this task.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/spec/author.test.ts`
Expected: FAIL — the client records two calls and `mockup_html` holds a composed document.

- [ ] **Step 3: Cut the mockup out of `authorSpec`**

Remove from `lib/spec/author.ts`:

- The whole `if (affected.length > 0)` mockup block: `loadPrompt(MOCKUP_SCREENS_PROMPT)`, the retry loop, `parseScreenMockups`, `mockupAttempt`, `MAX_MOCKUP_ATTEMPTS`.
- `readScreenMockups`, `insertScreenMockups`, `carried`, `patchAffected`, `missingCarried`, `affected`, `composeMockup`, `mockupHtml`, `previewHtml`.
- `mockup_prompt_sha`, `mockupPromptSha`, and the `mockup_failed` metric arm.
- `mockup_html` and `preview_html` from the exported `Proposal` type.
- The `onStage` call announcing the drawing stage.

Keep everything about the spec call itself: the retry loop, `parseSpecDraft`, `sealVersion`, `spec_proposed`, `spec_error`, `spec_aborted`, `authoring_mode`, `ops_count`. The patch machinery stays — plan 3 removes it.

At the `insertSpec` call, pass `mockupHtml: ''` with a comment stating why the column still exists and what an empty value means.

In `lib/chat/prompt.ts`, mark `MOCKUP_PROMPT` and `MOCKUP_SCREENS_PROMPT` as no longer loaded by production code, in the same form the file already uses for the historical `MOCKUP_PROMPT` note. **Do not delete the constants or the files** — `prompt_sha` values on existing spec rows name them.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Author a spec without drawing a mockup

One model call instead of two. specs.mockup_html stays a NOT NULL column and
takes '' — altering it would be schema surgery on an append-only table, and ''
readably means 'authored after mockups were removed'. spec_screen_mockups
keeps its rows and stops gaining any."
```

---

### Task 5: Alert on an authored spec, and on a failed one

**Files:**
- Modify: `lib/alerts/ntfy.ts` (`ALERT_TEXT`)
- Modify: `lib/spec/author.ts` or `app/api/chat/route.ts` (the alert call sites)
- Test: `tests/alerts/ntfy.test.ts`, `tests/spec/author.test.ts`

**Interfaces:**
- Consumes: Task 4's `authorSpec`.
- Produces: two new `AlertKind` values.

**Why this task exists.** Two signals died in this plan. `spec_confirmed` fired when a friend pressed Build this — that was how Nico learned there was work to do, and nothing confirms any more. And a `spec_error` used to be visible because the friend watched a card fail to arrive; in the background nobody is watching, and the friend has asked for something that does not exist.

The design doc (§8, D11) requires the failure alert. **The success alert is an addition beyond it**, and it is load-bearing for the operator loop: without it, the only way Nico learns a friend wants a build is by reading transcripts.

- [ ] **Step 1: Write the failing test**

`tests/alerts/ntfy.test.ts` has `fakeFetch(calls, answer)`, `ok()` returning a
200 `Response`, a local `alerter(over?)` wrapper around `conversationAlerter`,
and `metrics()`. Use them.

```typescript
it('sends a slug and a fixed phrase for an authored spec', async () => {
  // The metrics bound applied to a push notification: WHO and WHAT KIND,
  // never a title, a panel, or a change summary. This alert exists because
  // removing the confirmation removed the signal that told Nico there was
  // work to do.
  const calls: Call[] = []
  await alerter({ fetch: fakeFetch(calls, ok) })('spec_authored', accountId)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.body).toContain('devone')
  expect(calls[0]!.body).toContain(ALERT_TEXT.spec_authored)
})

it('has a kind for an authoring failure', async () => {
  // In the background nobody is watching. The friend has asked for something
  // and nothing exists; this is the only thing that says so.
  const calls: Call[] = []
  await alerter({ fetch: fakeFetch(calls, ok) })('spec_failed', accountId)
  expect(calls[0]!.body).toContain(ALERT_TEXT.spec_failed)
})

it('carries nothing the friend wrote, for either kind', async () => {
  const calls: Call[] = []
  const send = alerter({ fetch: fakeFetch(calls, ok) })
  await send('spec_authored', accountId)
  await send('spec_failed', accountId)
  for (const call of calls) {
    expect(call.body).not.toMatch(/divorce_lawyer_fund/)
  }
})
```

Match the exact shape of `Call` and how the file reads a request body from it —
`calls[0]!.body` above is a guess at that shape, so check it against the file's
existing assertions and use whatever they use.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/alerts/ntfy.test.ts`
Expected: FAIL — neither kind exists on `ALERT_TEXT`.

- [ ] **Step 3: Add the kinds and wire them**

```typescript
export const ALERT_TEXT = {
  conversation_started: 'started a conversation',
  spec_confirmed: 'confirmed a spec',
  spec_authored: 'asked for a build',
  spec_failed: 'asked for a build, and writing the spec failed',
  migration_failed: 'could not log in — migration failed',
} as const
```

Keep `spec_confirmed`. Nothing sends it now, but the key costs nothing and removing it would make an old alert's wording unrecoverable.

Wire both at the point that already knows the outcome. `authorSpec` returns a proposal or records a `spec_error`; the caller in `app/api/chat/route.ts` already builds a `conversationAlerter` and has `process.env.NTFY_TOPIC` in hand. Send from there rather than reaching into `authorSpec`, so the alerting stays out of the module every test injects a fake client into.

**The alert must never block or fail the turn.** `lib/alerts/ntfy.ts`'s `alerter` already swallows its own failures; keep that property and do not `await` it in a way that delays the friend's reply.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Confirm no test reaches the network — `fetch` is injected everywhere.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Alert when a spec is authored, and when authoring fails

Two signals died with the confirmation card: Nico learning there is work to do,
and a failure being visible because the friend watched a card not arrive. The
alert carries a slug and a fixed phrase — never anything the friend wrote."
```

---

### Task 6: Delete the mockup surfaces

**Files:**
- Delete: `lib/spec/mockupCompose.ts`, `lib/spec/banner.ts`, `app/mockup/[version]/route.ts`, `app/admin/mockup/[user]/[version]/route.ts`, `users/*/mockup.html`
- Modify: `app/admin/[user]/page.tsx` (the Mockup tab), `scripts/pull-spec.sh`, `scripts/write-spec-pair.ts`, `scripts/export-spec.ts`
- Delete: the corresponding tests
- Test: `tests/scripts/writeSpecPair.test.ts`, `tests/admin/*`

**Interfaces:**
- Consumes: Tasks 2 and 4 — nothing composes or serves a mockup by now.
- Produces: `writeSpecPair` writing one file; `pull-spec.sh` producing `spec.md` only.

- [ ] **Step 1: Delete what nothing calls**

```bash
git rm lib/spec/mockupCompose.ts lib/spec/banner.ts
git rm -r "app/mockup" "app/admin/mockup"
git rm users/*/mockup.html
```

Then remove their tests and the Mockup tab from `app/admin/[user]/page.tsx`, leaving the Spec tab and the transcript.

**The mockup CSP guard goes with them, and that is correct rather than a weakening.** It existed because mockup HTML was generated from interview content, so any external fetch it made could leak transcript-derived content to a third party. With nothing generating or serving that HTML, the channel it guarded no longer exists. Say so in the commit message — a future reader finding a deleted CSP needs to know it was removed with its subject, not from it.

- [ ] **Step 2: Make `writeSpecPair` write one file**

`scripts/write-spec-pair.ts` writes `spec.md` and `mockup.html` as an atomic unit — temp-write, move the existing pair aside, commit by rename, roll back on failure. With one file the atomicity requirement is weaker but the rollback behaviour is still worth keeping: a half-written `spec.md` is worse than an untouched one.

Keep the injectable `FsOps` seam and the guards; drop only the second file. `tests/scripts/writeSpecPair.test.ts` injects failures at specific calls and asserts each guard catches its own case — update it to the one-file shape rather than deleting cases, and keep its "delete each guard in turn and confirm only its own test goes red" property.

Update `scripts/export-spec.ts` to stop emitting `mockup_html`, and `scripts/pull-spec.sh`'s comments, which describe writing a pair.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run && npx tsc --noEmit && npx next build`
Expected: PASS all three. **`next build` matters here specifically** — this task deletes route files, and a stale import of a deleted route is exactly the failure `tsc --noEmit` does not catch.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Delete the mockup composer, its routes and its files

The mockup CSP guard goes with them. It existed because mockup HTML was
generated from interview content, so an external fetch could leak
transcript-derived content to a third party the moment a friend opened a
preview. Nothing generates or serves that HTML now, so the channel it guarded
is gone — the guard was removed with its subject, not from it."
```

---

### Task 7: `agent-v7.md`

**Files:**
- Create: `platform/prompts/agent-v7.md`
- Modify: `lib/chat/prompt.ts` (`AGENT_PROMPT`)
- Test: `tests/chat/prompt.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `AGENT_PROMPT = 'agent-v7.md'`.

- [ ] **Step 1: Copy v6 and edit**

```bash
cp platform/prompts/agent-v6.md platform/prompts/agent-v7.md
```

Change only these, leaving everything else byte-identical:

1. **`## Proposing`** — remove the preview entirely: the minute-long wait, "mostly spent drawing the preview", the two buttons, Build this / Not quite yet, "The new preview replaces the old one", and "Do not describe the dashboard in detail yourself before calling the tool — the preview does that". Replace with: calling `propose_spec` ends your turn and hands the build to the builder; say in one short sentence that you have what you need and that it is being built. **The friend must be told**, because with no card there is otherwise no sign anything happened. Since no preview describes the dashboard any more, the agent SHOULD now say briefly what it is going to have built — the instruction inverts.
2. **`## After they confirm`** — delete the section. There is no confirmation.
3. **"Every change ships through a confirmed proposal, including small ones."** — replace with the rule that survives: only call `propose_spec` when something actually changed, and never when the spec it would produce matches the one already authored.
4. **`## When you have enough`** — **unchanged, byte for byte.** It is the load-bearing part of this prompt and the reason the spec artifact survives at all.

- [ ] **Step 2: Point `AGENT_PROMPT` at it**

```typescript
/**
 * v7 removes the preview. There is no mockup and nothing to confirm: calling
 * propose_spec writes a spec in the background and the build arrives. The
 * agent now says briefly what it will have built, because the card that used
 * to say it is gone.
 */
export const AGENT_PROMPT = 'agent-v7.md'
```

- [ ] **Step 3: Diff and verify**

```bash
diff -u platform/prompts/agent-v6.md platform/prompts/agent-v7.md
npx vitest run tests/chat/prompt.test.ts
```

Read the diff yourself and confirm every hunk is one of the four changes above. `tests/chat/prompt.test.ts` sweeps `platform/prompts/*.md` from disk, so v7 is covered without an edit; if it pins the opener text, v7 keeps it unchanged.

- [ ] **Step 4: Commit**

```bash
git add platform/prompts/agent-v7.md lib/chat/prompt.ts
git commit -m "agent-v7: no preview, no confirmation, say what will be built"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/runbook.md`, `docs/dashboard-build-rules.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

Docs are exempt from Gate B by path, so there is no test. The verification is reading each claim against the code.

- [ ] **Step 1: CLAUDE.md**

Rewrite the parts of "Schema & module rules" that describe the loop: the spec is no longer confirmed, `specs.mockup_html` is written empty, `spec_screen_mockups` and `spec_confirmations` are append-only tables nothing writes to any more, and the mockup CSP paragraph goes — with one sentence recording that the guard was removed because its subject was, not because the promise weakened.

Keep every rule that still holds: `specs` rejects UPDATE, read stored payloads through `lib/spec/stored.ts`, `based_on_version` is server-supplied, metrics never carry user values, prompts are added never edited.

- [ ] **Step 2: docs/runbook.md**

Steps 5 and 6 describe a friend confirming a spec and the operator pulling a spec/mockup pair. Rewrite: there is nothing to confirm, `pull-spec.sh` writes `spec.md` alone, and Nico learns a friend wants a build from an ntfy alert rather than from a confirmation. Step 7.3 says "Build toward `mockup.html`" — there is no mockup; the build contract is `spec.md`, the conversation, `current.md` and the code.

- [ ] **Step 3: docs/dashboard-build-rules.md**

Update the index entries whose sources changed, keeping each line's citation. Remove entries indexing deleted rules.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/runbook.md docs/dashboard-build-rules.md
git commit -m "Document the loop without a mockup or a confirmation"
```

---

## Done when

- `npx vitest run` green, `npx tsc --noEmit` clean, `npx next build` succeeds.
- No file under `app/`, `lib/` or `scripts/` composes, serves or stores a mockup.
- `users/*/mockup.html` is gone; `users/*/spec.md` remains.
- `spec_screen_mockups` and `spec_confirmations` still exist, still hold their rows, still reject UPDATE and DELETE.
- An authored spec sends an ntfy alert carrying a slug and a fixed phrase.
- `npm run shots` reviewed as pictures — no screen still shows a card or a stage bar.

## Not in this plan

Change-only specs (`SpecDraft` keeps `screens`), `lib/spec/patch.ts`, the `stored.ts` discriminator and its third arm, `conversation.md` in `pull-spec.sh`, and the `current.md` version gate in `announce-deploy.ts`. All of that is plan 3.
