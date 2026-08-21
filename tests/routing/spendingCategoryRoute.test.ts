// tests/routing/spendingCategoryRoute.test.ts
//
// run11's spending write path — the ONLY thing pinning
// app/api/users/[user]/spending-category/route.ts. users/run11/tests/spending.test.ts
// reproduces the route's effect by hand (a platform route must not be imported
// by a user's test), so nothing there goes red if this route's SQL changes.
// This file is that half.
//
// Modelled on tests/routing/walkLogRoute.test.ts, including its mocking shape
// and the reason for it: the order of the four checks IS the security
// property. resolveState() itself calls getKey() internally, so "no key was
// fetched" can never be an assertion this suite can make — instead the lock
// test asserts canSeeUserSpace (check 2) is never called, alongside the status
// and the absence of the encrypted file.
//
// ─── WHAT MAKES THIS ROUTE DIFFERENT ───────────────────────────────────────
//
// It is the first write route in this repo whose payload is FREE TEXT the
// friend composed. Every other one takes a closed set (a verb, a direction) or
// a day key. Two consequences drive the length of this file:
//
//   * the NORMALISATION block, because the name is a PRIMARY KEY and
//     "Eating  out" and "Eating out" are one bucket to him and two rows to
//     SQLite;
//   * the METRICS assertions, because `metrics` is the unencrypted platform
//     database and this is the column CLAUDE.md's own `divorce_lawyer_fund`
//     example is about. The row is asserted WHOLE, and additionally asserted
//     not to contain the typed name anywhere in it.
//
// It also takes a `transaction_id` from the caller, and the existence check
// that guards it is doing two jobs at once: the id has to be a transaction the
// friend actually has, AND one on an account the Spending screen covers. Both
// come from 004's `spending_transactions` view, so one check answers both — and
// the out-of-scope test below is what proves the second half is really there.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { setNodeEnv } from '@/tests/support/nodeEnv'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlatformDb } from '@/lib/db/platform'

const cookieSlot: { value: { value: string } | undefined } = { value: undefined }
let sessionCookieName = 'sid'
const cookieGet = vi.fn((name: string) => {
  if (name === sessionCookieName) return cookieSlot.value
  return undefined
})
/**
 * `headers` is stubbed alongside `cookies` because lib/metrics/deviceClass.ts
 * reads the User-Agent as its fallback when no stairwell_dc cookie exists. An
 * empty header map is the honest fixture and resolves to 'desktop'.
 */
const emptyHeaders = { get: () => null }

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
  headers: async () => emptyHeaders,
}))

const loaderSlot: { value: unknown } = { value: undefined }
vi.mock('@/lib/dashboard/registry', () => ({
  dashboardLoaderFor: () => loaderSlot.value,
  registeredSlugs: () => ['run11'],
}))

const canSeeUserSpaceSpy = vi.fn()
const accountIdForSpy = vi.fn()
vi.mock('@/lib/auth/authorize', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/auth/authorize')>('@/lib/auth/authorize')
  canSeeUserSpaceSpy.mockImplementation(actual.canSeeUserSpace)
  accountIdForSpy.mockImplementation(actual.accountIdFor)
  return { ...actual, canSeeUserSpace: canSeeUserSpaceSpy, accountIdFor: accountIdForSpy }
})

/**
 * run11's REAL migrations, read off disk rather than retyped, so this suite
 * exercises the shape run11.db is actually created under. ALL FOUR: the Plaid
 * envelope arrives in 003 and the override table and views in 004, so a fixture
 * stopping at 002 would prove nothing about the tables this route touches.
 */
const MIGRATIONS_SRC = resolve(__dirname, '..', '..', 'users', 'run11', 'migrations')
const MIGRATIONS = [
  '001_initial.sql',
  '002_walk_log_and_settings.sql',
  '003_module_plaid_initial.sql',
  '004_run11_spending.sql',
].map((name) => ({
  name,
  number: Number(name.slice(0, 3)),
  sql: readFileSync(join(MIGRATIONS_SRC, name), 'utf8'),
}))

let dir: string
let handle: PlatformDb | undefined
let accountId: number
let originalEnv: string | undefined

