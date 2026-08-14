# Onboarding & Invite Flow — UX/UI Spec (handoff to Claude Code)

**Status:** Approved 2026-08-13. Handoff-ready — Claude Code builds from this doc as written.
**Amended 2026-08-14, after the build**, in one place only: the card-anatomy line under "Mockup cards in chat" now describes what shipped. Everything else is the approved text, unchanged. The amendment is marked inline.
**Scope:** Invite link → first-login password setup → privacy disclosure → landing in the app shell (chat + placeholder card) for the interview, plus returning login, forgot-password dead-end, platform-chrome design direction, admin portal styling, and mockup preview cards. Includes the **minimal app shell** (see S3) — pulled into this build so first-run is not a one-off layout.
**Non-goals:** Visual styling (deferred to the taste memo — build clean/unstyled), password *change* UI (envelope encryption supports it; UI comes later), admin-side invite management beyond the minimum to mint a link, any generated-dashboard UI, and shell niceties (resizable panel, animation polish, persistence of panel state across sessions).
**Applies from:** friend #1 forward. `devtwo` is grandfathered on its dev-set password; do not migrate.

---

## Why this flow is shaped the way it is

The password is the encryption key (KDF → unwraps the data key). That means:
1. The password must exist **before** the first real byte is written — so password setup is the first thing a recruit does, and the encrypted DB is created at that moment, not at first log.
2. There is no reset. The UX must make that unmistakable at setup time and honest at failure time — never an error message that implies recovery exists.
3. A typo'd password at setup is catastrophic (user locks themselves out of an empty DB on day one and blames the product). Setup screen is engineered against typos: confirm field **and** show-password toggle.

---

## Viewport rules (standing principle — applies here and to everything after)

Two layers, two different rules:

**Surfaces** — coherent units of content: a form, the chat, a generated dashboard. Each surface is built **once, responsively**, and renders fluidly across its container's full width range. A surface's internals are never forked per device or breakpoint. Prose-width caps apply inside surfaces (forms ~420px, chat ~760px of readable column) because that's what good desktop looks like for those content types, not as a mobile compromise.

**Composition (the shell)** — the layer that decides *which surfaces are visible at once and how they're arranged*. This layer **may and should differ by breakpoint**: e.g., a future app shell composing chat as a collapsible left panel beside the dashboard on wide viewports, and as one-surface-at-a-time (full-screen dashboard, chat as a toggleable sheet) on narrow ones. Breakpoint differentiation lives here and only here.

The rule in one line: **breakpoints change arrangement, never internals.** One implementation per surface; the shell composes.

**Applied to this build:** onboarding screens S0–S2 and S4–S5 are single surfaces with no composition question — each is one centered-column responsive layout. On wide viewports the column renders as a distinct card/panel against a treated background, never bare content floating in an empty viewport (treatment specifics deferred to the taste memo). No device is preferred, gated, or nudged; desktop interviews are first-class. S3 is the app shell — the one composed screen in this build — specced below.

**Codegen container contract (stated now, binds all future dashboard builds):** **generated dashboards target a fluid container** (~375px up to full desktop width, including full-minus-chat-panel) and never assume a fixed width or panel state.

**Channels:** the invite link goes out over whatever reaches the person — text or email. The **7am delivery nudge stays a text** (a 7am email is buried by 7:04). Neither constrains the design; the link works the same everywhere.

**Which device users actually glance from is a pilot question, not a design decision** — answered by the `device_class` instrumentation below; dashboard-era layout investment follows that data.

## Flow map

