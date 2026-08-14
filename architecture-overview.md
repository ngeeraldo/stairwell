# Personal Dashboard Pilot — Architecture Overview

**Status:** Decided, pre-build. Wizard-of-Oz pilot targeting N=3 friends (starting with 1 test user), designed to draw a straight line to N=50 without rewrites.

**Hypothesis under test:** *A non-introspective person, given an agent that interviews them, generates their dashboard, and iterates on it with them, will still be checking it voluntarily at week 3 — and will resist having it taken away.*

---

## System shape

**You are the codegen pipeline.** No automated builder for the pilot. Full bespoke code per user (no config/component palette — customizability is the thesis), written by you driving Claude Code. Automation gets built rung-by-rung only when your hands hurt (see roadmap).

```
Friend's phone/browser
  ├── Dashboard (their code + their data, behind their login)
  └── Persistent chat window (toggleable/hidden) — the agent surface for the
        one proposal loop (§6): discovery → propose_spec → preview → confirm
        └──► you ──► Claude Code ──► tests pass ──► deploy
              ──► you run the announce command, by hand, never automatic
              ──► agent announces in chat, above

Server (single VPS)
  ├── /users/<name>/
  │     ├── dashboard code        (bespoke per user)
  │     ├── spec.md               (agent-emitted, user-confirmed build spec —
  │     │                          rendered from the latest confirmed version)
  │     ├── mockup.html           (agent-rendered UI preview — the build contract)
  │     ├── schema.sql            (their table shapes)
  │     ├── seed.py               (synthetic data generator)
  │     ├── synthetic.db          (regenerated per session)
  │     ├── tests/                (scoped to this dashboard, run on synthetic.db)
  │     └── <name>.db             (real data, SQLCipher-encrypted)
  ├── Admin portal (Nico only, read-only): spec versions with their diffs,
  │     and transcripts (the `requests` table is dead schema, unused since
  │     step 1 — superseded by the spec-version list, unified-loop ledger D12)
  ├── Alerts → ntfy.sh push (session start; spec confirmed, now on every
  │     confirmed version however small — the "run to the computer" signal)
  ├── Plaid sync (runs at login)
  └── Metrics log (from day one)
```

---

## Stack (decided — do not relitigate)
**Next.js (App Router), full-stack, single service.** API routes handle auth, chat, Plaid, and the admin portal — no separate backend server. Per-user encrypted SQLite via `better-sqlite3-multiple-ciphers`. Plaid via the official Node SDK. Python exists only as standalone dev scripts (`seed.py` and similar), never as a server.

---

## Core decisions

### 1. One persistent chat surface — and a short way in to it
- **A single chat window, toggleable to hidden, lives alongside the dashboard.** It is the agent surface for the whole proposal loop (§6) — the first-ever interview and every later request travel the same journey, differing only in diff size. There are no onboarding screens **inside the product**: the interview is the chat, as designed.
- **What there IS, since the onboarding build, is a way in.** Four screens a person passes through exactly once — an invite link, the privacy promise, the password that becomes their encryption key, and then the shell — plus a returning login and an honest forgot-password dead end. They exist because the encryption is real: the password must exist before the first byte is written, and there is no reset, so both facts have to be said plainly before an account exists rather than discovered afterwards. Spec: `onboarding-ux-spec.md`.
- **Every login lands in one shell** (`app/[user]/Shell.tsx`) for the product's whole life: the chat surface and a content area, with the content area holding a placeholder card until a dashboard is deployed and the dashboard afterwards. No first-run mode, no conditional routing. The chat is open by default during the interview and collapsed once a dashboard exists — the morning glance is dashboard-first. Which arrangement those two occupy is decided by CSS at a breakpoint, never by JavaScript.
- **First join:** the agent opens with a prompted chat message that kicks off the interview conversationally — what they worry about, what they'd want to see every morning, what accounts they have, what they'll realistically log.
- Interview ends with a **concrete spec version presented back for confirmation, alongside a rendered mockup**: the agent generates an HTML preview of the expected dashboard (synthetic numbers, rough styling) rendered inline in chat — HTML, not generated images, so the preview is honest and cheap. Every spec version is **whole-surface** — it describes the user's entire dashboard, all screens and panels, not just what the latest conversation touched — and **every change ships through a newly confirmed version, including small ones**: there is no fast path that deploys without a confirmation, however trivial the change looks. The preview card **leads with what changed** relative to the version before it (for version 1, "what changed" is the whole dashboard). On confirmation, the agent **emits a structured `spec.md` + `mockup.html`** rendered from that version, saved to the user's folder — rendered in the admin portal and consumed directly by Claude Code, which builds toward *"make the code match this version."* The preview is a contract, not an illustration.
- Dashboard delivered **next morning** — first exposure happens inside the morning ritual being tested. 7am text with the link (delivery nudges stay out-of-app; everything else lives in the chat).
- The agent system prompt (interview opening + ongoing behavior) is the highest-leverage artifact in the pilot; iterate on it by hand.

