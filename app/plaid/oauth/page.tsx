import { PlaidOAuthReturn } from '@/lib/ui/PlaidOAuthReturn'

/**
 * Where an OAuth bank returns the friend after they log in.
 *
 * This path is registered in the Plaid dashboard's allowed redirect URIs and
 * must match it EXACTLY — `http://localhost:3000/plaid/oauth` in dev and the
 * droplet's own origin in production. It is supplied to Plaid as
 * `redirect_uri` when the link token is minted, which is why it lives in an
 * environment variable rather than being derived from the request: the value
 * has to equal what is registered, and the request URL behind a reverse proxy
 * names the internal origin (lib/http/redirect.ts).
 *
 * ── WHY TWO SEGMENTS, AND NOT /plaid-oauth ──────────────────────────────────
 *
 * lib/session/resolve.ts's isUserSpacePath treats ANY single non-reserved
 * segment as a user slug, so `/plaid-oauth` would be routed to
 * app/[user]/page.tsx looking for a dashboard named "plaid-oauth" and render
 * the not-built placeholder. Two segments avoids that with no change to the
 * routing rules — better than adding an entry to RESERVED_SEGMENTS for
 * something that is not reserved in any meaningful sense.
 *
 * A locked session is bounced to /unlock from here, because two segments is
 * not user space. That is the correct trade: the connection attempt is lost
 * and the friend starts over, which is honest, and the alternative would be
 * carving a hole in the lock for a path a third party redirects into.
 *
 * The page itself renders nothing but a client component. There is no data to
 * fetch: everything needed to resume was written to sessionStorage before the
 * friend left, and the only other input is the URL, which is handed to Plaid
 * unparsed.
 */
export default function PlaidOAuthPage() {
  return <PlaidOAuthReturn />
}