const KEY = Buffer.alloc(32, 7)

/** A transaction on an account the Spending screen covers (a credit card). */
const IN_SCOPE = 'txn-in-scope-TEST'
/** A transaction on a savings account, which 004's view deliberately excludes. */
const OUT_OF_SCOPE = 'txn-out-of-scope-TEST'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stairwell-spending-'))
  process.env.PLATFORM_DB = join(dir, 'synthetic.db')
  process.env.USERS_DIR = join(dir, 'users')
  // The ENCRYPTED write path is what this suite is about — the one that runs
  // against run11's real data on the droplet. lib/db/userData.ts sends dev to
  // synthetic.db instead, so without saying `production` these tests would
  // quietly exercise a different database than the one they describe.
  originalEnv = process.env.NODE_ENV
  setNodeEnv('production')
  mkdirSync(join(dir, 'users', 'run11', 'migrations'), { recursive: true })
  for (const m of MIGRATIONS) {
    writeFileSync(join(dir, 'users', 'run11', 'migrations', m.name), m.sql)
  }
  writeFileSync(
    join(dir, 'users', 'run11', 'migrations', 'manifest.json'),
    JSON.stringify({
      migrations: MIGRATIONS.map((m) => ({
        number: m.number,
        sha256: createHash('sha256').update(m.sql).digest('hex'),
      })),
    }),
  )
  vi.resetModules()
  cookieGet.mockClear()
  canSeeUserSpaceSpy.mockClear()
  accountIdForSpy.mockClear()
  cookieSlot.value = undefined
  loaderSlot.value = async () => ({ default: () => null })
  handle = undefined
})

afterEach(() => {
  handle?.close()
  delete process.env.PLATFORM_DB
  setNodeEnv(originalEnv)
  delete process.env.USERS_DIR
  rmSync(dir, { recursive: true, force: true })
})

/** Open the friend's encrypted database directly, to prove rows are on disk. */
function openUserDb(slug = 'run11') {
  const Database = require('better-sqlite3-multiple-ciphers')
  const db = new Database(join(dir, 'users', slug, `${slug}.db`))
  db.pragma("cipher='chacha20'")
  db.key(KEY)
  return db
}

/**
 * Put two synced transactions in place, on accounts that differ in exactly the
 * way 004's `spending_accounts` view cares about.
 *
 * Written directly rather than through the refresh route: this suite is about
 * the category route, and the refresh route is pinned by its own tests. What
 * matters is that the SHAPE is the envelope's real one, so the view's
 * json_extract() paths are the ones production uses.
 */
function seedTransactions() {
  const db = openUserDb()
  try {
    db.prepare(
      'INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)',
    ).run(
      'acct-card',
      'item-TEST',
      JSON.stringify({ name: 'CARD TEST', mask: '3333', type: 'credit', subtype: 'credit card' }),
    )
    db.prepare(
      'INSERT INTO plaid_accounts (account_id, item_id, payload) VALUES (?, ?, ?)',
    ).run(
      'acct-savings',
      'item-TEST',
      JSON.stringify({ name: 'SAVINGS TEST', mask: '1111', type: 'depository', subtype: 'savings' }),
    )
    for (const [id, account] of [
      [IN_SCOPE, 'acct-card'],
      [OUT_OF_SCOPE, 'acct-savings'],
    ] as const) {
      db.prepare(
        'INSERT INTO plaid_transactions (transaction_id, account_id, date, payload) VALUES (?, ?, ?, ?)',
      ).run(
        id,
        account,
        '2026-08-20',
        JSON.stringify({
          amount: 12.5,
          merchant_name: 'COFFEE PALACE TEST',
          personal_finance_category: { primary: 'FOOD_AND_DRINK' },
        }),
      )
    }
  } finally {
    db.close()
  }
}

function overrides() {
  const db = openUserDb()
  try {
    return db
      .prepare(
        'SELECT transaction_id, category, set_at FROM transaction_category_overrides ORDER BY transaction_id',
      )
      .all() as { transaction_id: string; category: string; set_at: number }[]
  } finally {
    db.close()
  }
}

