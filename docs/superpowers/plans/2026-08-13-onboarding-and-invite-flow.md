# Onboarding & Invite Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A friend receives a link, reads the promise, sets the password that becomes their encryption key, and lands in the app shell they will use for the product's whole life — with the returning-login, forgot-password, admin, and mockup-preview surfaces the same build implies.

**Architecture:** Five onboarding surfaces (S0 dead link, S1 the deal, S2 set password, S4 login, S5 forgot) are single centred columns; S3 — the shell — is the one composed screen, and its breakpoint behaviour is CSS only (ledger D6). The password derives a key-encrypting key that unwraps a random data key stored wrapped in a new `account_keys` table (D2); accounts created before this branch have no row and keep deriving the database key directly, forever. Token consumption, account creation, key wrapping and session creation happen in one SQLite transaction, with the empty encrypted database built *before* it and linked into place *after* (D13). Everything Nico-built is built from literal shadcn/ui on Tailwind, defaults barely touched (D1).

**Tech Stack:** Next.js App Router, TypeScript (strict, `noUncheckedIndexedAccess`), better-sqlite3-multiple-ciphers, `@node-rs/argon2`, `node:crypto` (AES-256-GCM), vitest, Playwright (headless, review only). **New dependencies are exactly the table in ledger D1 and nothing outside it** — shadcn/ui with its Radix primitives and `lucide-react`, `react-markdown` + `remark-gfm` for the admin Spec tab, `jsdom` and `@playwright/test` for tests.

**Spec:** `onboarding-ux-spec.md` (repo root). **Read it in full, plus `docs/superpowers/ledgers/onboarding.md`, before Task 1.** The ledger records the rulings this plan depends on and the three false assumptions (§0) that motivated them; a task that seems to contradict the spec is almost certainly executing a ruling.

## Global Constraints

- **The three copy blocks are build contracts, shipped verbatim**: the promise block (S1 + S4), the password warning (S2), and the placeholder card (S3). They live as constants in `lib/copy/onboarding.ts` and are pinned sentence-by-sentence by tests, the way `tests/routing/loginPage.test.ts` already pins today's promise. A wording change is a string edit plus a test edit, in the same commit, on purpose.
- **No password reset path may exist anywhere, including "temporarily for dev."** No route, no script, no admin action, no `TODO`.
- **Every screen is screenshotted and reviewed before the task that touched it is committed** (ledger D16). The harness is Task 3; every UI task afterwards carries a capture-and-review step, and a failed review blocks the commit exactly like a red test. Shots live in `.screenshots/<task>/` and are kept.
- **`metrics` and `transcripts` gain no columns and no rows this plan does not name.** `device_class` is a key inside the existing `data` JSON blob (D4). Proposal cards and confirmations are merged into the transcript at read time and write nothing (D5, D5a).
- **Metrics never carry user values.** A `device_class` is a three-value enum. An invite's slug is a name Nico assigned, not something the friend authored, so it may ride on `invite_opened`/`promise_accepted`/`password_set`/`db_created`; nothing else about them may.
- **Derived keys, data keys, and passwords stay out of every persisted artifact.** The wrapped data key is the only key material ever written down, and it is written wrapped. No key material in a cookie, a URL, a log line, a metrics row, an error message, or a screenshot.
- **Every screen is one responsive implementation.** Breakpoint differentiation exists only in `app/[user]/Shell.tsx`'s composition, and only as Tailwind class names (D6).
- **Test with `npx vitest run`.** Scope with a path. Gate B (pre-commit) needs a staged file under `tests/` for any `app|lib|platform|scripts|middleware.ts` change. `*.css` is Gate-B exempt by path; root-level `*.json` is too, so `components.json` and `package.json` are free. `components/ui/*` gets its own exempt arm in Task 2 — it is vendored third-party source, like `platform/prompts/*`.
- **Gate D (`next build`) is the layer that catches what `tsc` cannot.** Tailwind, PostCSS, a Radix client component reached from a server component, and a `react-markdown` import in a server tree are all things that compile clean and can still break a build. Run `npx next build` at the end of Tasks 2, 3, 13, 15 and 16 specifically, not only at push time.
- **The red-test control is standing practice** (step-4 ledger): for every guard a test claims to cover, delete the guarded code, confirm **exactly that one test** goes red, and restore. Named explicitly per task below. A test nobody has watched fail is not evidence.
- **Two red-test controls are named by the spec itself and are non-negotiable:** "a locked session can neither read nor write" and "a used token cannot re-register" each get a test that goes red when its guard is deleted.

---

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `components.json`, `app/globals.css`, `postcss.config.mjs` | shadcn/ui + Tailwind, written by `shadcn init`, barely touched. |
| `components/ui/*.tsx` | Vendored shadcn components: `button`, `input`, `label`, `card`, `checkbox`, `dialog`, `tabs`, `collapsible`, `alert`. |
| `lib/utils.ts` | `cn()` — written by the CLI at its default path. |
| `lib/ui/PasswordField.tsx` | Client. shadcn `Input` + `Label` + a show-password toggle. Used by S2 (twice), S4. |
| `lib/copy/onboarding.ts` | The three verbatim copy blocks, the dead-link line, the wrong-password line, the S5 body. |
| `lib/metrics/deviceClass.ts` | `DEVICE_CLASS_COOKIE`, `deviceClassFrom()`, `readDeviceClass()`. |
| `lib/auth/envelope.ts` | `newDataKey()`, `wrapDataKey()`, `unwrapDataKey()`, `WrappedKeyError`. |
| `lib/db/accountKeys.ts` | `putWrappedKey()`, `readWrappedKey()`. Absence = legacy account. |
| `lib/invite/tokens.ts` | `newToken()`, `tokenSha()`, `mintInvite()`, `readInvite()`, `consumeInvite()`, `revokeInvite()`, `InviteState`. |
| `lib/invite/register.ts` | `registerFromInvite()` — the whole S2 server action, D13's ordering in one function. |
| `lib/chat/timeline.ts` | `buildTimeline()` — turns, proposals and confirmations in one order (D5, D5a). |
| `app/(auth)/invite/[token]/page.tsx` | S0 / S1 / S2. One route, `?step=password` selects S2. |
| `app/(auth)/invite/[token]/SetPasswordForm.tsx` | Client. The match/length/checked gating of S2's button. |
| `app/api/invite/accept/route.ts` | S1 accept → `promise_accepted` → redirect to `?step=password`. |
| `app/api/invite/register/route.ts` | S2 submit → `registerFromInvite` → session cookie → `/<slug>`. |
| `app/(auth)/forgot/page.tsx` | S5. Static copy, one link back, `forgot_password_viewed`. |
| `app/[user]/Shell.tsx` | Client. S3 composition: chat surface + content area, one `open` boolean. |
| `app/[user]/PlaceholderCard.tsx` | Server. The verbatim placeholder copy. |
| `app/[user]/MockupDialog.tsx` | Client. shadcn `Dialog`, full-viewport, one close X. |
| `app/mockup/[version]/route.ts` | The friend's own mockup, session-authed, `text/html`. |
| `app/admin/[user]/AdminTabs.tsx` | Client. shadcn `Tabs` over three server-rendered panes. |
| `app/admin/mockup/[user]/[version]/route.ts` | Admin-scoped mockup serving, read-only. |
| `scripts/create-invite.ts`, `scripts/revoke-invite.ts` | The two operator CLIs. |
| `scripts/shots.ts` | The screenshot harness: seed, serve, capture, teardown. |
| `screenshots/screens.ts` | The screen list and its per-screen review assertions. |
| `tests/support/dom.tsx` | `mount()` / `click()` / `type()` over `react-dom/client` + React 19 `act`, plus the Radix jsdom shims. |
| `docs/superpowers/ledgers/onboarding.md` | *(already written)* |

**Modified**

| Path | Change |
|---|---|
| `platform/schema.sql` | `invites` and `account_keys` tables. No sacred table touched. |
| `platform/seed.ts` | Companion change for Gate A. |
| `app/layout.tsx` | Imports `globals.css`; carries the `device_class` cookie script; font, background, viewport. |
| `middleware.ts` | `/invite/*` and `/forgot` reachable without a cookie. |
| `lib/session/resolve.ts` | `PUBLIC` gains `/forgot`; invite paths public in every state; `RESERVED_SEGMENTS` gains `invite`, `forgot`, `mockup`. |
| `lib/auth/slug.ts` | `RESERVED_SLUGS` gains `invite`, `forgot`, `mockup`. |
| `lib/auth/flow.ts` | `databaseKeyFor()` — the envelope, with the legacy arm. |
| `app/api/login/route.ts`, `app/api/unlock/route.ts` | Same, plus the `login` metric. |
| `lib/db/encryptedUserDb.ts` | `createEmptyEncryptedUserDb`, `encryptedUserDbHasTables`, missing-`schema.sql` tolerance. |
| `app/[user]/page.tsx` | Real-vs-synthetic by table count; renders `Shell`; `first_session_start`; the merged timeline. |
| `app/[user]/ChatPanel.tsx` | Timeline rendering; `TOGGLE_KEY` deleted; card gains preview iframe, Details collapsible, full-screen control; shadcn throughout. |
| `app/(auth)/login/page.tsx`, `app/(auth)/unlock/page.tsx` | shadcn; shared promise constant; show-password toggle; forgot link; exact wrong-password copy. |
| `app/admin/page.tsx`, `app/admin/[user]/page.tsx` | User list with last-activity; three tabs; proposal cards inline; markdown spec. |
| `lib/db/appendOnly.ts` | `lastActivityAt()`, `hasMetric()`. |
| `lib/dashboard/registry.ts` | `hasDashboard(slug)`. |
| `.githooks/pre-commit`, `.claude/hooks/test-hooks.sh` | Gate-B arms for `components/ui/*` (exempt) and `components/*` (guarded). |
| `.gitignore` | `.screenshots/`, `test-results/`. |
| `docs/local-dev.md` | Minting, revoking, walking the flow, running the shots — as commands. |
| `CLAUDE.md`, `architecture-overview.md` | The living documents (Task 17, and Task 0 for the build-state section). |

---

## Task 0: Retire the build-order table

**Lands after Nico's approval of this plan and before Task 1, on its own commit.**

**Files:**
- Modify: `architecture-overview.md:170-193`

The table has been overtaken. It is not replaced with a shorter table or a remaining-steps list — those were the artefact of a pre-build plan and the pilot path is task-by-task now. What replaces it is a record of what exists, and one named future task.

- [ ] **Step 1: Replace the section**

Replace everything from `## Build order (each step ends with a verifiable checkpoint — Nico is user #0 throughout)` down to and including the `Note: after step 4 …` paragraph with:

```markdown
## Build state

The build-order table this section used to hold has been retired. It described
a plan; what follows describes the system, and the pilot path from here is
task-by-task rather than step-by-step.

**What exists**, each shipped behind a passed checkpoint, each with a ledger
under `docs/superpowers/ledgers/`:

| Ledger | What it left behind |
|---|---|
| `step1a.md` | Auth, sessions, the two-tier lock, the admin login, the test gates |
| `step1b.md` | `app.stairwell.run` on the droplet, Caddy, `deploy.sh`, `smoke.sh` |
| `step2.md` | The chat window, the agent, append-only transcripts, the admin transcript pane |
| `step3.md` | ntfy alerts on session start and on every confirmed spec |
| `step4.md` | Structured specs, the inline mockup, the confirm gate, `spec.md` + `mockup.html` |
| `step5.md` | Per-user dashboard hosting, and the `users/<slug>/` folder conventions |
| `step6a.md` | Per-user encrypted `<slug>.db`, the key derived at login, the first write path behind the lock |
| `unified-loop.md` | One proposal loop for a first interview and a one-word relabel alike: whole-surface versions, schema validation, a separate mockup call, structural diffs |

The metrics log has run since the first of those and the transcripts since the
second. Both are append-only, both are sacred (CLAUDE.md), and neither has ever
been migrated.

**In progress: the onboarding and invite flow.** Spec: `onboarding-ux-spec.md`.
Plan: `docs/superpowers/plans/2026-08-13-onboarding-and-invite-flow.md`.
Ledger: `docs/superpowers/ledgers/onboarding.md`. It is the first build aimed
at a person who is not Nico — an invite link, a first-login password that is
the encryption key, the privacy promise read before an account exists, and the
app shell every login lands in from then on. Its internals are written into
this document when that branch lands, not before.

**One named future task, carried here so it does not evaporate: an off-VPS
backup of the metrics log.** The log is append-only and sacred precisely
because the retention curve is the raise and cannot be regenerated — and it
currently exists on exactly one droplet. Nothing else in this document depends
on it; it is written down because a single copy of an irreplaceable file is
not a backup strategy, and the cost of discovering that is total.

**Code is disposable; conventions are cheap; data (metrics log + chat
transcripts) is sacred.**
```

- [ ] **Step 2: Commit**

```bash
git add architecture-overview.md
git commit -m "Retire the build-order table for a record of what exists

Docs are Gate-B exempt by path; no test gate applies."
```

---

## Task 1: A DOM for the panel, and the nine mutations that survive without one

**Why first:** the spec makes it a precondition — *"If shell work touches `ChatPanel`: the known mutation residual applies — install jsdom and kill the nine surviving call-site mutations **before** modifying."* Tasks 13, 14 and 15 all modify `ChatPanel`. Step-4 ledger residual 1 names the worst of the nine: `proposals={[]}` at the `ProposalRegion` call site disconnects the entire proposal card region and the full suite stays green.

**Files:**
- Create: `tests/support/dom.tsx`
- Test: `tests/chat/panelWiring.test.tsx`
- Modify: `package.json` (devDependency), `vitest.config.ts` (include `.test.tsx`)

**Interfaces:**
- Produces: `mount(element)` → `{ container, unmount }`; `click(el)`; `type(el, value)`; `flush()`; `installDomShims()`. All async except the last, all wrapping React 19's `act`.

- [ ] **Step 1: Install jsdom and let vitest see `.tsx` tests**

```bash
npm install --save-dev jsdom
```

`vitest.config.ts` — widen the three include globs from `*.test.ts` to `*.test.{ts,tsx}`. Leave `environment: 'node'` exactly as it is: jsdom is opted into per file (ledger D9), so the other ~790 tests keep their current speed.

- [ ] **Step 2: Write the harness**