```
Nico mints invite (admin/CLI) ───► text or email with link
                                        │
                              /invite/<token>
                                        │
                         ┌── invalid/used ──► S0 dead link
                         │
                    S1 The Deal (privacy promise, accept)
                         │
                    S2 Set Password (destruction warning, ack)
                         │  submit: derive key → create encrypted DB
                         │          → session → token marked used
                         │          → metrics rows
                         ▼
                    S3 App shell: chat + placeholder card
                         │  (agent opening message fires; chat open by default)
                         │
              ... interview → spec confirm → next-morning delivery
                    (existing flow; deploy swaps placeholder → dashboard)

Returning:  /  ───► S4 Login ───► S3 shell (placeholder or deployed dashboard)
                     │
              "Forgot password?" ───► S5 Dead-end (honest, no form)
```

---

## Invite minting (Nico-side, minimum viable)

- CLI or admin action: `create-invite <username>` → single-use token → URL `/invite/<token>`.
- Token is bound to a pre-created username. No self-chosen usernames — Nico assigns.
- **No automatic expiry.** Manual revoke command instead. N=3 friends; expiry timers are over-engineering.

---

## S0 — Dead link (`/invite/<token>` when token is used/revoked/unknown)

One line, no branding effort:

> This link isn't valid anymore. Text Nico and we'll sort it out.

No distinction shown between "used" and "unknown" — same message for both (leaks nothing, and the fix is identical: text Nico).

---

## S1 — The Deal (valid token)

**Job:** the recruit reads and accepts the privacy terms before any account exists. This is the consent surface; the recruit message deliberately did zero framing, so this page carries all of it.

**Content, in order:**
1. Greeting line: `Hey — you're in.` (or similar; keep it in the recruit-message register)
2. The promise block — **verbatim copy, do not paraphrase:**

> **Our Privacy Policy:**
>
> **What we see:**
> Everything you tell the AI (your chat history), and when you open the app.
>
> **What we never see:**
> Your actual data (whether created here or pulled in from somewhere else). It's encrypted with your password, so there's no way for anyone to access it.

3. Single button: `Sounds good →`

**The label and the body are separate strings**, not one sentence beginning with a label. Rendered as plain paragraphs the two labels sat at body weight mid-text, and the distinction this screen exists to make — what we see versus what we never see — was the hardest thing on it to find. Each label gets its own line, and **each body starts with a capital and stands as its own sentence**, because it sits under the label rather than continuing it.

**On accept:** log `promise_accepted` metrics row (timestamp, username). No checkbox — the button is the acceptance.

**Notes:**
- This same promise block (minus greeting) is the paragraph that lives on the returning-login page (S4), so it should be one shared copy constant, not duplicated strings.
- This wording supersedes the version in `architecture-overview.md` — it folds in the engagement-visibility disclosure from the horizon list.
- **Nico's edit pass landed 2026-08-14, and this section now carries its result** rather than the pre-build draft. What changed, and why, is `docs/superpowers/ledgers/onboarding.md > D19`. Three things are worth repeating here, because they are the parts a future rewrite is most likely to undo by accident:
  - **The opens disclosure is not negotiable.** "and when you open the app" is what makes `first_session_start`, `dashboard_write` and the device class honest telemetry rather than undisclosed collection — CLAUDE.md > Metrics names this promise as the reason they may be recorded at all. `tests/copy/onboarding.test.ts` pins it as a data-safety gate, not a style preference. If the sentence goes, the metric rows go with it.
  - **"Whether created here or pulled in from somewhere else"** is forward cover for step 6b: Plaid rows land in the same encrypted database under the same key, and a friend reading this before that ships should already have been told so.
  - **The fake-data line and "when the pilot ends, everything is deleted" were dropped from this surface.** Both remain true — CLAUDE.md > Data safety still binds the first — they are simply no longer promised here.

**Voice, standing rule as of the same pass:** every string the product speaks is **"we"**. The one exception is the S2 acknowledgement checkbox below, which is the friend speaking back and stays first-person singular. Naming Nico as the person to text is fine anywhere; narrating what he will then do is not (`he'll sort it out` → `we'll sort it out`). Both directions are swept by `tests/copy/onboarding.test.ts > the voice`.

---

## S2 — Set Password

