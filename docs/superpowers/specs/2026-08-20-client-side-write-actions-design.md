# Client-side write actions — design

**Status:** designed, not built. Branch `fix-dashboard-reload`.

**Rulings:** Nico, 2026-08-20 — §2 (update model), §3 (mechanism and group
scope), §5 (rollout), §6 (examples point at platform code), §7 (trigger field,
additive), §8 (probe threshold and levers).

**Touches:** `CLAUDE.md`, `docs/dashboard-build-rules.md`,
`docs/runbook-ai.md`, `docs/dashboard-ui-ux-guidelines.md`,
`platform/templates/`, `lib/ui/`, `users/run9/dashboard.tsx`,
`users/devtwo/dashboard.tsx`, `app/[user]/page.tsx`.

---

## 0. Why this exists now

Nico noticed run9's dashboard "feels a little choppy" when the log button is
pressed, and asked whether the page reloads. It does — completely.

`users/run9/dashboard.tsx:128` renders a plain `<form method="post">`. The
browser performs a document POST; `app/api/users/[user]/pee/route.ts:176`
answers with a host-relative redirect back to `/<slug>`; the browser follows it with a
fresh GET. Every tap therefore re-runs the whole page — session resolve,
SQLCipher open and decrypt, all four queries, the chat transcript read — and
repaints the document from scratch. No JavaScript is involved on that path at
all.

The chart is not the cause. `users/run9/TrendChart.tsx:121` already sets
`isAnimationActive={false}`. The choppiness is the document swap: the flash,
the scroll and focus reset, the chart re-mounting.

### 0.1 The two findings behind it

This was not a build mistake. It is the visible symptom of two documentation
failures, and fixing only the button would leave both in place.

**Finding 1 — a ruling never reached the documentation.** Nico's ruling of
2026-08-19, which sanctions client and imported components under `users/`,
exists verbatim in exactly one place: the header comment of
`users/run9/TrendChart.tsx:20-28`. It is paraphrased in
`users/run9/notes/v1.md`. It is in no doc — not `CLAUDE.md`, not
`docs/dashboard-build-rules.md`, not `docs/runbook-ai.md`, not
`docs/dashboard-ui-ux-guidelines.md`. The next build cannot see it.

**Finding 2 — the documented rule contradicts the code, and two docs
contradict each other.**

- `docs/dashboard-build-rules.md:175` and `docs/runbook-ai.md:218` state
  "compose only host elements … never return a nested function component"
  absolutely. Every `<Card>` and `<Button>` in every dashboard already
  violates it, and `components/ui/button.tsx` is not even a client component —
  it is a nested *function component*, which is what the rule actually names.
  The rule as written has never been true.
- `docs/dashboard-ui-ux-guidelines.md:108` says "all interactivity should feel
  delightful and alive, nothing should feel static," and its worked example is
  literally a counter app whose "Good" case is *"the number pops — a quick
  scale up/down — when the user changes it."* run9's dashboard **is** that
  example. A full document reload cannot produce that behaviour.

Nothing in the docs states which of those wins. The builder resolved it toward
the security-shaped rule, which is the safe direction to guess, and recorded
nothing in `## Open` because it did not read as a tradeoff at the time.

**The rule to carry forward (Nico, 2026-08-20): do not leave a rule in the
docs that the code already violates.** That is unified-loop ledger D19 — a
guard is not present because something nearby resembles it — arriving by
construction: a rule stated absolutely and violated everywhere teaches the
next builder that the docs are approximate, which is the failure mode that
loses the *next* ruling too.

---

## 1. What "POSTs to a platform route" was, and was not, saying

`CLAUDE.md`, `docs/dashboard-build-rules.md:244` and `docs/runbook-ai.md:240`
all carry one sentence: *"A dashboard may render an entry widget, but the
widget POSTs to a platform route."*

That sentence is about **where the write happens** — no dashboard component
ever holds a writable handle, and the four ordered auth checks live in exactly
one place. It says nothing about whether the browser navigates. But it reads
like a description of a `<form method="post">`, and it was taken that way.

Nothing in this design weakens it. The route remains the only writable handle,
the four ordered checks are untouched, and the dashboard stays a server
component with a read-only handle. What changes is the transport: `fetch`
instead of a document POST, and an in-place re-render instead of a redirect.

---

## 2. The update model (ruled)

> Press → the controls that share that route go pending → the server answers →
> every affected value patches in together, in place, no navigation.

Nothing on screen moves before the server has answered. There is no optimistic
update and no rollback path, because nothing was ever shown that the database
did not hold.