### 2. Data layer
- **One SQLite file per user** (`/users/<name>/<name>.db`). No shared DB, no per-user Postgres. Deletion = `rm`.
- **Encrypted at rest with SQLCipher; key derived from the user's login password via KDF.** Key stored nowhere. DB unlocks in memory during their session only. You cannot open it accidentally or casually — requires their password.
- **Consequence: no background jobs.** Sync **runs at login** — morning open triggers: unlock → Plaid sync pulls new transactions → dashboard renders fresh. Matches the ritual; simpler than cron.
- **Two-tier session (step 1a).** The session row persists in the platform
  database; the database key lives only in an in-process map with a 4h idle TTL
  and a 12h absolute ceiling. **The password no longer IS that key**: it derives
  a key-encrypting key that unwraps a random data key, stored wrapped in
  `account_keys` (onboarding ledger D2). The friend-visible behaviour is
  identical; what it buys is that changing a password later re-wraps 32 bytes
  instead of re-encrypting a whole history. Accounts created before that —
  `devone`, `devtwo`, `nico` — have no wrapped key and derive the database key
  directly, forever. A deploy therefore leaves users logged in but
  locked — the chat surface keeps working across the proposal loop (§6), and
  data panels ask for the password again. The key cannot survive overnight, which is
  what keeps login-triggered sync from serving stale data.
- **Platform database.** Accounts, sessions, transcripts, metrics, and the
  request queue live in a single unencrypted `platform.db`, separate from the
  per-user encrypted files. Transcript visibility here is already covered by
  the onboarding promise. `transcripts` and `metrics` reject UPDATE and DELETE
  via SQLite triggers.
- **Schemas are fully bespoke per user, assembled from optional modules.** No mandatory layers — the interview decides what exists; some users will have no finance data at all. You maintain a small library of reusable schema modules (first: `plaid.sql`, since Plaid dictates its shape and the sync job writes into it; workout/sleep modules emerge once hand-built twice). A user who wants finance includes the module; one who doesn't has no Plaid connection or sync job at all. **Rule: shared-module internals are never forked per user** — user-specific needs are met with views/derived tables on top, so shared sync code and each module's synthetic faker keep working for everyone. Custom tables outside modules are unlimited.
- **Dashboards may render entry widgets — forms writing to the user's own database during their session.** This covers both creating new hand-logged data and annotating synced data (e.g. a note on a Plaid transaction). The render path never holds a writable handle to do this itself: the widget POSTs to a platform route, which is the only place holding the writable connection and the four ordered checks (CLAUDE.md > Dashboard folder conventions). **Annotations on synced rows live in the user's own tables, keyed to the synced rows — never as edits to a shared-module table.** This is the shared-module-internals rule above, applied to writes: it is what stops a login sync or a re-pull from trampling an annotation the user made in between.