function visibility() {
  const db = openUserDb()
  try {
    return db
      .prepare('SELECT category, included FROM category_visibility ORDER BY category')
      .all() as { category: string; included: number }[]
  } finally {
    db.close()
  }
}

function categories() {
  const db = openUserDb()
  try {
    return (
      db.prepare('SELECT name FROM custom_categories ORDER BY name').all() as { name: string }[]
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

/**
 * Sign run11 in. `lock` withholds the key, as a restart would; `migrate: false`
 * withholds the migration a real login would have run.
 */
async function arrange(
  opts: { lock?: boolean; slug?: string; migrate?: boolean; seed?: boolean } = {},
) {
  const { getDb } = await import('@/lib/db/instance')
  const { createAccount } = await import('@/lib/auth/accounts')
  const { createSession, SESSION_COOKIE } = await import('@/lib/session/store')
  const { putKey } = await import('@/lib/session/keymap')
  sessionCookieName = SESSION_COOKIE
  handle = getDb()
  accountId = await createAccount(handle, {
    slug: opts.slug ?? 'run11',
    role: 'user',
    password: 'pw',
  })
  const sid = createSession(handle, accountId)
  if (!opts.lock) {
    // A COPY, not the test's own constant. The keymap ZEROES the buffer it
    // holds when an entry ages out, so handing it KEY directly wipes the
    // constant every other assertion in this file decrypts with.
    putKey(sid, Buffer.from(KEY))
    if (opts.migrate !== false) {
      const { migrateUserDb } = await import('@/lib/db/migrate')
      migrateUserDb(opts.slug ?? 'run11', KEY)
      if (opts.seed !== false) seedTransactions()
    }
  }
  cookieSlot.value = { value: sid }
  const { POST } = await import('@/app/api/users/[user]/spending-category/route')
  return POST
}

const params = (user: string) => ({ params: Promise.resolve({ user }) })

/** A form submit, the way the dashboard's own <form method="post"> sends one. */
function submit(fields: Record<string, string>, headers?: Record<string, string>): Request {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return new Request('http://x', { method: 'POST', body, headers })
}

/** A WriteAction submit: same body, plus the header only fetch can set. */
function fetchSubmit(fields: Record<string, string>): Request {
  return submit(fields, { 'X-Stairwell-Write': '1' })
}

function metricRows() {
  const rows = handle!
    .prepare("SELECT event, data FROM metrics WHERE event LIKE 'dashboard_%' ORDER BY id")
    .all() as { event: string; data: string }[]
  return rows.map((r) => ({ event: r.event, data: JSON.parse(r.data) as Record<string, unknown> }))
}

describe('POST /api/users/[user]/spending-category — the four ordered checks', () => {
  it('refuses a LOCKED session before it touches ownership or a file', async () => {
    const POST = await arrange({ lock: true })
    const res = await POST(submit({ action: 'create', name: 'Coffee' }), params('run11'))
    expect(res.status).toBe(403)
    // Check 2 was never reached: a route that opened the file and refused
    // afterwards would look identical on status and file-existence alone.
    expect(canSeeUserSpaceSpy).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'users', 'run11', 'run11.db'))).toBe(false)
  })

  it('answers 404, never 403, for a slug that is not theirs', async () => {
    // 404 so the response cannot confirm another account exists.
    const POST = await arrange()
    const res = await POST(submit({ action: 'create', name: 'Coffee' }), params('someone-else'))
    expect(res.status).toBe(404)
  })

  it('answers 404 when no dashboard is registered for the slug', async () => {
    // Otherwise any authenticated slug could cause an encrypted file to be
    // created for a user who has no dashboard at all.
    const POST = await arrange()
    loaderSlot.value = undefined
    const res = await POST(submit({ action: 'create', name: 'Coffee' }), params('run11'))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/users/[user]/spending-category — what it will not accept', () => {
  it('refuses an unknown action', async () => {
    const POST = await arrange()
    const res = await POST(submit({ action: 'delete', name: 'Coffee' }), params('run11'))
    expect(res.status).toBe(400)
    expect(categories()).toEqual([])
  })

  it('refuses a missing body', async () => {
    const POST = await arrange()
    const res = await POST(
      new Request('http://x', { method: 'POST' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
  })

  it('refuses an empty or whitespace-only category name', async () => {
    const POST = await arrange()
    for (const name of ['', '   ', '\n\t ']) {
      const res = await POST(submit({ action: 'create', name }), params('run11'))
      expect(res.status).toBe(400)
    }
    expect(categories()).toEqual([])
  })

  it('refuses a name longer than the bound, measured AFTER normalisation', async () => {
    const POST = await arrange()
    // 41 characters: one past the route's own MAX_NAME. The bound exists
    // because this is a TEXT PRIMARY KEY and an unbounded string is a row
    // nothing can render.
    const res = await POST(submit({ action: 'create', name: 'x'.repeat(41) }), params('run11'))
    expect(res.status).toBe(400)
    // …but a name that is only too long because of padding is fine, which is
    // what "after normalisation" means and what a naive length check on the
    // raw field would get wrong.
    const padded = await POST(
      fetchSubmit({ action: 'create', name: `   ${'x'.repeat(40)}   ` }),
      params('run11'),
    )
    expect(padded.status).toBe(204)
    expect(categories()).toEqual(['x'.repeat(40)])
  })

  it('refuses to re-file a transaction that is not in the friend’s database', async () => {
    const POST = await arrange()
    const res = await POST(
      submit({ action: 'assign', transaction_id: 'not-a-real-id', category: 'Coffee' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    // Nothing accumulated. An override for an id that does not exist would be
    // inert, but unbounded growth in a database only the friend can clean up.
    expect(overrides()).toEqual([])
  })

  it('refuses to re-file a transaction on an account this screen does not cover', async () => {
    // THE SECOND HALF OF THE EXISTENCE CHECK, and the reason it reads the view
    // rather than plaid_transactions: a savings-account transaction is really
    // in his database and is deliberately outside the Spending screen's scope
    // (004's `spending_accounts`). Re-filing one would write an override that
    // no panel could ever show him.
    const POST = await arrange()
    const res = await POST(
      submit({ action: 'assign', transaction_id: OUT_OF_SCOPE, category: 'Coffee' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(overrides()).toEqual([])
  })
})

describe('POST /api/users/[user]/spending-category — re-filing', () => {
  it('writes the override, keyed to the transaction rather than editing it', async () => {
    const POST = await arrange()
    const res = await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'Eating out' }),
      params('run11'),
    )
    expect(res.status).toBe(204)

    const rows = overrides()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.transaction_id).toBe(IN_SCOPE)
    expect(rows[0]!.category).toBe('Eating out')

    // AND THE SYNCED ROW IS UNTOUCHED. This is the whole reason the override
    // lives in its own table: an edit here would be overwritten by the next
    // refresh, because /transactions/sync upserts `modified` rows over the top.
    const db = openUserDb()
    try {
      const payload = db
        .prepare('SELECT payload FROM plaid_transactions WHERE transaction_id = ?')
        .get(IN_SCOPE) as { payload: string }
      expect(JSON.parse(payload.payload).personal_finance_category.primary).toBe('FOOD_AND_DRINK')
    } finally {
      db.close()
    }
  })

  it('upserts rather than accumulating — re-filing twice is one fact, and the last wins', async () => {
    const POST = await arrange()
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'Eating out' }),
      params('run11'),
    )
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'Groceries' }),
      params('run11'),
    )
    const rows = overrides()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.category).toBe('Groceries')
  })

  it('normalises the target category the same way a typed name is normalised', async () => {
    // The category arrives from a menu rather than a text field, but the no-JS
    // path posts whatever the form holds — and a category stored as
    // "Eating  out" would be a slice that never joins the bucket it came from.
    const POST = await arrange()
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: '  Eating   out  ' }),
      params('run11'),
    )
    expect(overrides()[0]!.category).toBe('Eating out')
  })

  it('refuses an empty target category', async () => {
    const POST = await arrange()
    const res = await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: '   ' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(overrides()).toEqual([])
  })
})

