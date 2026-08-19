# The built dashboard is the truth — design

**Status:** proposed, 2026-08-18. Not yet built.

**Supersedes:** the 2026-08-17 scoped-specs design in full (Parts A/B/C — the
patch, the applier, the per-screen preview), and the unified-proposal-loop
design's confirmation and mockup surfaces. Build notes (that design's Part A)
survive unchanged and are load-bearing here.

---

## 0. Why this exists now

A friend's second conversation was proposed against the first conversation's
**spec**, never against the dashboard that was actually built. The spec is a
prediction written before any code existed; the build necessarily departs from
it; nothing ever wrote the departure back.

`users/run8/` shows it in the repo today. Its confirmed v2 spec still lists
three `## Open questions` — whether minus stops at zero, whether it may edit
past days, which day the week starts — that **the build answered**. The built
dashboard also dropped the mockup's colours for the app palette, leaves
pre-start days blank rather than zero, and averages over days actually logged.
None of that is in the spec row. Some is in `mockup.html`, some only in
`notes/v2.md`, some only in `dashboard.tsx`.

The mechanism, confirmed by reading the authoring path:

- `authorSpec` builds its entire picture of "what exists" from `currentSpec`
  (`lib/spec/author.ts:450`), rendered by `currentVersionBlock`
  (`author.ts:312`). That is the last confirmed **spec row** — model output,
  never touched by a build.
- Untouched screens' mockup fragments are carried from
  `readScreenMockups(db, current.id)` (`author.ts:686-687`) — the previously
  *proposed* HTML, so a v2 preview composites last time's drawing of screens
  that no longer look like it.
- The only writers of `specs` are `authorSpec` itself and `scripts/shots.ts`
  fixtures. No build, deploy or announce step amends a row, and `specs` rejects
  UPDATE regardless.
- Data flows one way only: `specs` → `export-spec.ts` → `write-spec-pair.ts` →
  `users/<slug>/spec.md`. Nothing pushes back.

`docs/dashboard-build-rules.md:67` already states half of this — "a note is the
only record of what actually SHIPPED; `spec.md` records what was *asked for*" —
without drawing the conclusion that the asked-for version is what the next
proposal is built on.

**The one partial channel**, for completeness: `announce` appends the deploy
message as an assistant transcript row (`lib/chat/announce.ts:52`), drafted from
the friend-facing notes including `## Built differently`, and `authorSpec` reads
the whole transcript. So a departure *can* reach the writer as ≤600 characters
of prose, competing with an authoritative JSON base that still says otherwise.
It cannot correct structure, and `built_differently` is documented as routinely
empty.

**What this is not.** Not a change to what a dashboard folder contains or how
one is built. Not a change to the friend's data model, the encryption story, or
the metrics bound. Not an agentic code-reading tool in the chat process — see
§10.

---

## 1. Decisions

- **D1 — The built dashboard is the source of truth, and it speaks through a
  written description rather than through its own source.** The alternative
  considered was a tool letting the chat agent read the code on demand. Rejected
  for now on three grounds: `lib/chat/turn.ts` has no tool loop at all
  (`PROPOSE_TOOL` carries an empty schema and calling it *ends the turn*), so
  this is not "add a tool" but "add tool_result round-trips inside a response
  the friend is watching stream"; the read would run in the one process holding
  every unlocked friend's data key in the in-process keymap, needing
  slug-scoping, extension allowlisting and traversal tests — the same class of
  concern that made `lib/dashboard/registry.ts` refuse to build a module path
  from a URL segment; and it makes the agent translate JSX and SQL into product
  language live on every turn rather than once at build time. **The tool remains
  strictly additive later**, and shipping the description first produces real
  conversations showing which questions it failed to answer, which is what
  should scope the tool.

- **D2 — Code-reading belongs to the builder, which already has it safely.**
  The asymmetry is the argument. The building agent runs on the laptop with the
  whole repo; the chat agent's job is conversation.

- **D3 — No confirmation step, and no mockup anywhere.** The friend never
  presses Build this. A spec is authored in the background, the change is built,
  and the announcement tells them. Deliberately accepted: they no longer see the
  thing before it exists. That moment was buying trust which, at pilot scale
  with friends Nico knows, is already there — and it was partly buying a
  *false* picture, since run8's built dashboard is not the one their card
  showed.

