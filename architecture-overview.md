# Personal Dashboard Pilot — Architecture Overview

**Status:** Decided, pre-build. Wizard-of-Oz pilot targeting N=3 friends (starting with 1 test user), designed to draw a straight line to N=50 without rewrites.

**Hypothesis under test:** *A non-introspective person, given an agent that interviews them, generates their dashboard, and iterates on it with them, will still be checking it voluntarily at week 3 — and will resist having it taken away.*

---

## System shape

**You are the codegen pipeline.** No automated builder for the pilot. Full bespoke code per user (no config/component palette — customizability is the thesis), written by you driving Claude Code. Automation gets built rung-by-rung only when your hands hurt (see roadmap).

```
Friend's phone/browser
  ├── Dashboard (their code + their data, behind their login)
  └── Persistent chat window (toggleable/hidden) — the agent surface:
        first-join interview, goal planning, tweak requests
        └──► you ──► Claude Code ──► tests pass ──► deploy

Server (single VPS)
  ├── /users/<name>/
  │     ├── dashboard code        (bespoke per user)
  │     ├── spec.md               (agent-emitted, user-confirmed build spec)
  │     ├── mockup.html           (agent-rendered UI preview — the build contract)
  │     ├── schema.sql            (their table shapes)
  │     ├── seed.py               (synthetic data generator)
  │     ├── synthetic.db          (regenerated per session)
  │     ├── tests/                (scoped to this dashboard, run on synthetic.db)
  │     └── <name>.db             (real data, SQLCipher-encrypted)
  ├── Admin portal (Nico only, read-only): transcripts, specs, request queue
  ├── Alerts → ntfy.sh push (session start, spec confirmed / tweak requested)
  ├── Plaid sync (runs at login)
  └── Metrics log (from day one)
```

---

## Stack (decided — do not relitigate)
**Next.js (App Router), full-stack, single service.** API routes handle auth, chat, Plaid, and the admin portal — no separate backend server. Per-user encrypted SQLite via `better-sqlite3-multiple-ciphers`. Plaid via the official Node SDK. Python exists only as standalone dev scripts (`seed.py` and similar), never as a server.

---

## Core decisions

### 1. One persistent chat surface — no separate onboarding flow
- **A single chat window, toggleable to hidden, lives alongside the dashboard.** It is the agent surface for everything: first-join interview, goal planning, and tweak requests. No dedicated onboarding screens.
- **First join:** the agent opens with a prompted chat message that kicks off the interview conversationally — what they worry about, what they'd want to see every morning, what accounts they have, what they'll realistically log.
- Interview ends with a **concrete spec presented back for confirmation, alongside a rendered mockup**: the agent generates an HTML preview of the expected dashboard (synthetic numbers, rough styling) rendered inline in chat — HTML, not generated images, so the preview is honest and cheap. On confirmation, the agent **emits a structured `spec.md` + `mockup.html`** saved to the user's folder — rendered in the admin portal and consumed directly by Claude Code, which builds *toward the mockup*. The preview is a contract, not an illustration.
- Dashboard delivered **next morning** — first exposure happens inside the morning ritual being tested. 7am text with the link (delivery nudges stay out-of-app; everything else lives in the chat).
- The agent system prompt (interview opening + ongoing behavior) is the highest-leverage artifact in the pilot; iterate on it by hand.

### 2. Data layer
- **One SQLite file per user** (`/users/<name>/<name>.db`). No shared DB, no per-user Postgres. Deletion = `rm`.
- **Encrypted at rest with SQLCipher; key derived from the user's login password via KDF.** Key stored nowhere. DB unlocks in memory during their session only. You cannot open it accidentally or casually — requires their password.
- **Consequence: no background jobs.** Sync **runs at login** — morning open triggers: unlock → Plaid sync pulls new transactions → dashboard renders fresh. Matches the ritual; simpler than cron.
- **Two-tier session (step 1a).** The session row persists in the platform
  database; the derived key lives only in an in-process map with a 4h idle TTL
  and a 12h absolute ceiling. A deploy therefore leaves users logged in but
  locked — the chat surface keeps working across the tweak loop, and data
  panels ask for the password again. The key cannot survive overnight, which is
  what keeps login-triggered sync from serving stale data.