describe('POST /api/users/[user]/spending-category — creating a bucket', () => {
  it('creates it, and collapses inner whitespace so one bucket stays one bucket', async () => {
    const POST = await arrange()
    const res = await POST(
      fetchSubmit({ action: 'create', name: '  Eating   out  ' }),
      params('run11'),
    )
    expect(res.status).toBe(204)
    expect(categories()).toEqual(['Eating out'])
  })

  it('is a no-op on a name that already exists, in any case', async () => {
    // Typing a name that already exists is the same intent as choosing it, so
    // it is a no-op rather than an error he has to understand. The column is
    // COLLATE NOCASE, so "Coffee" does not become a second "coffee".
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Coffee' }), params('run11'))
    const res = await POST(fetchSubmit({ action: 'create', name: 'coffee' }), params('run11'))
    expect(res.status).toBe(204)
    expect(categories()).toEqual(['Coffee'])
  })

  it('strips a newline rather than storing a name that renders as a broken row', async () => {
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Eating\nout' }), params('run11'))
    expect(categories()).toEqual(['Eating out'])
  })
})

describe('POST /api/users/[user]/spending-category — ticking a category', () => {
  it('stores the untick for a category a transaction sits in', async () => {
    const POST = await arrange()
    const res = await POST(
      fetchSubmit({ action: 'hide', category: 'FOOD_AND_DRINK' }),
      params('run11'),
    )
    expect(res.status).toBe(204)
    expect(visibility()).toEqual([{ category: 'FOOD_AND_DRINK', included: 0 }])
  })

  it('stores a tick for a bucket that has nothing in it yet', async () => {
    // The second arm of the existence check, and it is not redundant: a bucket
    // he has just made has no transactions, so a check against the view alone
    // would refuse to let him tick the thing he just created.
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Eating out' }), params('run11'))
    const res = await POST(
      fetchSubmit({ action: 'show', category: 'Eating out' }),
      params('run11'),
    )
    expect(res.status).toBe(204)
    expect(visibility()).toEqual([{ category: 'Eating out', included: 1 }])
  })

  it('refuses a category that does not exist at all', async () => {
    // Without this the route accumulates rows for categories nothing can ever
    // render, in a database only the friend can clean up.
    const POST = await arrange()
    const res = await POST(
      fetchSubmit({ action: 'hide', category: 'NOT A CATEGORY' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(visibility()).toEqual([])
  })

  it('refuses to tick a category that only exists on an out-of-scope account', async () => {
    // The savings transaction is really in his database and really carries
    // FOOD_AND_DRINK — but the Spending screen does not cover that account, so
    // the category is not one this screen has. The check reads the VIEW, which
    // is what makes that true.
    const POST = await arrange()
    const db = openUserDb()
    try {
      db.prepare('DELETE FROM plaid_transactions WHERE transaction_id = ?').run(IN_SCOPE)
    } finally {
      db.close()
    }
    const res = await POST(
      fetchSubmit({ action: 'hide', category: 'FOOD_AND_DRINK' }),
      params('run11'),
    )
    expect(res.status).toBe(400)
    expect(visibility()).toEqual([])
  })

  it('upserts, and the LAST request wins', async () => {
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'hide', category: 'FOOD_AND_DRINK' }), params('run11'))
    await POST(fetchSubmit({ action: 'show', category: 'FOOD_AND_DRINK' }), params('run11'))
    expect(visibility()).toEqual([{ category: 'FOOD_AND_DRINK', included: 1 }])
  })

  it('names the target state rather than toggling, so a repeat is idempotent', async () => {
    // Two `hide` requests leave it hidden. A toggle would have flipped it back
    // on — which is the state neither request asked for, and exactly what a
    // double-press or a retried POST would produce.
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'hide', category: 'FOOD_AND_DRINK' }), params('run11'))
    await POST(fetchSubmit({ action: 'hide', category: 'FOOD_AND_DRINK' }), params('run11'))
    expect(visibility()).toEqual([{ category: 'FOOD_AND_DRINK', included: 0 }])
  })

  it('snaps a bucket name to the casing he stored it under', async () => {
    // custom_categories is COLLATE NOCASE so "Coffee" and "coffee" cannot be
    // two buckets — but a category KEY is compared exactly everywhere else, so
    // a no-JS post naming the wrong case would otherwise write a visibility row
    // for a category the legend renders separately.
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Eating out' }), params('run11'))
    await POST(fetchSubmit({ action: 'hide', category: 'eating OUT' }), params('run11'))
    expect(visibility()).toEqual([{ category: 'Eating out', included: 0 }])
  })

  it('snaps the same way when re-filing, so the two tables agree on the key', async () => {
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Eating out' }), params('run11'))
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'eating OUT' }),
      params('run11'),
    )
    expect(overrides()[0]!.category).toBe('Eating out')
  })
})

