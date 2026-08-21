// modules/plaid/scrub.ts
//
// Turn a real Plaid Sandbox response into something that is safe to commit and
// obviously fake on a screen, WITHOUT changing its shape.
//
// ─── WHY THIS EXISTS RATHER THAN A HAND-WRITTEN FAKER ───────────────────────
//
// The synthetic database every dashboard is built against has to have Plaid's
// exact field shape, or a panel that works in dev breaks for a real friend. A
// hand-written faker is a second author's guess at that shape and nothing
// notices when it drifts. So the fixture is a RECORDING of a real response,
// and this file is what makes a recording committable:
//
//   - it changes VALUES, never KEYS, so the shape is byte-exact;
//   - it marks the fields a person could hide in;
//   - it leaves untouched every field a query might filter or group on.
//
// ─── TWO SEPARATE RULES, WITH TWO SEPARATE REASONS ──────────────────────────
//
// It matters that these are not the same rule, because conflating them
// produced an incoherent scrubber once already (Gate 2).
//
// TEXT FIELDS ARE MARKED so a SCREEN READS AS FAKE. `Uber` becomes
// `UBER TEST`. It is deliberately still readable: Sandbox merchants are
// Plaid's public demo data, identical for every developer on earth and about
// nobody, so there is no identity here to hide — CLAUDE.md's loudly-fake rule
// is about a screenshot being unmistakable, and the threat it names ("a real
// person's merchant list pasted into a generator") cannot arise from a
// fabricated Sandbox response. Keeping real-looking merchant names is also
// WORTH something: a builder designing a merchant column learns more from
// nineteen varied names than from nineteen copies of COFFEE PALACE TEST.
//
// URL FIELDS ARE REPLACED so a SYNTHETIC RENDER FETCHES NOTHING. This is not
// a privacy rule at all. A dashboard rendering `<img src={logo_url}>` against
// synthetic data would reach out to plaid.com on every dev render and every
// screenshot run — a third-party request made on a developer's machine, from
// a page that is supposed to be entirely local and entirely fake. That is why
// `personal_finance_category_icon_url` is replaced too even though it names a
// CATEGORY and no merchant: the rule is about the fetch, not about the name.
//
// ─── THE SECOND HALF IS THE DANGEROUS HALF ──────────────────────────────────
//
// Over-scrubbing is worse than under-scrubbing, and it is the mistake that
// hides. If `personal_finance_category.primary` became `FOOD_AND_DRINK TEST`,
// a builder writing a view would group on the synthetic value, every test
// would pass, and the panel would be empty for a real friend — green all the
// way to their screen. An unscrubbed merchant name, by contrast, is visible to
// anyone who opens the file.
//
// So the rule is narrow and the exclusions are deliberate. NOT scrubbed, each
// for its own reason:
//
//   ticker_symbol      A public market identifier, the same kind of thing as
//                      an ISO currency code, and the likeliest thing a view
//                      filters on. `WHERE ticker_symbol = 'BTC'` must mean the
//                      same in both worlds.
//   merchant_entity_id, entity_id
//                      Opaque Plaid identifiers, not human-readable, and
//                      usable as stable group-by keys.
//   mask               Four digits. CLAUDE.md's own carve-out: a value that is
//                      a number cannot carry the word and still be the thing
//                      it is.
//   category, merchant_category_code, every *_id, date, amount, enum
//                      Structure, not identity.
//
// ─── WHAT GUARDS IT ─────────────────────────────────────────────────────────
//
// modules/tests/scrub.test.ts, and it has to be, because
// tests/users/conventions.test.ts cannot: that sweep checks column values, and
// the envelope stores Plaid's whole object as one JSON string, so it would see
// a single value and pass on the first TEST anywhere in it.
//
// Plan: docs/superpowers/plans/2026-08-20-plaid-connection.md, D4 and F6.

/** The literal tests/users/conventions.test.ts looks for. Keep it exact. */
export const MARKER = 'TEST'

/**
 * Human-readable names — a merchant, a security, an account, an institution.
 *
 * MARKED, NOT REPLACED, for two reasons. Distinct merchants stay distinct, so
 * a GROUP BY still produces the same number of groups as it would in
 * production. And the marker is what makes a screenshot unmistakable, which is
 * the whole of what the loudly-fake rule asks for here.
 *
 * `name` is deliberately blanket: it means a merchant on a transaction, a
 * security on a holding, an account on an account, and a counterparty inside
 * an array — every one of which is identity, none of which is structure.
 */
export const TEXT_FIELDS = [
  'name',
  'merchant_name',
  'official_name',
  'original_description',
  'description',
  'institution_name',
] as const

/**
 * Anything a rendered panel could turn into a network request.
 *
 * REPLACED WHOLESALE rather than marked, because appending to a URL leaves a
 * working URL. `.test` is a reserved TLD (RFC 2606) that can never resolve, so
 * a synthetic render provably reaches nobody — an `<img>` fails locally
 * instead of quietly calling plaid.com from a laptop.
 *
 * `personal_finance_category_icon_url` is in this list even though it names a
 * category rather than a merchant: the rule is about the FETCH.
 */
export const URL_FIELDS: Record<string, string> = {
  logo_url: `https://example.test/${MARKER}.png`,
  website: `${MARKER}.example`,
  personal_finance_category_icon_url: `https://example.test/${MARKER}-category.png`,
}

const TEXT = new Set<string>(TEXT_FIELDS)

/**
 * Uppercase and marked: `Uber` becomes `UBER TEST`.
 *
 * Marked rather than replaced so two different merchants stay two different
 * merchants — a seeded database whose every name collapsed to one string would
 * make every GROUP BY panel render a single row.
 *
 * An EMPTY string stays empty. Real Sandbox recurring streams carry
 * `merchant_name: ""`, and a blank already holds nothing; turning it into
 * " TEST" would invent a value Plaid never sent and change the shape a panel's
 * empty-state branch sees.
 */
function mark(value: string): string {
  if (value === '') return ''
  return `${value.toUpperCase()} ${MARKER}`
}

/**
 * Walk a payload and scrub in place-by-copy.
 *
 * ARRAYS ARE WALKED, which is not incidental: `counterparties` is an array of
 * objects carrying `name`, `website` and `logo_url`, so a scrubber that only
 * visited top-level keys would leave the merchant fully identified one level
 * down while looking like it had worked.
 */
export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => scrub(entry)) as unknown as T
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (typeof inner === 'string' && TEXT.has(key)) {
      out[key] = mark(inner)
    } else if (typeof inner === 'string' && key in URL_FIELDS && inner !== '') {
      out[key] = URL_FIELDS[key]
    } else {
      out[key] = scrub(inner)
    }
  }
  return out as T
}