**Why not optimistic.** Two alternatives were considered and declined: a split
model (the pressed count optimistic, derived panels confirmed) and a fully
optimistic one. Both can briefly display a value the database does not hold.
For a dashboard whose entire product is an accurate count, and in a repo whose
UI guidelines already forbid animation that "impersonates the system," the
confirmed model is the only one where the displayed number is always true. It
is also the only one statable as a single rule for every future dashboard,
with no per-panel judgment about which values may run ahead.

**Where the feedback lives.** The pending state carries the interaction
feedback the UI guidelines ask for. This is the reconciliation §6 writes into
that document: the guidelines' "the number pops when the user changes it" is
satisfied by the control responding on press and the value landing on
confirmation — not by the number moving early.

**Pending ends when the new tree commits, not when the POST returns.** If the
control un-pends on the POST response, the count and the chart update a frame
apart and the choppiness returns in a smaller form. The transition must remain
pending until the refreshed server render has committed.

---

## 3. The mechanism

### 3.1 `lib/ui/WriteAction.tsx` — a shared platform primitive

A client component that dashboards import. It owns pending state, the POST,
the refresh and the error surface. Dashboards supply an action URL, a payload
and a label, and write none of the mechanics.

It renders a real `<form method="post">` with hidden inputs and intercepts the
submit when JavaScript is present. The no-JS behaviour the original form POST
had is **kept**, not traded away — it degrades to exactly today's redirect.

Sequence:

1. Press → `startTransition`
2. `fetch(action, {method: 'POST', body: <form data>})`
3. On a 2xx → `router.refresh()` inside the same transition
4. Pending clears when the refreshed tree commits
5. On a non-2xx or a network failure → inline error beside the control,
   nothing on screen moved

`useWriteAction` is exported underneath it for anything a labelled button
cannot express — a form with fields. No such case exists today.

### 3.2 Why `router.refresh()` rather than a JSON response

The write route stays a writer. `router.refresh()` re-runs the existing server
component, so no read logic is duplicated into the route, `queries.ts` remains
the only place SQL lives, and the dashboard remains a server component with a
read-only handle. A JSON-patching alternative would require the write route to
run read queries and would put knowledge of which values changed in two
places.

### 3.3 Group scope — per route, never per page (ruled)

run9 has three controls posting to the same route. Pressing "Log one" must put
−1 and +1 in the pending state too, or conflicting writes queue mid-flight.

**The group keys on the action URL, not on the page.** A friend with a habit
panel and a weight panel must not have weight lock while a habit tap is in
flight — they are unrelated writes to unrelated routes, and freezing one for
the other is a page-wide lock wearing a correctness argument.

### 3.4 Affordances are unchanged

run9's `disabled={count === 0}` on −1 stays exactly as it is. It is the
affordance; the route still enforces the bound.

### 3.5 How a write route answers (ruled, fix round 1)

`fetch` defaults to `redirect: 'follow'`. A write route that always answers
success with the 303 it has given a form POST since before this change would
have that 303 followed automatically, by the browser, as a second credentialed
GET of the whole dashboard — session resolve, SQLCipher open, every query, a
`dashboard_open` row — and then `router.refresh()` inside the same
`useWriteAction` transition renders it a **third** time and appends a
**second** `dashboard_open` row. §7.1 below says this change is "metric-neutral:
one open per tap before, one after"; unguarded, it is two, into a table that
is append-only and therefore cannot be corrected after the fact.

**The fix is a response-shape split, not a client-side workaround.**

- A **native form POST** — the no-JS path §3.1 keeps — gets the 303 it has
  always gotten. The browser follows it and lands back on the dashboard,
  which is the entire no-JS behaviour; nothing here changes it.
- A **fetch-initiated write** gets **204 No Content** and nothing else. 204 is
  a 2xx, so `response.ok` in `useWriteAction` still means what it always
  meant — the write happened — without the route needing to compose or
  serialise a body.

**The discriminator is a request header**, `X-Stairwell-Write: 1`, set by
`useWriteAction`'s `fetch` call and checked by
`lib/http/redirect.ts`'s `writeAnswer(request, path)`, which every write
route calls in place of `relativeRedirect` directly. A native `<form>` submit
cannot set a request header, so its absence is the honest, un-spoofable
signal that this is the no-JS path and the 303 is safe to send.