### 2a. Hosting (step 1b)
- **`app.stairwell.run`** on a DigitalOcean droplet (Ubuntu 24.04), Next.js
  under systemd on `127.0.0.1:3000` behind Caddy.
- **TLS terminates on the droplet, not at Cloudflare.** The DNS record is
  grey-cloud (DNS only). The login password is SQLCipher key material, so an
  edge that terminates TLS would see it in plaintext — which would put an
  asterisk on the onboarding promise that cannot be honestly omitted. Flipping
  to a proxied record later is reversible; the privacy paragraph is not.
  Verified by certificate rather than by header: `app.stairwell.run` presents
  our own Let's Encrypt certificate, where the deliberately-proxied
  `kplife.stairwell.run` presents Cloudflare's.
- The loopback bind is the `-H 127.0.0.1` **flag**, never a `HOSTNAME`
  environment variable — `next start` does not read that variable, and the
  difference is a socket on every interface versus one on loopback. Checked with
  `ss -ltnp`, because an external probe cannot tell the two apart through `ufw`.
- `kplife.stairwell.run` is an unrelated tunnel CNAME and is untouched.
- Deploys go out through `deploy/deploy.sh`: pull, install, build, test,
  restart. Tests gate the restart, so a failing suite leaves the previous
  version serving.
- **Redirects are host-relative in route handlers and absolute in middleware.**
  Not a style choice: `new URL(path, request.url)` yields the *internal* origin
  behind a proxy, and Next's middleware runtime rejects a relative `Location`
  outright. See `lib/http/redirect.ts`. Anything running behind a reverse proxy
  has to respect this asymmetry.

### 3. Bank connection = Plaid (production, already approved)
- 0/200 item cap available. Enabled: Transactions (24mo history), Balance, Transactions Refresh (powers login-sync), Recurring Transactions (subscription/paycheck detection — useful day-one panel material, since it works before any custom logging accumulates).
- **Plaid Link runs on the friend's device** — their bank credentials never touch your systems; you store only the access token, encrypted at rest.
- Log every Plaid API call so the access pattern is auditable ("it's just the login sync").
- Gap to watch: Investments and Liabilities not yet enabled — check in the interview whether a friend needs them *before* promising the panel.
- SimpleFIN dropped from the build entirely.

