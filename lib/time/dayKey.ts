/**
 * The LOCAL calendar day as 'YYYY-MM-DD'.
 *
 * Local, not UTC, and not `toISOString()`: devone shipped a dashboard whose
 * query bucketed months locally while its renderer formatted dates in UTC, so
 * west of Greenwich a late-evening row displayed under the previous day. A
 * tracker whose unit IS the day cannot afford that ambiguity, so the day key is
 * built from local calendar components at the one place it is derived.
 *
 * WHY THIS IS ITS OWN MODULE, and must not go back into a route file:
 * it lived in `app/api/users/[user]/walk/route.ts` and was exported so its
 * timezone behaviour could be tested directly. Next 15 validates a route
 * module's export list against a closed set of route fields, so that export
 * failed `next build` outright — while `npx vitest run` and `npx tsc --noEmit`
 * both stayed green, the latter because tsconfig pulls in `.next/types` and no
 * build had ever generated them. A pure helper does not belong in a route
 * module; this is where it belongs.
 *
 * WHY `users/devtwo/queries.ts` KEEPS ITS OWN `dayKeyOf` RATHER THAN IMPORTING
 * THIS: the duplication is deliberate and predates this module. A user folder
 * is self-contained — schema, seed, queries, dashboard, tests — and a user's
 * queries file taking a platform dependency for four lines of date arithmetic
 * buys nothing and costs the property that a dashboard folder can be read on
 * its own. The original reason (a platform route must never import ONE USER'S
 * queries file) is unchanged and points the same way: this module is the
 * platform side of that boundary, not a bridge across it. The two must agree,
 * and nothing pins them against each other — see the step-6a ledger.
 */
export function dayKey(at: number): string {
  const d = new Date(at)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}