**Why not `redirect: 'manual'` on the client instead.** Considered and
rejected: a manual-mode fetch that hits a redirect gets back an
*opaqueredirect* response — `status: 0`, `ok: false`, body unreadable —
regardless of whether the thing the redirect pointed at would itself have
succeeded or failed. "Opaque" is the operative word: `useWriteAction` cannot
tell a successful write that happened to redirect from a redirect to an error
page, so every success would read as `WRITE_FAILED`. A response the route
shapes on purpose is legible on both ends; a mode flag that hides the
response from the client is not.

---

## 4. The component rule, stated in three arms

This replaces the absolute "compose only host elements" text at
`docs/dashboard-build-rules.md:175` and `docs/runbook-ai.md:218`.

A dashboard composes host elements and components from these three classes:

1. **Presentational** — shadcn's `Card`, `Button`, and anything that renders
   props as markup without deriving values from them. **Trusted.** This has
   always been true in the code and was stated in the 2026-08-19 ruling as
   "purely presentational components are trusted like shadcn's."

2. **Data-computing** — Recharts, and anything deriving scales, layout or
   geometry from values. **Sanctioned, guarded by a states check:** degenerate
   data (empty, single-point, all-identical, NaN) renders the panel's empty
   state as host elements and never mounts the component. The empty-database
   first render must show empty states, not charts. `chartable` in
   `users/run9/dashboard.tsx` is the worked shape of that guard.

3. **Interaction controls** — a component whose job is to accept a press and
   post it. **Sanctioned, and now the default for every write control** (§5).
   Its guard is structural rather than a states check: it derives nothing from
   user values, taking an action URL, a payload and a label, so it has no
   degenerate-input case a chart-style guard would catch.

**The residual, stated once for all three.** All three render outside
`app/[user]/page.tsx`'s try/catch — `renderDashboard` calls `Dashboard(...)`
rather than returning `<Dashboard />` precisely so the dashboard's own body
runs inside that catch, and a nested component's body is deferred past it. A
throw there 500s the page after the `dashboard_open` row is already written.

For arm 3 this residual sits on the happy path of every dashboard rather than
behind a `chartable`-style guard. That is why the mechanism belongs in
`lib/ui/` as platform code tested once. The catch exists because "bespoke
per-user code is the least-reviewed code in the repo"
(`app/[user]/page.tsx:36-39`); a shared primitive is not that, and moving the
control into platform code is what keeps arm 3's residual smaller than the
rule it replaces.

---

## 5. Rollout (ruled)

One platform branch. The primitive is built, the docs are corrected, and
run9's three controls and devtwo's one are converted in the same branch.

**No spec version, no `notes/v2.md`, no announcement, `current.md`
untouched.** run9 did not ask for this, and their surface does not change —
same screens, same panels, same entries — so `current.md` stays true as
written and a spec version would be a fiction. `scripts/announce-deploy.ts`
is not involved: it announces a version, and there is no new version.

This ships on the next deploy like any platform fix.

**Client-side updating is the default from here.** A new dashboard's write
control uses `WriteAction` unless there is a stated reason not to. The
scaffold ships it wired up, so the default is what a builder gets by not
making a decision.

---

## 6. Documentation changes

### 6.1 The four docs

| File | Change |
|---|---|
| `CLAUDE.md` | The three-arm rule; client-side updating as the default; the ruling recorded with its date. |
| `docs/dashboard-build-rules.md` | Replace the absolute rule at :175. Extend §4 with the update contract. Re-point the examples (§6.2). |
| `docs/runbook-ai.md` | Replace the absolute rule at :218. §2.6 gets the update contract. |
| `docs/dashboard-ui-ux-guidelines.md` | Reconcile Delight/Animation with §2: the pending state carries the press feedback; the value lands on confirmation. Without this the next builder hits the same contradiction. |

The build rules are an index, not a second copy — where it disagrees with a
source, the source wins — so the substance lands in `CLAUDE.md` and the build
rules cite it.

### 6.2 Examples point at platform code (ruled)

**Everything under `users/` is deleted at pilot end.** A doc pointing into a
friend's folder goes dead on the day nobody wants to be fixing docs. Examples
therefore name platform code only — not run9, not devtwo.

Five citations name a friend's folder or a friend-specific route:

| Citation | Names | Becomes |
|---|---|---|
| `CLAUDE.md:471` | `users/devtwo/tests/write.test.ts` | `platform/templates/dashboard/tests/` |
| `docs/dashboard-build-rules.md:262` | same | same |
| `docs/runbook-ai.md:259` | same | same |
| `docs/dashboard-build-rules.md:257` | `app/api/users/[user]/walk/route.ts` | see below |
| `CLAUDE.md:465` | "the walk route above" | see below |

The write-*widget* example is new and points at `lib/ui/WriteAction.tsx` plus
the scaffold template.