- **D4 — There are still no modes.** `agent-v5.md` already says "There are no
  modes; do not treat 'building' and 'tweaking' as different jobs". An earlier
  draft of this design kept the mockup for a first dashboard only; that
  reintroduced the mode the unified loop deliberately removed, and is rejected.
  A first conversation and a relabel are the same job at different sizes.

- **D5 — The spec sheet survives, because it is what keeps the agent
  inquisitive.** `agent-v5.md`'s `## When you have enough` sets a real bar —
  "could the build start without calling this person back?", four things known
  and not guessed. That test is about the build, not the document, but the spec
  is what gives it teeth: with no artifact to produce, "enough" has no
  consequence and the agent drifts into pleasant chat.

- **D6 — The spec becomes change-only.** It no longer restates the whole
  surface, because `current.md` already does. This is what deletes ids,
  `applyPatch`, and the three authoring paths.

- **D7 — `current.md` is overwritten every build; `notes/v<n>.md` is still added
  and never edited.** The difference is not stylistic. A note is pinned because
  `announce-deploy.ts` already spoke from it, so an edit rewrites the basis of a
  message the friend holds permanently. Nothing permanent points at a
  current-state description, so it is free to be replaced — and *must* be, since
  a changelog replayed forward is the same "derive current state from history"
  failure this design exists to remove.

- **D8 — `current.md` is parsed for frontmatter only.** Version and slug come
  out of the frontmatter for the announce gate; the body is prose handed to the
  agent untouched. A body parser is a second thing that drifts from what the
  builder writes.

- **D9 — Nothing sacred is dropped.** `spec_screen_mockups` and
  `spec_confirmations` stop being written but remain as tables with their rows
  and their append-only triggers. CLAUDE.md declares both append-only; dropping
  a sacred table holding rows is a rule change, not a refactor.

- **D10 — The tool keeps the name `propose_spec`.** Its description changes
  completely. Renaming splits the `spec_proposed` metric series across two
  spellings for a wording change — the reason `contextFor` still says `'tweak'`
  (unified-loop D11).

- **D11 — A failed authoring call must alert Nico.** Today a failure is visible
  because the friend watches a card fail to arrive. In the background nobody is
  watching: the friend has asked for something and nothing exists. This is the
  one place where removing the UI removes an accidental monitor.

---

## 2. The loop, in one page

```
friend talks to the agent, which has read current.md
   │
   ├─ agent reaches "when you have enough", says so in words
   │  and calls propose_spec
   │
   ▼
change-only spec written in the background      (no card, no wait, no buttons)
   │
   ▼
Nico builds on <slug>/v<n>, from:
   the spec · the conversation · current.md · the code
   │
   ▼
commits: the code · notes/v<n>.md · a rewritten current.md
   │
   ▼
deploy  →  announce-deploy speaks from notes/v<n>.md
   │
   ▼
friend reads it and keeps talking — agent now has the new current.md
```

---

## 3. The three artifacts

Each has exactly one job, and no two answer the same question.

| Artifact | Question it answers | Lifecycle | Read by |
|---|---|---|---|
| `users/<slug>/current.md` | What is the dashboard *now*? | Overwritten every build | The chat agent |
| `users/<slug>/notes/v<n>.md` | What shipped in version n? | Added, never edited | `announce-deploy.ts`, the next builder |
| The spec row (`specs`) | What should change next? | Append-only, versioned | Nico and the building agent |

`spec.md` in the folder remains the pulled rendering of the spec row.
`mockup.html` ceases to exist.

---

## 4. `current.md`

Lives at `users/<slug>/current.md` — the folder root, not `notes/`, because
`tests/users/conventions.test.ts:283` forbids strays inside `notes/`.

```markdown
---
slug: run8
version: 2
---

## What this is for
One paragraph, in the friend's own terms.

## Screens
Each screen: its title, and what is on it.

## Panels
Each panel: what it shows, how it behaves, and the edges that were decided —
minus stops at zero, minus adjusts today only, days before they started are
blank rather than zero.

## What can be entered
Every control that writes, and what it writes.

## Deliberately not included
What was considered and turned down, and why. This is what stops the agent
re-proposing something already refused.
```