```tsx
// tests/support/dom.tsx
//
// The smallest thing that can drive a React client component in jsdom.
//
// NOT @testing-library/react: the spec asked for jsdom and nothing else, and
// step-4 ledger residual 1 is the standing bar on new test dependencies
// (onboarding ledger D9). Everything below is react-dom/client plus React
// 19's own `act` — about sixty lines, no query DSL, no matchers to learn.
//
// Every export is async and awaited, because `act` flushes effects and state
// updates on its returned promise. A test that forgets the await sees the
// pre-update DOM and passes for the wrong reason.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * What jsdom does not implement and Radix expects.
 *
 * shadcn's Dialog, Tabs, Checkbox and Collapsible are Radix underneath
 * (onboarding ledger D1), and Radix reaches for browser APIs jsdom has never
 * had. Each stub below exists because its absence throws rather than degrades
 * — so they are installed once, here, rather than rediscovered one component
 * at a time. They are STUBS, not implementations: nothing in this suite
 * asserts on layout, which is what the Playwright review in Task 3 is for.
 */
export function installDomShims(): void {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
  }
  if (!globalThis.DOMRect) {
    globalThis.DOMRect = class {
      constructor(
        public x = 0, public y = 0, public width = 0, public height = 0,
      ) {}
      top = 0; right = 0; bottom = 0; left = 0
      toJSON(): object { return {} }
    } as unknown as typeof DOMRect
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
      addListener() {}, removeListener() {},
    })) as unknown as typeof window.matchMedia
  }
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
  // <dialog> is unimplemented in jsdom; Radix's Dialog does not use it, but
  // MockupDialog's tests assert on `open`, so give it the two methods.
  const dialog = HTMLDialogElement?.prototype as unknown as Record<string, unknown> | undefined
  if (dialog) {
    dialog.showModal ??= function (this: HTMLDialogElement) { this.open = true }
    dialog.close ??= function (this: HTMLDialogElement) { this.open = false }
  }
}

export type Mounted = { container: HTMLElement; unmount: () => Promise<void> }

export async function mount(element: React.ReactNode): Promise<Mounted> {
  installDomShims()
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root
  await act(async () => {
    root = createRoot(container)
    root.render(element)
  })
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

/** Click, then let every resulting state update and effect settle. */
export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click(): no element')
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Set a controlled input's value the way a user typing would. */
export async function type(el: Element | null | undefined, value: string): Promise<void> {
  if (!el) throw new Error('type(): no element')
  const node = el as HTMLInputElement | HTMLTextAreaElement
  const proto =
    node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  // React installs its own value setter on the instance; calling the
  // prototype's setter is what makes React's onChange see a real change.
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value)
  await act(async () => {
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Let pending promises and their state updates settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
```

**Radix renders its overlays into a portal on `document.body`**, not inside the mounted container — so any assertion about a dialog's contents queries `document.body`, never `container`. Say so in a comment where the first such test lands (Task 15).

- [ ] **Step 3: Write the failing wiring tests**

```tsx
// tests/chat/panelWiring.test.tsx
// @vitest-environment jsdom
//
// Step-4 ledger residual 1: "Nine call-site mutations survive the full suite,
// including proposals={[]} — which disconnects the entire proposal card
// region, so the product silently does nothing while the suite stays green."
//
// tests/chat/panel.test.ts drives the pure reducers directly and is excellent
// at it. What it cannot reach is the WIRING: which state each render prop is
// given, whether send() writes the body the route expects, whether onConfirm
// reaches attemptConfirm. That is this file's entire job, and every assertion
// below corresponds to one of the surviving mutations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { mount, click, type, flush } from '@/tests/support/dom'
import ChatPanel from '@/app/[user]/ChatPanel'

beforeEach(() => {
  vi.stubGlobal('React', React)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** An NDJSON body, as the route sends it. */
function ndjson(lines: unknown[]): Response {
  const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('')
  return new Response(new TextEncoder().encode(text), { status: 200 })
}

const SPEC = {
  kind: 'version' as const,
  version: {
    title: 'Morning',
    summary: 'Your morning surface.',
    change_summary: 'Added a streak panel.',
    background: '',
    based_on_version: null,
    open_questions: [],
    data_requirements: [],
    screens: [
      {
        id: 'home',
        title: 'Home',
        order: 1,
        panels: [
          { id: 'streak', title: 'Streak', display: 'Days in a row', intent: '', values: [] },
        ],
      },
    ],
  },
}

const PROPOSAL = { id: 7, version: 1, spec: SPEC, mockup_html: '<p>x</p>', first: true }

describe('ChatPanel wiring', () => {
  it('renders the proposal it was handed at page load — the proposals={[]} mutation', async () => {
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )
    expect(container.querySelector('[data-spec-id="7"]')).not.toBeNull()
    expect(container.textContent).toContain('Added a streak panel.')
    await unmount()
  })

  it('POSTs the typed message to /api/chat and streams the reply into the transcript', async () => {
    const fetchMock = vi.fn(async () => ndjson([{ t: 'hello ' }, { t: 'there' }, { done: true }]))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'what can you do?')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/chat')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      body: 'what can you do?',
    })
    expect(container.textContent).toContain('what can you do?')
    expect(container.textContent).toContain('hello there')
    await unmount()
  })

  it('a proposal arriving mid-stream renders as a card without a reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjson([{ t: 'ok' }, { authoring: true }, { proposal: PROPOSAL }, { done: true }]),
    ))
    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)
    await type(container.querySelector('textarea'), 'build it')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    expect(container.querySelector('[data-spec-id="7"]')).not.toBeNull()
    await unmount()
  })

  it('"Build this" POSTs the card\'s own spec id to /api/spec/confirm', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )
    const build = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Build this',
    )
    await click(build)
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/spec/confirm', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ specId: 7 }),
    }))
    expect(container.textContent).toContain('Building this one.')
    await unmount()
  })

  it('a failed confirm says so on the card rather than silently re-enabling', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })))
    const { container, unmount } = await mount(
      <ChatPanel initial={[]} proposal={{ ...PROPOSAL, confirmed: false }} first={true} />,
    )
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Build this'))
    await flush()
    expect(container.textContent).toContain("That didn't go through")
    await unmount()
  })

  it('the retry button re-sends ITS OWN message, not the newest one', async () => {
    // Two interrupted turns on screen; step-4's `source`-on-the-Turn fix. The
    // older button must re-send the older text.
    const fetchMock = vi.fn(async () => ndjson([{ t: 'partial' }])) // no {done:true}
    vi.stubGlobal('fetch', fetchMock)
    const { container, unmount } = await mount(<ChatPanel initial={[]} first={true} />)

    await type(container.querySelector('textarea'), 'first message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()
    await type(container.querySelector('textarea'), 'second message')
    await click(container.querySelector('button[type="submit"]'))
    await flush()

    fetchMock.mockClear()
    const retries = [...container.querySelectorAll('button')].filter(
      (b) => b.textContent === 'retry',
    )
    expect(retries).toHaveLength(2)
    await click(retries[0])
    await flush()

    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      body: 'first message',
    })
    await unmount()
  })
})
```

- [ ] **Step 4: Run and watch them pass — then prove each one is real**

```bash
npx vitest run tests/chat/panelWiring.test.tsx
```

Expected: 6 pass. These describe code that already exists and is correct, so a green first run is expected and is not evidence. **The evidence is the mutation drill in Step 5.**

- [ ] **Step 5: The red-test control — six mutations, six reds**

Apply each to `app/[user]/ChatPanel.tsx`, run the file, confirm the named test (and ideally only it) goes red, restore. Record the tally in the ledger.

| # | Mutation | Must redden |
|---|---|---|
| 1 | `proposals={[]}` at the `ProposalRegion` call site | "renders the proposal it was handed" + "arriving mid-stream" |
| 2 | `body: JSON.stringify({ text })` in `send()` | "POSTs the typed message" |
| 3 | Drop `setPanel((p) => applyLine(p, raw))` from the read loop | "POSTs the typed message" + "arriving mid-stream" |
| 4 | `onConfirm={() => {}}` on `ProposalRegion` | "Build this POSTs the card's own spec id" |
| 5 | Delete the `else { setPanel(… confirmError: true) }` branch | "a failed confirm says so" |
| 6 | `onRetry={() => void send(draft)}` on `TurnRow` | "the retry button re-sends ITS OWN message" |

If any mutation leaves the file green, the test for it is wrong — fix the test, not the tally.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts tests/support/dom.tsx tests/chat/panelWiring.test.tsx
git commit -m "Give the chat panel a DOM, and kill the mutations that lived without one

Step-4 residual 1: nine call-site mutations survived the whole suite,
proposals={[]} among them. Six drills, six reds, recorded in the ledger."
```

---

## Task 2: shadcn/ui, defaults barely touched

Read ledger D1 and D1a first. This is **literal shadcn**: the CLI writes the components, and exactly two tokens are edited.

**Files:**
- Create: `components.json`, `app/globals.css`, `postcss.config.mjs`, `lib/utils.ts`, `components/ui/*.tsx`, `lib/ui/PasswordField.tsx`
- Modify: `app/layout.tsx`, `package.json`, `.githooks/pre-commit`, `.claude/hooks/test-hooks.sh`, `.gitignore`
- Test: `tests/ui/primitives.test.tsx`

- [ ] **Step 1: Init**

```bash
npx shadcn@latest init --yes --defaults --base-color slate
npx shadcn@latest add button input label card checkbox dialog tabs collapsible alert
```

If the CLI cannot resolve the project (it inspects `tsconfig.json` paths, `app/`, and the Tailwind setup), fix the project rather than hand-writing the components — hand-writing is the thing D1 overturned. `components.json` should land with `"rsc": true`, `"tsx": true`, `"tailwind": {"baseColor": "slate", "cssVariables": true}`, and the default aliases (`@/components`, `@/lib/utils`).

Verify what it installed: `@radix-ui/react-dialog`, `-tabs`, `-checkbox`, `-label`, `-collapsible`, `-slot`, plus `clsx`, `tailwind-merge`, `class-variance-authority`, `lucide-react`, `tailwindcss`, `@tailwindcss/postcss`, `postcss`. **Anything outside ledger D1's table is a surprise — stop and check it rather than accepting it.**

- [ ] **Step 2: The two token edits, and only those**

In the `app/globals.css` the CLI wrote:

```css
/* onboarding-ux-spec.md > Design direction, and onboarding ledger D1a.
 *
 * shadcn's own token block, kept as written, with exactly two edits:
 *
 *  1. THE .dark BLOCK IS DELETED and color-scheme pinned to light. "Light
 *     mode only. No dark mode, no theme toggle." Leaving it in would make the
 *     whole product follow the reader's OS setting — a design decision nobody
 *     made, on a product whose first impression is the point.
 *  2. --primary IS STOCK TAILWIND BLUE. The slate base colour gives a
 *     near-black primary; the spec rules "Neutral palette + one accent: blue
 *     … everything else stays gray-scale". Destructive contexts (S2's warning
 *     block, S5) keep shadcn's own destructive treatment and never take the
 *     accent.
 *
 * A THIRD edit is a design decision and belongs to the taste memo, not here.
 */
:root {
  color-scheme: light;
  /* … the CLI's tokens, untouched … */
  --primary: oklch(0.546 0.215 262.881);        /* tailwind blue-600 */
  --primary-foreground: oklch(0.985 0 0);
}
```

Set the font in the same file's `@theme` block to `Inter, ui-sans-serif, system-ui, …`. **No webfont is fetched** — a font request is a third-party request on a page that makes a privacy promise; Inter is used if the reader has it and system-ui otherwise.

- [ ] **Step 3: `app/layout.tsx`**

```tsx
import './globals.css'

export const metadata = { title: 'Stairwell' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className="min-h-dvh bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  )
}
```

(The `device_class` script lands here in Task 4.)

- [ ] **Step 4: `lib/ui/PasswordField.tsx`**

```tsx
'use client'

import { useId, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

/**
 * A password input with a show-password toggle.
 *
 * The toggle is not a nicety: onboarding-ux-spec.md §"Why this flow is shaped
 * the way it is" makes it one of two anti-typo measures on the single most
 * consequential screen in the product, and S4 and S5 both point at it by name
 * ("try again slowly with the show-password toggle on").
 *
 * The toggle swaps `type` and nothing else: same input, same name, same value,
 * so a half-typed password survives it. Composed from shadcn primitives rather
 * than being one — it is ours, and it lives in lib/ui/ so that components/ui/
 * stays exactly what the CLI wrote (onboarding ledger D1).
 */
export function PasswordField({
  name, label, hint, autoComplete, error,
}: {
  name: string
  label: string
  hint?: string
  autoComplete: 'new-password' | 'current-password'
  error?: string
}) {
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          required
          className="pr-16"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
          className="absolute inset-y-0 right-0 h-full px-3 text-xs"
        >
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </div>
  )
}
```

- [ ] **Step 5: Teach the commit gate about `components/`**

`.githooks/pre-commit`, in `_gate_b_class`, beside the `platform/prompts/*.md` arm:

```sh
  # Vendored shadcn/ui source. Third-party code that happens to live in this
  # repo, exactly like platform/prompts/*.md above: written by
  # `npx shadcn@latest add`, never hand-edited, and a test over it would pin
  # somebody else's implementation. Anything ELSE under components/ is ours
  # and stays guarded by the arm further down.
  case "$p" in
    components/ui/*) echo "exempt"; return ;;
  esac
```

and in the guarded-scopes block, `components/*` → `guard:platform`. Add two cases to `.claude/hooks/test-hooks.sh` covering both arms — this is a `.githooks/` change, so Gate B requires exactly that file.

`.gitignore` gains `.screenshots/` and `test-results/` (Task 3 uses both).

- [ ] **Step 6: Write the tests**

```tsx
// tests/ui/primitives.test.tsx
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import * as React from 'react'
import { mount, click } from '@/tests/support/dom'
import { cn } from '@/lib/utils'
import { PasswordField } from '@/lib/ui/PasswordField'

beforeEach(() => vi.stubGlobal('React', React))
afterEach(() => vi.unstubAllGlobals())

describe('cn', () => {
  it('lets a caller class win over the component default', () => {
    // The reason tailwind-merge is in the tree: without it both classes ship
    // and the cascade, not the caller, decides.
    expect(cn('px-4 py-2', 'px-6')).toBe('py-2 px-6')
  })
})

describe('PasswordField', () => {
  it('starts masked, reveals on toggle, and keeps the same input', async () => {
    const { container, unmount } = await mount(
      <PasswordField name="password" label="Password" autoComplete="new-password" />,
    )
    const input = container.querySelector('input')!
    expect(input.type).toBe('password')
    input.value = 'half typed'

    await click(container.querySelector('button[type="button"]'))

    expect(container.querySelector('input')!.type).toBe('text')
    expect(container.querySelector('input')!.value).toBe('half typed')
    expect(container.querySelectorAll('input')).toHaveLength(1)
    await unmount()
  })

  it('renders an inline error where a form can put one', async () => {
    const { container, unmount } = await mount(
      <PasswordField
        name="confirm" label="Confirm" autoComplete="new-password"
        error="Passwords don’t match."
      />,
    )
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      'Passwords don’t match.',
    )
    await unmount()
  })
})
```

Add one more, which is the point of installing Radix at all:

```tsx
it('a shadcn Dialog opens and closes in jsdom, portalled to body', async () => {
  // Proves the D1 shims are sufficient BEFORE Task 15 depends on them, and
  // documents where Radix puts its content: on document.body, not inside the
  // mounted container.
  const { container, unmount } = await mount(
    <Dialog>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent><DialogTitle>Preview</DialogTitle></DialogContent>
    </Dialog>,
  )
  expect(document.body.textContent).not.toContain('Preview')
  await click(container.querySelector('button'))
  expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  await unmount()
})
```

- [ ] **Step 7: Run everything, including the build**

```bash
npx vitest run tests/ui/primitives.test.tsx
.claude/hooks/test-hooks.sh
npx tsc --noEmit
npx next build
```

Expected: tests pass; hooks 100%; `tsc` clean; **the build succeeds and emits CSS**. Gate D is the only layer that proves the PostCSS wiring works (CLAUDE.md > Testing: "tsc clean does not mean the build succeeds"). If `next build` fails here, fix it here — every later task assumes this works.

- [ ] **Step 8: Red-test controls**

1. Delete the `twMerge(...)` wrapper in `lib/utils.ts` → the `cn` test goes red, alone.
2. Hardcode `type="password"` in `PasswordField` → exactly the reveal test goes red.
3. Remove `ResizeObserver` from `installDomShims` → the Dialog test goes red (proving the shim is load-bearing rather than superstition).
4. Stage a file at `components/thing.tsx` with no test → the pre-commit gate blocks; stage `components/ui/thing.tsx` → it does not.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json components.json postcss.config.mjs app/globals.css app/layout.tsx lib/utils.ts lib/ui components .githooks/pre-commit .claude/hooks/test-hooks.sh .gitignore tests/ui
git commit -m "Install shadcn/ui and touch two tokens: no dark mode, one blue accent"
```

---

## Task 3: Screenshots, and a review that blocks the commit

Read ledger D16. This is a review gate, not a test: no pixel diffing, no golden images. It exists because nothing else in this repo can see a layout, and because the styling layer arrived one task ago in a codebase that had never rendered a pixel.

**Files:**
- Create: `scripts/shots.ts`, `screenshots/screens.ts`
- Modify: `package.json` (devDependency + script)
- Test: `tests/scripts/shots.test.ts`

**Interfaces:**
- Produces: `npm run shots -- --task=<n> [--only=<id>]`, writing `.screenshots/task-<n>/<id>-<width>.png`; `SCREENS: Screen[]` where `Screen = { id, path, width: 375|1440, viewportHeight, setup, assertions: string[] }`.

- [ ] **Step 1: Install**

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

`npx playwright install` downloads a browser. If it fails (offline, sandbox), **stop and say so** rather than proceeding — the review gate is the thing that catches what the rest of the plan structurally cannot, and a silently-skipped gate is worse than a missing one.

- [ ] **Step 2: The screen list, with its assertions**

```ts
// screenshots/screens.ts
//
// Every screen this branch ships, at the two widths onboarding-ux-spec.md
// names, with what each one has to look like.
//
// The assertions are PROSE, deliberately. They are read by a person (or by
// Claude, reading the PNG) against the shot, before the task that touched that
// screen is committed — onboarding ledger D16. There is no pixel diff here and
// there should not be: a visual-regression suite in a codebase with no
// baseline fails on every commit for a month and then gets switched off.
//
// `state` names the fixture the harness seeds before navigating (see
// scripts/shots.ts). Adding a screen means adding its state too.

export type ScreenId =
  | 's0-dead-link' | 's1-the-deal' | 's2-set-password'
  | 's3-shell-placeholder' | 's3-shell-dashboard' | 's3-shell-chat-collapsed'
  | 's4-login' | 's4-login-error' | 's5-forgot'
  | 'unlock' | 'card-proposal' | 'card-fullscreen'
  | 'admin-index' | 'admin-transcript' | 'admin-spec' | 'admin-mockup'

export const WIDTHS = [375, 1440] as const

export type Screen = {
  id: ScreenId
  /** The path to visit, after `state` has been seeded and any login done. */
  path: string
  state: 'anonymous' | 'invite-valid' | 'invite-used' | 'friend-new' | 'friend-built' | 'admin'
  /** Extra clicks before the shot, e.g. opening the full-screen dialog. */
  act?: 'open-fullscreen' | 'collapse-chat' | 'tab-spec' | 'tab-mockup'
  assertions: string[]
}