describe('POST /api/users/[user]/spending-category — the metric row', () => {
  it('carries a slug and a panel and NOTHING the friend typed', async () => {
    const POST = await arrange()
    await POST(
      fetchSubmit({ action: 'create', name: 'divorce lawyer fund' }),
      params('run11'),
    )
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'divorce lawyer fund' }),
      params('run11'),
    )

    const rows = metricRows()
    // The WHOLE row, so a field added later cannot slip a value in unnoticed.
    expect(rows).toEqual([
      {
        event: 'dashboard_write',
        data: { slug: 'run11', panel: 'spending_category_create', device_class: 'desktop' },
      },
      {
        event: 'dashboard_write',
        data: { slug: 'run11', panel: 'spending_category_assign', device_class: 'desktop' },
      },
    ])

    // AND SAID THE OTHER WAY ROUND, because this is the first route in the repo
    // whose payload is free text the friend composed. `metrics` is the
    // UNENCRYPTED platform database, and a bucket called `divorce_lawyer_fund`
    // is CLAUDE.md's own example of what may never reach it.
    // The tick path carries the name too, and is held to the same bound.
    await POST(
      fetchSubmit({ action: 'hide', category: 'divorce lawyer fund' }),
      params('run11'),
    )

    const serialised = JSON.stringify(metricRows())
    expect(serialised).not.toContain('divorce')
    expect(serialised).not.toContain('lawyer')
    expect(serialised).not.toContain(IN_SCOPE)
  })

  it('names the two actions apart, so a query can tell them from each other', async () => {
    const POST = await arrange()
    await POST(fetchSubmit({ action: 'create', name: 'Coffee' }), params('run11'))
    await POST(
      fetchSubmit({ action: 'assign', transaction_id: IN_SCOPE, category: 'Coffee' }),
      params('run11'),
    )
    await POST(fetchSubmit({ action: 'hide', category: 'Coffee' }), params('run11'))
    await POST(fetchSubmit({ action: 'show', category: 'Coffee' }), params('run11'))
    expect(metricRows().map((r) => r.data.panel)).toEqual([
      'spending_category_create',
      'spending_category_assign',
      'spending_category_hide',
      'spending_category_show',
    ])
  })

  it('writes NO metric row when the request is refused', async () => {
    const POST = await arrange()
    await POST(submit({ action: 'create', name: '  ' }), params('run11'))
    expect(metricRows()).toEqual([])
  })
})

describe('POST /api/users/[user]/spending-category — how it answers', () => {
  it('redirects a native form post back to the spending screen', async () => {
    // Without JavaScript this is the whole navigation. Landing him back on the
    // decider after re-filing a transaction would look like the change was
    // thrown away.
    const POST = await arrange()
    const res = await POST(submit({ action: 'create', name: 'Coffee' }), params('run11'))
    expect(res.status).toBe(303)
    // Host-relative: the app runs behind a reverse proxy, so an absolute URL
    // built from request.url would name the internal origin.
    expect(res.headers.get('location')).toBe('/run11?screen=spending')
  })

  it('answers a fetch-initiated write with 204 and no redirect', async () => {
    // WriteAction's fetch defaults to redirect:'follow', so a 303 here would
    // make the browser render the whole dashboard again and append a second
    // dashboard_open row before router.refresh() added a third.
    const POST = await arrange()
    const res = await POST(fetchSubmit({ action: 'create', name: 'Coffee' }), params('run11'))
    expect(res.status).toBe(204)
    expect(res.headers.get('location')).toBeNull()
  })
})