- **Platform database.** Accounts, sessions, transcripts, metrics, and the
  request queue live in a single unencrypted `platform.db`, separate from the
  per-user encrypted files. Transcript visibility here is already covered by
  the onboarding promise. `transcripts` and `metrics` reject UPDATE and DELETE
  via SQLite triggers.
- **Schemas are fully bespoke per user, assembled from optional modules.** No mandatory layers — the interview decides what exists; some users will have no finance data at all. You maintain a small library of reusable schema modules (first: `plaid.sql`, since Plaid dictates its shape and the sync job writes into it; workout/sleep modules emerge once hand-built twice). A user who wants finance includes the module; one who doesn't has no Plaid connection or sync job at all. **Rule: shared-module internals are never forked per user** — user-specific needs are met with views/derived tables on top, so shared sync code and each module's synthetic faker keep working for everyone. Custom tables outside modules are unlimited.

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
- **All building/tweaking happens against synthetic data.** Real numbers exist only in the encrypted per-user DB, rendered at runtime behind their login.
- `schema.sql` + `seed.py` + `tests/` are **co-located and updated in the same commit** — any migration that changes the schema updates the generator and the tests in the same Claude Code change. This is the anti-drift rule.
- **Per-user test suites** (`/users/<name>/tests/`) run against `synthetic.db` — scoped to that dashboard's panels and data logic. Tests pass before any deploy to that user. Because tests run on synthetic data, the full test cycle never touches real numbers.
- `synthetic.db` regenerated fresh at the start of any dev session; tailored per user only by account *types* and interests stated in the interview (never their numbers, which you don't have).
- Synthetic data uses **loud fake merchants** ("COFFEE PALACE TEST") so any screen instantly reads as fake or real.
- **Dev laptop never contains production DBs.** Real files live on the server; deploys go out through git; Claude Code runs only in folders where synthetic.db is the only database.
- **Privacy toggle** on every dashboard: swaps live numbers for synthetic ones (for studio sessions / screen shares).
- Honest residue, stated plainly to users at onboarding: *"My tools run on fake data. I'll see what you tell the agent and what you ask for. I won't open your transactions. I'd have to deliberately modify the system to see anything, and I won't. Everything's deleted when the pilot ends."* Written down where they can see it (login page paragraph).

### 5. The agent's core job — monitoring-first, goals optional
- The product may end up replacing a horizontal shelf of apps (Quicken, MyFitnessPal, etc.) — so the agent's framing stays broad: its job is to find out **what this person would want to keep an eye on every morning.** What do they currently check (or wish they checked)? What do they worry about? What would they glance at over coffee?
- **Goals are optional and emergent, never demanded.** "What are your goals?" is a hostile opening for non-introspective people — the exact self-knowledge this product exists to not require. Some users just want their finances visible a certain way; some have deep goals they can't articulate yet. The agent meets them at the monitoring level and lets goals surface over weeks of conversation.
- Iteration is **user-initiated**: what they care about evolves, they say so in chat, the dashboard follows. No autonomous watcher reading their data — cut from scope. Side effect: no component reads real data unattended; the only unattended real-data touch is the Plaid sync pipe.

### 6. Tweak loop
- Tweak requests come through the **in-app chat window** — same surface as everything else. Friends know you're behind it; the agent framing gives permission to ask freely. Explicit first-join line: "send anything, any time — every request is data I need." (Optional: a text/Telegram relay for when they're not in the app, but the chat is the canonical channel and the log of record.)
- Response expectation: small tweaks within a few hours; consistency over speed.
- **Live-build + notify:** requests come in, you build live via Claude Code, and when the deploy lands the agent posts in chat ("your eating-out panel is live"). No scheduled studio sessions — the chat is the whole loop.
- Every request logged with timestamp before fulfilling. Later sorted into "expressible as config" vs "needed custom code" — this distribution settles the future architecture debate.
- Deferred (build only if the week has room): message-mirror → headless Claude Code run → **approval gate** (diff summary + synthetic-render screenshot → you tap ✅ → deploy).

