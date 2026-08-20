// lib/ui/writeActionStore.ts
//
// Which write routes currently have a request in flight.
//
// KEYED ON THE ACTION URL, NEVER ON THE PAGE (Nico's ruling, 2026-08-20;
// design doc §3.3). Two controls posting to the same route must not both be
// pressable — run9's "Log one", "+1" and "−1" all write pee_logs, and a
// second press mid-flight queues a conflicting write. Two controls posting to
// DIFFERENT routes are unrelated, and freezing one for the other would be a
// page-wide lock wearing a correctness argument.
//
// A MODULE-LEVEL STORE RATHER THAN REACT CONTEXT, deliberately. A dashboard is
// a server component; a context provider would be one more client boundary a
// builder has to remember to wrap things in, and forgetting it would silently
// degrade to no grouping at all. The grouping is a property of the URL, not of
// the tree, so it does not need the tree.
//
// No React import here on purpose — this file is plain state, and its test
// runs in the node environment without a DOM.

const inFlight = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

export function beginWrite(action: string): void {
  inFlight.add(action)
  notify()
}

export function endWrite(action: string): void {
  inFlight.delete(action)
  notify()
}

export function isWriteInFlight(action: string): boolean {
  return inFlight.has(action)
}

export function subscribeToWrites(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * TEST ONLY — no production caller.
 *
 * Module state outlives a test file's cases, so one test leaving an action in
 * flight would make the next one pass or fail for reasons it never stated.
 */
export function __resetWriteActionStore(): void {
  inFlight.clear()
  listeners.clear()
}