Six further devtwo mentions are **factual, not exemplary, and stay**:
legacy accounts with no `account_keys` row (`CLAUDE.md:288`), `version: 0`
predating the spec loop (`CLAUDE.md:183`, build-rules:99), and the
`screenshots/screens.ts` empty-state pin (`CLAUDE.md:322`,
build-rules:335-336).

### 6.3 Open item — the write-route example has no platform home

`walk/route.ts` and `pee/route.ts` live under `app/`, so they survive the
pilot `rm`, but they are friend-specific routes and the docs cite `walk` twice
as *the* worked example for the four ordered auth checks.

**Proposed:** a new `platform/templates/route/route.ts.tmpl` carrying the four
checks in full, with the docs pointing there.

**Cost, stated honestly:** a template is skeletal where a live route is real
working code. `docs/dashboard-build-rules.md:257` currently calls `walk` "the
worked example, not a thing to refactor into a shared one," and that phrasing
earns its keep — the four checks are the security property and are cheaper to
read twice than to trace through an abstraction. A template preserves the
copy-don't-abstract intent while surviving the pilot; it is slightly less
convincing than a route that demonstrably runs.

**Flagged for Nico's review.** Proceeding with the template unless overruled.

---

## 7. The `trigger` field on `dashboard_open`

### 7.1 Measured baseline — the inflation is already in the past

`app/[user]/page.tsx:212` writes one `dashboard_open` row per
`renderDashboard` call, with no write-path dedup, by deliberate ruling: "an
open" is a definition applied when the log is READ, never at write time.

The concern was that `router.refresh()` would start writing an extra row per
tap. **It does not, because the redirect already does.** Measured against
`platform/dev/synthetic.db` on 2026-08-20:

```
dashboard_write rows                          39
…followed by a dashboard_open within 3s       38
```

The interleaving is unambiguous — write, then open, 33–200ms later, every
time:

```
dashboard_open   {"slug":"run9",…,"screen_order":1}   …309869
dashboard_write  {"slug":"run9","panel":"pee_log"}    …309836
dashboard_open   {"slug":"run9",…,"screen_order":1}   …308596
dashboard_write  {"slug":"run9","panel":"pee_log"}    …308398
```

**This change is metric-neutral: one open per tap before, one after.** The
trigger field is therefore a cleanup that makes an *existing* ambiguity
readable, not a guard against a new discontinuity.

Scope of the measurement: that is the dev platform database — dev taps against
run9's synthetic data, not run9's production rows. The mechanism is identical
in production. The droplet's platform database is non-synthetic and is not
readable from the laptop; the production number is obtained by running, on the
droplet:

```bash
sqlite3 "$PLATFORM_DB" "
SELECT (SELECT COUNT(*) FROM metrics WHERE event='dashboard_write') AS writes,
       (SELECT COUNT(*) FROM metrics w WHERE w.event='dashboard_write'
          AND EXISTS (SELECT 1 FROM metrics o WHERE o.event='dashboard_open'
                        AND o.at >= w.at AND o.at <= w.at + 3000)) AS followed;"
```

### 7.2 Additive by construction — no migration

`metrics` is `(id, account_id, event, data, at)` with `data` holding JSON.
There are no per-event columns, so `trigger` is a JSON key, not an
`ALTER TABLE`. Old rows simply lack it.

Decoding follows the deploy timeline, as ruled: **absent = `nav`, for any row
written before this deploy.** New rows always carry it.

The value names no user data — it is a render cause, not a friend-derived
identifier — so the metrics bound ("metrics never carry user values") permits
it. It is not a panel id, a screen id, a day or a count.

**Red test:** a refresh-triggered render that writes a `dashboard_open` row
with `trigger` missing fails.

### 7.3 Detection — the one real unknown, and its coupling

A client component cannot attach headers to `router.refresh()`. The only
server-side signal available to `app/[user]/page.tsx` is the `RSC` request
header Next sends on a refresh.

That works **only because every navigation in this app is a plain document
load.** The tab strip is deliberately bare `<a href="?screen=">` anchors, no
client router, no `<Link>`. So `RSC` present ≈ refresh.

Two things follow, both recorded rather than assumed:

- **Unverified.** That Next sets `RSC` on `router.refresh()` in this version is
  not confirmed. It is confirmed as part of the §8 probe, before the field is
  relied on. If it does not hold, the fallback is read-time correlation with
  `dashboard_write` timestamps — which §7.1 shows already works at 38/39.
- **Named risk.** The detection becomes wrong the day someone introduces a
  client-side `<Link>` or a client router. The tab-strip dependency is
  documented at the detection site so that change is caught where it is made.