### 7. Admin portal (Nico only) + real-time alerts
- **Read-only portal behind your admin login:** user list; per-user three panes — full chat transcript, current confirmed `spec.md`, and a request queue (open asks with timestamps — doubles as a metrics view).
- Transcript visibility is already covered by the onboarding promise ("I'll see what you tell the agent") — no new privacy surface.
- **Alerts via ntfy.sh** (free push; phone app subscribes to a topic, server curls it): (1) session start — first message after 30+ min silence, debounced; (2) spec confirmed / tweak requested — the "run to the computer" signal.

### 8. Agent system prompt (the chatbot spec)
- A living, page-length artifact — draft v1 rough, iterate weekly against real transcripts starting with your own step-4 interview. Never "done."
- Must cover: persona & tone; interview behavior (**monitoring-first framing** — what they'd keep an eye on, what apps they check, what they worry about; goals optional/emergent, never demanded; plus accounts and what they'll realistically log); **spec-confirmation output contract** (the structured format that becomes `spec.md` + the HTML mockup generation — the load-bearing pieces); honest expectation-setting (builds arrive next morning, tweaks within hours — never promise instant); escalation rules (feasibility questions it can't answer get flagged to Nico, not guessed at).

### 9. Metrics pipeline — build in week one, from user #1
Retention curves cannot be reconstructed retroactively, and they are the fundraise.
- Dashboard opens (timestamped)
- Tweak requests and goal-planning conversations (timestamped, verbatim — the chat log is the log of record)
- Token costs per user (interview, planning, tweak runs) and Plaid per-item cost
- Every manual intervention you make that the agent flow didn't produce (= product backlog or evidence it doesn't automate)

---

## Build order (each step ends with a verifiable checkpoint — Nico is user #0 throughout)

| Step | Build | ✅ Checkpoint |
|---|---|---|
| 1 | Auth, site up, user routing, password/session handling, admin login | Nico logs in as two dev users; each sees only their own (empty) space; admin portal loads, empty |
| 2 | Chat window (toggleable) + LLM chatbot w/ system prompt v1 + transcript persistence + admin transcript pane | Dev user chats with the bot; transcript appears in admin |
| 3 | ntfy.sh alerts (session start, spec confirmed) | Phone buzzes when dev user #2 sends a message |
| 4 | Interview → structured spec flow: agent presents spec + renders HTML mockup inline in chat, user confirms, `spec.md` + `mockup.html` saved + shown in admin | Nico runs his own interview end-to-end; spec + mockup land in the portal |
| 5 | Per-user dashboard hosting + folder conventions (`schema.sql` / `seed.py` / `tests/` / `synthetic.db`) | Nico builds his own dashboard from his own spec via Claude Code; deploys behind his login; dev user #2 can't see it |
| 6 | Plaid module: Link flow, SQLCipher, login-triggered sync | Nico's real accounts sync into his encrypted DB; dev folder shows only COFFEE PALACE TEST |
| 7 | Privacy toggle + metrics logging (append-only, off-VPS backup) | Metrics rows appear from Nico's own usage; backup verified |
| → | **Onboard test user #1** | |

Note: after step 4 a user could technically be onboarded with everything downstream hand-delivered — the critical path to a live test is shorter than the full list. Ugly versions of everything are fine; it needs to exist by test-user #1's first morning. **Code is disposable; conventions are cheap; data (metrics log + chat transcripts) is sacred — the retention curve is the raise and cannot be regenerated.**

---

## Scale constraint
Architecture must support up to **50 users without rewrites** (per-user SQLite, single VPS, and the 200-item Plaid cap all clear that bar). Everything beyond — automation rungs, fundraising targets, deferred architecture debates — lives outside this doc until retention data exists.