### 4. Privacy model — "can't see it by accident"
- **All building happens against synthetic data.** Real numbers exist only in the encrypted per-user DB, rendered at runtime behind their login.
- `schema.sql` + `seed.py` + `tests/` are **co-located and updated in the same commit** — any migration that changes the schema updates the generator and the tests in the same Claude Code change. This is the anti-drift rule.
- **Per-user test suites** (`/users/<name>/tests/`) run against `synthetic.db` — scoped to that dashboard's panels and data logic. Tests pass before any deploy to that user. Because tests run on synthetic data, the full test cycle never touches real numbers.
- `synthetic.db` regenerated fresh at the start of any dev session; tailored per user only by account *types* and interests stated in the interview (never their numbers, which you don't have).
- Synthetic data uses **loud fake merchants** ("COFFEE PALACE TEST") so any screen instantly reads as fake or real.
- **Dev laptop never contains production DBs.** Real files live on the server; deploys go out through git; Claude Code runs only in folders where synthetic.db is the only database.
- **Privacy toggle** on every dashboard: swaps live numbers for synthetic ones (for studio sessions / screen shares).
- Honest residue, stated plainly to users at onboarding. **The wording now lives in `lib/copy/onboarding.ts` as `PROMISE_BLOCK`** and is rendered from that one constant on BOTH the invite page (before an account exists) and the login page — two copies of a promise are two things that can drift apart. It is pinned sentence by sentence in `tests/copy/onboarding.test.ts` and `tests/routing/loginPage.test.ts`; `onboarding-ux-spec.md` supersedes the paragraph that used to be quoted here.
- **Extended in step 6a, when real per-user data first became possible.** Two sentences, both consequences of decisions rather than caveats on them:
  - *"I can see when you use it — which days you open it and log things — but not what you log."* Engagement is recorded because the retention curve is the fundraise and cannot be reconstructed later. The **permanent policy** is `dashboard_write` carrying a slug and a panel and **never a value** — for every panel type, now and in future, not just this dashboard. That bound is what makes the sentence true, so the sentence and the policy stand or fall together.
  - *"If you forget your password, your logged data is gone forever — I can't recover it, on purpose, because I can't read it either."* The key is derived from the password and stored nowhere. There is no reset path and no backup, by design.
- The whole paragraph is pinned sentence-by-sentence in `tests/routing/loginPage.test.ts`. It is a promise made to a person; it should not be able to drift through an unrelated edit without someone deciding to change it.

### 5. The agent's core job — PM for one stakeholder
- **The agent is product manager for a product with exactly one stakeholder**, working over a single living, versioned spec that describes that person's whole dashboard. The product may end up replacing a horizontal shelf of apps (Quicken, MyFitnessPal, etc.) — so the agent's framing stays broad: its job is to find out **what this person would want to keep an eye on every morning.** What do they currently check (or wish they checked)? What do they worry about? What would they glance at over coffee?
- **Goals are optional and emergent, never demanded.** "What are your goals?" is a hostile opening for non-introspective people — the exact self-knowledge this product exists to not require. Some users just want their finances visible a certain way; some have deep goals they can't articulate yet. The agent meets them at the monitoring level and lets goals surface over weeks of conversation.
- Iteration is **user-initiated**: what they care about evolves, they say so in chat, a new spec version follows. No autonomous watcher reading their data — cut from scope. Side effect: no component reads real data unattended; the only unattended real-data touch is the Plaid sync pipe.
- **Product-identity convention: every app has a morning surface.** Each user's product is a bespoke personal app, and its screens may serve any rhythm — glanced at over coffee, or opened in the moment before and after a practice session. One invariant holds regardless of what else the app does: a glanceable daily front door, designed for every user, because it is the retention instrument the hypothesis at the top of this document measures.

### 6. The proposal loop
- **There is exactly one loop.** Every request — the first-ever interview, a brand-new screen, a one-word relabel — travels it, through the same **in-app chat window**. They differ only in the size of the diff between spec versions and in how much discovery precedes the proposal:
  ```
  always-on chat (agent as PM, user present)
    → discovery (proportional to ambiguity — may be one turn)
    → readiness gate (want / cost accepted / context of use known)
    → propose_spec
    → spec version N+1 written, schema-validated, appended
    → preview card (leads with what changed vs. version N) — Build this / Not quite yet
    → confirm → ntfy → Nico + Claude Code build to "make the code match spec vN+1"
    → deploy → Nico runs the announce command → agent announces in chat
    → loop
  ```
  The announce step is a command Nico runs by hand for the account whose
  build just shipped (`docs/local-dev.md`), never automatic — `deploy.sh`
  deploys the whole service, and an automatic announcement would post into
  every account's chat on every push, a permanent lie in an append-only
  transcript for every account not being deployed for.
  Friends know you're behind it; the agent framing gives permission to ask freely. Explicit first-join line: "send anything, any time — every request is data I need." (Optional: a text/Telegram relay for when they're not in the app, but the chat is the canonical channel and the log of record.)
- Response expectation: small changes within a few hours; consistency over speed.
- **Live-build + notify:** a request comes in, you build live via Claude Code against the newly confirmed version, and when the deploy lands the agent posts in chat ("your eating-out panel is live"). No scheduled studio sessions — the chat is the whole loop.
- **The confirmed version *is* the approval gate, and it is never optional.** No version deploys unconfirmed, regardless of how trivial the change looks. This replaces an earlier, deferred idea of a separate message-mirror → headless-build → diff-summary-and-screenshot approval step: the preview card already leads with what changed, and the confirm button already is that gate, so there is nothing further to build.