export const SCREENS: Screen[] = [
  {
    id: 's1-the-deal',
    path: '/invite/TOKEN',
    state: 'invite-valid',
    assertions: [
      'One centred card, not bare text floating in an empty viewport (Viewport rules).',
      'At 1440 the card is capped near 420px wide and centred; at 375 it fills the width with page padding.',
      'The greeting reads in Nico’s first-person voice, above the promise block.',
      'All three promise paragraphs are present and legible; none is truncated or clipped.',
      'Exactly one button, reading "Sounds good →". No checkbox anywhere.',
      'No password field — this screen creates nothing.',
    ],
  },
  {
    id: 's2-set-password',
    path: '/invite/TOKEN?step=password',
    state: 'invite-valid',
    assertions: [
      'The heading reads "Pick your password".',
      'The warning block is visually distinct — bordered and tinted, amber/destructive, NOT the blue accent. It reads as a warning at a glance, before any word is read.',
      'The warning has the screen to itself above the fields; nothing competes with it.',
      'Two password fields, each with its own Show control, plus the 10+ character hint under the first.',
      'One unchecked checkbox with the no-reset acknowledgement.',
      'The "Create my account" button is visibly DISABLED in the empty state.',
      'At 375 nothing overflows horizontally and the warning is fully readable without scrolling sideways.',
    ],
  },
  {
    id: 's0-dead-link',
    path: '/invite/TOKEN',
    state: 'invite-used',
    assertions: [
      'One line, one card. No form, no branding effort, no error styling that looks like a crash.',
      'It says to text Nico. It does NOT say whether the link was used or unknown.',
    ],
  },
  {
    id: 's3-shell-placeholder',
    path: '/SLUG',
    state: 'friend-new',
    assertions: [
      'At 1440: chat is a fixed ~400px LEFT panel with a visible divider; the content area fills the remainder and holds the placeholder card.',
      'At 375: the chat covers the screen as a sheet (it is open by default here — no dashboard is deployed) with a way back to the content.',
      'The placeholder card reads "This is where your app will live." and mentions no time of day.',
      'The chat composer is reachable without scrolling at both widths.',
    ],
  },
  {
    id: 's3-shell-dashboard',
    path: '/SLUG',
    state: 'friend-built',
    assertions: [
      'Chat is COLLAPSED by default here, because a dashboard is deployed — a toggle is visible and the dashboard is the landing view.',
      'The dashboard renders inside the shell, unstyled-by-us and unbroken by it: the shell is platform chrome, not part of the user’s code.',
      'The SYNTHETIC DATA banner is present (this fixture has no real rows) and is not mistakable for chrome.',
    ],
  },
  {
    id: 's3-shell-chat-collapsed',
    path: '/SLUG',
    state: 'friend-new',
    act: 'collapse-chat',
    assertions: [
      'At 1440 the content area REFLOWS to fill the width the panel had; it does not leave a 400px hole.',
      'At 375 the sheet is gone entirely and a persistent toggle remains visible.',
    ],
  },
  {
    id: 's4-login',
    path: '/login',
    state: 'anonymous',
    assertions: [
      'Username, password with a Show control, one primary button.',
      'The promise block is present below the form — the same three paragraphs as S1, verbatim.',
      '"Forgot your password?" is present and unemphatic; it is not styled like a primary action.',
    ],
  },
  {
    id: 's4-login-error',
    path: '/login?error=1',
    state: 'anonymous',
    assertions: [
      'The error reads exactly: "That password doesn’t unlock your data. Check for typos — caps lock, autocorrect."',
      'Nothing on screen offers, implies, or links to a reset.',
    ],
  },
  {
    id: 's5-forgot',
    path: '/forgot',
    state: 'anonymous',
    assertions: [
      'The heading reads "There’s no reset. That’s on purpose."',
      'No form, no input, no email field anywhere on the page.',
      'One control: back to login.',
      'The tone reads as honest rather than as an error state.',
    ],
  },
  {
    id: 'unlock',
    path: '/unlock',
    state: 'friend-built',
    assertions: [
      'Matches the other auth screens — same card, same rhythm. It is not the one screen that looks like it came from a different build.',
      'Both escapes are present: the forgot link and the sign-out form.',
    ],
  },
  {
    id: 'card-proposal',
    path: '/SLUG',
    state: 'friend-new',
    assertions: [
      'Card anatomy, top to bottom: version label, title, one-line description, then the scaled mockup preview, then a COLLAPSED "Details", then the confirm control.',
      'The mockup preview renders actual content — not a blank white box, which is what a broken /mockup route looks like.',
      'The delivery line is present under the buttons.',
      'At 375 the preview scales to the column instead of overflowing it.',
    ],
  },
  {
    id: 'card-fullscreen',
    path: '/SLUG',
    state: 'friend-new',
    act: 'open-fullscreen',
    assertions: [
      'The dialog fills the viewport at both widths, with one close X top-right and nothing else.',
      'The page behind is dimmed and inert; there is no second overlay and no nesting.',
      'The mockup inside is the same document as the card preview, at full width.',
    ],
  },
  {
    id: 'admin-index',
    path: '/admin',
    state: 'admin',
    assertions: [
      'A user list with a last-activity timestamp per row, newest first.',
      'An account that has done nothing says so, rather than showing a 1970 date.',
    ],
  },
  {
    id: 'admin-transcript',
    path: '/admin/SLUG',
    state: 'admin',
    assertions: [
      'Reading measure is roughly 680px at 1440 — not the full window width.',
      'User and agent turns are clearly distinguishable at a glance.',
      'A proposal card appears INLINE in conversation order, not collected at the end.',
      'A confirmation appears as an event at the point it happened.',
      'The newest turn is at the bottom and the pane is scrolled to it.',
    ],
  },
  {
    id: 'admin-spec',
    path: '/admin/SLUG',
    state: 'admin',
    act: 'tab-spec',
    assertions: [
      'The spec renders as real markdown — headings are headings, lists are lists. Not a wall of preformatted text.',
      'A version label and a confirmation timestamp sit at the top.',
    ],
  },
  {
    id: 'admin-mockup',
    path: '/admin/SLUG',
    state: 'admin',
    act: 'tab-mockup',
    assertions: [
      'The mockup renders in an iframe with a full-screen control — the same affordance the friend gets.',
    ],
  },
]
```

- [ ] **Step 3: The harness**

`scripts/shots.ts`:

```ts
/**
 * Headless screenshots of every screen, at both widths, for review before a
 * commit (onboarding ledger D16).
 *
 *   npm run shots -- --task=9              # every screen
 *   npm run shots -- --task=9 --only=s2-set-password
 *
 * SYNTHETIC ONLY, and structurally so: this builds its own platform database
 * in a temp directory, points USERS_DIR at a temp tree, and never reads
 * anything under the repo's own users/ or platform/dev/. CLAUDE.md > Data
 * safety — a screenshot is a file on disk that outlives the run, so a harness
 * that could point at real data would be the worst possible place to be
 * careless. The fixtures are loudly fake for the same reason the seeds are.
 *
 * It also never sets ANTHROPIC_API_KEY: no screen here needs a model call, and
 * a harness that could bill is a harness that will.
 */
```

Shape:

1. `mkdtemp` a root; `PLATFORM_DB=<tmp>/platform.db`, `USERS_DIR=<tmp>/users`.
2. Seed the six fixture states through the **real** library functions — `createAccount`, `mintInvite`, `registerFromInvite`, `insertSpec`, `confirmSpec`, `appendTranscript` — never raw SQL. A fixture built by hand-written INSERTs drifts from what the app writes, and then the shots show a screen no user will ever see.
3. `next build` once (reusing `.next` if fresh), then `next start -p 3987` with those env vars; poll `/login` for a 200 the way `deploy/smoke.sh` does, for the same reason.
4. For each screen × each width: new context at that viewport, log in if the state needs it, navigate, run `act` if present, `page.screenshot({ fullPage: true })` to `.screenshots/task-<n>/<id>-<width>.png`.
5. Print a review checklist to stdout: for each shot, its path followed by its assertions.
6. Kill the server, remove the temp root. **The shots are kept** — they are the artifacts.

Wire `"shots": "tsx scripts/shots.ts"` into `package.json`.

- [ ] **Step 4: Test the harness**

```ts
// tests/scripts/shots.test.ts
//
//  1. SCREENS has an entry for every ScreenId, and every entry has at least
//     two assertions — a screen listed with nothing to check is a screen
//     nobody is really reviewing
//  2. every `path` is a real route in app/ (resolve the file, allowing the
//     TOKEN and SLUG placeholders)
//  3. the harness refuses to run when PLATFORM_DB points anywhere inside the
//     repo — the data-safety guard, asserted rather than trusted
//  4. WIDTHS is exactly [375, 1440]
//
// Deliberately NOT tested: that Chromium launches. That is what running it
// does, and mocking a browser to assert we called it proves nothing.
```

- [ ] **Step 5: First run — the baseline**

```bash
npm run shots -- --task=3 --only=s4-login
npm run shots -- --task=3 --only=unlock
```

Only `/login` and `/unlock` exist yet. **Open both PNGs and check them against their assertions.** This is the first time anyone has looked at this product; expect to find something. Fix what the assertions say is wrong, re-shoot, and only then commit.

- [ ] **Step 6: Run the suite and the build**

```bash
npx vitest run tests/scripts/shots.test.ts
npx next build
```

- [ ] **Step 7: Red-test control**

Delete an entry from `SCREENS` → assertion 1 goes red. Point a screen's `path` at `/nope` → assertion 2 goes red. Set `PLATFORM_DB` inside the repo and run the harness → it must refuse, loudly.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json scripts/shots.ts screenshots tests/scripts/shots.test.ts
git commit -m "Look at the screens, at both widths, before saying they are done"
```

**From here on, every task that touches a screen carries this step, and it blocks the commit:**

> **Capture and review.** `npm run shots -- --task=<n>`. Open each PNG for the screens this task touched, at both widths, and check it against its assertions in `screenshots/screens.ts`. A failed assertion is fixed in this task, not filed. Note in the commit message which screens were reviewed.

---

## Task 4: `device_class`, on every row this flow writes

Read ledger D4: this is a **field inside `metrics.data`**, never a column. `metrics` is sacred.

**Files:**
- Create: `lib/metrics/deviceClass.ts`
- Modify: `app/layout.tsx`, `app/[user]/page.tsx`, `app/api/users/[user]/walk/route.ts`
- Test: `tests/metrics/deviceClass.test.ts`

**Interfaces:**
- Produces: `DEVICE_CLASS_COOKIE = 'stairwell_dc'`; `type DeviceClass = 'phone' | 'tablet' | 'desktop'`; `deviceClassFrom({ cookie, userAgent })`; `readDeviceClass(): Promise<DeviceClass>`.
- Consumed by: every `appendMetric` call site added in Tasks 9–13, and the three existing ones listed above.

- [ ] **Step 1: Write the failing test**

```ts
// tests/metrics/deviceClass.test.ts
import { describe, expect, it } from 'vitest'
import { deviceClassFrom } from '@/lib/metrics/deviceClass'

describe('deviceClassFrom', () => {
  it('trusts the cookie, which is the only source that knows the viewport', () => {
    expect(deviceClassFrom({ cookie: 'phone', userAgent: 'Mozilla/5.0 (Macintosh)' }))
      .toBe('phone')
  })

  it('ignores a cookie value that is not one of the three', () => {
    // The cookie is client-set, so it is untrusted input. An unknown value
    // must not reach metrics: the point of an enum is that grouping by it
    // works forever.
    expect(deviceClassFrom({ cookie: 'laptop', userAgent: 'Mozilla/5.0 (Macintosh)' }))
      .toBe('desktop')
  })

  it('falls back to the UA on the first request, before any script has run', () => {
    expect(deviceClassFrom({ cookie: undefined, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })).toBe('phone')
    expect(deviceClassFrom({ cookie: undefined, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' })).toBe('tablet')
    expect(deviceClassFrom({ cookie: undefined, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe('phone')
    expect(deviceClassFrom({ cookie: undefined, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' })).toBe('desktop')
  })

  it('defaults to desktop when it knows nothing at all', () => {
    expect(deviceClassFrom({ cookie: undefined, userAgent: undefined })).toBe('desktop')
  })
})
```

