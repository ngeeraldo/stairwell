// lib/plaid/client.ts
//
// The only file that knows Plaid exists.
//
// Modelled on lib/weather/openMeteo.ts, and for the same reason: a third party
// on the other end of a socket is a place a friend's data could leak to, so
// the guarantee is made a property of the FILE rather than of one careful
// caller. What differs is the direction of the risk. Open-Meteo is a public
// endpoint about a place; Plaid holds a credential that reaches a real bank
// account, so the properties below are about what this module REFUSES to
// carry outward as much as what it accepts inward.
//
// ─── FOUR PROPERTIES HOLD THIS FILE TOGETHER ───
//
// 1. THE API OBJECT IS INJECTED. Every exported call takes `api` as its first
//    parameter. `plaidApiFromEnv()` is the ONLY function here that reads
//    process.env, and no test in the default suite calls it — CLAUDE.md >
//    Testing: "Every third-party client is injected, and no test in the
//    default suite reaches the network."
//
// 2. IT RETURNS PLAID'S PAYLOAD VERBATIM. No mapping, no renaming, no date
//    parsing, no camelCasing. The envelope stores what Plaid said
//    (modules/plaid/initial.sql), so a field this module does not know about
//    is still there when a friend's dashboard turns out to need it. That is
//    why the return types below say `unknown[]`: TypeScript modelling the
//    payload would be the same hand-maintained derivative the SQL schema
//    deliberately is not.
//
//    The ONE exception is `removed`, where an id is lifted out of its wrapper
//    object. Extracting the key we delete on is not modelling a payload.
//
// 3. IT THROWS PlaidCallError AND NOTHING ELSE. A CODE, never Plaid's prose.
//    An upstream error body is text we did not write, on a path that ends in a
//    friend's database, an ntfy alert and a stderr line — and a Plaid error
//    message can quote an institution name or an account mask. The same bound
//    ForecastError and ManifestError already carry.
//
// 4. NO ACCESS TOKEN IS EVER LOGGED, THROWN, OR RETURNED ANYWHERE BUT TO ITS
//    CALLER. It is a bearer credential for a real bank connection. It appears
//    in exactly two places for its whole life: the return value of an exchange,
//    and the `plaid_items` row inside the friend's own encrypted database.
//
// ─── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───
//
// It validates only the TOP-LEVEL SHAPE it promises to return — that `added`
// is an array, that `next_cursor` is a string. It does NOT validate the fields
// inside a transaction. That split is deliberate: per-item field checks belong
// to tests/support/plaidShape.ts, which is shared with the live shape test so a
// drifted fixture is caught, and to the row writer, which is the thing that
// actually needs `transaction_id` to exist. Duplicating them here would be a
// third answer to "is this payload valid".
//
// Design: docs/superpowers/plans/2026-08-20-plaid-connection.md, D2.
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'

/**
 * A hung provider with no timeout holds a socket for the life of the request.
 *
 * Generous relative to lib/weather/openMeteo.ts's 8s, because a first
 * /transactions/sync after a fresh connection is doing real work upstream. The
 * friend is watching a pending button, so it is still bounded by human
 * patience rather than by generosity to Plaid.
 */
export const PLAID_TIMEOUT_MS = 15_000

export type PlaidErrorCode =
  /** Non-2xx that is not one of the two below. */
  | 'http'
  /** No egress, DNS failure, connection reset. */
  | 'network'
  /** Exceeded PLAID_TIMEOUT_MS. */
  | 'timeout'
  /** 2xx whose body is not the shape this module promises to return. */
  | 'unparseable'
  /** Our own client id or secret is wrong — an operator problem, not a friend's. */
  | 'auth'
  /** The FRIEND must reconnect their bank. The one code with a user-facing meaning. */
  | 'item_login_required'

/**
 * Carries a CODE, never Plaid's message.
 *
 * The closed set above is enough to tell the four operational questions apart:
 * is the droplet offline, are our credentials wrong, must the friend
 * reconnect, or did Plaid answer with something unexpected. Nothing else about
 * an upstream failure is ours to repeat.
 */
export class PlaidCallError extends Error {
  readonly code: PlaidErrorCode

  constructor(code: PlaidErrorCode) {
    super(`plaid call failed: ${code}`)
    this.name = 'PlaidCallError'
    this.code = code
  }
}

/**
 * The ONLY place in this repo that reads a Plaid environment variable.
 *
 * THROWS ON AN UNSET OR UNKNOWN PLAID_ENV rather than defaulting to sandbox.
 * A default here is the PLATFORM_DB failure shape from deploy/required-env:
 * production quietly talking to Sandbox, serving fabricated balances to a real
 * person with every health check green. Failing to boot the call is the
 * cheaper mistake by a wide margin.
 *
 * PlaidEnvironments has exactly two keys — Plaid retired `development` — so
 * this is a two-value check rather than a general lookup.
 */
export function plaidApiFromEnv(): PlaidApi {
  const env = process.env.PLAID_ENV
  if (env !== 'sandbox' && env !== 'production') throw new PlaidCallError('auth')

  const clientId = process.env.PLAID_CLIENT_ID
  const secret = process.env.PLAID_SECRET
  if (!clientId || !secret) throw new PlaidCallError('auth')

  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
        timeout: PLAID_TIMEOUT_MS,
      },
    }),
  )
}

/**
 * Map anything thrown by the SDK onto the closed code set.
 *
 * Reads `error_code` off Plaid's error body for the two cases that mean
 * something specific, and DISCARDS the body otherwise — `error_message` and
 * `display_message` never leave this function. Exported for the test that
 * pins property 3, which is worth more asserting against the real mapping than
 * against a reconstruction of it.
 */