**Job:** one screen, one warning, engineered against typos. This is the single most consequential screen in the product — the destruction warning gets the room to itself.

**Content, in order:**
1. Heading: `Pick your password`
2. Warning block — **verbatim copy, visually distinct (bordered/tinted), do not soften:**

> **Read this one properly.**
>
> Your data gets locked with this password. There's no reset — that's what keeps your data completely secure and completely yours. If you forget it, everything you've logged is permanently gone and we start over from nothing.

3. Field: password (min length 10, no complexity rules, no strength meter). Inline hint: `10+ characters. A short sentence works great.`
4. Field: confirm password.
5. Show-password toggle applying to both fields.
6. Checkbox (unchecked by default): `I understand there's no reset — forgotten password means my data is gone.` **Stays first-person singular** — the standing "we" voice is us talking to the friend, and this is the friend talking back. "We understand there's no reset" is not a consent control.
7. Button: `Create my account` — disabled until fields match, length ok, box checked.

**On submit (server):** derive KDF key → generate random data key → wrap → create `<name>.db` (SQLCipher, empty schema per current conventions) → create session → mark token used → metrics rows `password_set`, `db_created`. All-or-nothing: if DB creation fails, token is NOT consumed; show retry.

**Error states:**
- Mismatch: `Passwords don't match.` (inline, on confirm field)
- Too short: `Needs at least 10 characters.`
- Server failure: `Something broke on our end — try once more, then text Nico.`

---

## S3 — App shell (the only screen after login, from day one)

**Job:** one layout for the product's entire life. No first-run special mode, no conditional routing — every login lands here; the only thing that ever changes is what occupies the content area (placeholder card → deployed dashboard).

**Composition (per Viewport rules — this is the one composed screen):**
- **Wide viewports:** chat as a fixed-width left panel (~400px), collapsible to a slim toggle; content area fills the remainder and reflows when the panel toggles. Minimal build: no resize handle, no animation polish.
- **Narrow viewports:** content area full-screen; chat opens as a full-screen sheet via a persistent toggle button.
- The chat is **one surface** in both compositions — same component, same transcript, per the surfaces rule.