- [ ] **Step 2: Run it, watch it fail** — expected `Cannot find module '@/lib/metrics/deviceClass'`.

- [ ] **Step 3: Implement**

```ts
// lib/metrics/deviceClass.ts
import { cookies, headers } from 'next/headers'

/**
 * Which kind of screen a metrics row came from.
 *
 * onboarding-ux-spec.md: "the phone-vs-desktop usage split cannot be
 * reconstructed retroactively any more than the retention curve can", so this
 * exists from user #1. It is a FIELD INSIDE metrics.data, never a column —
 * metrics is append-only and outside lib/db/reshape.ts, and CLAUDE.md forbids
 * widening that exception (onboarding ledger D4).
 *
 * It carries a three-value enum and nothing else, so the permanent policy
 * ("metrics never carry user values") is untouched.
 */
export type DeviceClass = 'phone' | 'tablet' | 'desktop'

const CLASSES = new Set<string>(['phone', 'tablet', 'desktop'])

export const DEVICE_CLASS_COOKIE = 'stairwell_dc'
export const TABLET_MIN_PX = 768
export const DESKTOP_MIN_PX = 1024

/**
 * The cookie wins because it is the only source that has seen a viewport; the
 * User-Agent is the fallback for the first request of a session, before any
 * script has run. Both are untrusted, so an unrecognised cookie is discarded
 * rather than written through — a metrics enum is only useful if every row in
 * it is one of the values.
 */
export function deviceClassFrom(input: {
  cookie: string | undefined
  userAgent: string | undefined
}): DeviceClass {
  if (input.cookie && CLASSES.has(input.cookie)) return input.cookie as DeviceClass
  const ua = input.userAgent ?? ''
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) return 'tablet'
  if (/iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone/i.test(ua)) return 'phone'
  return 'desktop'
}

/** The request-scoped read. Server components and route handlers only. */
export async function readDeviceClass(): Promise<DeviceClass> {
  const cookie = (await cookies()).get(DEVICE_CLASS_COOKIE)?.value
  const userAgent = (await headers()).get('user-agent') ?? undefined
  return deviceClassFrom({ cookie, userAgent })
}
```

- [ ] **Step 4: The client half — four lines in the root layout**

Into `app/layout.tsx`'s `<head>`:

```tsx
{/*
  The only script tag in this app. It writes a three-value enum into a cookie
  so server-side metrics emitters know what kind of screen a row came from
  (onboarding ledger D4). No user data, no analytics vendor, no network call.
  Inline and synchronous so the cookie exists before the first metric of the
  session is written; SameSite=Lax and a one-year Max-Age so it survives the
  redirect chain that a login is.
*/}
<script
  dangerouslySetInnerHTML={{
    __html:
      "var w=window.innerWidth,c=w<768?'phone':w<1024?'tablet':'desktop';" +
      "document.cookie='stairwell_dc='+c+';path=/;max-age=31536000;samesite=lax';",
  }}
/>
```

- [ ] **Step 5: Thread it through the three existing call sites**

`dashboard_open`, both `dashboard_error` sites, and `dashboard_write` gain `device_class`. Resolve once per request and spread into `data`. Do **not** touch `chat_turn`, `spec_*`, or `alert_sent`: the spec asks for this flow's events plus dashboard opens, and widening an append-only series further than asked is not free.

- [ ] **Step 6: Extend the existing metrics tests** — in `tests/routing/dashboardRegion.test.ts` and `tests/routing/walkRoute.test.ts`, assert the emitted row's parsed `data.device_class` is `'desktop'` (the no-cookie, no-UA default under the mocked `next/headers`).

- [ ] **Step 7: Run, then the red-test control**

```bash
npx vitest run tests/metrics tests/routing
```

Control: make `deviceClassFrom` trust any cookie string → "ignores a cookie value that is not one of the three" goes red, alone. Remove `device_class` from `dashboard_open` → exactly the dashboardRegion assertion goes red.

- [ ] **Step 8: Commit**

```bash
git add lib/metrics app/layout.tsx "app/[user]/page.tsx" "app/api/users/[user]/walk/route.ts" tests/metrics tests/routing
git commit -m "Record which kind of screen a row came from, in the blob and never in a column"
```

---

## Task 5: The three copy blocks, as constants

**Files:**
- Create: `lib/copy/onboarding.ts`
- Modify: `app/(auth)/login/page.tsx`, `tests/routing/loginPage.test.ts`
- Test: `tests/copy/onboarding.test.ts`

**Interfaces:**
- Produces: `PROMISE_BLOCK`, `PASSWORD_WARNING`, `PLACEHOLDER_CARD`, `GREETING`, `ACCEPT_BUTTON`, `DEAD_LINK`, `PASSWORD_MIN_LENGTH = 10`, `PASSWORD_HINT`, `NO_RESET_ACK`, `PASSWORD_ERRORS`, `WRONG_PASSWORD`, `FORGOT`.
- Consumed by: Tasks 9, 10, 11, 12, 13.

- [ ] **Step 1: Write the constants, verbatim from the spec**

```ts
// lib/copy/onboarding.ts
//
// BUILD CONTRACTS. onboarding-ux-spec.md > Explicit constraints for Claude
// Code: "The three copy blocks (promise, password warning, placeholder card)
// are build contracts — shipped verbatim, stored as shared constants."
//
// Shared, not duplicated, because the promise block appears on TWO surfaces
// (S1, before an account exists, and S4, "written down where they can see
// it") and two copies of a promise are two things that can drift apart. Every
// sentence here is pinned by a test, the way today's login promise already is
// — if one stops being true, a red test and a conversation is the right
// outcome, not a silent diff.
//
// Apostrophes are U+2019 throughout, not '. Deliberate: it renders correctly
// in JSX without &apos; escaping, and it removes a whole class of vacuous
// not.toContain test (unified-loop ledger: "a not.toContain that was vacuously
// true because renderToStaticMarkup escapes the apostrophe in 'it'll'").

export const PROMISE_BLOCK = {
  heading: 'The deal, honestly:',
  paragraphs: [
    'My build tools only ever run on fake data. What I will see: everything you tell the AI, everything you ask it for — that’s how your app gets built — and when you open the app, because whether you actually keep using it is the whole experiment.',
    'What I won’t see: your actual data. It’s encrypted with a password only you know — there’s no way for me or anyone else to ever access it.',
    'When the pilot ends, everything is deleted.',
  ],
} as const

export const PASSWORD_WARNING = {
  heading: 'Read this one properly.',
  body: 'Your data gets locked with this password. There’s no reset — that’s what keeps your data completely secure and completely yours. If you forget it, everything you’ve logged is permanently gone and we start over from nothing.',
} as const

export const PLACEHOLDER_CARD = {
  heading: 'This is where your app will live.',
  body: 'Talk to the chat — what it learns is what gets built. You’ll hear from the chat when your app is live.',
} as const

export const GREETING = 'Hey — you’re in.'
export const ACCEPT_BUTTON = 'Sounds good →'

export const DEAD_LINK =
  'This link isn’t valid anymore. Text Nico and he’ll sort it out.'

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_HINT = '10+ characters. A short sentence works great.'
export const NO_RESET_ACK =
  'I understand there’s no reset — forgotten password means my data is gone.'

export const PASSWORD_ERRORS = {
  mismatch: 'Passwords don’t match.',
  tooShort: 'Needs at least 10 characters.',
  server: 'Something broke on my end — try once more, then text Nico.',
} as const

export const WRONG_PASSWORD =
  'That password doesn’t unlock your data. Check for typos — caps lock, autocorrect.'

export const FORGOT = {
  heading: 'There’s no reset. That’s on purpose.',
  paragraphs: [
    'Your data is encrypted with your password and I never have a copy — that’s what keeps me (and everyone else) out of it. The flip side is that nobody can recover it, including me.',
    'Before giving up: typos, caps lock, and phone autocorrect cause most of these. Try again slowly with the show-password toggle on.',
    'If it’s really gone: text Nico. Your old data gets deleted and you start fresh — same app idea, empty history.',
  ],
  back: '← Back to login',
} as const
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/copy/onboarding.test.ts
import { describe, expect, it } from 'vitest'
import {
  PROMISE_BLOCK, PASSWORD_WARNING, PLACEHOLDER_CARD, FORGOT, WRONG_PASSWORD,
} from '@/lib/copy/onboarding'

/**
 * These are the sentences the spec says ship verbatim. A test that compared a
 * constant to itself would prove nothing, so each expectation below is the
 * spec's own text, typed out once, here.
 */
describe('the promise block', () => {
  it('says my build tools only run on fake data', () => {
    expect(PROMISE_BLOCK.paragraphs[0]).toContain('My build tools only ever run on fake data.')
  })
  it('discloses that engagement is visible and content is not', () => {
    expect(PROMISE_BLOCK.paragraphs[0]).toContain(
      'when you open the app, because whether you actually keep using it is the whole experiment',
    )
    expect(PROMISE_BLOCK.paragraphs[1]).toContain('What I won’t see: your actual data.')
  })
  it('promises deletion at the end of the pilot', () => {
    expect(PROMISE_BLOCK.paragraphs[2]).toBe('When the pilot ends, everything is deleted.')
  })
})

describe('the password warning', () => {
  it('says there is no reset, and what that costs', () => {
    expect(PASSWORD_WARNING.body).toContain('There’s no reset')
    expect(PASSWORD_WARNING.body).toContain(
      'everything you’ve logged is permanently gone and we start over from nothing',
    )
  })
  it('never implies recovery is possible', () => {
    for (const text of [PASSWORD_WARNING.body, WRONG_PASSWORD, ...FORGOT.paragraphs]) {
      expect(text.toLowerCase()).not.toMatch(
        /reset your password|recover your (data|password)|reset link/,
      )
    }
  })
})

describe('the placeholder card', () => {
  it('promises the chat, not a time of day', () => {
    expect(PLACEHOLDER_CARD.body).toContain('You’ll hear from the chat when your app is live.')
    expect(PLACEHOLDER_CARD.body.toLowerCase()).not.toMatch(
      /tomorrow|morning|hours|tonight|overnight/,
    )
  })
})
```

That last assertion is the spec's rule made mechanical: *"No time promises on the card. Any delivery-time wording anywhere in UI chrome must read from the same two constants as the agent's delivery line — never hardcode a time of day."*

- [ ] **Step 3: Run — fail, then implement, then pass.**

- [ ] **Step 4: Point the login page at the constant**

Replace the three hardcoded `<p>` elements in `app/(auth)/login/page.tsx` with a map over `PROMISE_BLOCK.paragraphs` plus the heading. **The wording changes** — the spec says so explicitly: *"This wording supersedes the version in `architecture-overview.md`."* So `tests/routing/loginPage.test.ts`'s `PROMISED` array is rewritten to the new sentences in this same commit, and its docstring gains a line naming which spec superseded which.

Keep the file's existing comment block explaining *why* the promise is pinned — it is still true and it is the only place that explains the test to whoever breaks it.

- [ ] **Step 5: Run** — `npx vitest run tests/routing/loginPage.test.ts tests/copy`

- [ ] **Step 6: Red-test control**