---

## 8. Performance probe and threshold (ruled)

The refresh re-runs the entire page per tap: session resolve, SQLCipher open
and decrypt, every query, the chat transcript read, the opening-message check.
That round trip is what the pending state waits on. If it is slow, we will
have replaced a page flash with a spinner.

**Threshold, decided now so the number is not argued with later:**

> **p95 under 300ms on the droplet**, against run9's real page — real-shape
> synthetic data, full transcript length.

**If it clears, ship.** If it does not, two levers, in order, **neither built
unless the probe fails:**

1. **The chat transcript read has no business on the log-press refresh path.**
   It is the obvious first cut and the cheapest.
2. **Hold the unlocked database handle for the session** rather than reopening
   per request.

**Record the measured number in this document either way** — it is the
baseline for the next time someone asks why a tap feels slow.

Measured p95: *(pending — probe not yet run)*

---

## 9. Tests

- `tests/ui/writeAction.test.tsx` — pending state through to commit, the
  success path, the failure path leaving the screen unmoved, and the no-JS
  form shape (a real `<form method="post">` with the right hidden inputs).
- `tests/routing/dashboardRegion.test.ts` — the §7.2 red test, added to the
  suite that already owns the page's metric harness rather than a new file.
- `users/run9/tests/` and `users/devtwo/tests/` updated for the changed
  controls. run9's existing write-path and render tests must stay green
  unchanged in substance — the surface does not change.
- `npm run shots` — every screen is reviewed as a picture before the task is
  committed. This is a review gate, not a pixel diff, and it is the only thing
  that can answer whether the pending state reads as responsive or as stuck.

Gate B: changes under `app/` and `lib/` need a test under `tests/`; changes
under `users/<slug>/` need one in that folder. Both are covered above.

---

## 10. Out of scope, found on the way

Two stale things, neither blocking, neither fixed here:

- `app/api/users/[user]/count/route.ts` exists with a full test suite
  (`tests/routing/countRoute.test.ts`) and **no dashboard posts to it.**
- `CLAUDE.md` refers to "all four dashboards on this branch" and to "every one
  of the four dashboards." There are three: `devone`, `devtwo`, `run9`.

---

## 11. Residual risks

1. **Arm 3's throw lands outside the page's try/catch**, on the happy path of
   every dashboard (§4). Mitigated by the primitive being platform code tested
   once, not per-user code. Accepted.
2. **`RSC`-header detection couples to the tab strip staying anchor-based**
   (§7.3). Documented at the detection site; fallback is read-time correlation.
3. **The refresh cost is per-tap and unmeasured until the probe** (§8).
   Threshold and levers are fixed in advance so the outcome is a decision, not
   a negotiation.
4. **A doc rule that the code violates teaches that docs are approximate**
   (§0.1). This design fixes the two known instances; nothing gates against a
   third appearing. No test in this repo can see a doc going false — that is
   the standing gap this design does not close.
5. **The central behavioural claim — "pending ends when the refreshed tree
   COMMITS, not when the POST returns" (§2) — is verified by hand, once, and
   by no test.** It rests on two Next internals, named at the effect in
   `lib/ui/useWriteAction.ts`: that `router.refresh()` dispatches its state
   update inside the transition passed to `startTransition`, and that Next
   entangles that update into React's async-action lane, which is what holds
   `isPending` true through the refreshed render's commit rather than only
   through the fetch. Neither is a public React or Next contract.
   `tests/ui/writeAction.test.tsx` mocks `useRouter().refresh` as a
   synchronous `vi.fn()`, so it can only prove the WEAKER half — that the
   shared flag survives until `refresh` is CALLED. It cannot distinguish that
   from "survives until the refreshed tree commits", and it is honest about
   pinning only what it pins. The stronger half was confirmed exactly once, by
   hand, in a browser.

   **The failure is silent and cosmetic, which is what makes it a residual
   rather than a bug.** A Next upgrade that stopped doing either would make
   `isPending` resolve as soon as the fetch settles, un-pending every sibling
   control a beat early while the numbers on screen are still stale — the
   choppiness this whole design exists to remove, in a smaller form. The suite
   stays green, `tsc` stays clean, `next build` stays clean. The only
   mitigation is the comment at the effect telling the next reader to re-check
   in a browser after a Next major bump, and a reader who forgets gets no
   signal at all. Closing it properly needs a test that drives a real
   `router.refresh()` against a real server render, which is a browser-level
   harness this repo does not have and this branch is not the place to add.