**Chat default state — one boolean:** chat is **open by default until a real dashboard is deployed** (interview period: it's where the action is), and **collapsed by default after** (the morning glance is dashboard-first; chat stays one tap away). Never landing-view once a dashboard exists.

**Placeholder card** (occupies the content area whenever no dashboard is deployed) — static UI chrome, not an agent message:

> **This is where your app will live.**
>
> Talk to the chat — what it learns is what gets built. You'll hear from the chat when your app is live.

- The *agent never announces the deploy itself* — "you'll hear from the chat" refers to the operator-authored go-live message, per the existing rule.
- No time promises on the card. Any delivery-time wording anywhere in UI chrome must read from the same two constants as the agent's delivery line (the "tomorrow morning" fix) — never hardcode a time of day.
- First-run: the agent's prompted opening message fires immediately (existing step-2/4 behavior, unchanged); metrics row `first_session_start` on first render. Desktop interviews are first-class — a keyboard is arguably the best way to do the 20-minute interview, with the panel open beside the awaiting canvas.
- Deploy swaps the placeholder for the dashboard in the content area; nothing else about the shell changes. Deployed dashboards render per the codegen container contract.
- `devtwo`'s existing dashboard renders inside this shell like any other — the shell is platform chrome, not part of any user's bespoke code.

---

## S4 — Returning login (`/`)

- Fields: username, password. Button: `Open`.
- Below the fold / footer: the shared promise block from S1 (the "written down where they can see it" requirement).
- Link under the form: `Forgot your password?` → S5.
- **Wrong password error — exact copy:** `That password doesn't unlock your data. Check for typos — caps lock, autocorrect.` Never `incorrect password, click here to reset`. The show-password toggle exists here too.
- On successful unlock: existing behavior (Plaid sync where applicable), then land in S3 — always the shell, whether the content area holds the placeholder or a deployed dashboard.

---

## S5 — Forgot password (honest dead-end)

**Job:** tell the truth, offer the only real path. No form, no email field.

> **There's no reset. That's on purpose.**
>
> Your data is encrypted with your password and we never have a copy — that's what keeps us (and everyone else) out of it. The flip side is that nobody can recover it, including us.
>
> Before giving up: typos, caps lock, and phone autocorrect cause most of these. Try again slowly with the show-password toggle on.
>
> If it's really gone: text Nico. Your old data gets deleted and you start fresh — same app idea, empty history.

Button: `← Back to login`.

---

## Design direction — platform chrome v0 (ruled: least work that reads as a real product)

Applies to everything Nico-built in this spec: onboarding screens, the shell, the placeholder card, admin. Does **not** govern generated dashboards or mockups — that's the taste memo's territory when it exists; chrome and dashboards can diverge.

- **shadcn/ui components on Tailwind, defaults barely touched.** This is the entire strategy: the stock look *is* the credible-product look, and Claude Code produces it fluently with no design supervision.
- **Light mode only.** No dark mode, no theme toggle.
- **Neutral palette + one accent: blue** (stock shadcn/Tailwind blue — no custom shade work; everything else stays gray-scale). Destructive/warning contexts (S2 warning block, S5) use the standard red/amber treatment, not the accent.
- **Type: Inter or the system-ui stack.** One family, weights 400/500/600. No display fonts.
- Cards with subtle border + shadow on a slightly-tinted background — this satisfies the treated-background rule from Viewport rules with zero custom work.
- Anti-goals: no gradients, no illustrations, no empty-state art, no loading skeletons beyond shadcn defaults, no logo work. Wordmark is plain text.

---

## Admin portal (Nico only) — functional density, zero polish budget

Same design system as above; the only design goal is reading comfort during monitoring.

- **Layout:** user list down the left (name + last-activity timestamp); selecting a user shows tabs: **Transcript / Spec / Mockup**.
- **Transcript tab:** the full chat log, readable typography (~680px measure), clear user/agent turn distinction, timestamps on hover or muted inline. Newest at bottom, auto-scrolled.
- **Spec tab:** current confirmed spec rendered as markdown (rendered from the spec payload, per the source-of-truth rule). Version label + confirmation timestamp at top.
- **Mockup tab:** the confirmed mockup in an iframe with the same `View full screen` dialog affordance users get (same component, same serving route) — Nico reviews it the way the user saw it.
- **Manual refresh only.** No live updates, no polling, no websockets — ntfy is the real-time channel; the portal is for reading.
- Existing constraint stands: admin account scoped to `/admin` only, read-only, no chat capability.
- **No metrics UI** — punted indefinitely. Nico reads the append-only metrics log directly until that hurts.

---

## Mockup cards in chat (proposed-product previews)

The mockup is the build contract, so the user must be able to actually *look* at it — but full-screen viewing must not cost a modal system.

- **In chat:** the proposal renders as a card, mockup-led. Card anatomy, top to bottom: **version label + title + one-line description → scaled-down live mockup preview** (the mockup HTML in a sandboxed iframe, scaled to fit the chat column; non-interactive at card size is fine) **→ collapsed "Details" disclosure → confirm control.**

  > **Amended 2026-08-14 to match what shipped.** The **one-line description** on the card face is `change_summary` — what changed relative to the version before it — because on a tweak that is the only new sentence, and burying it is how a one-word relabel becomes invisible on the card where it gets approved. The whole-surface `summary` — what the dashboard *is* — sits inside the Details disclosure alongside the panel-by-panel rules, not on the face. As built: `app/[user]/ChatPanel.tsx`, `SpecCard`.

  The Details disclosure holds the behavioral spec (the panel-by-panel rules — e.g. what marks a day complete, how a streak resets); collapsed by default because the visual carries the pitch, but always present, because the mockup renders synthetic numbers and cannot communicate behaviour — and what the user confirms is the whole versioned spec, not just the picture. Narrative recap (how the idea evolved in conversation) is **not** card content — it belongs in the agent's chat prose around the card.
- **Transcript-native, not bolted-on UI.** A proposal card is a **persisted chat message**: it lives in the transcript in conversation order, rendered from its versioned spec payload, and survives reload — scrollback shows every proposal exactly where it happened. The user's confirmation is a transcript event too. Never render "the current proposal" from ephemeral state outside the message history.
- **No card state machine.** Cards are immutable transcript messages; nothing on them is stored state. What renders on a card is a conditional over spec-version data the loop already stores: version has a `confirmed_at` → confirmed label + timestamp; else it's the latest version → active confirm control; else → nothing (plain inert card, version label only). Correctness lives server-side: a confirm on any non-latest version is rejected. No live-updating of old cards, no transitions, no stored per-card state field. Cards accumulate in the transcript across the app's life, making the chat double as the app's version history in context. Deploy status never appears on a card: the card records agreement; go-live is announced by the operator-authored chat message, per the standing rule.
- **Admin transcript pane renders the same cards inline**, so Nico reads the conversation the way the user experienced it — a transcript with a hole where the proposal happened is a broken transcript.
- **Full screen = a full-screen modal, not a new tab.** The card's `View full screen` control opens the mockup in a full-viewport dialog (stock shadcn Dialog stretched to the viewport) with a single close X top-right. No stacking, no nested overlays, no custom animation — one dialog component, used as-is. The user never leaves the page: open, look, close, confirm.
- **One serving route for both views:** the mockup HTML is served at a session-authed route (e.g. `/mockup/<version>`), used as the iframe src by both the scaled card preview and the full-screen dialog. Mockup routes serve only the logged-in user's own mockups (admin can reach all, read-only).
- Quiet double duty: mockups are built against the fluid-container contract, and the full-screen dialog exercises it at confirmation time for free — full viewport width on desktop, phone width on a phone.
- Out of scope: version-diff views, side-by-side comparisons, annotation. The chat is where reactions go.

---

| Event | When |
|---|---|
| `invite_opened` | S1 render (valid token) |
| `promise_accepted` | S1 accept |
| `password_set` / `db_created` | S2 success |
| `first_session_start` | S3 first render |
| `login` | every S4 success |
| `forgot_password_viewed` | S5 render — early signal a friend may be about to lose data (log only; no push) |

**Every event row carries a `device_class` column** (`phone` / `tablet` / `desktop`, derived from viewport width + UA at emit time). This is the instrument that answers the "where do people actually glance from" question — it must exist from user #1, because the phone-vs-desktop usage split cannot be reconstructed retroactively any more than the retention curve can. Dashboard-open events (existing metrics pipeline) must carry the same column.

---

## Explicit constraints for Claude Code

- The three copy blocks (promise, password warning, placeholder card) are **build contracts** — shipped verbatim, stored as shared constants (promise block is used in both S1 and S4). Future wording tweaks are cheap string edits, not re-approvals.
- No password reset path may exist anywhere, including "temporarily for dev."
- Token consumption and DB creation are atomic; a consumed token with no DB is an invalid state.
- One responsive implementation per surface (see Viewport rules); test every screen at 375px **and** 1440px. Breakpoint differentiation exists only in the S3 shell composition.
- If shell work touches `ChatPanel`: the known mutation residual applies — install jsdom and kill the nine surviving call-site mutations **before** modifying, and run a manual end-to-end interview as `devtwo` after.
- `device_class` is emitted on every metrics row in this flow and on dashboard opens.
- Red-test discipline applies: the "locked session can neither read nor write" property and "used token cannot re-register" each get a test that goes red when the guard is deleted.