**All five sections are required, in this order, and nothing else may appear** —
parsed the way `lib/build/notes.ts` parses a note's four. `## Deliberately not
included` earns enforcement rather than convention: it is the only carrier of a
refusal. run8's spec records that time-of-day tracking was considered and turned
down; without that section nothing in the new loop remembers, and the agent
proposes it again. An empty section is a real answer and is written as such —
the parser rejects a MISSING heading, not an empty one.

**Same data bound as notes.** It is committed to the repo, so it describes
shape — a panel, a computation, a rule — never a row, a value, or a merchant.
CLAUDE.md's "Build notes never carry user values either", applied to a third
artifact.

**Written in product language, not code.** It is read by an agent talking to a
friend about their dashboard, not by a compiler.

### 4.1 The staleness gate

`current.md` carries `version:` in frontmatter, and `announce-deploy.ts` refuses
to announce version `n` unless `current.md` says `n`. Not an mtime comparison: a
fresh clone rewrites every mtime, so a check that passes on the laptop and fails
on the droplet would be worse than none.

This is the same shape as the existing gate that refuses to announce v`n`
without `notes/v<n>.md` — a build that skipped the rewrite cannot announce.

---

## 5. The spec, reshaped

Change-only. The fields:

- `change_summary` — what is changing, in plain words. Becomes the
  announcement's headline, as today.
- The change itself — screens and panels added, changed or removed, described in
  product language. No ids, no whole-surface restatement.
- `data_requirements` — what the build needs to store or fetch.
- `open_questions` — anything genuinely unresolvable in conversation.

Kept as validated structure rather than prose for three specific reasons: the
announcement's headline, the non-empty-`## Open` routing warning, and a
validator standing between a rambling model and a permanent row in a table that
rejects UPDATE.

`lib/spec/schema.ts` and `validate.ts` shrink to this shape. `lib/spec/patch.ts`,
`applyPatch`, `PATCH_JSON_SCHEMA` and the three authoring paths go entirely.

### 5.1 What `pull-spec.sh` writes

Two files, and the pair stays atomic (`write-spec-pair.ts` keeps its temp-write
and rollback; only the second file changes identity):

- `users/<slug>/spec.md` — the rendered spec, as today. `mockup.html` is gone.
- `users/<slug>/conversation.md` — **the transcript since the previous spec
  row**, oldest first: every row whose `at` falls between spec v(n-1) and spec
  v(n). For a first spec, everything up to it. This is the conversation that
  produced the spec, which is what a builder actually needs — the spec says what
  to build, the conversation says what they meant.

**`conversation.md` is gitignored**, and this is a data-safety line rather than
housekeeping. `spec.md` is tracked and always has been: it is a designed
artifact describing a dashboard. A raw transcript is everything a friend said,
including whatever they said around the dashboard. It is a working input pulled
fresh when needed; the record of record is `transcripts`, which is encrypted
nowhere but lives on the droplet and is append-only. A committed copy would put
a friend's conversation in every clone of this repo forever.

The guard hook does not cover it — the hook denies `.db` and `.env` files, not
markdown — so the gitignore entry and this paragraph are the whole defence,
which is exactly why it is written down here.

---

## 6. The agent — `agent-v6.md`

Prompts are added, never edited (unified-loop D13), so this is a new file.

**Changes:**

- "There is one living description of their dashboard: the spec" becomes
  `current.md`. The spec becomes the change request.
- `current.md`'s body is supplied to the chat call as a context block, read off
  disk exactly the way `lib/build/notes.ts` already reads notes, and omitted
  when the file does not exist (a friend with no dashboard yet).
- The entire `## Proposing` preview passage goes: the minute-long wait, "mostly
  spent drawing the preview", the two buttons, Build this / Not quite yet, and
  `## After they confirm`.
- Replaced by: say in words that you have what you need and that it will be
  built. **The friend must be told**, because with no card there is otherwise no
  signal that anything happened.
- `## When you have enough` is unchanged. It is the load-bearing part.

**Worth recording:** the chat agent currently receives *no* description of the
dashboard at all — only its system prompt and the transcript (`lib/chat/turn.ts`
builds the request from `loadPrompt()` plus transcript rows). It has been
reconstructing the dashboard from conversation. `current.md` is therefore
net-new capability, not a replacement, and it becomes load-bearing the moment
the spec-writer stops seeing prior versions.

---

## 7. Versioning and announce

**The version anchor stays where it is** — `specs` row position, derived and
never stored, so it can neither drift nor race (`lib/db/specs.ts`). Nothing
about that changes.

