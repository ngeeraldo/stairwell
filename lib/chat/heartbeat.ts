/**
 * Keep a streaming response's connection from going silent while the server
 * does slow work that produces no output.
 *
 * ─── why this exists ───
 *
 * `/api/chat` streams NDJSON, and between the agent's reply finishing and the
 * authored proposal coming back it sends NOTHING for 47–97 seconds — the spec
 * call and then the mockup call, neither of which reports progress. Across the
 * platform's whole history, 5 of 12 authoring attempts died in that window:
 * `spec_aborted` rows with all-zero token counters, written because
 * `request.signal` aborted, with Caddy recording `"error":"reading: context
 * canceled"` — the client's connection went away. The teardowns landed at 8.0s,
 * 17.3s, 18.2s, 36.5s and 40.0s, every one of them EARLIER than the fastest
 * successful authoring call, and none of them at a repeating value. So it is
 * not a timeout of ours (`SPEC_TIMEOUT_MS` is 180s), not a proxy timeout
 * (deploy/Caddyfile configures none), and not any fixed deadline.
 *
 * What all five share is a connection that had carried no bytes for a while.
 * This puts a byte on it. Whether that FIXES the teardown is exactly the open
 * question (unified-loop ledger D13) — if aborts continue at the same rate with
 * heartbeats flowing, idleness was never the trigger and the cause is in the
 * client's own environment. Either outcome is worth more than the silence we
 * have now, which is why this ships as diagnosis as much as mitigation.
 *
 * ─── what it is not ───
 *
 * Not progress. There is no honest token-level progress for either authoring
 * call, and the panel already has `authoringStage` for the one real milestone.
 * A heartbeat carries no information and the panel is required to ignore it —
 * see HEARTBEAT_LINE.
 */

/**
 * The interval between beats.
 *
 * Chosen against the evidence rather than by feel: the shortest silent window
 * that has actually been torn down was 8.0 seconds, so anything at or above
 * that leaves the exact gap this exists to close. Five seconds puts at least
 * one byte inside every window we have seen die, at a cost of ~11 bytes per
 * beat and roughly a dozen beats across a slow authoring call.
 *
 * If teardowns survive this, LOWERING it is the wrong next move — a heartbeat
 * that does not help at 5s is evidence that idleness is not the mechanism, and
 * the next step is the Caddy access log, not a busier timer.
 */
export const HEARTBEAT_MS = 5_000

/**
 * The line itself.
 *
 * `hb` and nothing else, deliberately. `app/[user]/ChatPanel.tsx`'s `applyLine`
 * dispatches on `t`, `stage`, `authoring`, `proposal` and `proposal_error`, and
 * returns the state object untouched for any line carrying none of them — so a
 * heartbeat is inert in the panel WITHOUT the panel needing a branch for it,
 * and a browser still running an older bundle ignores it just as safely.
 * `tests/chat/heartbeat.test.ts` pins the key list so it cannot quietly grow
 * into a field the UI acts on.
 */
export const HEARTBEAT_LINE = { hb: 1 } as const

export type HeartbeatInput = {
  /** Emit one beat. May throw; see the catch below. */
  beat: () => void
  /**
   * Whether the client is already gone. Checked before every beat because
   * enqueueing onto a `ReadableStream` controller whose consumer has
   * disconnected throws, and the route's own abort handling has by then
   * already decided what to persist.
   */
  stopped: () => boolean
  intervalMs?: number
}

/**
 * Begin beating. Returns the stop function, which is idempotent and MUST be
 * called from a `finally` — an interval that outlives its request is a leak
 * that writes to a closed controller forever.
 */
export function startHeartbeat(input: HeartbeatInput): () => void {
  const timer = setInterval(() => {
    if (input.stopped()) return
    try {
      input.beat()
    } catch {
      // A throw on a timer callback has no caller to catch it — it surfaces as
      // an unhandled exception, and in a Node server that is the whole process,
      // not one request. The request this belonged to is already over; there is
      // nothing left to fail.
    }
  }, input.intervalMs ?? HEARTBEAT_MS)

  // A pending interval keeps the Node event loop alive. A request-scoped timer
  // must never be the reason a process will not exit.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  return () => clearInterval(timer)
}
