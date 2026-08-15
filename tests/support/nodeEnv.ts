// tests/support/nodeEnv.ts
//
// Set NODE_ENV in a test.
//
// `process.env.NODE_ENV` is typed read-only (Next's types narrow it), so
// assigning it directly is a compile error even though it is perfectly
// writable at runtime. The cast lives HERE, once, rather than in every suite
// that needs to say which world it is testing — a cast repeated in five files
// is five places for someone to copy a slightly different one.
//
// Which suites need this: anything exercising the production data path.
// lib/db/userData.ts gates on NODE_ENV, and under vitest it is "test", so a
// suite about encrypted databases that did not say `production` would pass
// vacuously against a no-op.
type MutableEnv = Record<string, string | undefined>

export function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as MutableEnv).NODE_ENV
    return
  }
  ;(process.env as MutableEnv).NODE_ENV = value
}

/** Run `fn` with NODE_ENV set, restoring whatever was there afterwards. */
export function withNodeEnv(value: string, fn: () => void): void {
  const before = process.env.NODE_ENV
  setNodeEnv(value)
  try {
    fn()
  } finally {
    setNodeEnv(before)
  }
}