### 7. Admin portal (Nico only) + real-time alerts
- **Read-only portal behind your admin login:** a user list ordered by LAST ACTIVITY (the question it is opened to answer is who has been using it), and per-user three tabs — **Transcript**, with proposal cards and confirmations rendered inline in conversation order, because a transcript with a hole where the proposal happened is a broken transcript; **Spec**, the current confirmed version as rendered markdown; **Mockup**, served from the same route and shown with the same full-screen affordance the friend gets, so Nico reviews it the way they saw it. Manual refresh only — nothing polls. There is no metrics pane: `app/admin/[user]/page.tsx` reads no metrics, and the metrics log is queried directly (§9). The original third pane, a "request queue (open asks with timestamps — doubles as a metrics view)," is superseded: the `requests` table it would have read from has been dead schema since step 1 — nothing ever wrote to it — and every request now lives as a spec-version diff instead (unified-loop ledger D12).
- Transcript visibility is already covered by the onboarding promise ("I'll see what you tell the agent") — no new privacy surface.
- **Alerts via ntfy.sh** (free push; phone app subscribes to a topic, server curls it): (1) session start — first message after 30+ min silence, debounced; (2) spec confirmed — now fires on every confirmed version, however small, not just the first — the "run to the computer" signal.

### 8. Agent system prompt (the chatbot spec)
- A living, page-length artifact — draft v1 rough, iterate weekly against real transcripts starting with your own step-4 interview. Never "done."
- Must cover: persona & tone; interview behavior (**monitoring-first framing** — what they'd keep an eye on, what apps they check, what they worry about; goals optional/emergent, never demanded; plus accounts and what they'll realistically log); **spec-confirmation output contract** (the structured format that becomes `spec.md` + the HTML mockup generation — the load-bearing pieces); honest expectation-setting (a first-ever build arrives next morning, later changes within a few hours — never promise instant, matching §6's timing); escalation rules (feasibility questions it can't answer get flagged to Nico, not guessed at).

### 9. Metrics pipeline — build in week one, from user #1
Retention curves cannot be reconstructed retroactively, and they are the fundraise.
- Dashboard opens (timestamped)
- **The onboarding funnel**, from the first click of an invite link to the first session: `invite_opened`, `promise_accepted`, `password_set`, `db_created`, `first_session_start`, `login`, `forgot_password_viewed`. It cannot be reconstructed later, and `forgot_password_viewed` is the early signal that a friend may be about to lose everything they have logged.
- **A `device_class` on every row of that funnel and on every dashboard open** (`phone`/`tablet`/`desktop`, a field inside `metrics.data` — never a column, since `metrics` is never migrated). It answers the one question the pilot cannot answer retroactively and cannot guess: where do people actually glance from. Dashboard-era layout investment follows that data rather than an assumption.
- Every conversation in the proposal loop, timestamped, verbatim — the chat log is the log of record
- **Spec-version diffs, first-class.** The structural diff between a confirmed version and the version it was based on (screens/panels added, removed, changed) is the canonical record of what a request was. It replaces classifying chat text after the fact, and it is what settles the "expressible as config" vs. "needed custom code" question — the distribution that decides the future architecture debate.
- Token costs per user (interview, discovery, spec-authoring runs) and Plaid per-item cost
- Every manual intervention you make that the agent flow didn't produce (= product backlog or evidence it doesn't automate)

---

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
on it; it is written down because a single copy of an irreplaceable file is not
a backup strategy, and the cost of discovering that is total.

**Code is disposable; conventions are cheap; data (metrics log + chat
transcripts) is sacred.**

---

## Scale constraint
Architecture must support up to **50 users without rewrites** (per-user SQLite, single VPS, and the 200-item Plaid cap all clear that bar). Everything beyond — automation rungs, fundraising targets, deferred architecture debates — lives outside this doc until retention data exists.