What changes is what "current" and "built" mean, and the two are now answered by
different things, each checking what it can actually know:

- **`currentSpec` loses its confirmed-only filter.** With no confirmations, the
  current spec is the highest row. `hasConfirmedSpec` / `hasConfirmedSpecBelow`
  follow — they become "has any spec" / "has a spec below". `contextFor` keeps
  returning `'tweak'` for the metric series (D10).
- **`announceTarget` keys off the notes file, not the spec row.** A spec written
  after the build but before the announcement would otherwise become the target,
  and it has not been built. `notes/v<n>.md` exists only for versions that were
  actually built, so it is the honest marker: **announce the highest version
  that has a notes file and no `deploy_announced` row.**
- **`deploy_announced` keeps carrying `spec_id`.** No legacy arm is needed —
  spec versions still exist and still number the same way, so no stored row
  changes meaning.

**Superseded specs.** With nothing to confirm, a friend can produce two specs
before either is built. The rule: the builder builds the highest, and an earlier
unbuilt spec is superseded — it simply never gets a `notes/v<n>.md`. Gaps in the
notes sequence are legible and honest: v3 was superseded before it was built.

---

## 8. Background authoring

`propose_spec` keeps its empty input schema and still ends the turn. What
changes is what happens after: no mockup call, no `proposal` NDJSON line, no
card.

`app/api/chat/route.ts` stops enqueueing `{proposal}` and `{proposal_error}`.
`ChatPanel.tsx` loses the preview card, the two buttons, and the two-stage
progress bar with its "Writing the spec… / Drawing the preview…" copy.

**Failure alerting (D11).** A `spec_error` now happens where nobody is looking.
`lib/alerts/ntfy.ts` gains a kind for it, alongside the existing conversation
and migration alerters. The friend has asked for something; if authoring failed,
the only record is a metric row nobody reads.

---

## 9. What is deleted

- `lib/spec/mockupCompose.ts` (1,038 lines) — `composeMockup`,
  `affectedScreens`, `stripExternalReferences`, the shared stylesheet, the
  per-screen `#screen-<id>` scoping.
- `lib/spec/patch.ts` (403 lines) and `applyPatch`.
- Most of `lib/spec/author.ts` (990 lines): the patch arm, the mockup call, the
  carry-forward and its `missingCarried` healing, `currentVersionBlock`,
  `Proposal.preview_html`.
- `platform/prompts/mockup-v1..v4.md` and `spec-v3.md` stop being loaded. The
  FILES stay on disk — prompts are added, never edited, and never deleted:
  `prompt_sha` is stamped on transcript and spec rows that already exist, and
  removing the file it names would orphan them.
- `app/mockup/[version]/route.ts` and `app/admin/mockup/[user]/[version]/route.ts`,
  and the admin Mockup tab.
- `users/<slug>/mockup.html` and the mockup half of `write-spec-pair.ts` /
  `pull-spec.sh`.
- The mockup CSP guard in both its forms — the route headers and the
  `<meta http-equiv>` written into composed documents — because there is no
  generated HTML left to serve.
- `ChatPanel.tsx`'s proposal card, confirmation buttons, and progress bar.

**On the tabs question.** Nearly all the complexity that made screens feel
complicated was the per-screen mockup machinery: `spec_screen_mockups` keyed by
`(spec_id, screen_id)`, `affectedScreens`, fragment scoping, selector
prefixing. It all goes here. What remains is the `screens` export, `?screen=`,
and `tabStrip` — roughly forty lines, deliberately left alone.

---

## 10. What is NOT changing

- Dashboard folder conventions, the registry, the read-only handle, the
  four ordered checks on writes, `dayKey` and the friend-timezone rules.
- The friend's encrypted database, `lib/db/migrate.ts`, the keymap, envelope
  keys, and the no-password-reset rule.
- The metrics bound. `current.md`'s existence changes nothing about what
  `metrics` may carry.
- Build notes: four sections, two friend-facing, parser-enforced.
- `transcripts`, `metrics`, `specs`, `spec_confirmations` and
  `spec_screen_mockups` remain append-only, with their triggers, forever.
- No code-reading tool in the chat process (D1).

---

## 11. Failure modes

- **A build forgets to rewrite `current.md`.** Caught: the announce gate refuses
  a version mismatch (§4.1). The friend is not announced to, and Nico is the one
  who finds out.