export function classifyError(error: unknown): PlaidErrorCode {
  if (typeof error !== 'object' || error === null) return 'http'
  const e = error as {
    code?: string
    response?: { status?: number; data?: { error_code?: string } }
  }

  // axios raises these before any response exists.
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') return 'timeout'
  if (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET') {
    return 'network'
  }

  const status = e.response?.status
  if (status === undefined) return 'network'

  const plaidCode = e.response?.data?.error_code
  if (plaidCode === 'ITEM_LOGIN_REQUIRED') return 'item_login_required'
  if (plaidCode === 'INVALID_API_KEYS' || status === 401) return 'auth'

  return 'http'
}

async function call<T>(fn: () => Promise<{ data: unknown }>): Promise<T> {
  let data: unknown
  try {
    data = (await fn()).data
  } catch (error) {
    throw new PlaidCallError(classifyError(error))
  }
  if (typeof data !== 'object' || data === null) throw new PlaidCallError('unparseable')
  return data as T
}

function arrayAt(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key]
  if (!Array.isArray(value)) throw new PlaidCallError('unparseable')
  return value
}

export type PlaidItem = {
  accessToken: string
  itemId: string
}

/**
 * Mint an item WITHOUT Plaid Link, for the probe and the live shape test.
 *
 * SANDBOX ONLY — there is no production equivalent and there must not be one:
 * a real bank connection exists only because a person typed their credentials
 * into Plaid's own UI on their own device. This is how a test gets an item to
 * call against without a browser.
 */
export async function createSandboxItem(
  api: PlaidApi,
  opts: { institutionId: string; products: string[] },
): Promise<PlaidItem> {
  const created = await call<{ public_token?: unknown }>(() =>
    api.sandboxPublicTokenCreate({
      institution_id: opts.institutionId,
      // The SDK's enum is a string union at runtime; the caller names products
      // as plain strings so this module does not re-export Plaid's types.
      initial_products: opts.products as never,
    }),
  )
  if (typeof created.public_token !== 'string') throw new PlaidCallError('unparseable')
  return exchangePublicToken(api, created.public_token)
}

/**
 * Trade the public token Plaid Link hands back for the long-lived access token.
 *
 * The public token is short-lived and safe to move through a request body; the
 * access token this returns is neither, and property 4 governs it from here on.
 */
export async function exchangePublicToken(
  api: PlaidApi,
  publicToken: string,
): Promise<PlaidItem> {
  const body = await call<{ access_token?: unknown; item_id?: unknown }>(() =>
    api.itemPublicTokenExchange({ public_token: publicToken }),
  )
  if (typeof body.access_token !== 'string' || typeof body.item_id !== 'string') {
    throw new PlaidCallError('unparseable')
  }
  return { accessToken: body.access_token, itemId: body.item_id }
}

export type TransactionsPage = {
  added: unknown[]
  modified: unknown[]
  /** Transaction ids to delete. The one place an id is lifted out of a payload. */
  removed: string[]
  nextCursor: string
  hasMore: boolean
}

/**
 * One page of the transactions cursor stream.
 *
 * INCREMENTAL BY CONSTRUCTION: pass the cursor stored on the friend's
 * plaid_items row and Plaid returns only what changed since it. Omit it and
 * Plaid returns the item's history from the beginning. The caller is
 * responsible for advancing the stored cursor and writing the rows in ONE
 * transaction — a cursor saved without its rows says we already hold data we
 * threw away, and there is no second chance to ask for it.
 */
export async function syncTransactions(
  api: PlaidApi,
  accessToken: string,
  cursor?: string,
): Promise<TransactionsPage> {
  const body = await call<Record<string, unknown>>(() =>
    api.transactionsSync({ access_token: accessToken, cursor }),
  )

  const nextCursor = body.next_cursor
  if (typeof nextCursor !== 'string') throw new PlaidCallError('unparseable')

  return {
    added: arrayAt(body, 'added'),
    modified: arrayAt(body, 'modified'),
    removed: arrayAt(body, 'removed').map((entry) => {
      const id = (entry as { transaction_id?: unknown })?.transaction_id
      if (typeof id !== 'string') throw new PlaidCallError('unparseable')
      return id
    }),
    nextCursor,
    hasMore: body.has_more === true,
  }
}

export type HoldingsSnapshot = {
  accounts: unknown[]
  holdings: unknown[]
  securities: unknown[]
}

/**
 * Investment holdings — a SNAPSHOT, not a stream.
 *
 * There is no cursor here and there is nothing to page through: Plaid returns
 * what the accounts hold right now. The caller therefore replaces rather than
 * merges, exactly as replaceForecast does in
 * app/api/users/[user]/forecast/route.ts — yesterday's holding is worth
 * nothing once a newer one exists, and merging would leave positions behind
 * that the friend has since sold.
 */
export async function getHoldings(
  api: PlaidApi,
  accessToken: string,
): Promise<HoldingsSnapshot> {
  const body = await call<Record<string, unknown>>(() =>
    api.investmentsHoldingsGet({ access_token: accessToken }),
  )
  return {
    accounts: arrayAt(body, 'accounts'),
    holdings: arrayAt(body, 'holdings'),
    securities: arrayAt(body, 'securities'),
  }
}

/** Every account on the item, with balances. A snapshot, same as holdings. */
export async function getAccounts(api: PlaidApi, accessToken: string): Promise<unknown[]> {
  const body = await call<Record<string, unknown>>(() =>
    api.accountsGet({ access_token: accessToken }),
  )
  return arrayAt(body, 'accounts')
}