Soften `PASSWORD_WARNING.body` to "There's no reset, but text Nico and he can help" → the "never implies recovery" test goes red. Add "by tomorrow morning" to `PLACEHOLDER_CARD.body` → the placeholder test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add lib/copy tests/copy "app/(auth)/login/page.tsx" tests/routing/loginPage.test.ts
git commit -m "Store the three promises once, and pin every sentence of them"
```

---

## Task 6: The password stops being the database key

Read ledger D2. New accounts get a wrapped data key in `account_keys`; **existing accounts have no row and keep deriving the key directly, forever** — `devtwo`'s real database on the droplet depends on this.

**Files:**
- Create: `lib/auth/envelope.ts`, `lib/db/accountKeys.ts`
- Modify: `platform/schema.sql`, `platform/seed.ts`, `lib/auth/flow.ts`, `app/api/login/route.ts`
- Test: `tests/auth/envelope.test.ts`, `tests/db/accountKeys.test.ts`, `tests/auth/routes.test.ts` (extend)

**Interfaces:**
- Produces: `newDataKey(): Buffer`; `wrapDataKey(kek, dataKey): Buffer`; `unwrapDataKey(kek, wrapped): Buffer`; `WrappedKeyError`; `putWrappedKey(db, accountId, wrapped, at)`; `readWrappedKey(db, accountId): Buffer | undefined`; `databaseKeyFor(db, account, password): Promise<Buffer>`.

- [ ] **Step 1: Schema**

```sql
-- Envelope encryption (onboarding ledger D2). The user's password derives a
-- key-encrypting key; the key that actually opens their SQLCipher database is
-- 32 random bytes, wrapped under it and stored here.
--
-- A TABLE rather than a column on `accounts`, and the difference is the whole
-- design: `accounts` already has rows in production, this repo has no additive
-- migration mechanism, and lib/db/reshape.ts is not one and must not be
-- widened (CLAUDE.md). A CREATE TABLE IF NOT EXISTS needs no mechanism.
--
-- ABSENCE OF A ROW IS THE LEGACY ARM. devone, devtwo and nico predate this and
-- have no row, so their database key stays argon2(password, salt_key) — which
-- is what keeps devtwo's existing real database openable. Never backfill:
-- there is no way to compute a legacy account's wrapped key without their
-- password, and inventing one would lock them out of their own data.
--
-- NOT append-only, deliberately: a password change (not built here) rewrites
-- this row and nothing else, which is the entire point of the indirection.
CREATE TABLE IF NOT EXISTS account_keys (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  wrapped_key BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/auth/envelope.test.ts
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { newDataKey, wrapDataKey, unwrapDataKey, WrappedKeyError } from '@/lib/auth/envelope'

describe('envelope', () => {
  it('round-trips a data key through a wrap', () => {
    const kek = randomBytes(32)
    const data = newDataKey()
    expect(unwrapDataKey(kek, wrapDataKey(kek, data))).toEqual(data)
  })

  it('produces a different ciphertext every time, for the same inputs', () => {
    // A fresh nonce per wrap. Without it, two accounts that chose the same
    // password would produce byte-identical rows in an unencrypted database.
    const kek = randomBytes(32)
    const data = newDataKey()
    expect(wrapDataKey(kek, data)).not.toEqual(wrapDataKey(kek, data))
  })

  it('refuses a wrong key rather than returning wrong bytes', () => {
    // GCM authenticates. Without the tag check this would hand back plausible
    // garbage, SQLCipher would report "file is not a database", and a friend
    // who mistyped would be told their data was corrupt.
    const wrapped = wrapDataKey(randomBytes(32), newDataKey())
    expect(() => unwrapDataKey(randomBytes(32), wrapped)).toThrow(WrappedKeyError)
  })

  it('refuses a tampered ciphertext', () => {
    const kek = randomBytes(32)
    const wrapped = wrapDataKey(kek, newDataKey())
    wrapped[wrapped.length - 1] ^= 0xff
    expect(() => unwrapDataKey(kek, wrapped)).toThrow(WrappedKeyError)
  })

  it('makes a data key that is 32 bytes and never repeats', () => {
    expect(newDataKey()).toHaveLength(32)
    expect(newDataKey()).not.toEqual(newDataKey())
  })

  it('never puts key material in the error message', () => {
    const wrapped = wrapDataKey(randomBytes(32), newDataKey())
    try { unwrapDataKey(randomBytes(32), wrapped) } catch (e) {
      expect((e as Error).message).toBe('wrapped key did not open with this key')
    }
  })
})
```

```ts
// tests/db/accountKeys.test.ts — use tests/support/synthetic.ts's fresh
// platform-db idiom, matching tests/db/specs.test.ts.
//
//  1. putWrappedKey then readWrappedKey returns the same bytes
//  2. readWrappedKey returns undefined for an account with no row (legacy arm)
//  3. a second putWrappedKey for the same account REPLACES rather than throwing
//     (account_id is the PRIMARY KEY; a future password change needs this)
```

And in `tests/auth/routes.test.ts`, the pair that matters most:

```ts
it('a legacy account with no wrapped key still opens its database', async () => {
  // devtwo's real file on the droplet was written under argon2(password,
  // salt_key). If unlock() ever stopped falling back to that, this branch
  // would lock a real friend out of real data with no recovery path.
  const id = await createAccount(db, { slug: 'legacy', role: 'user', password: 'pw-legacy' })
  const sid = createSession(db, id)
  expect(await unlock(db, sid, 'pw-legacy')).toBe(true)
  const account = findAccountById(db, id)!
  expect(getKey(sid)).toEqual(await deriveDbKey('pw-legacy', account.salt_key))
})

it('an enveloped account gets the DATA key, not the derived key', async () => {
  const id = await createAccount(db, { slug: 'modern', role: 'user', password: 'pw-modern' })
  const account = findAccountById(db, id)!
  const dataKey = newDataKey()
  putWrappedKey(db, id, wrapDataKey(await deriveDbKey('pw-modern', account.salt_key), dataKey), Date.now())
  const sid = createSession(db, id)
  expect(await unlock(db, sid, 'pw-modern')).toBe(true)
  expect(getKey(sid)).toEqual(dataKey)
  expect(getKey(sid)).not.toEqual(await deriveDbKey('pw-modern', account.salt_key))
})
```

- [ ] **Step 3: Run, watch them fail.**

- [ ] **Step 4: Implement `lib/auth/envelope.ts`**

```ts
// lib/auth/envelope.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * The password no longer IS the database key; it unwraps one.
 *
 * Before this, `deriveDbKey(password, salt_key)` was handed straight to
 * SQLCipher, which meant the password could never change without re-encrypting
 * the whole file. Now that derivation produces a key-encrypting key (KEK), and
 * the 32 bytes SQLCipher sees are random, generated once, and stored wrapped
 * in `account_keys` (onboarding ledger D2).
 *
 * AES-256-GCM from node:crypto — no dependency, and AUTHENTICATED, which
 * matters more than it looks: an unauthenticated mode would hand back
 * plausible bytes for a wrong password, SQLCipher would report "file is not a
 * database", and a friend who mistyped would be told their data was corrupt.
 *
 * Layout: [12-byte IV][16-byte tag][ciphertext]. Fixed-width prefixes, so
 * parsing is slicing and there is no length field to get wrong.
 *
 * NEITHER KEY IS EVER LOGGED, and no error below carries bytes.
 */
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export class WrappedKeyError extends Error {
  constructor() {
    // No account id, no byte counts, nothing that varies with the input: this
    // message reaches a log, and a log is not where key material goes.
    super('wrapped key did not open with this key')
    this.name = 'WrappedKeyError'
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function wrapDataKey(kek: Buffer, dataKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const body = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

export function unwrapDataKey(kek: Buffer, wrapped: Buffer): Buffer {
  if (wrapped.length <= IV_BYTES + TAG_BYTES) throw new WrappedKeyError()
  const iv = wrapped.subarray(0, IV_BYTES)
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    // A failed tag check is the only interesting outcome, and it is
    // deliberately not distinguished from a malformed buffer: both mean "this
    // password does not open this account", and telling them apart tells a
    // caller nothing it can act on.
    throw new WrappedKeyError()
  }
}
```

- [ ] **Step 5: Implement `lib/db/accountKeys.ts`**

```ts
// lib/db/accountKeys.ts
import type { PlatformDb } from './platform'

/** Absence of a row is the legacy arm — see platform/schema.sql. */
export function readWrappedKey(db: PlatformDb, accountId: number): Buffer | undefined {
  const row = db
    .prepare('SELECT wrapped_key FROM account_keys WHERE account_id = ?')
    .get(accountId) as { wrapped_key: Buffer } | undefined
  return row?.wrapped_key
}

export function putWrappedKey(
  db: PlatformDb, accountId: number, wrapped: Buffer, at: number,
): void {
  db.prepare(
    `INSERT INTO account_keys (account_id, wrapped_key, created_at) VALUES (?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET wrapped_key = excluded.wrapped_key`,
  ).run(accountId, wrapped, at)
}
```

- [ ] **Step 6: One resolver, two call sites**

Add to `lib/auth/flow.ts`, and call it from **both** `unlock()` and `app/api/login/route.ts` — the only two places `putKey` is reached from, and they must not drift:

```ts
/**
 * The 32 bytes that open this account's SQLCipher database.
 *
 * Two arms, permanently (onboarding ledger D2). An account with a row in
 * `account_keys` gets the unwrapped data key; one without gets the derived key
 * itself, which is what devone/devtwo/nico's databases were written under.
 * There is no third arm and no backfill: a legacy account's wrapped key cannot
 * be computed without their password, and fabricating one would lock a real
 * person out of real data.
 */
export async function databaseKeyFor(
  db: PlatformDb,
  account: { id: number; salt_key: Buffer },
  password: string,
): Promise<Buffer> {
  const derived = await deriveDbKey(password, account.salt_key)
  const wrapped = readWrappedKey(db, account.id)
  return wrapped ? unwrapDataKey(derived, wrapped) : derived
}
```

Both call sites already verified the password with Argon2, so a `WrappedKeyError` here means a corrupt `account_keys` row, not a wrong password. Catch it and fail the login (`return false` / `relativeRedirect('/login?error=1')`). **Write no metrics row** — the failure is already visible as a failed login, and a new event kind for a state that should be impossible is noise in an append-only log. Say that in a comment so the omission reads as a decision.

- [ ] **Step 7: Run** — `npx vitest run tests/auth tests/db`

- [ ] **Step 8: Red-test controls**

1. Delete `decipher.setAuthTag(tag)` → "refuses a wrong key" and "refuses a tampered ciphertext" go red.
2. Make `databaseKeyFor` always return `derived` → "an enveloped account gets the DATA key" goes red; the legacy test stays green.
3. Make `databaseKeyFor` always unwrap → **"a legacy account with no wrapped key still opens its database" goes red.** This is the drill standing between a refactor and locking `devtwo` out. Run it and record it.

- [ ] **Step 9: Commit**

```bash
git add platform/schema.sql platform/seed.ts lib/auth/envelope.ts lib/db/accountKeys.ts lib/auth/flow.ts app/api/login/route.ts tests/auth tests/db
git commit -m "Wrap a random data key under the password, and never migrate the accounts that predate it"
```

---

## Task 7: Invites — the table, the tokens, and the two commands

Read ledger D11 (tokens stored hashed) and D12 (the account is created at S2, not at mint).

**Files:**
- Create: `lib/invite/tokens.ts`, `scripts/create-invite.ts`, `scripts/revoke-invite.ts`
- Modify: `platform/schema.sql`, `platform/seed.ts`, `lib/auth/slug.ts`
- Test: `tests/invite/tokens.test.ts`, `tests/scripts/createInvite.test.ts`

**Interfaces:**
- Produces: `newToken()`, `tokenSha(token)`, `mintInvite(db, {slug, at})`, `readInvite(db, token)`, `consumeInvite(db, {token, accountId, at})`, `revokeInvite(db, {slug, at})`.
- `type InviteState = { kind: 'valid'; id: number; slug: string } | { kind: 'invalid' }` — **one invalid arm, never two.** The spec: *"No distinction shown between 'used' and 'unknown' — same message for both."* A type that cannot express the distinction is stronger than a renderer that remembers not to.

- [ ] **Step 1: Schema**

```sql
-- Invite links. Operational state, like `sessions` — NOT sacred, NOT
-- append-only: consuming and revoking are UPDATEs, which is the whole point.
--
-- The token is stored HASHED (onboarding ledger D11). platform.db is
-- unencrypted by design and invites deliberately never expire, so a live token
-- sitting in it would be a permanent bearer credential to create an account.
-- The token itself exists only in the URL Nico sends.
--
-- `slug` is reserved at mint time and validated then (SLUG_PATTERN +
-- RESERVED_SLUGS), so Nico finds out he typed a route name while minting
-- rather than while his friend is trying to use it. The ACCOUNT is created at
-- password-set time, not here: accounts.auth_hash is NOT NULL and there is no
-- password yet (ledger D12).
CREATE TABLE IF NOT EXISTS invites (
  id         INTEGER PRIMARY KEY,
  token_sha  TEXT    NOT NULL UNIQUE,
  slug       TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  used_at    INTEGER,
  revoked_at INTEGER,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL
);
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/invite/tokens.test.ts — the assertions that carry weight
//
//  1. mintInvite returns a token readInvite resolves to {kind:'valid'}
//  2. the token is NOT stored: the row holds a 64-char hex sha and no column
//     anywhere contains the token itself
//  3. a revoked invite reads {kind:'invalid'}
//  4. a consumed invite reads {kind:'invalid'}
//  5. an unknown token reads {kind:'invalid'} — same shape, no distinction
//  6. mintInvite throws at MINT time for a reserved slug ('admin','invite')
//     and for one failing SLUG_PATTERN
//  7. mintInvite throws for a slug an account already holds
//  8. consumeInvite returns true once and false forever after   ← RED-TEST #1
//  9. consumeInvite returns false for a revoked invite
```

Test 8 is the spec's named red-test control, and it must exercise the guard in the `UPDATE`'s `WHERE`, not a read-then-write:

```ts
it('consumes exactly once, even when two requests race', () => {
  const token = mintInvite(db, { slug: 'friendone', at: 1 })
  const a = consumeInvite(db, { token, accountId: 1, at: 2 })
  const b = consumeInvite(db, { token, accountId: 2, at: 3 })
  expect([a, b]).toEqual([true, false])
  expect(db.prepare('SELECT used_at, account_id FROM invites').get())
    .toMatchObject({ used_at: 2, account_id: 1 })
})
```

- [ ] **Step 3: Run, watch them fail.**

- [ ] **Step 4: Implement `lib/invite/tokens.ts`**

```ts
// lib/invite/tokens.ts
import { createHash, randomBytes } from 'node:crypto'
import type { PlatformDb } from '@/lib/db/platform'
import { RESERVED_SLUGS, SLUG_PATTERN } from '@/lib/auth/slug'

/**
 * A single-use invite, bound to a slug Nico assigned.
 *
 * onboarding-ux-spec.md > Invite minting: no self-chosen usernames, no
 * automatic expiry, a manual revoke instead. N=3 friends.
 */

export type InviteState =
  | { kind: 'valid'; id: number; slug: string }
  /**
   * ONE invalid arm, deliberately. The spec: "No distinction shown between
   * 'used' and 'unknown' — same message for both (leaks nothing, and the fix
   * is identical: text Nico)." A type that cannot express the distinction is
   * a stronger guarantee than a renderer that remembers not to.
   */
  | { kind: 'invalid' }

/** 32 bytes, base64url — URL-safe with no escaping, ~43 characters. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenSha(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function mintInvite(db: PlatformDb, input: { slug: string; at: number }): string {
  // Validated HERE, at mint, so a bad slug is Nico's problem for ten seconds
  // rather than his friend's problem at the worst possible moment. The same
  // two rules createAccount applies, because this reserves the name it will
  // later create.
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      `invalid slug '${input.slug}': must match ${SLUG_PATTERN.source} ` +
        '(lowercase letters, digits, and hyphens only, 1-32 characters)',
    )
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': reserved for a route`)
  }
  if (db.prepare('SELECT 1 FROM accounts WHERE slug = ?').get(input.slug)) {
    throw new Error(`invalid slug '${input.slug}': an account already has it`)
  }

  const token = newToken()
  db.prepare('INSERT INTO invites (token_sha, slug, created_at) VALUES (?, ?, ?)')
    .run(tokenSha(token), input.slug, input.at)
  return token
}

export function readInvite(db: PlatformDb, token: string): InviteState {
  const row = db
    .prepare(
      `SELECT id, slug FROM invites
       WHERE token_sha = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .get(tokenSha(token)) as { id: number; slug: string } | undefined
  return row ? { kind: 'valid', id: row.id, slug: row.slug } : { kind: 'invalid' }
}

/**
 * Mark an invite used, atomically.
 *
 * The `used_at IS NULL AND revoked_at IS NULL` guard lives in the UPDATE's own
 * WHERE clause, NOT in a read before it. A read-then-write would let two
 * simultaneous submissions of the same form both see an unused invite and both
 * go on to create an account — and `accounts.slug` is UNIQUE, so the loser
 * would 500 after consuming a token that can never be reissued. Here the loser
 * gets `changes === 0` and is told, honestly, that the link is no longer valid.
 */
export function consumeInvite(
  db: PlatformDb,
  input: { token: string; accountId: number; at: number },
): boolean {
  const info = db
    .prepare(
      `UPDATE invites SET used_at = ?, account_id = ?
       WHERE token_sha = ? AND used_at IS NULL AND revoked_at IS NULL`,
    )
    .run(input.at, input.accountId, tokenSha(input.token))
  return info.changes === 1
}

export function revokeInvite(db: PlatformDb, input: { slug: string; at: number }): boolean {
  const info = db
    .prepare('UPDATE invites SET revoked_at = ? WHERE slug = ? AND used_at IS NULL')
    .run(input.at, input.slug)
  return info.changes === 1
}
```

- [ ] **Step 5: The two CLIs**

```ts
// scripts/create-invite.ts
//
//   PLATFORM_DB=/home/deploy/stairwell/platform.db npx tsx scripts/create-invite.ts <slug>
//
// Prints ONE line: the URL to text or email. The token is never written
// anywhere else — not to the database (only its hash), not to a log. If the
// message is lost, revoke and mint again.
import { resolve } from 'node:path'
import { openPlatformDb } from '../lib/db/platform'
import { mintInvite } from '../lib/invite/tokens'

const ORIGIN = process.env.INVITE_ORIGIN ?? 'https://app.stairwell.run'

function main(): void {
  const slug = process.argv[2]
  if (!slug) {
    console.error('usage: npx tsx scripts/create-invite.ts <slug>')
    process.exitCode = 1
    return
  }
  const path = process.env.PLATFORM_DB
    ? resolve(process.env.PLATFORM_DB)
    : resolve(process.cwd(), 'platform', 'dev', 'synthetic.db')
  const db = openPlatformDb(path)
  try {
    console.log(`${ORIGIN}/invite/${mintInvite(db, { slug, at: Date.now() })}`)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exitCode = 1
  } finally {
    db.close()
  }
}

main()
```

`scripts/revoke-invite.ts` is the same shape over `revokeInvite`, printing `revoked <slug>` or `nothing to revoke for <slug>` (exit 1 for the latter).

`INVITE_ORIGIN` goes in `deploy/required-env`'s **OUT OF SCOPE** block, not its variable list, with the same reasoning `USERS_DIR` already carries: its default *is* the correct production value, so absence cannot produce a wrong link on the droplet, and listing it would block deploys over a variable that should normally be unset.

- [ ] **Step 6: `lib/auth/slug.ts`** — `RESERVED_SLUGS` gains `'invite'`, `'forgot'`, `'mockup'`. Extend `tests/auth/accounts.test.ts` to assert `createAccount` rejects each.

- [ ] **Step 7: Test the CLI**

`tests/scripts/createInvite.test.ts`, following `tests/scripts/createDevUsers.test.ts`'s idiom (spawn `tsx` against a temp `PLATFORM_DB`). Assert: prints a `/invite/<token>` URL; the printed token is **not** anywhere in the database; a second mint for the same slug exits non-zero; a reserved slug exits non-zero.

- [ ] **Step 8: Run, then the red-test control**

```bash
npx vitest run tests/invite tests/scripts/createInvite.test.ts tests/auth
```

Control (the spec's named one): delete `AND used_at IS NULL AND revoked_at IS NULL` from `consumeInvite`'s `WHERE` → **"consumes exactly once" goes red, alone.** Also: store `token` instead of `tokenSha(token)` → the "not stored" test goes red.

- [ ] **Step 9: Commit**

```bash
git add platform/schema.sql platform/seed.ts lib/invite lib/auth/slug.ts scripts/create-invite.ts scripts/revoke-invite.ts deploy/required-env tests/invite tests/scripts tests/auth
git commit -m "Mint single-use invites, store only their hashes, and consume them exactly once"
```

---

## Task 8: An encrypted database with nothing in it — and what that does to the render path

Read ledger D3. This is the task most likely to break `devtwo`'s working dashboard if done carelessly.

**Files:**
- Modify: `lib/db/encryptedUserDb.ts`, `app/[user]/page.tsx`
- Test: `tests/db/encryptedUserDb.test.ts` (extend), `tests/routing/dashboardRegion.test.ts` (extend)

**Interfaces:**
- Produces: `createEmptyEncryptedUserDb(slug, key): void`; `encryptedUserDbHasTables(slug, key): boolean`.
- Consumed by: Task 10 (`registerFromInvite`), Task 13 (the shell's real-vs-synthetic decision).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/db/encryptedUserDb.test.ts — added cases
//
//  1. createEmptyEncryptedUserDb creates users/<slug>/ when it does not exist
//  2. the file it creates is non-empty and does NOT open with a different key
//     (genuinely encrypted, not a zero-byte placeholder)
//  3. it holds zero tables: encryptedUserDbHasTables → false
//  4. after a writable open against a folder that HAS schema.sql, the same
//     file holds tables: encryptedUserDbHasTables → true
//  5. a writable open against a folder with NO schema.sql succeeds and still
//     surfaces a wrong key as WrongKeyError                    ← the D3 arm
//  6. createEmptyEncryptedUserDb leaves no .creating-* debris behind
//  7. calling it twice does not clobber a file that already has rows (link()
//     EEXIST, the step-6a property, restated for the new entry point)

// tests/routing/dashboardRegion.test.ts — added cases
//
//  8. an unlocked owner whose encrypted file exists but holds NO tables sees
//     the SYNTHETIC dashboard and the banner — not "This dashboard failed to
//     load"                                                    ← RED-TEST #2
//  9. an unlocked owner whose encrypted file holds tables sees the real one,
//     with no banner (existing test, unchanged — it must stay green)
```

Case 8 is the reason this task exists: without it, Task 10 ships a build where every newly onboarded friend's first screen is an error.

- [ ] **Step 2: Run, watch them fail.**

- [ ] **Step 3: Implement**

```ts
/**
 * The schema a user folder holds, or `undefined` when the folder has none.
 *
 * An invited friend's `users/<slug>/` is created by the registration route and
 * holds exactly one thing — their encrypted database. `schema.sql` arrives days
 * later, when Nico builds their dashboard from a confirmed spec. Until then
 * every writable open has to work without one (onboarding ledger D3).
 */
function schemaTextFor(slug: string): string | undefined {
  try {
    return readFileSync(join(usersRoot(), slug, 'schema.sql'), 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined
    throw error
  }
}
```

`createEncryptedUserDb`'s exec becomes conditional on `schemaTextFor(slug)`; with no schema it runs `db.pragma('user_version = 1')` instead — **a real write, deliberately**, so the file carries encrypted pages and cannot be opened under any other key. `openEncryptedUserDb`'s writable branch does the same, falling back to the read path's `SELECT count(*) FROM sqlite_schema` as its key check when there is no schema to exec. Then:

```ts
/**
 * Create a user's encrypted database with NO tables, for a friend who has just
 * set their password and has no dashboard yet.
 *
 * onboarding-ux-spec.md S2 requires the file to exist the moment the password
 * does — "a consumed token with no DB is an invalid state" — and the same
 * spec's flow has nothing to put in it. Reuses the temp-then-link path
 * (step 6a) unchanged, so the atomicity property is one implementation, not
 * two: the file at `path` is always complete or absent, never half-made.
 */
export function createEmptyEncryptedUserDb(slug: string, key: Buffer): void {
  const path = encryptedUserDbPath(slug)
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path)) return
  createEncryptedUserDb(slug, path, key)
}

/**
 * Whether this database holds anything yet.
 *
 * The predicate the render path uses to decide real-vs-synthetic, replacing
 * `encryptedUserDbExists`. Since S2 creates the file at password-set time,
 * existence no longer means "has real data" — and a read-only handle can never
 * create the tables a dashboard's first SELECT needs, so an empty file read as
 * real is a permanent "This dashboard failed to load" that a friend has no
 * control to escape (onboarding ledger D3).
 */
export function encryptedUserDbHasTables(slug: string, key: Buffer): boolean {
  if (!encryptedUserDbExists(slug)) return false
  const db = openEncryptedUserDb(slug, key, { readonly: true })
  try {
    const { n } = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { n: number }
    return n > 0
  } finally {
    db.close()
  }
}
```

In `app/[user]/page.tsx`:

```ts
// Not `encryptedUserDbExists` any more: since S2 creates the file when the
// password is set, existence means "this friend has an account", not "this
// friend has data". A wrong key here throws WrongKeyError, which the caller's
// catch already handles — so an unlockable-but-wrong key still reports
// honestly instead of silently showing synthetic data.
const useReal = key !== undefined && encryptedUserDbHasTables(slug, key)
```

**This opens and closes a handle**, so the region opens twice on the real path. Accepted: an open is microseconds against a page already doing Argon2 elsewhere, and the alternative — threading a handle out of a predicate — is how a handle outlives its key.

- [ ] **Step 4: Run** — `npx vitest run tests/db/encryptedUserDb.test.ts tests/routing/dashboardRegion.test.ts`

- [ ] **Step 5: Red-test controls**

1. Revert `useReal` to `encryptedUserDbExists(slug)` → **case 8 goes red**, case 9 stays green.
2. Delete the `user_version` pragma from the no-schema branch → case 2 goes red, because a zero-byte file opens under anything.
3. **The spec's named control:** delete `readonly: true` at the `openEncryptedUserDb` call site in `dashboardRegion` → the step-6a "a locked session can neither read nor write" companion must go red. Confirm it still does; this task moved the code around it.

- [ ] **Step 6: Commit**

```bash
git add lib/db/encryptedUserDb.ts "app/[user]/page.tsx" tests/db tests/routing
git commit -m "Let a database exist with nothing in it, and stop reading existence as data"
```

---

## Task 9: S0 and S1 — the dead link, and the deal

**Files:**
- Create: `app/(auth)/invite/[token]/page.tsx`, `app/api/invite/accept/route.ts`
- Modify: `middleware.ts`, `lib/session/resolve.ts`
- Test: `tests/invite/page.test.tsx`, `tests/routing/middleware.test.ts` (extend)

- [ ] **Step 1: Open the door**

`middleware.ts`:

```ts
/**
 * Paths a person with no session must reach. /login has always been one;
 * /invite/<token> and /forgot arrived with the onboarding flow, and both are
 * meaningless to anyone who IS logged in — an invite creates the account a
 * session already proves, and a forgot page is read by someone who cannot get
 * one.
 */
function isPublicPath(pathname: string): boolean {
  return pathname === '/login' || pathname === '/forgot' || pathname.startsWith('/invite/')
}
```

`lib/session/resolve.ts`: `PUBLIC` gains `/forgot`; `routeFor` returns `null` for any `/invite/` path **in every state** (a logged-in Nico opening a friend's link to check it must see the page, not a bounce to `/unlock`); `RESERVED_SEGMENTS` gains `invite`, `forgot`, `mockup`. Add cases to `tests/routing/middleware.test.ts` for each — including that `/invitations` is still bounced, the segment-boundary bug `isAdminPath` already guards against.

- [ ] **Step 2: Write the failing page tests**

```tsx
// tests/invite/page.test.tsx — @vitest-environment jsdom
//
//  1. an unknown token renders the dead-link line and NO form
//  2. a used token renders EXACTLY the same output as an unknown one — the
//     no-distinction property, asserted by comparing the two renders
//  3. a revoked token, likewise
//  4. a valid token renders the greeting, all three promise paragraphs, and
//     one accept button posting to /api/invite/accept
//  5. a valid token writes an `invite_opened` row carrying the slug and a
//     device_class
//  6. rendering the same valid token twice writes TWO invite_opened rows — it
//     is an open, not a state change. This pins that nobody "optimises" it
//     into idempotency and loses the funnel.
```

- [ ] **Step 3: Implement the page**

```tsx
// app/(auth)/invite/[token]/page.tsx
//
// S0 and S1 in one route. The token is in the PATH, not a query string, so it
// is never a value a form carries around after the account exists.
//
// This page is the consent surface. onboarding-ux-spec.md: "the recruit
// message deliberately did zero framing, so this page carries all of it."
// Nothing here creates an account, writes a key, or touches a database beyond
// one metrics append.
```

`<main className="grid min-h-dvh place-items-center p-4">` around a `<Card className="w-full max-w-[420px]">` — the spec's ~420px form cap, as a max-width on a fluid column so it is one responsive implementation, not a breakpoint. The promise sits in an `<Alert>`; the accept control is a `<form method="post" action={...}>` with a single full-width `<Button>`. **No checkbox** — the spec is explicit that the button *is* the acceptance. The dead-link arm renders the same shell with one line and no form.

- [ ] **Step 4: Implement the accept route**

Reads the token from the query, `readInvite`s it, and on `{kind:'valid'}` appends `promise_accepted` (`accountId: null` — there is no account yet; slug and device class ride in `data`), then redirects to `/invite/<token>?step=password`. On `{kind:'invalid'}` it redirects to `/invite/<token>` so the dead-link page renders — never a 404, which reads as a broken site rather than a spent link.

- [ ] **Step 5: Run, capture and review, red-test control, commit**

```bash
npx vitest run tests/invite tests/routing/middleware.test.ts
npm run shots -- --task=9
```

**Review `s1-the-deal` and `s0-dead-link` at both widths against their assertions before committing.**

Control: make `readInvite` return `{kind:'valid'}` for a used token → tests 2 and 4's used-token cases go red. Delete the `invite_opened` append → test 5 goes red.

```bash
git add "app/(auth)/invite" app/api/invite middleware.ts lib/session/resolve.ts tests/invite tests/routing/middleware.test.ts
git commit -m "Let a stranger read the deal before there is an account to read it with

Screens reviewed: s1-the-deal, s0-dead-link, at 375 and 1440."
```

---

## Task 10: S2 — the single most consequential screen

**Files:**
- Create: `lib/invite/register.ts`, `app/api/invite/register/route.ts`, `app/(auth)/invite/[token]/SetPasswordForm.tsx`
- Modify: `app/(auth)/invite/[token]/page.tsx`
- Test: `tests/invite/register.test.ts`, `tests/invite/page.test.tsx` (extend)

**Interfaces:**
- Produces: `registerFromInvite(db, { token, password, at })` → `{ ok: true; slug: string; sessionId: string } | { ok: false; reason: 'invalid_token' | 'too_short' | 'server' }`.

Read ledger D13 for the ordering. The filesystem cannot join a SQLite transaction, so the invariant is held by sequence.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/invite/register.test.ts
//
//  1. a valid token + a 10-char password produces: an account with that slug,
//     an account_keys row, a session, a key in the keymap, a consumed invite,
//     and an encrypted file at users/<slug>/<slug>.db
//  2. the key in the keymap OPENS that file, and a key derived from the
//     password does NOT — proving the envelope is really in the path
//  3. a used token returns {ok:false,reason:'invalid_token'} and creates
//     NOTHING: no account, no file, no session         ← RED-TEST (spec's)
//  4. a 9-character password returns 'too_short' and creates nothing
//  5. with the users root unwritable, the call returns 'server' AND the invite
//     is still UNUSED, so the friend can retry — the spec's "if DB creation
//     fails, token is NOT consumed; show retry"
//  6. two concurrent registrations for one token produce exactly one account
//  7. password_set and db_created rows are written, each with the slug and a
//     device class and nothing else
```

Test 5 is the one the spec names in prose and the one an implementer is most likely to invert.

- [ ] **Step 2: Run, watch them fail.**

- [ ] **Step 3: Implement `lib/invite/register.ts`**

```ts
/**
 * Everything S2's submit does, in the order that keeps its promise.
 *
 * onboarding-ux-spec.md: "Token consumption and DB creation are atomic; a
 * consumed token with no DB is an invalid state." A SQLite transaction cannot
 * roll back a filesystem link(), so this is held by ORDER (onboarding D13):
 *
 *   1. Build the encrypted database FIRST. It is the only step that can fail
 *      for reasons outside the database — a full disk, a read-only mount, a
 *      permissions mistake — and a failure here has touched nothing at all.
 *      The friend sees "try once more" and their link still works.
 *   2. One transaction: consume the token, create the account, store the
 *      wrapped key, create the session. consumeInvite's guard lives in its
 *      UPDATE's WHERE, so a double submit loses the race HERE rather than
 *      failing later on the UNIQUE constraint over accounts.slug.
 *   3. Put the data key in the keymap — never in the transaction, never in a
 *      row (CLAUDE.md > Data safety).
 *
 * If step 2 fails, the leftover is an empty encrypted database in a folder no
 * account points at: inert, unreadable, and reused by the next attempt for
 * that slug (link() EEXIST keeps whichever exists).
 */
```

The password length check (`PASSWORD_MIN_LENGTH`) happens **server-side, first** — the client `disabled` attribute is a courtesy, not a gate. The confirm-field match is checked in the route handler and returns to the form with `?error=mismatch`.

- [ ] **Step 4: The route**

`POST /api/invite/register` reads `token` from the query and `password`/`confirm` from the form. Mismatch or too-short → `relativeRedirect('/invite/<token>?step=password&error=<kind>')`. `ok` → set the session cookie with `COOKIE_OPTIONS` and redirect to `/<slug>`. `'server'` → redirect with `error=server`.

- [ ] **Step 5: The S2 arm of the page**

Rendered when `searchParams.step === 'password'` **and** the invite is still valid — an invalid one falls back to S0, because a friend who accepted and then took a week must see the dead-link line, not a password form.

Order, exactly as the spec lists it: `Pick your password` → `<Alert variant="destructive">` holding `PASSWORD_WARNING` → `PasswordField` (password, with `PASSWORD_HINT`) → `PasswordField` (confirm) → shadcn `Checkbox` + `Label` with `NO_RESET_ACK` → `<Button className="w-full">Create my account</Button>`.

The button's disabled state needs client state (match + length + checked), so the form body is `SetPasswordForm.tsx`. Two independent `PasswordField`s: the spec's "toggle applying to both fields" is satisfied by each having one, which is also what lets a friend reveal only the field they are unsure of. *(One toggle governing both is a `shown` boolean lifted into the form — noted, not built.)*

- [ ] **Step 6: Run everything, capture and review**

```bash
npx vitest run tests/invite
npx tsc --noEmit
npm run shots -- --task=10
```

**Review `s2-set-password` at both widths.** Its assertions are the strictest in the set — the warning has to read as a warning before a word is read, and nothing may overflow at 375.

- [ ] **Step 7: Red-test controls**

1. **The spec's named control.** Delete `consumeInvite`'s call in `registerFromInvite` (leave the account creation) → test 3 goes red.
2. Move `createEmptyEncryptedUserDb` to after the transaction → **test 5 goes red** (the token gets consumed by a run that then fails).
3. Store the derived key instead of a wrapped random one → test 2 goes red.
4. Drop the server-side length check, keeping the client `disabled` → test 4 goes red.

- [ ] **Step 8: Commit**

```bash
git add lib/invite/register.ts app/api/invite "app/(auth)/invite" tests/invite
git commit -m "Set a password that is the key, and make the database exist the moment it does

Screens reviewed: s2-set-password, at 375 and 1440."
```

---

## Task 11: S4 — the returning login

**Files:**
- Modify: `app/(auth)/login/page.tsx`, `app/api/login/route.ts`, `app/(auth)/unlock/page.tsx`
- Test: `tests/routing/loginPage.test.ts` (extend), `tests/auth/routes.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

```
1. the page renders a username field, a PasswordField (a show/hide control
   exists), and a "Forgot your password?" link to /forgot
2. ?error=1 renders WRONG_PASSWORD verbatim, and the page contains neither
   "reset" nor "click here"
3. the page renders every paragraph of PROMISE_BLOCK — the same constant S1
   uses, asserted by identity against the constant, not a retyped string
4. a successful login writes a `login` row with a device_class and nothing
   beyond the account id
5. a FAILED login writes no `login` row
```

Assertion 3 is what makes "one shared copy constant, not duplicated strings" a property rather than an intention.

- [ ] **Step 2: Implement**

The page keeps `requireState('/login')` and its dispatch comment untouched — that logic is load-bearing and unrelated. What changes is the body: a centred `<Card className="w-full max-w-[420px]">`, `PasswordField`, the forgot link, `PROMISE_BLOCK` in a muted `<Alert>` below the form, and `WRONG_PASSWORD` in place of "That did not match. Try again."

`app/api/login/route.ts` appends the `login` metric after `putKey`, before the redirect. `app/(auth)/unlock/page.tsx` gets the same card treatment, and its "Cannot remember it?" line becomes a link to `/forgot` **alongside** the existing sign-out form — the form stays, because it is the only escape from a locked session and the comment above it explains why.

- [ ] **Step 3: Run, capture and review, red-test control, commit**

```bash
npx vitest run tests/routing tests/auth
npm run shots -- --task=11
```

**Review `s4-login`, `s4-login-error` and `unlock` at both widths.**

Control: revert the error copy to "That did not match." → assertion 2 goes red. Delete the `login` append → assertion 4 goes red, 5 stays green.

```bash
git add "app/(auth)/login" "app/(auth)/unlock" app/api/login tests/routing tests/auth
git commit -m "Say what a wrong password actually means, and never imply a reset

Screens reviewed: s4-login, s4-login-error, unlock, at 375 and 1440."
```

---

## Task 12: S5 — the honest dead end

**Files:**
- Create: `app/(auth)/forgot/page.tsx`
- Test: `tests/routing/forgotPage.test.tsx`

- [ ] **Step 1: Write the failing tests**

```
1. renders FORGOT.heading and all three paragraphs, verbatim from the constant
2. renders NO <form> and NO <input> — the spec: "No form, no email field"
3. renders exactly one link, back to /login
4. writes a `forgot_password_viewed` row with a device_class
5. the page contains no anchor, button, or route reference matching
   /reset|recover/i — the standing "no password reset path may exist anywhere"
   constraint, made mechanical
```

- [ ] **Step 2: Implement** — a `<Card>` with the heading in an `<Alert variant="destructive">` and plain prose below, plus a secondary `<Button asChild>` wrapping the link home. `accountId: null` on the metric: someone reading this page is by definition not authenticated.

- [ ] **Step 3: Run, capture and review, red-test control, commit**

```bash
npx vitest run tests/routing/forgotPage.test.tsx
npm run shots -- --task=12
```

**Review `s5-forgot` at both widths** — in particular that it reads as honest rather than as an error state, which is the one assertion here no test can make.

Control: add a `<form action="/api/reset">` → assertions 2 and 5 both go red.

```bash
git add "app/(auth)/forgot" tests/routing/forgotPage.test.tsx
git commit -m "Tell the truth about the password, and offer the only real path

Screens reviewed: s5-forgot, at 375 and 1440."
```

---

## Task 13: S3 — the shell, and the only screen after login

Read ledger D6 (CSS-only breakpoints) and D7 (the chat-open default, and deleting `localStorage`).

**Files:**
- Create: `app/[user]/Shell.tsx`, `app/[user]/PlaceholderCard.tsx`
- Modify: `app/[user]/page.tsx`, `app/[user]/ChatPanel.tsx`, `lib/dashboard/registry.ts`, `lib/db/appendOnly.ts`
- Test: `tests/routing/shell.test.tsx`, `tests/routing/userSpace.test.ts` (extend)

**Interfaces:**
- Produces: `<Shell chat content chatOpenByDefault />`; `hasDashboard(slug): boolean`; `hasMetric(db, accountId, event): boolean`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/routing/shell.test.tsx — @vitest-environment jsdom
//
//  1. Shell renders BOTH regions in the DOM at once, in one order, with one
//     ChatPanel instance — the surfaces rule: "The chat is one surface in both
//     compositions — same component, same transcript"
//  2. the chat region's class list carries BOTH compositions: the wide-viewport
//     panel classes (md:-prefixed, a fixed width) and the narrow-viewport sheet
//     classes (fixed inset-0), so arrangement is the browser's job and no JS
//     measures a viewport                                        ← ledger D6
//  3. chatOpenByDefault=true renders the chat open; false renders the toggle
//     and no transcript
//  4. toggling is in-session only: after a toggle, window.localStorage has no
//     'stairwell:chat-open' key                                  ← ledger D7
//  5. the content region renders the placeholder card verbatim when handed one
//
// tests/routing/userSpace.test.ts — added cases
//
//  6. an account with no registered dashboard gets chatOpenByDefault=true
//  7. an account WITH one gets false
//  8. first_session_start is written on the first render and NOT on the second
//  9. a locked owner still gets the shell and the chat — the step-1a rule that
//     "the chat surface keeps working" survives the shell rewrite
```

- [ ] **Step 2: Implement `Shell.tsx`**

```tsx
'use client'
// app/[user]/Shell.tsx
//
// The one composed screen in this product (onboarding-ux-spec.md S3). Every
// login lands here for the app's whole life; the only thing that ever changes
// is what occupies the content area — a placeholder card, then a deployed
// dashboard. There is no first-run mode and no conditional routing.
//
// BREAKPOINTS ARE CSS, NEVER JAVASCRIPT (onboarding ledger D6). The spec's
// standing rule is "breakpoints change arrangement, never internals", and a
// matchMedia branch that renders a sheet on narrow and a panel on wide is two
// implementations of the chat surface wearing one name — and renders
// differently on the server than on the client for one frame. So: ONE
// ChatPanel, mounted once, in one DOM position, and Tailwind decides whether
// its container reads as a fixed left column or a full-screen sheet.
//
// The only state is `open`, which means the same thing in both compositions.
```

Concretely:

- Root: `<div className="flex min-h-dvh flex-col md:flex-row">`
- Chat region, open: `"fixed inset-0 z-20 flex flex-col overflow-y-auto border-border bg-background p-4 md:static md:z-auto md:w-[400px] md:shrink-0 md:border-r"` — a full-screen sheet below `md`, a fixed 400px left column at and above it: exactly the two arrangements the spec names.
- Chat region, closed: not rendered; a persistent toggle instead — `"fixed bottom-4 right-4 z-20 md:static md:m-4"`.
- Content: `"flex-1 overflow-y-auto p-4 md:p-8"`, so it "fills the remainder and reflows when the panel toggles" for free.
- No resize handle, no animation. The spec lists both as non-goals.

- [ ] **Step 3: `PlaceholderCard.tsx`** — a `<Card className="mx-auto max-w-[560px]">` rendering `PLACEHOLDER_CARD.heading` and `.body`. Static chrome, not an agent message; no props, no time wording (Task 5's test enforces the second).

- [ ] **Step 4: Rewire `app/[user]/page.tsx`**

Every guard stays. What changes:

```tsx
// Chat open by default until a real dashboard is deployed, collapsed after
// (onboarding-ux-spec.md S3, "one boolean"). "Deployed" is exactly "is this
// slug in lib/dashboard/registry.ts" — the registry line is what makes a
// dashboard render at all, so nothing else can disagree with it.
//
// This replaces the localStorage default ChatPanel used to keep. The spec
// lists persistence of panel state across sessions as a non-goal, and keeping
// it would mean a friend who collapsed the chat once during the interview
// never sees it open on the morning their dashboard lands (ledger D7).
const chatOpenByDefault = !hasDashboard(user)
```

`first_session_start` is appended when `!hasMetric(getDb(), accountId, 'first_session_start')`, with the device class. `hasMetric` goes in `lib/db/appendOnly.ts` beside the other reads, with a docstring pointing at ledger D8 and CLAUDE.md's sacred-data note — **this is the second metrics row in the codebase that is system state rather than telemetry, and pruning it makes an old account announce itself as new.**

The dashboard region becomes the `content` prop; `<PlaceholderCard />` replaces today's `<p>Nothing here yet…</p>`; the logout form moves into the shell's content-column footer.

- [ ] **Step 5: Delete the localStorage toggle from `ChatPanel`**

Remove `TOGGLE_KEY`, its `useEffect`, and the `toggle()` writes. `open` lifts into `Shell`; `ChatPanel` stops owning open/closed and renders only its transcript, its proposal region, and its composer. `tests/chat/panel.test.ts` and `tests/chat/panelWiring.test.tsx` both need prop updates — and **Task 1's six mutation drills must still redden after this change. Re-run them**, because this is the moment the residual could quietly come back.

- [ ] **Step 6: Run everything, including the build, then capture and review**

```bash
npx vitest run
npx tsc --noEmit
npx next build
npm run shots -- --task=13
```

**Review `s3-shell-placeholder`, `s3-shell-dashboard` and `s3-shell-chat-collapsed` at both widths.** This is the screen the whole product lives in and the only one with two compositions; it is the most important review in the plan.

- [ ] **Step 7: Red-test controls**

1. Replace `!hasDashboard(user)` with `true` → case 7 goes red.
2. Delete the `hasMetric` guard → case 8 goes red.
3. Re-run all six Task-1 mutations → all six must still redden.
4. Delete the `md:` half of the chat container's class string → case 2 goes red **and** the 1440 shot visibly breaks, which is the pair working as intended.

- [ ] **Step 8: Commit**

```bash
git add "app/[user]" lib/dashboard/registry.ts lib/db/appendOnly.ts tests/routing tests/chat
git commit -m "Build the shell every login lands in, and let breakpoints arrange rather than fork

Screens reviewed: s3-shell-placeholder, s3-shell-dashboard,
s3-shell-chat-collapsed, at 375 and 1440."
```

---

## Task 14: Cards and confirmations where they happened

Read ledger D5 and **D5a**. Three sources merge by `at`; **nothing new is persisted.**

**Files:**
- Create: `lib/chat/timeline.ts`
- Modify: `app/[user]/page.tsx`, `app/[user]/ChatPanel.tsx`, `lib/db/specs.ts`
- Test: `tests/chat/timeline.test.ts`, `tests/chat/panelWiring.test.tsx` (extend)

**Interfaces:**
- Produces: `type TimelineItem = { kind: 'turn'; turn: Turn; at: number } | { kind: 'proposal'; proposal: CardProposal; at: number } | { kind: 'confirmation'; version: number; at: number }`; `buildTimeline(turns, proposals, confirmations): TimelineItem[]`.
- Also: `readConfirmations(db, accountId): { spec_id: number; version: number; at: number }[]` in `lib/db/specs.ts`, walking `readSpecs`'s derivation rather than adding a second one.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/chat/timeline.test.ts
//
//  1. a transcript with a proposal between two turns renders the proposal
//     between them, not after everything
//  2. two proposals in one conversation both appear, each at its own place
//  3. a proposal streamed in mid-session lands at the END, after the turn that
//     produced it — the only honest position for something that just happened
//  4. only the newest proposal is live, wherever it sits in the order
//     (withLiveness's rule, restated over the merged list)
//  5. a confirmation appears at ITS OWN timestamp, not at the proposal's —
//     the two can be days apart                                 ← ledger D5a
//  6. a proposal confirmed later shows BOTH: the card where it was offered
//     and the confirmation event where it was accepted
//  7. ties on `at` break deterministically: turn, then proposal, then
//     confirmation (a proposal is authored after the reply that raised the
//     hand; a confirmation follows the card it confirms)
```

- [ ] **Step 2: Implement**

`buildTimeline` merges and sorts. **`ChatPanel`'s `PanelState` gains nothing** — `turns` and `proposals` stay separate in state and the merge happens in the render, so every existing pure-reducer test in `tests/chat/panel.test.ts` keeps passing untouched. That is deliberate: this is a rendering change, and making it a state change would invalidate the one part of this component that already has good coverage.

`app/[user]/page.tsx` passes **all** of the account's spec rows (with their `at`) and all confirmations, not just the newest, so scrollback shows every proposal. Each is read through `readStoredSpec` inside the same narrow `SpecShapeError` catch the page already has — one corrupt row costs its own card, never the conversation.

A confirmation renders as a short inline event — "Confirmed v3" and its time, in muted type. It is a fact, not a card; giving it card weight would make the scrollback read as two proposals.

`ProposalRegion` stops rendering the card list. It keeps the `authoring` spinner and the `proposal_error` line, which belong at the bottom because they describe what is happening *now*.

- [ ] **Step 3: Run, capture and review, red-test control, commit**

```bash
npx vitest run tests/chat
npm run shots -- --task=14
```

**Review `card-proposal` at both widths.**

Controls: sort the merged list by `kind` instead of `at` → case 1 goes red. Pass only `newestSpec` from the page → case 2 goes red. Render the confirmation at the proposal's `at` → case 5 goes red.

```bash
git add lib/chat/timeline.ts lib/db/specs.ts "app/[user]" tests/chat
git commit -m "Show every proposal and every confirmation where it happened, without writing either down twice

Screens reviewed: card-proposal, at 375 and 1440."
```

---

## Task 15: One route for the mockup, and one dialog for looking at it

Read ledger D14. `sandbox=""` stays on both iframes; the route authorises rather than trusting the URL.

**Files:**
- Create: `app/mockup/[version]/route.ts`, `app/[user]/MockupDialog.tsx`
- Modify: `app/[user]/ChatPanel.tsx` (`SpecCard`)
- Test: `tests/spec/mockupRoute.test.ts`, `tests/spec/sandbox.test.ts` (extend), `tests/chat/panelWiring.test.tsx` (extend)

- [ ] **Step 1: Write the failing tests**

```
mockupRoute:
 1. an unlocked owner gets 200, text/html, and the stored mockup_html byte for
    byte
 2. an authenticated-but-LOCKED owner also gets 200 — the mockup is chat
    surface, not data, and a locked friend must still be able to confirm
 3. an anonymous request gets 401
 4. another user's session gets 404 (never 403 — the 404-never-403 rule)
 5. a version that does not exist gets 404
 6. the response carries Cache-Control: no-store and
    Content-Security-Policy: sandbox — belt and braces beside the iframe
    attribute, because a friend who opens the URL directly has no iframe

card:
 7. the preview iframe's src is /mockup/<version> and its sandbox is ""
 8. the Details disclosure is CLOSED by default and holds the panel-by-panel
    body — the spec's "collapsed by default because the visual carries the
    pitch"
 9. the "View full screen" control opens the Radix dialog (queried on
    document.body, not the container — Radix portals) holding a second iframe
    with the same src and the same sandbox
10. a confirmed card shows the confirmed label and NO confirm control; a
    superseded card shows neither — the spec's "no card state machine", a
    conditional over version data with nothing stored
```

- [ ] **Step 2: Implement the route** — reads the session, resolves the account, `specByVersion(db, accountId, version)`, returns `new Response(row.mockup_html, { headers })`. **A route handler, not a page**, so no React, no layout, and no Tailwind reaches the model-authored markup.

- [ ] **Step 3: `MockupDialog.tsx`**

```tsx
'use client'
/**
 * A full-viewport modal, from shadcn's Dialog.
 *
 * onboarding-ux-spec.md: "Full screen = a full-screen modal, not a new tab …
 * stock shadcn Dialog stretched to the viewport … with a single close X
 * top-right. No stacking, no nested overlays, no custom animation — one dialog
 * component, used as-is. The user never leaves the page: open, look, close,
 * confirm."
 *
 * Stretched with className, not by editing components/ui/dialog.tsx: that file
 * is what the CLI wrote and stays that way (onboarding ledger D1).
 */
```

`<DialogContent className="h-dvh w-screen max-w-none rounded-none p-0">` holding the iframe, with lucide's `X` in the close control. The dialog's content is `children`, so the card decides what goes in it.

- [ ] **Step 4: Rework `SpecCard`**

Anatomy, top to bottom, exactly as the spec lists it: **version label + title + one-line description → scaled-down live mockup preview → collapsed "Details" disclosure → confirm control.**

- Preview: `<iframe title={…} src={`/mockup/${proposal.version}`} sandbox="" className="pointer-events-none h-64 w-full rounded-md border" />`. `pointer-events-none` implements "non-interactive at card size is fine" without a second mechanism.
- Details: shadcn `Collapsible`, closed by default, holding today's `VersionBody` (and the legacy arm's panel list). Carry the spec's reason in a comment: *the mockup renders synthetic numbers and cannot communicate behaviour, and what the user confirms is the whole versioned spec, not just the picture.*
- The delivery line and both `DELIVERY_*` constants are **unchanged**. Unified-loop D9 is not reopened by this task.
- The `first` fallback (`proposal.first ?? first`) is **unchanged**, and unified-loop residual 7 says a test is the only thing holding it — confirm `tests/chat/panel.test.ts`'s assertion still passes after the rework.

- [ ] **Step 5: Run everything, including the build, then capture and review**

```bash
npx vitest run
npx tsc --noEmit
npx next build
npm run shots -- --task=15
```

**Review `card-proposal` and `card-fullscreen` at both widths.** `card-proposal`'s "the preview renders actual content, not a blank white box" is the assertion that catches a broken `/mockup` route, which no unit test on this side of the iframe can see.

- [ ] **Step 6: Red-test controls**

1. Remove `sandbox=""` from either iframe → `tests/spec/sandbox.test.ts` goes red (confirm it sees the new sites).
2. Drop the account check in the mockup route → case 4 goes red.
3. Set `defaultOpen` on the Collapsible → case 8 goes red.
4. Render the confirm control regardless of `confirmed` → case 10 goes red.

- [ ] **Step 7: Commit**

```bash
git add app/mockup "app/[user]" tests/spec tests/chat
git commit -m "Serve the mockup from one route, and let a friend actually look at it

Screens reviewed: card-proposal, card-fullscreen, at 375 and 1440."
```

---

## Task 16: The admin portal Nico reads during the pilot

**Files:**
- Create: `app/admin/[user]/AdminTabs.tsx`, `app/admin/mockup/[user]/[version]/route.ts`
- Modify: `app/admin/page.tsx`, `app/admin/[user]/page.tsx`, `lib/db/appendOnly.ts`, `package.json`
- Test: `tests/admin/transcriptPane.test.ts`, `tests/admin/specPane.test.ts` (both extended), `tests/admin/mockupRoute.test.ts`

- [ ] **Step 1: Install the markdown renderer**

```bash
npm install react-markdown remark-gfm
```

Granted at plan approval (ledger D1). **Raw HTML stays disabled** — `react-markdown`'s default — and that is not incidental: a spec payload is model-authored, and the admin portal must not be a softer target than the chat surface it is reviewing.

- [ ] **Step 2: Write the failing tests**

```
 1. the portal index lists each user with a last-activity timestamp, newest
    first (today it sorts by slug and shows no timestamp)
 2. an account that has never done anything shows "no activity yet", not a
    1970 date
 3. the Transcript tab shows conversations oldest-at-bottom, each turn with
    role and time — the spec flips today's newest-conversation-first ordering
 4. it renders proposal cards and confirmations INLINE, in conversation order,
    from the SAME buildTimeline the friend's panel uses — "a transcript with a
    hole where the proposal happened is a broken transcript"
 5. the Spec tab renders the current confirmed version as real markdown: a
    heading becomes an <h1>/<h2>, a list becomes a <ul>. Not a <pre>.
 6. the Spec tab does NOT render raw HTML embedded in the payload — a
    <script> in a spec string arrives as text
 7. the Mockup tab renders the confirmed mockup in an iframe with sandbox=""
    and a full-screen control — the SAME component the friend gets
 8. every tab 404s for a non-admin session and for an unknown user
 9. the admin mockup route serves any user's version, read-only, and 404s for
    a non-admin
```

Assertion 6 is the one worth writing before assertion 5 works.

- [ ] **Step 3: Implement**

- `lastActivityAt(db, accountId)` in `lib/db/appendOnly.ts`: `MAX` over the account's newest transcript row and newest metrics row. One query, documented as a read of two append-only tables and nothing more.
- `AdminTabs.tsx` is shadcn `Tabs` over three panes rendered server-side and passed in as children. All three render per request — with N=3 friends that is cheap, and it is what the spec describes ("selecting a user shows tabs"). Deep-linking is not a spec requirement and tab state is not persisted; "manual refresh only" is satisfied because nothing polls.
- Reading measure: `className="mx-auto max-w-[680px]"` on the transcript column, exactly the spec's number.
- "Newest at bottom, auto-scrolled": ordering is server-side; the auto-scroll is a two-line client effect scrolling the container to its bottom on mount. No smooth behaviour, no scroll library.
- The Spec tab renders `renderSpecMarkdown` output through `<ReactMarkdown remarkPlugins={[remarkGfm]}>`, with the version label and confirmation timestamp above it.

- [ ] **Step 4: Run everything, including the build, then capture and review**

```bash
npx vitest run
npx tsc --noEmit
npx next build
npm run shots -- --task=16
```

**Review `admin-index`, `admin-transcript`, `admin-spec` and `admin-mockup` at both widths.** The 680px measure and the user/agent turn distinction are review assertions, not test assertions — that is the whole reason for the gate.

- [ ] **Step 5: Red-test controls**

Sort the index by slug again → case 1 goes red. Drop the timeline merge from the transcript tab → case 4 goes red. Remove `isAdmin` from the new mockup route → case 9 goes red. Enable `rehype-raw` → case 6 goes red.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json app/admin lib/db/appendOnly.ts tests/admin
git commit -m "Let Nico read a friend's conversation the way the friend had it

Screens reviewed: admin-index, admin-transcript, admin-spec, admin-mockup,
at 375 and 1440."
```

---

## Task 17: The living documents

**Files:**
- Modify: `CLAUDE.md`, `architecture-overview.md`, `docs/local-dev.md`, `docs/superpowers/ledgers/onboarding.md`

- [ ] **Step 1: `CLAUDE.md`**

Four edits, each correcting a sentence this branch made false:

1. **Dashboard folder conventions** — "the walk route's writable open is the only thing that creates or migrates a user's real database" becomes **two** named writable opens: the registration route (`lib/invite/register.ts`, creates an empty database at password-set time) and the walk route (creates-with-schema, and is still the only thing that *migrates*). Add: a third is a change to onboarding ledger D3, not a refactor.
2. **Dashboard folder conventions** — a dashboard reads the real database when it exists **and holds at least one table**, because the file now exists from the moment the account does.
3. **Data safety** — the password derives a key-encrypting key; the SQLCipher key is random, wrapped in `account_keys`, and **accounts created before this branch have no row and derive the key directly, forever. Never backfill.**
4. **Sacred data** — the `deploy_announced` note becomes a list of **two** load-bearing metrics events: `deploy_announced` and `first_session_start` (ledger D8).

Add a short **Onboarding** section: invites are minted by CLI, tokens are stored hashed, there is no password reset path anywhere, the three copy blocks live in `lib/copy/onboarding.ts` and are pinned by tests, and `components/ui/*` is vendored shadcn source that is never hand-edited.

- [ ] **Step 2: `architecture-overview.md`**

Task 0 retired the build-order section. Now the content edits this branch earns:

1. **§1 "One persistent chat surface — no separate onboarding flow"** — the heading is now half wrong and the correction is the interesting part: there is still no separate onboarding *product* surface (the interview is the chat, as designed), but there is now an onboarding *entry* — invite → deal → password → the shell. Rewrite the bullet to say which is which.
2. **§2** — the two-tier session bullet gains the envelope: the password unwraps the data key rather than being it.
3. **§4** — the honest-residue paragraph is superseded by `PROMISE_BLOCK`; point at the constant and say the login page and the invite page render the same one.
4. **§7** — the admin portal is now a user list with last-activity plus three tabs, and it serves mockups through the same route the friend uses.
5. **§9** — metrics gains the onboarding funnel and `device_class`, with a line saying which question the latter answers.

- [ ] **Step 3: `docs/local-dev.md`** — a new section, as commands:

```bash
# Mint an invite. Prints ONE line: the link to text them. The token is never
# stored — only its hash — so a lost link is re-minted, not recovered.
INVITE_ORIGIN=http://localhost:3000 npx tsx scripts/create-invite.ts friendone

# On the droplet:
PLATFORM_DB=/home/deploy/stairwell/platform.db npx tsx scripts/create-invite.ts friendone

# Revoke one that has not been used yet.
npx tsx scripts/revoke-invite.ts friendone

# Walk the flow: open the printed link, accept, set a password of 10+
# characters, land in the shell. Then check what it created:
sqlite3 platform/dev/synthetic.db \
  "SELECT slug, used_at IS NOT NULL AS used FROM invites;"
sqlite3 platform/dev/synthetic.db \
  "SELECT event, json_extract(data,'\$.device_class') FROM metrics ORDER BY at DESC LIMIT 8;"
ls -la users/friendone/     # friendone.db exists, and holds no tables yet

# Re-shoot every screen and print the review checklist.
npm run shots -- --task=manual
```

- [ ] **Step 4: Close the ledger** — fill in "Built" and "Residual risks": the task count, the suite size, `tsc`/`next build`/`test-hooks.sh` results, every ruling amended during the build, every test found to be vacuous, every mutation drill's tally, and **every screenshot review that found something** — that last one is the evidence for whether D16 was worth it.

- [ ] **Step 5: Final verification**

```bash
npx vitest run
npx tsc --noEmit
npx next build
.claude/hooks/test-hooks.sh
npm run shots -- --task=final
```

All five must be clean, and the final shot set reviewed end to end, before this branch is offered for review.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md architecture-overview.md docs/
git commit -m "Write down what the invite flow changed, including two sentences it made false"
```

---

## What only a human can check

The screenshot gate (Task 3) sees layout. It does not see these, and they are the morning walk:

1. **The real invite flow on a real phone**, against the droplet: text yourself the link, accept, set a password, land in the shell. Headless Chromium at 375px has no software keyboard, no Safari viewport quirks, and no autocorrect — and autocorrect is named in the spec's own copy as a leading cause of lockouts.
2. **A manual end-to-end interview as `devtwo`** after the `ChatPanel` work — the spec names this explicitly as the follow-up to touching the panel, and step-4 residual 1 says a green suite is not sufficient evidence for this component.
3. **`devtwo`'s existing dashboard still renders**, inside the shell, from their existing encrypted database — the one place envelope encryption's legacy arm meets real data.
4. **The full-screen mockup dialog on a phone**, which is the spec's "quiet double duty": it exercises the fluid-container contract at confirmation time for free.
5. **A deploy**, through `deploy/deploy.sh` only, with `deploy/smoke.sh` gating success.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| Viewport rules — surfaces built once, responsively | 2, 9–13 (max-width caps, no per-device forks) |
| Viewport rules — composition differs by breakpoint | 13 (CSS only, ledger D6) |
| Codegen container contract | 17 (written into `CLAUDE.md`); no code change — dashboards already receive a fluid container |
| Invite minting, no expiry, manual revoke | 7 |
| S0 dead link, no used/unknown distinction | 7 (the type), 9 (the render) |
| S1 the deal, verbatim, `promise_accepted` | 5, 9 |
| S2 set password, warning, confirm, toggle, checkbox, atomicity | 5, 6, 8, 10 |
| S3 shell, placeholder, chat-open boolean, `first_session_start` | 13 |
| S4 returning login, shared promise, exact wrong-password copy | 5, 11 |
| S5 forgot, no form | 12 |
| Design direction — shadcn on Tailwind, light only, one accent | 2 (ledger D1, D1a) |
| Admin portal — list, tabs, measure, manual refresh, no metrics UI | 16 |
| Mockup cards — anatomy, transcript-native, no state machine, one route, full-screen dialog | 14, 15 |
| Confirmation is a transcript event | 14 (ledger D5a) |
| Metrics table + `device_class` on every row | 4, and each emitting task |
| No password reset path anywhere | 12 (asserted mechanically), 5 (copy), 17 (written down) |
| Token consumption and DB creation atomic | 10 (ledger D13) |
| jsdom + the nine mutations before touching `ChatPanel` | 1 |
| Every screen at 375px and 1440px | 3, and a capture-and-review step in every UI task |
| Red-test discipline on the two named properties | 7 (used token), 8 (locked session) |

**Gaps, stated rather than hidden:**

- **One show-password toggle per field**, not one governing both (Task 10). The spec's wording admits either; the per-field version is what a friend unsure of one field actually wants. One-line change if Nico disagrees.
- **Admin tabs are client state, not routes** (Task 16), so a tab is not deep-linkable. The spec describes tabs and requires only that nothing polls; both hold.
- **Nothing here fixes unified-loop residual 13** — the proposal that intermittently dies telling the friend a lie. Ledger D15 rules it out of this branch and into the next one.