- **`current.md` is accurate but thin.** The agent proposes something already
  refused, or misdescribes an edge. Not caught by any gate — it surfaces in
  conversation, and the fix is a better `## Deliberately not included`. This is
  the accepted cost of D1, and the signal that would justify the read tool.
- **Two specs, one build.** Handled by the supersede rule (§7). The risk is Nico
  building the older one; the mitigation is that `currentSpec` is the highest.
- **Authoring fails silently.** Handled by D11's alert. Without it this is the
  worst failure in the design, because the friend believes something is coming.
- **A friend expects to approve.** They no longer can. If someone pushes back
  after a build, that is an ordinary next version — which is the loop working,
  not a failure, but it is a change in the promise and `agent-v6.md` must not
  imply otherwise.

---

## 12. Files touched

**New:** `platform/prompts/agent-v6.md`, `users/<slug>/current.md` per built
dashboard, a `current.md` template in `platform/templates/dashboard/`,
`lib/build/currentState.ts` (frontmatter + section parser).

**Changed:** `lib/spec/author.ts`, `lib/spec/schema.ts`, `lib/spec/validate.ts`,
`lib/spec/stored.ts`, `lib/chat/prompt.ts`, `lib/chat/turn.ts`,
`lib/db/specs.ts`, `lib/chat/announce.ts`, `scripts/announce-deploy.ts`,
`scripts/pull-spec.sh`, `scripts/write-spec-pair.ts`, `lib/alerts/ntfy.ts`,
`app/api/chat/route.ts`, `app/[user]/ChatPanel.tsx`, `app/[user]/page.tsx`,
`app/admin/[user]/page.tsx`, `tests/users/conventions.test.ts`, `.gitignore`,
`CLAUDE.md`, `docs/dashboard-build-rules.md`, `docs/runbook.md`.

**Deleted:** as §9.

**Testing.** Conventions sweep requires `current.md` for a `built` folder.
Announce refuses a frontmatter version mismatch. The chat call includes
`current.md` when present and omits it when absent. `propose_spec` writes a spec
and no mockup. The alert fires on an authoring failure. The `screenshots/`
fixtures that seed proposal cards need reworking — `scripts/shots.ts` calls
`insertSpec` and `insertScreenMockups` in three places.

---

## 13. Resolved, 2026-08-18

1. **Backfill `current.md` by hand.** The sweep is unconditional: every built
   folder has one. Nico's note was that what has been built so far is
   throwaway — see §13.1.
2. **`pull-spec.sh` keeps writing into the folder**, and gains
   `conversation.md` alongside `spec.md` (§5.1).
3. **`## Deliberately not included` is required and parser-enforced** (§4).

### 13.1 Which folders exist when this lands

`run3`, `run4` and `run8` are **deleted**, with their `lib/dashboard/registry.ts`
lines. Those accounts then serve `PlaceholderCard` and their chats open by
default again (`hasDashboard()` goes false). Nothing on the droplet is touched:
the accounts, their invites and their encrypted databases are untouched by a
repo deletion, and this design deletes no user data anywhere.

`users/devone/` stays — the hand-written reference implementation.
`users/devtwo/` stays — `screenshots/screens.ts` pins its empty-state screen to
that slug, so deleting it would break the screenshot review gate.

So the backfill is two files: `devone/current.md` and `devtwo/current.md`.

**Two consequences that are not free, and are accepted:**

- `run4` is the only folder in the repo in the `scaffolded` state — migrations
  present, no numbered `.sql` yet — and `tests/users/conventions.test.ts:437`
  names it as the worked case for that branch. Deleting it leaves the branch
  live but uncovered. The plan either builds a fixture folder for it or records
  it as a knowing gap; it must not silently lose the case.
- `app/api/users/[user]/count/route.ts` is run8's write path and becomes
  orphaned — no registered dashboard POSTs to it. **Keep it, and keep
  `tests/routing/countRoute.test.ts`.** It is the repo's only worked example of
  the four ordered checks on a write, the test inlines its own copy of the
  migration rather than reading the user folder (so it survives the deletion
  untouched), and CLAUDE.md's rule that every dashboard write goes through a
  platform route has nothing else demonstrating it.

## 14. Out of scope

A code-reading tool for the chat agent (D1) — revisit once `current.md` has
failed a real conversation. Plaid (step 6b). Any change to how a dashboard is
built, tested or screenshotted.
